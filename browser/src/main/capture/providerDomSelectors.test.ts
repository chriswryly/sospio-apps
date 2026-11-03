import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  hasCharacterizedDom,
  providerTurnSelectorsShimSource,
  turnSelectorsFor,
  UNCHARACTERIZED_FALLBACK,
} from "./providerDomSelectors";

describe("provider DOM selectors", () => {
  it("characterizes chatgpt", () => {
    expect(hasCharacterizedDom("chatgpt")).toBe(true);
    expect(turnSelectorsFor("chatgpt").assistant).toContain('[data-message-author-role="assistant"]');
  });

  /**
   * The regression this table exists for: claude.ai became a study provider while both selector
   * tables still had only a ChatGPT branch and a Grok-shaped fallback, which matches nothing on
   * Claude. These are the markers a live discovery run found, and neither is inherited.
   */
  it("characterizes claudeai from its own surface, not the fallback", () => {
    const claude = turnSelectorsFor("claudeai");
    expect(hasCharacterizedDom("claudeai")).toBe(true);
    expect(claude.user).toContain('div[data-cds="UserMessage"]');
    expect(claude.assistant).toContain("div[data-is-streaming]");
    expect(claude.assistant).not.toEqual(UNCHARACTERIZED_FALLBACK.assistant);
    expect(claude.user).not.toEqual(UNCHARACTERIZED_FALLBACK.user);
  });

  /**
   * `data-is-streaming` flips to "true" mid-response. Pinning the selector to `="false"` would
   * make the governor blind to the turn it is actively mediating.
   */
  it("matches the streaming attribute by presence so an in-flight turn still resolves", () => {
    for (const selector of turnSelectorsFor("claudeai").assistant) {
      expect(selector).not.toContain("data-is-streaming=");
    }
  });

  it("keeps the heuristic fallback only for providers that are not study providers", () => {
    expect(turnSelectorsFor("grok")).toBe(UNCHARACTERIZED_FALLBACK);
    expect(turnSelectorsFor("piai")).toBe(UNCHARACTERIZED_FALLBACK);
  });

  it("serializes a page-script accessor backed by the same table", () => {
    const sandbox: Record<string, unknown> = {};
    runInNewContext(
      `${providerTurnSelectorsShimSource()}
       result = {
         chatgptAssistant: rshTurnSelectors("chatgpt", "assistant"),
         claudeUser: rshTurnSelectors("claudeai", "user"),
         unknown: rshTurnSelectors("nope", "assistant"),
       };`,
      sandbox,
    );
    const result = sandbox.result as Record<string, string[]>;
    expect(result.chatgptAssistant).toEqual(turnSelectorsFor("chatgpt").assistant);
    expect(result.claudeUser).toEqual(turnSelectorsFor("claudeai").user);
    expect(result.unknown).toEqual([]);
  });

  /**
   * Callers read `.at(-1)` as "the most recent turn". Claude is the first provider with two user
   * selectors, and without a document-order pass the last element would be the last match of the
   * last *selector* — so a turn matched only by the secondary selector would outrank a later one.
   */
  it("orders multi-selector matches by document position, not selector order", () => {
    const sandbox: Record<string, unknown> = { result: null };
    runInNewContext(
      `${providerTurnSelectorsShimSource()}
       // 4 = DOCUMENT_POSITION_FOLLOWING (argument comes after this node), 2 = PRECEDING.
       const late = { id: "late", compareDocumentPosition: () => 2 };
       const early = { id: "early", compareDocumentPosition: () => 4 };
       // As gathered selector-by-selector: reversed relative to the document.
       result = rshDocumentOrder([late, early]).map((n) => n.id);`,
      sandbox,
    );
    expect(sandbox.result).toEqual(["early", "late"]);
  });
});

it("prefers current ChatGPT markers while keeping the old markers", () => {
  expect(turnSelectorsFor("chatgpt")).toEqual({user: ['[data-user-message-bubble]', '[data-message-author-role="user"]'], assistant: ['[data-conversation-role="assistant"]', '[data-message-author-role="assistant"]']});
});
