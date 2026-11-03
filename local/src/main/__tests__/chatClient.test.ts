import { describe, expect, it } from "vitest";
import { keepAliveValue } from "../chatClient";

describe("ollama keep_alive encoding", () => {
  // Regression: the default "-1" was sent as a string and Ollama answered
  // HTTP 400 `time: missing unit in duration "-1"`, so every chat turn failed.
  it("sends the keep-loaded sentinel as a number", () => {
    expect(keepAliveValue("-1")).toBe(-1);
  });

  it("sends other numeric values as numbers", () => {
    expect(keepAliveValue("0")).toBe(0);
    expect(keepAliveValue("300")).toBe(300);
  });

  it("leaves real Go durations as strings", () => {
    expect(keepAliveValue("5m")).toBe("5m");
    expect(keepAliveValue("1h30m")).toBe("1h30m");
  });

  it("trims, and leaves an empty value as a string rather than coercing to 0", () => {
    expect(keepAliveValue(" 5m ")).toBe("5m");
    expect(keepAliveValue("")).toBe("");
  });
});

import { vi, afterEach } from "vitest";
import { ChatClient } from "../chatClient";
import { loadRuntimeConfig } from "../config";
afterEach(() => vi.unstubAllGlobals());
function mockStream(chunks: string[]): void {
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } })));
}
it("requires terminal completion and consumes a final non-newline record", async () => {
  mockStream(['{"done":false,"message":{"content":"hello"}}\n', '{"done":true,"message":{"content":" world"}}']);
  const seen: string[] = [];
  const result = await new ChatClient(loadRuntimeConfig()).streamChat({ systemPrompt: "s", messages: [] }, (s) => seen.push(s));
  expect(result).toMatchObject({ text: "hello world", completed: true });
  expect(seen).toEqual(["hello", "hello world"]);
});
it.each(['{"done":false,"message":{"content":"partial"}}\n', '{"error":"private error"}\n', 'bad json\n', '{"done":true}\n{"done":false}\n'])("rejects incomplete, malformed or post-terminal streams", async (raw) => {
  mockStream([raw]);
  await expect(new ChatClient(loadRuntimeConfig()).streamChat({ systemPrompt: "s", messages: [] }, () => undefined)).rejects.toThrow();
});
it('sends the selected model and preserves system-prompt augmentation and governor exclusion',async()=>{
 const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"done":true,"message":{"content":"reply"}}'));c.close()}})));
 vi.stubGlobal('fetch',fetcher);
 await new ChatClient(loadRuntimeConfig()).streamChat({model:'hf.co/org/model:tag',systemPrompt:'Recorded addition',messages:[{id:'g',role:'governor',content:'visible only',created_at:'now'},{id:'u',role:'user',content:'hello',created_at:'now'}]},()=>{});
 const init=fetcher.mock.calls[0] as unknown as [string,RequestInit];const body=JSON.parse(String(init[1].body));expect(body.model).toBe('hf.co/org/model:tag');expect(body.messages).toEqual([{role:'system',content:'Recorded addition'},{role:'user',content:'hello'}]);
});
