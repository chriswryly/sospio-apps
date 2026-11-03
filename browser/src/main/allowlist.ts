import type { BrowserWindowConstructorOptions, WebContents } from "electron";

export const ALLOWED_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "grok.com",
  "pi.ai",
  "login.anthropic.com",
  "console.anthropic.com",
  "accounts.x.ai",
  // Grok sign-in finishes by propagating the session cookie across xAI's other
  // origins: a chain of `<host>/set-cookie?q=<jwt>` hops, each JWT naming the next
  // hop in its `success_url`, ending at accounts.x.ai. Observed chain is
  // auth.grokipedia.com → auth.grokusercontent.com → auth.grok.com → auth.x.ai →
  // accounts.x.ai. Only auth.grok.com was already reachable (via grok.com), so
  // without the three below the flow dies mid-chain and the cookie is never set.
  // Kept to the `auth.` hosts rather than the apex domains — these are cookie-relay
  // endpoints, not sites the harness has any reason to browse.
  "auth.grokipedia.com",
  "auth.grokusercontent.com",
  "auth.x.ai",
  "auth.openai.com",
  "auth0.openai.com",
  "accounts.google.com",
  "appleid.apple.com",
  // Grok sign-in federates through X's OAuth, which redirects to x.com — not just
  // accounts.x.ai — so without this the Grok arm cannot be authenticated at all.
  // Note this is a broader surface than the other auth entries (x.com is the whole
  // platform, not an auth-only host); X provides no narrower origin for the flow.
  "x.com",
  "twitter.com",
];

export function isAllowedNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:" || parsed.protocol === "file:") {
      return true;
    }
    return ALLOWED_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

export function installNavigationGuard(
  webContents: WebContents,
  onBlocked: (url: string) => void,
): void {
  webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      onBlocked(url);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url)) {
      onBlocked(url);
      return { action: "deny" };
    }
    const overrideBrowserWindowOptions: BrowserWindowConstructorOptions = {
      width: 900,
      height: 900,
      title: "Sospio Browser - Auth",
      backgroundColor: "#101418",
      webPreferences: {
        partition: "persist:sospio-browser",
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
    return { action: "allow", overrideBrowserWindowOptions };
  });
}
