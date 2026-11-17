import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, session } from "electron";

export interface SavedWhCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export async function openInteractiveWallhavenLogin(options: {
  parent: BrowserWindow | null;
  configDir: string;
  prefillUsername?: string;
  prefillPassword?: string;
}): Promise<{ ok: boolean; username?: string; cookies?: SavedWhCookie[]; error?: string }> {
  const whSession = session.fromPartition("persist:wallhaven");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: {
      ok: boolean;
      username?: string;
      cookies?: SavedWhCookie[];
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const authWin = new BrowserWindow({
      width: 980,
      height: 740,
      parent: options.parent ?? undefined,
      modal: false,
      title: "Sign in to Wallhaven — Wayper",
      backgroundColor: "#0d0d0d",
      autoHideMenuBar: true,
      webPreferences: {
        session: whSession,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const inspectAuthState = async () => {
      if (settled || authWin.isDestroyed()) return;
      const url = authWin.webContents.getURL();
      if (!url.includes("wallhaven.cc")) return;

      try {
        const info = (await authWin.webContents.executeJavaScript(`
          (() => {
            const html = document.documentElement ? document.documentElement.innerHTML : "";
            const loggedIn = html.includes("Logout") || Boolean(document.querySelector('a[href*="/auth/logout"], form[action*="/auth/logout"]'));
            const userEl = document.querySelector('.username, a.username, #userpanel .username');
            const username = userEl ? (userEl.textContent || "").trim() : "";
            return { loggedIn, username, isLoginForm: Boolean(document.querySelector('input[name="username"]')) };
          })()
        `)) as { loggedIn: boolean; username: string; isLoginForm: boolean };

        if (info.isLoginForm && (options.prefillUsername || options.prefillPassword)) {
          await authWin.webContents.executeJavaScript(`
            (() => {
              const u = document.querySelector('input[name="username"]');
              const p = document.querySelector('input[name="password"]');
              if (u && !u.value && ${JSON.stringify(Boolean(options.prefillUsername))}) {
                u.value = ${JSON.stringify(options.prefillUsername ?? "")};
                u.dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (p && !p.value && ${JSON.stringify(Boolean(options.prefillPassword))}) {
                p.value = ${JSON.stringify(options.prefillPassword ?? "")};
                p.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()
          `);
        }

        if (info.loggedIn) {
          const rawCookies = await whSession.cookies.get({ domain: "wallhaven.cc" });
          const cookies: SavedWhCookie[] = rawCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || ".wallhaven.cc",
            path: c.path || "/",
          }));
          const resolvedUsername = info.username || options.prefillUsername || "";
          fs.mkdirSync(options.configDir, { recursive: true });
          const sessionFile = path.join(options.configDir, ".wh_session.json");
          fs.writeFileSync(
            sessionFile,
            JSON.stringify(
              {
                cookies,
                timestamp: Date.now() / 1000,
                username: resolvedUsername,
              },
              null,
              2,
            ),
            { encoding: "utf-8", mode: 0o600 },
          );
          finish({ ok: true, username: resolvedUsername, cookies });
          if (!authWin.isDestroyed()) {
            authWin.close();
          }
        }
      } catch {
        // Page still navigating or cross-origin challenge frame
      }
    };

    authWin.webContents.on("did-finish-load", () => {
      void inspectAuthState();
    });
    authWin.webContents.on("did-navigate", () => {
      void inspectAuthState();
    });
    authWin.on("closed", () => {
      finish({ ok: false, error: "Sign-in window closed before authentication completed" });
    });

    void authWin.loadURL("https://wallhaven.cc/login");
  });
}
