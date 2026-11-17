import fs from "node:fs";
import path from "node:path";
import { wallhavenId } from "../shared/tags";
import { saveConfig, type WayperConfig } from "./config";
import { httpFetch, httpGetJson, USER_AGENT } from "./http";
import { atomicWrite } from "./image-probe";
import { getConfigDir } from "./paths";
import { favoriteFilenames } from "./pool";
import { listBlacklist } from "./state";

const BASE_URL = "https://wallhaven.cc";
const SESSION_VERIFY_TTL_MS = 15 * 60 * 1000;
const LOGIN_RETRY_DELAY_MS = 60_000;
const ATTR_RE = /([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
export const PUSH_BATCH_SIZE = 5;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

type SessionVerification = "authenticated" | "unauthenticated" | "unavailable";

type InteractiveLoginHook = (config: WayperConfig) => Promise<{
  ok: boolean;
  cookies?: StoredCookie[];
  username?: string;
}>;

let interactiveLoginHook: InteractiveLoginHook | null = null;

export function setInteractiveLoginHandler(fn: InteractiveLoginHook | null): void {
  interactiveLoginHook = fn;
}

function sessionFilePath(): string {
  return path.join(getConfigDir(), ".wh_session.json");
}

function isCfChallenge(res: Response): boolean {
  return res.status === 403 && (res.headers.get("cf-mitigated") ?? "").includes("challenge");
}

function parseSetCookieHeaders(headers: Headers): StoredCookie[] {
  const rawList =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];

  const parsed: StoredCookie[] = [];
  for (const raw of rawList) {
    const segments = raw.split(";").map((s) => s.trim());
    const first = segments[0];
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    let domain = ".wallhaven.cc";
    let cookiePath = "/";
    for (let i = 1; i < segments.length; i += 1) {
      const [k, v] = segments[i].split("=");
      if (!k || !v) continue;
      const lower = k.trim().toLowerCase();
      if (lower === "domain") domain = v.trim();
      if (lower === "path") cookiePath = v.trim();
    }
    parsed.push({ name, value, domain, path: cookiePath });
  }
  return parsed;
}

class CookieJar {
  private map = new Map<string, StoredCookie>();

  load(cookies: StoredCookie[]): void {
    this.map.clear();
    for (const c of cookies) {
      if (c.name) this.map.set(c.name, c);
    }
  }

  mergeFromResponse(res: Response): void {
    for (const cookie of parseSetCookieHeaders(res.headers)) {
      if (cookie.value === "" || cookie.value === "deleted") {
        this.map.delete(cookie.name);
      } else {
        this.map.set(cookie.name, cookie);
      }
    }
  }

  headerValue(): string {
    return [...this.map.values()].map((c) => `${c.name}=${c.value}`).join("; ");
  }

  toArray(): StoredCookie[] {
    return [...this.map.values()];
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    copy.load(this.toArray());
    return copy;
  }

  clear(): void {
    this.map.clear();
  }
}

function loadCachedSession(expectedUsername: string): StoredCookie[] | null {
  const file = sessionFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      cookies?: StoredCookie[];
      timestamp?: number;
      username?: string;
    };
    if (!Array.isArray(data.cookies) || !data.cookies.length) return null;
    if (
      expectedUsername &&
      data.username &&
      data.username.toLowerCase() !== expectedUsername.toLowerCase()
    ) {
      return null;
    }
    return data.cookies;
  } catch {
    return null;
  }
}

function saveCachedSession(username: string, cookies: StoredCookie[]): void {
  if (!cookies.length) return;
  try {
    const file = sessionFilePath();
    atomicWrite(
      file,
      JSON.stringify(
        {
          cookies,
          timestamp: Date.now() / 1000,
          username,
        },
        null,
        2,
      ),
    );
    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Best-effort session persistence
  }
}

function clearCachedSession(): void {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch {
    // Ignore
  }
}

