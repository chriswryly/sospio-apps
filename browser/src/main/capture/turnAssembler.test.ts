import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatgptSpec } from "./providers/chatgpt";
import { TurnAssembler } from "./turnAssembler";

const fixtureDir = join(fileURLToPath(new URL(".", import.meta.url)), "providers", "__fixtures__");
const fixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");
const URL_ = "https://chatgpt.com/backend-api/f/conversation";
const STREAM = fixture("chatgpt_delta_encoding_v1.response.sse");
const STREAM_ID = "6a6a6b7b-0f28-83e8-82d7-a03a6f5ac19e";
const RENDERED = "Rendered screen text with no conversation identifier in it.";

// A new chat's first request carries conversation_id: null; later turns carry the real ID.
function request(conversationId: string | null): string {
  const base = JSON.parse(fixture("chatgpt_short.request.json")) as Record<string, unknown>;
  return JSON.stringify({ ...base, conversation_id: conversationId });
}

function assemble(conversationId: string | null, responseBody: string, idSources?: string[]) {
  const assembler = new TurnAssembler();
  expect(assembler.start("r1", URL_, request(conversationId), chatgptSpec)).toBeNull();
  return assembler.finish("r1", responseBody, idSources).turn!;
}

describe("TurnAssembler session identity", () => {
  it("finds a new chat's ID in the network body when display text was taken from the screen", () => {
    const turn = assemble(null, RENDERED, [STREAM]);
    expect(turn.session_id).toBe(STREAM_ID);
    expect(turn.session_source).toBe("network_response");
    expect(turn.assistant_text).toBe(RENDERED);
  });

  it("reproduces the first-turn split when only rendered text is searched", () => {
    const turn = assemble(null, RENDERED);
    expect(turn.session_id).toBe(turn.turn_id);
    expect(turn.session_source).toBe("turn_id_fallback");
  });

  it("prefers the network response over the request hint and takes the first source with an ID", () => {
    const turn = assemble("hint-id", RENDERED, ["", "no ids here", STREAM]);
    expect(turn.session_id).toBe(STREAM_ID);
    expect(turn.session_source).toBe("network_response");
  });

  it("still reads the ID from the chosen body when it is the network stream", () => {
    const turn = assemble(null, STREAM);
    expect(turn.session_id).toBe(STREAM_ID);
    expect(turn.session_source).toBe("display_body");
  });

  it("falls back to the request hint, then the turn ID", () => {
    expect(assemble("hint-id", RENDERED, [RENDERED])).toMatchObject({ session_id: "hint-id", session_source: "request_hint" });
    const orphan = assemble(null, RENDERED, [RENDERED]);
    expect(orphan).toMatchObject({ session_id: orphan.turn_id, session_source: "turn_id_fallback" });
  });

  it("records provenance on synthetic (withheld) turns", () => {
    const assembler = new TurnAssembler();
    assembler.start("r1", URL_, request(null), chatgptSpec);
    expect(assembler.syntheticTurn("r1", "withheld")?.session_source).toBe("turn_id_fallback");
    assembler.start("r2", URL_, request("hint-id"), chatgptSpec);
    expect(assembler.syntheticTurn("r2", "withheld")).toMatchObject({ session_id: "hint-id", session_source: "request_hint" });
  });
});
