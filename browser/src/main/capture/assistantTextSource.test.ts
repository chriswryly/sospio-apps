import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
}));

import { chooseAssistantTextSource } from "./cdpClient";
import { providerForName } from "./providerRegistry";
import { REQUEST_CONTEXT_EFFECT_SIGNATURE } from "./requestMediation";

const chatgpt = providerForName("chatgpt")!;

describe("assistant text source selection", () => {
  it("prefers the rendered DOM when the network body parses to less text", () => {
    // The measured 2026-07-29 case: an 11,557-byte SSE body yielded 4 characters of assistant
    // text while the rendered DOM held 58 including the effect sentinel. Raw-length comparison
    // chose the 4-character version, so the sentinel was absent from a reply that plainly
    // contained it on screen.
    const rendered = `Treat that as unverified until corroborated. ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`;
    const bulkyButUninformative = [
      `data: ${JSON.stringify({ v: "Hmm", metadata: { x: "y".repeat(4000) } })}`,
      `data: ${JSON.stringify({ conversation_id: "c".repeat(4000) })}`,
      "data: [DONE]",
    ].join("\n\n");

    expect(bulkyButUninformative.length).toBeGreaterThan(rendered.length * 50);

    const choice = chooseAssistantTextSource(chatgpt, bulkyButUninformative, rendered);

    expect(choice.source).toBe("rendered_dom");
    expect(choice.body).toBe(rendered);
    expect(choice.body).toContain(REQUEST_CONTEXT_EFFECT_SIGNATURE);
  });

  it("keeps the network body when it parses to more text than the DOM shows", () => {
    const full = `A complete answer with detail. ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`;
    const sse = [
      `data: ${JSON.stringify({ message: { author: { role: "assistant" }, content: { parts: [full] } } })}`,
      "data: [DONE]",
    ].join("\n\n");

    const choice = chooseAssistantTextSource(chatgpt, sse, "A complete");

    expect(choice.source).toBe("network_body");
    expect(choice.networkExtractedChars).toBeGreaterThan("A complete".length);
  });

  it("prefers the network body on a tie", () => {
    // The provider's own bytes are authoritative; the DOM is a lossy view of them.
    const text = "identical text";
    const sse = [
      `data: ${JSON.stringify({ message: { author: { role: "assistant" }, content: { parts: [text] } } })}`,
      "data: [DONE]",
    ].join("\n\n");

    const choice = chooseAssistantTextSource(chatgpt, sse, text);

    expect(choice.source).toBe("network_body");
  });

  it("falls back to the DOM when the network body is empty", () => {
    const choice = chooseAssistantTextSource(chatgpt, "", "rendered only");

    expect(choice.source).toBe("rendered_dom");
    expect(choice.body).toBe("rendered only");
    expect(choice.networkExtractedChars).toBe(0);
  });

  it("refuses the rendered fallback when the response has no completion structure", () => {
    // The shape that fabricated turns: ChatGPT's draft pre-flight returns a conduit token, the
    // parser finds no assistant text in it, and the previous answer is still on screen. The
    // endpoint is now excluded by the completion rule, but the class is the point — any request
    // that matches the rule and produces no reply of its own must not borrow the screen.
    const preflight = JSON.stringify({ conduit_token: "c".repeat(200) });
    const previousAnswer = "a previous answer that is long enough to win a length contest";

    const choice = chooseAssistantTextSource(chatgpt, preflight, previousAnswer);

    expect(choice.source).toBe("network_body");
    expect(choice.body).toBe(preflight);
    expect(choice.renderedRefused).toBe("no_completion_structure");
    // The body it keeps yields no assistant text, so the assembler emits a `skipped` diagnostic
    // and no turn — which is the correct outcome for a request that was not a message send.
    expect(chatgpt.networkParser!.parseResponse(choice.body).assistant_text).toBeNull();
  });

  it("still falls back when a real stream parses to nothing", () => {
    // A body that carries SSE frames *was* a completion, whatever the parser managed to make of
    // it. This is the load-bearing case the refusal above must not touch: a format change that
    // defeats the parser has to degrade to the DOM, not to silence.
    const unparseableStream = ["data: {\"v\":{\"unknown_envelope\":1}}", "data: [DONE]"].join("\n\n");

    const choice = chooseAssistantTextSource(chatgpt, unparseableStream, "what the screen shows");

    expect(choice.source).toBe("rendered_dom");
    expect(choice.renderedRefused).toBeUndefined();
  });

  it("survives a parser throw without discarding the rendered text", () => {
    const throwing = {
      name: "chatgpt",
      networkParser: {
        parseResponse() {
          throw new Error("malformed");
        },
      },
    };

    const choice = chooseAssistantTextSource(throwing, "garbage", "rendered fallback");

    // A throw is not evidence that the body was not a completion — the parser choked. The
    // structure refusal deliberately does not apply here.
    expect(choice.source).toBe("rendered_dom");
    expect(choice.body).toBe("rendered fallback");
    expect(choice.renderedRefused).toBeUndefined();
  });
});