function extractCsrfToken(html: string): string | null {
  const metaMatch = html.match(/csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch?.[1]) return metaMatch[1];
  const inputMatch = html.match(/name="_token"\s+value="([^"]+)"/i);
  return inputMatch?.[1] ?? null;
}

function isAuthenticatedHtml(html: string): boolean {
  return html.includes("Logout") || /\/auth\/logout\b/i.test(html);
}

function isUnauthenticatedHtml(finalUrl: string, html: string): boolean {
  return (
    finalUrl.endsWith("/login") ||
    /<form[^>]+(?:id=["']login["']|action=["'][^"']*\/auth\/login)/i.test(html) ||
    /href=["'](?:https?:\/\/wallhaven\.cc)?\/login(?:[?'"#]|$)/i.test(html)
  );
}

function resolveWallhavenUrl(rawUrl: string): string {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  if (rawUrl.startsWith("//")) {
    return `https:${rawUrl}`;
  }
  if (rawUrl.startsWith("/")) {
    return `${BASE_URL}${rawUrl}`;
  }
  return `${BASE_URL}/${rawUrl}`;
}

export class WallhavenWebSession {
  private jar = new CookieJar();
  private loggedIn = false;
  private lastVerifiedAt = 0;
  private loginRetryAfter = 0;
  private sessionUsername = "";

  constructor(private config: WayperConfig) {}

  updateConfig(nextConfig: WayperConfig): void {
    this.config = nextConfig;
  }

  private persistSession(usernameOverride?: string): void {
    const effectiveUser = (
      usernameOverride ||
      this.sessionUsername ||
      this.config.wallhaven_username
    ).trim();
    saveCachedSession(effectiveUser, this.jar.toArray());
  }

  private async fetchWithJar(
    url: string,
    init: RequestInit & { jar?: CookieJar; timeoutMs?: number } = {},
  ): Promise<Response> {
    const activeJar = init.jar ?? this.jar;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    const cookieStr = activeJar.headerValue();
    if (cookieStr) {
      headers.set("Cookie", cookieStr);
    }
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    const res = await httpFetch(url, {
      method: init.method ?? "GET",
      headers: headerRecord,
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect ?? "follow",
      timeoutMs: init.timeoutMs ?? 20_000,
      proxy: this.config.proxy,
    });
    activeJar.mergeFromResponse(res);
    return res;
  }

  private async verifySession(): Promise<SessionVerification> {
    const tempJar = this.jar.clone();
    try {
      const res = await this.fetchWithJar(`${BASE_URL}/`, {
        jar: tempJar,
        redirect: "follow",
        timeoutMs: 15_000,
      });
      if (isCfChallenge(res) || res.status === 429 || res.status >= 500) {
        return "unavailable";
      }
      if (res.status === 401 || res.status === 403) {
        return "unauthenticated";
      }
      if (res.status !== 200) {
        return "unavailable";
      }
      const html = await res.text();
      if (isAuthenticatedHtml(html)) {
        this.jar.load(tempJar.toArray());
        return "authenticated";
      }
      if (isUnauthenticatedHtml(res.url, html)) {
        return "unauthenticated";
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async login(options: { allowBrowser?: boolean; force?: boolean } = {}): Promise<boolean> {
    const { allowBrowser = false, force = false } = options;
    if (
      this.loggedIn &&
      !force &&
      performance.now() - this.lastVerifiedAt < SESSION_VERIFY_TTL_MS
    ) {
      return true;
    }
    if (!force && performance.now() < this.loginRetryAfter) return false;

    const username = this.config.wallhaven_username.trim();
    if (!username && !allowBrowser) return false;

    // Stage 1: Cached .wh_session.json cookies
    const cached = loadCachedSession(username);
    if (!this.loggedIn && cached) {
      this.jar.load(cached);
    }
    if (this.jar.toArray().length > 0) {
      const state = await this.verifySession();
      if (state === "authenticated") {
        this.loggedIn = true;
        this.lastVerifiedAt = performance.now();
        this.loginRetryAfter = 0;
        this.sessionUsername = username || this.sessionUsername;
        this.persistSession(username);
        return true;
      }
      if (state === "unavailable" && !allowBrowser) {
        this.loginRetryAfter = performance.now() + LOGIN_RETRY_DELAY_MS;
        return false;
      }
      if (state === "unauthenticated") {
        this.loggedIn = false;
        clearCachedSession();
        this.jar.clear();
      }
    }

    // Stage 2: CSRF Form Login when password is provided
    if (username && this.config.wallhaven_password) {
      try {
        const loginPage = await this.fetchWithJar(`${BASE_URL}/login`, { redirect: "follow" });
        if (isCfChallenge(loginPage)) {
          if (!allowBrowser) {
            this.loginRetryAfter = performance.now() + LOGIN_RETRY_DELAY_MS;
            return false;
          }
        } else if (loginPage.ok) {
          const html = await loginPage.text();
          const token = extractCsrfToken(html);
          if (token) {
            const body = new URLSearchParams({
              _token: token,
              username,
              password: this.config.wallhaven_password,
            });
            const postRes = await this.fetchWithJar(`${BASE_URL}/auth/login`, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Referer: `${BASE_URL}/login`,
              },
              body: body.toString(),
              redirect: "manual",
            });
            if (postRes.status === 302) {
              const verify = await this.verifySession();
              if (verify === "authenticated") {
                this.loggedIn = true;
                this.lastVerifiedAt = performance.now();
                this.loginRetryAfter = 0;
                this.sessionUsername = username;
                this.persistSession(username);
                return true;
              }
            }
          }
        }
      } catch {
        this.loginRetryAfter = performance.now() + LOGIN_RETRY_DELAY_MS;
      }
    }

    // Stage 3: Built-in Electron interactive login window (passes Cloudflare naturally)
    if (allowBrowser && interactiveLoginHook) {
      const interactive = await interactiveLoginHook(this.config);
      if (interactive.ok && interactive.cookies?.length) {
        this.jar.load(interactive.cookies);
        const verify = await this.verifySession();
        if (verify === "authenticated") {
          this.loggedIn = true;
          this.lastVerifiedAt = performance.now();
          this.loginRetryAfter = 0;
          this.sessionUsername = (interactive.username || username).trim();
          this.persistSession(this.sessionUsername);
          return true;
        }
      }
    }

    return false;
  }

  async setFavoriteState(whId: string, wantFav: boolean): Promise<boolean> {
    if (!whId) return false;
    if (!(await this.login())) return false;

    const attemptToggle = async (): Promise<"ok" | "retry" | "fail"> => {
      const pageUrl = `${BASE_URL}/w/${whId}`;
      const res = await this.fetchWithJar(pageUrl, { redirect: "follow" });
      if (isCfChallenge(res)) return "fail";
      if (res.status === 401 || res.status === 403 || res.url.endsWith("/login")) {
        return "retry";
      }
      if (!res.ok) return "fail";

      const html = await res.text();
      if (!isAuthenticatedHtml(html) && isUnauthenticatedHtml(res.url, html)) {
        return "retry";
      }

      const parsed = parseFavButtonState(html);
      if (parsed.isFaved !== null && parsed.isFaved === wantFav) {
        this.persistSession();
        return "ok";
      }
      if (parsed.isFaved === null && !wantFav) {
        return "fail";
      }
      if (!parsed.actionUrl) return "fail";

      const csrf = extractCsrfToken(html);
      if (!csrf) return "fail";

      const targetUrl = resolveWallhavenUrl(parsed.actionUrl);

      const postRes = await this.fetchWithJar(targetUrl, {
        method: "POST",
        headers: {
          "X-CSRF-TOKEN": csrf,
          "X-Requested-With": "XMLHttpRequest",
          Referer: pageUrl,
          Accept: "application/json",
        },
      });
      if (isCfChallenge(postRes)) return "fail";
      if (!postRes.ok || postRes.url.endsWith("/login")) return "retry";
      const payload = (await postRes.json().catch(() => null)) as { status?: boolean } | null;
      if (payload?.status === true) {
        this.persistSession();
        return "ok";
      }
      return "fail";
    };

    const first = await attemptToggle();
    if (first === "ok") return true;
    if (first === "retry") {
      this.loggedIn = false;
      if (await this.login({ force: true })) {
        return (await attemptToggle()) === "ok";
      }
    }
    return false;
  }

  async syncBrowsingBlacklistField(
    fieldName: "blacklist" | "blacklist_users",
    items: string[],
  ): Promise<boolean> {
    if (!(await this.login())) return false;
    const attemptSync = async (): Promise<"ok" | "retry" | "fail"> => {
      try {
        const pageUrl = `${BASE_URL}/settings/browsing`;
        const res = await this.fetchWithJar(pageUrl, { redirect: "follow" });
        if (isCfChallenge(res)) return "fail";
        if (res.status === 401 || res.status === 403 || res.url.endsWith("/login")) {
          return "retry";
        }
        if (!res.ok) return "fail";
        const html = await res.text();
        if (!isAuthenticatedHtml(html) && isUnauthenticatedHtml(res.url, html)) {
          return "retry";
        }
        const token = extractCsrfToken(html);
        if (!token) return "fail";

        const formParams = scrapeFormFields(html);
        formParams.set("_token", token);

        const existingRaw = formParams.get(fieldName) ?? "";
        const mergedMap = new Map<string, string>();
        for (const line of existingRaw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) mergedMap.set(trimmed.toLowerCase(), trimmed);
        }
        for (const item of items) {
          const trimmed = item.trim();
          if (trimmed && !mergedMap.has(trimmed.toLowerCase())) {
            mergedMap.set(trimmed.toLowerCase(), trimmed);
          }
        }
        const sortedLines = [...mergedMap.values()].sort((left, right) =>
          left.localeCompare(right),
        );
        formParams.set(fieldName, sortedLines.join("\n"));

        const postRes = await this.fetchWithJar(pageUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: pageUrl,
          },
          body: formParams.toString(),
          redirect: "manual",
        });
        if (postRes.status === 200 || postRes.status === 302) {
          this.persistSession();
          return "ok";
        }
        return postRes.status === 401 || postRes.status === 403 || postRes.status === 419
          ? "retry"
          : "fail";
      } catch {
        return "fail";
      }
    };

    const first = await attemptSync();
    if (first === "ok") return true;
    if (first === "retry") {
      this.loggedIn = false;
      if (await this.login({ force: true })) {
        return (await attemptSync()) === "ok";
      }
    }
    return false;
  }
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseTagAttributes(openTag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(openTag)) !== null) {
    attrs.set(match[1].toLowerCase(), decodeHtmlEntities(match[3]));
  }
  return attrs;
}

