import { describe, expect, it } from "vitest";
import { redactQueryValues, sanitizeLogUrl } from "./urlRedaction";

// Mirrors the pattern in __tests__/credential_leak.test.ts. The scan asserts that
// no artifact on disk matches it; these tests assert that the redactors feeding
// the main log cannot produce a match in the first place.
const rawQuerySecret = /\?[a-z_]+=[A-Za-z0-9._-]{20,}/i;

// Shaped like the Google sign-in URLs a live Grok/ChatGPT auth flow navigates
// through — single-use tokens in `?TL=` and `?as=` — with synthetic token bodies.
const signInChallenge =
  "https://accounts.google.com/v3/signin/challenge/pwd?TL=SYNTHETICtokenSYNTHETICtokenSYNTHETICtoken&cid=1&flowName=GlifWebSignIn";
const accountChooser =
  "https://accounts.google.com/v3/signin/accountchooser?as=SYNTHETICtokenSYNTHETICtoken&client_id=49625052041-syntheticclientidsyntheticclientid.apps.googleusercontent.com";

describe("sanitizeLogUrl", () => {
  it("drops sign-in query strings but keeps the navigation target", () => {
    expect(sanitizeLogUrl(signInChallenge)).toBe(
      "https://accounts.google.com/v3/signin/challenge/pwd?REDACTED",
    );
    expect(sanitizeLogUrl(accountChooser)).toBe(
      "https://accounts.google.com/v3/signin/accountchooser?REDACTED",
    );
  });

  it("produces output the credential-leak scan accepts", () => {
    expect(rawQuerySecret.test(signInChallenge)).toBe(true);
    expect(rawQuerySecret.test(sanitizeLogUrl(signInChallenge))).toBe(false);
    expect(rawQuerySecret.test(sanitizeLogUrl(accountChooser))).toBe(false);
  });

  it("redacts opaque path segments the way network tags do", () => {
    expect(sanitizeLogUrl("https://chatgpt.com/c/6862d1f0-1234-4abc-8def-0123456789ab")).toBe(
      "https://chatgpt.com/c/REDACTED",
    );
    expect(sanitizeLogUrl("https://grok.com/chat")).toBe("https://grok.com/chat");
  });

  it("drops the fragment as well as the query", () => {
    expect(sanitizeLogUrl("https://claude.ai/new#access_token=SYNTHETICtokenSYNTHETIC")).toBe(
      "https://claude.ai/new?REDACTED",
    );
  });

  it("keeps origin-less schemes readable", () => {
    expect(sanitizeLogUrl("file:///Users/someone/sospio-browser/out/renderer/index.html")).toBe(
      "file:///Users/someone/sospio-browser/out/renderer/index.html",
    );
    expect(sanitizeLogUrl("about:blank")).toBe("about:blank");
  });

  it("collapses data: URLs to their media type", () => {
    const landing = `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><h1>Sospio Browser</h1>")}`;
    expect(sanitizeLogUrl(landing)).toBe("data:text/html;charset=utf-8");
  });

  it("drops userinfo", () => {
    expect(sanitizeLogUrl("https://user:secretpassword@chatgpt.com/")).toBe("https://chatgpt.com/");
  });

  it("keeps the port", () => {
    expect(sanitizeLogUrl("http://127.0.0.1:8765/health")).toBe("http://127.0.0.1:8765/health");
  });

  it("reports absent and unparseable URLs instead of throwing", () => {
    expect(sanitizeLogUrl("")).toBe("(none)");
    expect(sanitizeLogUrl("not a url")).toBe("unknown://invalid-url");
  });
});

describe("redactQueryValues", () => {
  it("masks long query values a caller forgot to sanitize", () => {
    expect(redactQueryValues(`did-finish-load url=${signInChallenge}`)).toBe(
      "did-finish-load url=https://accounts.google.com/v3/signin/challenge/pwd?TL=REDACTED&cid=1&flowName=GlifWebSignIn",
    );
  });

  it("masks values after an ampersand, which the leak scan pattern misses", () => {
    const url = "https://accounts.google.com/signin?hl=en&TL=SYNTHETICtokenSYNTHETICtoken";
    expect(rawQuerySecret.test(url)).toBe(false);
    expect(redactQueryValues(url)).toBe("https://accounts.google.com/signin?hl=en&TL=REDACTED");
  });

  it("leaves short values and ordinary log lines alone", () => {
    expect(redactQueryValues("captured turn provider=chatgpt turn=abc-123")).toBe(
      "captured turn provider=chatgpt turn=abc-123",
    );
    expect(redactQueryValues("https://grok.com/chat?hl=en")).toBe("https://grok.com/chat?hl=en");
  });
});
