import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatgptSpec } from "./chatgpt";
import { claudeaiSpec } from "./claudeai";
import { grokSpec } from "./grok";
import { piaiSpec } from "./piai";
import { sanitizeNetworkUrl } from "../urlRedaction";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(dirname, "__fixtures__");

describe("provider adapters", () => {
  it("captures a Grok request/stream pair with a DOM fallback", () => {
    const request = fixture("grok_short.request.json");
    const response = fixture("grok_short.response.sse");
    const url = "https://grok.com/rest/app-chat/conversations/grok-fixture-short/responses";
    expect(grokSpec.matches("https://grok.com/"), "official Grok consumer origin").toBe(true);
    expect(grokSpec.primary).toBe("network");
    expect(grokSpec.domEnabled).toBe(true);
    expect(grokSpec.networkParser?.isCompletionRequestUrl(url, "POST")).toBe(true);
    expect(grokSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
    expect(grokSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
    expect(grokSpec.networkParser?.extractConversationId(url, request, response)).toBe("grok-fixture-short");
  });

  it("parses ChatGPT snapshot-style SSE", () => {
    const request = fixture("chatgpt_short.request.json");
    const response = fixture("chatgpt_short.response.sse");
    expect(chatgptSpec.primary).toBe("network");
    expect(chatgptSpec.domEnabled).toBe(false);
    expect(chatgptSpec.networkParser?.isCompletionRequestUrl("https://chatgpt.com/backend-api/conversation", "POST")).toBe(true);
    expect(chatgptSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
    expect(chatgptSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
    expect(chatgptSpec.networkParser?.extractConversationId("https://chatgpt.com/backend-api/conversation", request, response)).toBe(
      "chatgpt-fixture-short",
    );
  });

  it("parses multi-paragraph ChatGPT text", () => {
    const request = fixture("chatgpt_long.request.json");
    const response = fixture("chatgpt_long.response.sse");
    expect(chatgptSpec.networkParser?.parseRequest(request).user_prompt).toBe("Give me two short paragraphs about calibration.");
    expect(chatgptSpec.networkParser?.parseResponse(response).assistant_text).toBe(
      "Calibration means matching confidence to evidence.\n\nIt matters because overconfident systems can sound useful while hiding uncertainty.",
    );
  });

  it("parses ChatGPT patch-style SSE", () => {
    const response = fixture("chatgpt_patch.response.sse");
    expect(chatgptSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
  });

  describe("ChatGPT v1 delta encoding", () => {
    // The reply the three delta-encoding fixtures stream. Markdown emphasis, a paragraph break,
    // and a trailing sentinel -- browser puts its effect signature last, so a parser that truncates
    // drops precisely the thing the probe checks for.
    const REPLY =
      "**Calibration** means matching confidence to evidence.\n\n" +
      "It matters because overconfident systems can sound useful while hiding uncertainty. ⟂";

    it("recovers the whole reply when continuation ops inherit a sticky path", () => {
      const response = fixture("chatgpt_delta_encoding_v1.response.sse");

      const text = chatgptSpec.networkParser?.parseResponse(response).assistant_text;

      expect(text).toBe(REPLY);
      // The measured 2026-07-30 regression: requiring an explicit `p` on every op kept only the
      // first chunk, so a 7,841-byte body yielded 39 characters of a 70-character reply.
      expect(text).not.toBe("**Calibration** means matching confiden");
      expect(text?.endsWith("⟂")).toBe(true);
    });

    it("recovers the whole reply when content ops are batched inside o:patch", () => {
      const response = fixture("chatgpt_delta_encoding_v1_patched.response.sse");

      const text = chatgptSpec.networkParser?.parseResponse(response).assistant_text;

      expect(text).toBe(REPLY);
    });

    it("never reports the delta-encoding version literal as assistant text", () => {
      // `data: "v1"` parses as a JSON string, so it used to fall through to the plain-text
      // branch and win the length contest against zero recovered deltas. A turn record on
      // 2026-07-30 has assistant_text exactly '"v1"'.
      const patched = fixture("chatgpt_delta_encoding_v1_patched.response.sse");
      expect(chatgptSpec.networkParser?.parseResponse(patched).assistant_text).not.toBe('"v1"');

      const preambleOnly = ['event: delta_encoding\ndata: "v1"', "data: [DONE]"].join("\n\n");
      expect(chatgptSpec.networkParser?.parseResponse(preambleOnly).assistant_text).toBeNull();
    });

    it("excludes reasoning content and keeps the deliverable reply", () => {
      const response = fixture("chatgpt_delta_encoding_v1_thoughts.response.sse");

      const text = chatgptSpec.networkParser?.parseResponse(response).assistant_text;

      expect(text).toBe(REPLY);
      expect(text).not.toContain("The user wants a definition");
    });

    it("reads the conversation id from the opening delta snapshot", () => {
      const response = fixture("chatgpt_delta_encoding_v1.response.sse");

      expect(
        chatgptSpec.networkParser?.extractConversationId("https://chatgpt.com/backend-api/f/conversation", "", response),
      ).toBe("6a6a6b7b-0f28-83e8-82d7-a03a6f5ac19e");
    });

    it("does not inherit a path for a bare value before any op names one", () => {
      // Guards against the sticky path inventing assistant text out of an unrelated envelope
      // that happens to carry a `v` field.
      const response = [
        `data: ${JSON.stringify({ v: "Hmm", metadata: { note: "unrelated envelope" } })}`,
        "data: [DONE]",
      ].join("\n\n");

      expect(chatgptSpec.networkParser?.parseResponse(response).assistant_text).toBeNull();
    });

    it("still accepts a rendered-DOM text body as a fallback", () => {
      // The capture layer routes rendered text through this parser when the network body parses
      // to less; that path must keep working. See chooseAssistantTextSource.
      expect(chatgptSpec.networkParser?.parseResponse(REPLY).assistant_text).toBe(REPLY);

      // A rendered reply that happens to parse as a JSON scalar is still a reply. Only a scalar
      // *inside* a stream is protocol metadata.
      expect(chatgptSpec.networkParser?.parseResponse('"Perpendicular."').assistant_text).toBe('"Perpendicular."');
    });
  });

  it("uses the longest ChatGPT text candidate", () => {
    const response = [
      'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["That’s"]}}}',
      "",
      'data: {"p":"/message/content/parts/0","o":"append","v":"That’s a longer complete answer."}',
    ].join("\n");
    expect(chatgptSpec.networkParser?.parseResponse(response).assistant_text).toBe("That’s a longer complete answer.");
  });

  it("recognizes newer ChatGPT response endpoints", () => {
    expect(chatgptSpec.networkParser?.isCompletionRequestUrl("https://chatgpt.com/backend-api/responses", "POST")).toBe(true);
    expect(
      chatgptSpec.networkParser?.isCompletionRequestUrl(
        "https://chatgpt.com/backend-api/conversation/experimental/generate_autocompletions",
        "POST",
      ),
    ).toBe(false);
    expect(chatgptSpec.networkParser?.parseRequest('{"input":"Please answer in one sentence."}').user_prompt).toBe(
      "Please answer in one sentence.",
    );
  });

  it("ignores the ChatGPT draft-prepare request that fires on the first keystroke", () => {
    // Observed live: typing the first character of a new message POSTs this with that one
    // character as the body. It used to be captured as a turn, paired with the previous
    // response scraped from the DOM.
    expect(
      chatgptSpec.networkParser?.isCompletionRequestUrl(
        "https://chatgpt.com/backend-api/f/conversation/prepare",
        "POST",
      ),
    ).toBe(false);
    // The real send on the same path prefix still captures.
    expect(
      chatgptSpec.networkParser?.isCompletionRequestUrl(
        "https://chatgpt.com/backend-api/f/conversation",
        "POST",
      ),
    ).toBe(true);
    expect(
      chatgptSpec.networkParser?.isCompletionRequestUrl("https://chatgpt.com/backend-api/conversation", "POST"),
    ).toBe(true);
  });

  it("extracts nested ChatGPT user input", () => {
    const request = JSON.stringify({
      body: {
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Please answer in one sentence." }],
          },
        ],
      },
    });
    expect(chatgptSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
  });

  it("parses Claude delta-style SSE", () => {
    const request = fixture("claude_short.request.json");
    const response = fixture("claude_short.response.sse");
    const url =
      "https://claude.ai/api/organizations/org-1/chat_conversations/claude-fixture-short/completion";
    expect(claudeaiSpec.primary).toBe("network");
    expect(claudeaiSpec.domEnabled).toBe(false);
    expect(claudeaiSpec.networkParser?.isCompletionRequestUrl(url, "POST")).toBe(true);
    expect(claudeaiSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
    expect(claudeaiSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
    expect(claudeaiSpec.networkParser?.extractConversationId(url, request, response)).toBe("claude-fixture-short");
  });

  it("extracts nested Claude user input", () => {
    const request = JSON.stringify({
      messages: [
        { role: "assistant", content: "prior answer" },
        { role: "user", content: [{ type: "text", text: "Please answer in one sentence." }] },
      ],
    });
    expect(claudeaiSpec.networkParser?.isCompletionRequestUrl(
      "https://claude.ai/api/organizations/org-1/chat_conversations/claude-fixture-short/completion",
      "POST",
    )).toBe(true);
    expect(claudeaiSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
  });

  it("parses Claude content-block SSE", () => {
    const response = fixture("claude_content_block.response.sse");
    expect(claudeaiSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
  });

  it("parses multi-paragraph Claude deltas", () => {
    const request = fixture("claude_long.request.json");
    const response = fixture("claude_long.response.sse");
    expect(claudeaiSpec.networkParser?.parseRequest(request).user_prompt).toBe("Give me two short paragraphs about calibration.");
    expect(claudeaiSpec.networkParser?.parseResponse(response).assistant_text).toContain(
      "overconfident systems can sound useful",
    );
  });

  it("parses Pi.ai SSE deltas", () => {
    const request = fixture("piai_short.request.json");
    const response = fixture("piai_short.response.sse");
    const url = "https://pi.ai/api/chat";
    expect(piaiSpec.experimental).toBe(true);
    expect(piaiSpec.enabled).toBe(false);
    expect(piaiSpec.networkParser?.isCompletionRequestUrl(url, "POST")).toBe(true);
    expect(piaiSpec.networkParser?.parseRequest(request).user_prompt).toBe("Please answer in one sentence.");
    expect(piaiSpec.networkParser?.parseResponse(response).assistant_text).toBe("Here is a concise one-sentence answer.");
    expect(piaiSpec.networkParser?.extractConversationId(url, request, response)).toBe("pi-fixture-short");
  });

  it("repairs Pi.ai mojibake text", () => {
    const response = fixture("piai_mojibake.response.sse");
    expect(piaiSpec.networkParser?.parseResponse(response).assistant_text).toBeNull();
  });

  it("parses rendered Pi.ai text fallback", () => {
    expect(piaiSpec.networkParser?.parseResponse("This is the full rendered Pi response.").assistant_text).toBe(
      "This is the full rendered Pi response.",
    );
  });

  it("rejects Pi.ai control text as an assistant response", () => {
    expect(piaiSpec.networkParser?.parseResponse("More options").assistant_text).toBeNull();
    expect(piaiSpec.networkParser?.parseResponse("Bad response").assistant_text).toBeNull();
    expect(piaiSpec.networkParser?.parseResponse("Good response").assistant_text).toBeNull();
  });

  it("parses nested Pi.ai v2 message payloads", () => {
    const response = JSON.stringify({
      data: {
        messages: [
          { role: "user", content: "old prompt" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "new prompt" },
          { role: "assistant", content: [{ type: "text", text: "new answer" }] },
        ],
      },
    });
    expect(piaiSpec.networkParser?.parseResponse(response).assistant_text).toBe("new answer");
  });

  it("parses Pi.ai nested streaming chunks", () => {
    const response = [
      'data: {"data":{"delta":{"content":[{"type":"text","text":"first "}]}}}',
      "",
      'data: {"data":{"delta":{"content":[{"type":"text","text":"second"}]}}}',
    ].join("\n");
    expect(piaiSpec.networkParser?.parseResponse(response).assistant_text).toBe("first second");
  });

  it("drops query strings and redacts opaque path segments", () => {
    const url = "https://claude.ai/api/organizations/123e4567-e89b-12d3-a456-426614174000/chat_conversations/987e6543-e21b-45d3-a456-426614174999/completion?code=secret-token";
    expect(sanitizeNetworkUrl(url, claudeaiSpec.networkParser)).toBe(
      "https://claude.ai/api/organizations/REDACTED/chat_conversations/REDACTED/completion",
    );
  });
});

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}


it("keeps an established empty root cursor across snapshots with omitted p and o", () => {
  const message = (role: string, content_type: string, text: string) => ({
    message: { author: { role }, content: { content_type, parts: [text] } },
    conversation_id: "root-cursor-session",
  });
  const events = [
    { p: "", o: "add", v: message("system", "text", "hidden system text") },
    { v: message("user", "text", "user text") },
    { v: message("assistant", "thoughts", "private reasoning") },
    { v: message("assistant", "text", "") },
    { p: "/message/content/parts/0", o: "append", v: "Visible " },
    { v: "answer." },
  ];
  const body = events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\ndata: [DONE]";
  expect(chatgptSpec.networkParser?.parseResponse(body).assistant_text).toBe("Visible answer.");
  expect(chatgptSpec.networkParser?.extractConversationId("", "", body)).toBe("root-cursor-session");
  expect(chatgptSpec.networkParser?.parseResponse('data: {"v":"unrelated envelope"}').assistant_text).toBeNull();
});