function usableActionUrl(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === "#" || /^javascript:/i.test(trimmed)) return null;
  if (/\/login(?:[?#"']|$)/i.test(trimmed)) return null;
  return trimmed;
}

function extractActionUrl(attrs: Map<string, string>): string | null {
  return usableActionUrl(attrs.get("href")) ?? usableActionUrl(attrs.get("data-href"));
}

function findInnerActionUrl(fragment: string, classToken?: string): string | null {
  const tagRe = classToken
    ? new RegExp(
        `<[\\w:-]+\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${classToken}\\b)[^>]*>`,
        "gi",
      )
    : /<[\w:-]+\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(fragment)) !== null) {
    const candidate = extractActionUrl(parseTagAttributes(match[0]));
    if (!candidate) continue;
    if (classToken || /wallpaper\/fav/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseFavButtonState(html: string): {
  isFaved: boolean | null;
  actionUrl: string | null;
} {
  const tagMatch = html.match(/<([\w:-]+)\b(?=[^>]*\bid\s*=\s*["']fav-button["'])[^>]*>/i);
  if (tagMatch && tagMatch.index !== undefined) {
    const openTag = tagMatch[0];
    const tagName = tagMatch[1];
    const attrs = parseTagAttributes(openTag);
    const classes = (attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
    const isFaved = classes.length > 0 ? !classes.includes("add-button") : true;
    let actionUrl = extractActionUrl(attrs);
    if (!actionUrl) {
      const bodyStart = tagMatch.index + openTag.length;
      const closeTag = `</${tagName}>`;
      const closeIdx = html.toLowerCase().indexOf(closeTag.toLowerCase(), bodyStart);
      const body = html.slice(bodyStart, closeIdx !== -1 ? closeIdx : bodyStart + 2500);
      if (!isFaved) {
        actionUrl = findInnerActionUrl(body, "add-fav") ?? findInnerActionUrl(body);
      } else {
        actionUrl = findInnerActionUrl(body, "rm-fav") ?? findInnerActionUrl(body);
      }
    }
    return { isFaved, actionUrl: actionUrl ? resolveWallhavenUrl(actionUrl) : null };
  }

  const globalAdd = findInnerActionUrl(html, "add-fav");
  if (globalAdd) {
    return { isFaved: false, actionUrl: resolveWallhavenUrl(globalAdd) };
  }
  const globalRemove = findInnerActionUrl(html, "rm-fav");
  if (globalRemove) {
    return { isFaved: true, actionUrl: resolveWallhavenUrl(globalRemove) };
  }
  return { isFaved: null, actionUrl: null };
}

function scrapeFormFields(html: string): URLSearchParams {
  const params = new URLSearchParams();
  const inputRe = /<input\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRe.exec(html)) !== null) {
    const attrs = match[1];
    const name = attrs.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const type = (attrs.match(/\btype=["']([^"']+)["']/i)?.[1] ?? "text").toLowerCase();
    const value = attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(attrs)) {
        params.append(name, value || "1");
      }
    } else if (type === "hidden" || type === "text" || type === "number") {
      params.set(name, value);
    }
  }

  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((match = selectRe.exec(html)) !== null) {
    const name = match[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const selectedOpt = match[2].match(/<option\b[^>]*\bselected\b[^>]*\bvalue=["']([^"']*)["']|<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*\bselected\b/i);
    if (selectedOpt) {
      params.set(name, selectedOpt[1] ?? selectedOpt[2] ?? "");
    }
  }

  const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((match = textareaRe.exec(html)) !== null) {
    const name = match[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    params.set(name, match[2]);
  }
  return params;
}

interface SharedSessionEntry {
  session: WallhavenWebSession;
  queue: Promise<void>;
}

const sharedSessions = new Map<string, SharedSessionEntry>();

function sharedSessionKey(config: WayperConfig): string {
  return [
    path.resolve(getConfigDir()),
    config.wallhaven_username.trim().toLowerCase(),
    config.wallhaven_password,
    config.proxy ?? "",
  ].join("|");
}

function withSharedWebSession<T>(
  config: WayperConfig,
  task: (session: WallhavenWebSession) => Promise<T>,
): Promise<T> {
  const key = sharedSessionKey(config);
  let entry = sharedSessions.get(key);
  if (!entry) {
    entry = { session: new WallhavenWebSession(config), queue: Promise.resolve() };
    sharedSessions.set(key, entry);
  } else {
    entry.session.updateConfig(config);
  }
  const activeSession = entry.session;
  const run = entry.queue.then(() => task(activeSession));
  entry.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function wallhavenWebFav(config: WayperConfig, filenameOrId: string): Promise<boolean> {
  if (!config.wallhaven_username) return false;
  const whId = wallhavenId(filenameOrId);
  if (!whId) return false;
  return withSharedWebSession(config, (session) => session.setFavoriteState(whId, true));
}

export async function wallhavenWebUnfav(config: WayperConfig, filenameOrId: string): Promise<boolean> {
  if (!config.wallhaven_username) return false;
  const whId = wallhavenId(filenameOrId);
  if (!whId) return false;
  return withSharedWebSession(config, (session) => session.setFavoriteState(whId, false));
}

export async function reconnectWallhaven(
  config: WayperConfig,
  options: { allowBrowser?: boolean } = {},
): Promise<boolean> {
  return withSharedWebSession(config, (session) =>
    session.login({ allowBrowser: options.allowBrowser ?? true, force: true }),
  );
}

export async function syncCloudTagBlacklist(config: WayperConfig): Promise<boolean> {
  if (!config.wallhaven_username || !config.wallhaven.exclude_tags.length) return false;
  return withSharedWebSession(config, (session) =>
    session.syncBrowsingBlacklistField("blacklist", config.wallhaven.exclude_tags),
  );
}

export async function syncCloudUserBlacklist(config: WayperConfig): Promise<boolean> {
  if (!config.wallhaven_username || !config.wallhaven.exclude_uploaders.length) return false;
  return withSharedWebSession(config, (session) =>
    session.syncBrowsingBlacklistField("blacklist_users", config.wallhaven.exclude_uploaders),
  );
}

export async function pushLocalFavorites(
  config: WayperConfig,
  remoteFiles: ReadonlySet<string>,
): Promise<number> {
  if (!config.wallhaven_username) return 0;
  const localFavs = [...favoriteFilenames(config)].sort();
  const missing = localFavs
    .filter((filename) => !remoteFiles.has(filename))
    .slice(0, PUSH_BATCH_SIZE);
  if (!missing.length) return 0;

  return withSharedWebSession(config, async (session) => {
    if (!(await session.login())) return 0;
    let pushed = 0;
    for (const filename of missing) {
      if (await session.setFavoriteState(wallhavenId(filename), true)) {
        pushed += 1;
      }
    }
    return pushed;
  });
}

export async function removeBlacklistedRemoteFavorites(
  config: WayperConfig,
  remoteFiles: ReadonlySet<string>,
): Promise<number> {
  if (!config.wallhaven_username || remoteFiles.size === 0) return 0;
  const stale = listBlacklist(config)
    .map((entry) => entry.filename)
    .filter((filename) => remoteFiles.has(filename))
    .slice(0, PUSH_BATCH_SIZE);
  if (stale.length === 0) return 0;

  return withSharedWebSession(config, async (session) => {
    if (!(await session.login())) return 0;
    let removed = 0;
    for (const filename of stale) {
      if (await session.setFavoriteState(wallhavenId(filename), false)) {
        removed += 1;
      }
    }
    return removed;
  });
}

async function fetchCloudSettings(config: WayperConfig): Promise<Record<string, unknown>> {
  if (!config.api_key) return {};
  try {
    const body = await httpGetJson(`${BASE_URL}/api/v1/settings`, {
      headers: { "User-Agent": USER_AGENT, "X-API-Key": config.api_key },
      timeoutMs: 15_000,
      proxy: config.proxy,
    });
    const data = body.data;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function cloudStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export async function fetchCloudTags(config: WayperConfig): Promise<string[]> {
  return cloudStringList((await fetchCloudSettings(config)).tag_blacklist);
}

function mergeBlacklistValues(target: string[], incoming: string[]): number {
  const existing = new Set(target.map((value) => value.toLowerCase()));
  let added = 0;
  for (const value of incoming) {
    const key = value.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    target.push(value);
    added += 1;
  }
  return added;
}

export async function mergeCloudBlacklistsIntoConfig(
  config: WayperConfig,
): Promise<{ modified: boolean; cloudTags: string[]; addedTags: number; addedUsers: number }> {
  const data = await fetchCloudSettings(config);
  const cloudTags = cloudStringList(data.tag_blacklist);
  const cloudUsers = cloudStringList(data.user_blacklist);
  const addedTags = mergeBlacklistValues(config.wallhaven.exclude_tags, cloudTags);
  const addedUsers = mergeBlacklistValues(config.wallhaven.exclude_uploaders, cloudUsers);
  const modified = addedTags > 0 || addedUsers > 0;
  if (modified) saveConfig(config);
  return { modified, cloudTags, addedTags, addedUsers };
}
