import { vi } from "vitest";
import { loadRuntimeConfig, hostedModels } from "../config";
export const assistantKey = "fixture-hosted-test-token";
export const model = hostedModels[0];
export function hostedConfig() {
  vi.stubEnv("RSH_LOCAL_HOSTED_ASSISTANT", "1");
  vi.stubEnv("RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY", assistantKey);
  return loadRuntimeConfig();
}
export function streamResponse(events: unknown[], byteStride = 7): Response {
  const wire = events.map(e => typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream<Uint8Array>({start(controller) {
    for (let i = 0; i < bytes.length; i += byteStride) controller.enqueue(bytes.slice(i, i + byteStride));
    controller.close();
  }}));
}
export const delta = (content: string) => ({id: "gen-test", provider: "Google", choices: [{delta: {content}, finish_reason: null}]});
export const finish = {choices: [{delta: {}, finish_reason: "stop"}]};
export const done = "data: [DONE]\n\n";
