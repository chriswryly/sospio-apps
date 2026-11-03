import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { isAllowedNavigation } from "./allowlist";

describe("navigation allowlist", () => {
  it("permits the study providers", () => {
    for (const url of [
      "https://chatgpt.com/",
      "https://grok.com/chat",
      "https://claude.ai/new",
    ]) {
      expect(isAllowedNavigation(url)).toBe(true);
    }
  });

  it("permits X's OAuth so the Grok arm can be authenticated", () => {
    // Grok sign-in federates through X, which redirects to x.com rather than staying on
    // accounts.x.ai. Without these the Grok arm cannot be logged in at all.
    for (const url of [
      "https://x.com/i/flow/login",
      "https://api.x.com/oauth/authorize",
      "https://accounts.x.ai/sign-in",
      "https://twitter.com/i/oauth2/authorize",
    ]) {
      expect(isAllowedNavigation(url)).toBe(true);
    }
  });

  it("permits every hop of the xAI cookie-propagation chain", () => {
    // Grok's post-login `set-cookie` relay walks four hosts before landing on
    // accounts.x.ai. Query values here are placeholders — the real ones are
    // single-use session JWTs and never belong in a fixture.
    for (const url of [
      "https://auth.grokipedia.com/set-cookie?q=PLACEHOLDER",
      "https://auth.grokusercontent.com/set-cookie?q=PLACEHOLDER",
      "https://auth.grok.com/set-cookie?q=PLACEHOLDER",
      "https://auth.x.ai/auth-error",
      "https://accounts.x.ai/auth-error",
    ]) {
      expect(isAllowedNavigation(url)).toBe(true);
    }
  });

  it("allows the relay hosts without opening their apex domains", () => {
    expect(isAllowedNavigation("https://grokipedia.com/")).toBe(false);
    expect(isAllowedNavigation("https://grokusercontent.com/")).toBe(false);
    expect(isAllowedNavigation("https://x.ai/")).toBe(false);
  });

  it("still blocks unrelated hosts", () => {
    for (const url of [
      "https://example.com/",
      "https://evil.test/phish",
      "https://notx.com/",
    ]) {
      expect(isAllowedNavigation(url)).toBe(false);
    }
  });

  it("does not treat a suffix collision as a subdomain match", () => {
    // `endsWith(".x.com")` must not be satisfied by a lookalike registrable domain.
    expect(isAllowedNavigation("https://x.com.attacker.test/")).toBe(false);
    expect(isAllowedNavigation("https://fakex.com/")).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(isAllowedNavigation("not a url")).toBe(false);
    expect(isAllowedNavigation("")).toBe(false);
  });
});
