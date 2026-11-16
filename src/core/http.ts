import {
  Agent,
  ProxyAgent,
  Response as UndiciResponse,
  fetch as undiciFetch,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const directAgent = new Agent({ connect: { timeout: 10_000 } });
const proxyAgents = new Map<string, Dispatcher>();

export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export function normalizeProxyUrl(proxy: string | null | undefined): string | null {
  const trimmed = (proxy ?? "").trim();
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function dispatcherFor(proxy: string | null | undefined): Dispatcher {
  const normalized = normalizeProxyUrl(proxy);
  if (!normalized) return directAgent;
  let agent = proxyAgents.get(normalized);
  if (!agent) {
    const scheme = new URL(normalized).protocol;
    if (scheme !== "http:" && scheme !== "https:") {
      throw new Error(`Unsupported proxy scheme ${scheme} (use an http:// or https:// proxy)`);
    }
    agent = new ProxyAgent({ uri: normalized, connect: { timeout: 10_000 } });
    proxyAgents.set(normalized, agent);
  }
  return agent;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "follow" | "manual" | "error";
  timeoutMs?: number;
  proxy?: string | null;
  signal?: AbortSignal;
}

async function run<T>(
  url: string,
  options: HttpRequestOptions,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    const response = await undiciFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: options.redirect ?? "follow",
      signal: controller.signal,
      dispatcher: dispatcherFor(options.proxy),
    });
    return await consume(response as unknown as Response);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface BufferedResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  text: string;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Fetch with the body buffered inside the timeout window, so a server that
 * stalls after sending headers cannot hang a caller that reads the body later.
 */
export function httpFetch(url: string, options: HttpRequestOptions = {}): Promise<Response> {
  return run(url, options, async (response) => {
    const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
    const buffered = new UndiciResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as never,
    });
    Object.defineProperties(buffered, {
      url: { value: response.url },
      redirected: { value: response.redirected },
    });
    return buffered as unknown as Response;
  });
}

export function httpFetchText(
  url: string,
  options: HttpRequestOptions = {},
): Promise<BufferedResponse> {
  return run(url, options, async (response) => ({
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: response.headers,
    text: await response.text(),
  }));
}

export function httpGetJson(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Record<string, unknown>> {
  return run(url, options, async (response) => {
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpStatusError(response.status, url);
    }
    const body = (await response.json()) as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  });
}

export function httpGetBytes(url: string, options: HttpRequestOptions = {}): Promise<Buffer> {
  return run(url, options, async (response) => {
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpStatusError(response.status, url);
    }
    return Buffer.from(await response.arrayBuffer());
  });
}

export function applyGlobalProxy(proxy: string | null | undefined): void {
  // Libraries that use the runtime's built-in fetch (model downloads) follow the same proxy.
  try {
    setGlobalDispatcher(dispatcherFor(proxy));
  } catch {
    setGlobalDispatcher(directAgent);
  }
}
