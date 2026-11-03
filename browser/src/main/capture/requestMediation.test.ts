import { describe, expect, it } from "vitest";
import { mediateRequestBody } from "./requestMediation";

describe("CDP request mediation", () => {
  it("appends bounded context to the ChatGPT user turn", () => {
    const result = mediateRequestBody(
      "chatgpt",
      JSON.stringify({ messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } }] }),
      "augment_request_context",
      "qualify uncertain claims",
    );
    const payload = JSON.parse(result.postData);
    expect(result.changed).toBe(true);
    expect(result.strategy).toContain("appended_user_turn_context");
    // The user turn is augmented in place; no separate (droppable) message is added.
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].author.role).toBe("user");
    expect(payload.messages[0].content.parts[0]).toContain("hello");
    expect(payload.messages[0].content.parts[0]).toContain("qualify uncertain claims");
    expect(result.postData).not.toMatch(/governor|harness|user-authorized|r[s]h/i);
  });

  it("bounds and appends context to the user turn", () => {
    const result = mediateRequestBody(
      "grok",
      JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      "augment_request_context",
      "x".repeat(700),
    );
    const payload = JSON.parse(result.postData);
    expect(result.changed).toBe(true);
    expect(result.strategy).toContain("appended_user_turn_context");
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[0].content).toContain("hello");
    expect(payload.messages[0].content).toContain("x".repeat(500));
    expect(payload.messages[0].content).not.toContain("x".repeat(501));
    expect(result.postData).not.toMatch(/governor|harness|user-authorized|r[s]h/i);
  });

  it("appends bounded context to Claude's prompt envelope", () => {
    const result = mediateRequestBody(
      "claudeai",
      JSON.stringify({ prompt: "hello", attachments: [] }),
      "augment_request_context",
      "qualify uncertain claims",
    );
    const payload = JSON.parse(result.postData);
    expect(result.changed).toBe(true);
    expect(result.strategy).toContain("claudeai:appended_user_turn_context");
    expect(payload.prompt).toContain("hello");
    expect(payload.prompt).toContain("qualify uncertain claims");
    expect(payload.attachments).toEqual([]);
    expect(result.postData).not.toMatch(/governor|harness|user-authorized|r[s]h/i);
  });

  it("appends context to a ChatGPT responses-style input turn", () => {
    const result = mediateRequestBody(
      "chatgpt",
      JSON.stringify({
        body: {
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "summarize this" }],
            },
          ],
        },
      }),
      "augment_request_context",
      "preserve uncertainty",
    );
    const payload = JSON.parse(result.postData);
    expect(result.changed).toBe(true);
    expect(result.strategy).toContain("appended_user_turn_context");
    expect(payload.body.input).toHaveLength(1);
    expect(payload.body.input[0].role).toBe("user");
    expect(payload.body.input[0].content[0].text).toContain("summarize this");
    expect(payload.body.input[0].content[0].text).toContain("preserve uncertainty");
    expect(result.postData).not.toMatch(/governor|harness|user-authorized|r[s]h/i);
  });

  it("rejects detectable governor or harness labels in model-routed context", () => {
    expect(
      mediateRequestBody(
        "chatgpt",
        JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
        "augment_request_context",
        "User-authorized governor context for this harness probe",
      ),
    ).toEqual({
      changed: false,
      postData: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      strategy: "d10_detectable_context",
    });
  });

  it("allows a detectable label when the run opts into attribution", () => {
    // The pattern protects *probe validity* — an anonymous context measures steering rather than
    // reaction to a label. It is not a product constraint, and an attribution experiment needs to
    // say who is speaking. Runs made this way report as diagnostics, never capability probes.
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    const result = mediateRequestBody(
      "chatgpt",
      body,
      "augment_request_context",
      "[Resilience harness, authorized by the user] preserve the user's original request",
      { allowAttribution: true },
    );
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("chatgpt:appended_user_turn_context");
    expect(result.postData).toContain("Resilience harness");
    // The default posture is unchanged: the same context without the opt-in is still refused.
    expect(
      mediateRequestBody("chatgpt", body, "augment_request_context",
        "[Resilience harness, authorized by the user] preserve the user's original request").strategy,
    ).toBe("d10_detectable_context");
  });

  it("fails closed for non-JSON bodies", () => {
    expect(
      mediateRequestBody("grok", "opaque", "augment_request_context", "context"),
    ).toEqual({ changed: false, postData: "opaque", strategy: "non_json_request" });
  });

  it("fails closed when the request carries no user turn to augment", () => {
    const result = mediateRequestBody(
      "chatgpt",
      JSON.stringify({ messages: [{ role: "assistant", content: "prior answer" }] }),
      "augment_request_context",
      "qualify uncertain claims",
    );
    expect(result.changed).toBe(false);
    expect(result.strategy).toBe("no_user_turn_text_field");
  });
});
