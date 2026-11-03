import { describe, expect, it } from "vitest";

import { describeBodyShape } from "./bodyShape";

describe("describeBodyShape", () => {
  it("never emits string values — only paths, types and lengths", () => {
    // The whole point. The harness must not persist raw request bodies, so a shape summary that
    // leaked the prompt or a token would be worse than no diagnostic at all.
    const secret = "synthetic-private-credential";
    const prompt = "my private question about a medical result";
    const shape = describeBodyShape(JSON.stringify({
      message: prompt,
      auth: { token: secret },
      modelName: "grok-4",
    }));

    expect(shape).not.toContain(secret);
    expect(shape).not.toContain(prompt);
    expect(shape).not.toContain("grok-4");
    // Structure is retained.
    expect(shape).toContain("message:str");
    expect(shape).toContain("auth.token:str");
    expect(shape).toContain("modelName:str");
  });

  it("reports string lengths so an empty field is distinguishable from a populated one", () => {
    expect(describeBodyShape(JSON.stringify({ prompt: "" }))).toContain("prompt:str(0)");
    expect(describeBodyShape(JSON.stringify({ prompt: "abcde" }))).toContain("prompt:str(5)");
  });

  it("shows nested and array structure with a representative element", () => {
    const shape = describeBodyShape(JSON.stringify({
      messages: [
        { role: "user", content: "hello there" },
        { role: "user", content: "second" },
      ],
    }));

    expect(shape).toContain("messages[2]");
    expect(shape).toContain("messages[0].role:str");
    expect(shape).toContain("messages[0].content:str");
    expect(shape).not.toContain("hello there");
  });

  it("handles a non-JSON body without throwing or echoing it", () => {
    const shape = describeBodyShape("this is not json at all");

    expect(shape).toBe("non-json body (23 chars)");
    expect(shape).not.toContain("not json");
  });

  it("records non-string primitives and nulls by type", () => {
    const shape = describeBodyShape(JSON.stringify({ n: 42, ok: true, nothing: null }));

    expect(shape).toContain("n:number");
    expect(shape).toContain("ok:boolean");
    expect(shape).toContain("nothing=null");
    expect(shape).not.toContain("42");
  });

  it("bounds output on a large or deeply nested body", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) {
      wide[`field_${i}`] = "value";
    }
    const shape = describeBodyShape(JSON.stringify(wide));

    expect(shape).toContain("truncated");
    expect(shape.length).toBeLessThan(2000);
  });

  it("does not recurse without bound on a deep body", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50; i += 1) {
      deep = { nested: deep };
    }
    expect(() => describeBodyShape(JSON.stringify(deep))).not.toThrow();
  });
});
