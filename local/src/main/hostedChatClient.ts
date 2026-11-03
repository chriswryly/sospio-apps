import type { HostedChatMetadata, HostedUsage } from "../shared/types";
import { toChatMessages, type ChatPort, type ChatRequest, type StreamResult } from "./chatClient";
import { HOSTED_MAX_TOKENS, type HostedConfig } from "./config";
import { type HostedSpendLedger, validNumber, validTokens, type HostedSpendRecord } from "./hostedSpend";

export class HostedChatError extends Error {
  constructor(message: string, readonly hosted?: HostedChatMetadata) { super(message); }
}
/** Redact complete credentials, not just the identifying prefix matched by the leak scan. */
export function scrubHostedError(text: string, key: string): string {
  return text.split(key).join("[redacted]")
    .replace(/(?:Authorization|Cookie|x-api-key)\s*[:=]?\s*[^\r\n]*/gi, "[redacted]")
    .replace(/Bearer\s+\S+|sk\x2d[A-Za-z0-9_-]+|\?[a-z_]+=[A-Za-z0-9._-]{20,}/gi, "[redacted]");
}

export class HostedChatClient implements ChatPort {
  constructor(private config: HostedConfig, private spend: HostedSpendLedger,
    private onSettlement: (record: HostedSpendRecord) => void,
    private onDispatch: () => void = () => {}) {}
  async prewarm(): Promise<void> { /* Never spend on warming. */ }
  async streamChat(request: ChatRequest, onChunk: (text: string) => void): Promise<StreamResult> {
    const model = this.config.models.find(m => m.id === request.model);
    if (!model) throw new Error("hosted_model_unavailable");
    const messages = toChatMessages(request);
    const reservation = this.spend.reserve(model, messages);
    let usage: HostedUsage = {};
    let text = "", chunks = 0, finished = false, doneMarker = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const started = Date.now();
    let failure: string | undefined;
    try {
      // Admission failures above do not count; failures once dispatch begins do.
      this.onDispatch();
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: ["Bearer", this.config.apiKey].join(" ") },
        body: JSON.stringify({ model: model.id, messages, stream: true, max_tokens: HOSTED_MAX_TOKENS,
          ...(model.disable_reasoning ? {reasoning: {effort: "none"}}
            : model.reasoning_effort ? {reasoning: {effort: model.reasoning_effort}} : {}),
          // sort: among the hosts these rules allow, the fastest first. Without it OpenRouter favours the cheapest,
          // which can be slow for some models. max_price still caps what any host costs.
          provider: { data_collection: "deny", zdr: true, allow_fallbacks: false, require_parameters: true, sort: "throughput",
            max_price: { prompt: model.prompt_usd_per_mtok, completion: model.completion_usd_per_mtok, request: 0 } },
        }),
      });
      if (!response.ok) {
        const detail = scrubHostedError(await response.text().catch(() => ""), this.config.apiKey).trim().slice(0, 300);
        throw new Error(`Hosted chat failed: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`);
      }
      if (!response.body) throw new Error("chat_stream_incomplete");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = (line: string) => {
        if (!line.trim() || line.startsWith(":")) return;
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { doneMarker = true; return; }
        if (doneMarker) throw new Error("chat_stream_malformed");
        let payload;
        try { payload = JSON.parse(data); } catch { throw new Error("chat_stream_malformed"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("chat_stream_malformed");
        if (typeof payload.id === "string") usage.generation_id = scrubHostedError(payload.id, this.config.apiKey);
        if (typeof payload.provider === "string") usage.upstream_provider = scrubHostedError(payload.provider, this.config.apiKey);
        if (payload.usage) {
          const u = payload.usage;
          usage = { ...usage,
            ...(validTokens(u.prompt_tokens) ? {prompt_tokens: u.prompt_tokens} : {}),
            ...(validTokens(u.completion_tokens) ? {completion_tokens: u.completion_tokens} : {}),
            ...(validNumber(u.cost) ? {reported_cost_usd: u.cost} : {}),
          };
        }
        if (payload.error !== undefined) throw new Error("chat_stream_error");
        if (!Array.isArray(payload.choices)) throw new Error("chat_stream_malformed");
        const choice = payload.choices[0];
        if (!choice) return; // trailing usage-only chunk
        if (choice.error !== undefined || choice.delta?.tool_calls !== undefined || choice.delta?.function_call !== undefined || ["tool_calls", "function_call", "error"].includes(choice.finish_reason)) throw new Error("chat_stream_error");
        const delta = choice.delta?.content;
        if (delta !== undefined && delta !== null && typeof delta !== "string") throw new Error("chat_stream_malformed");
        if (delta) {
          if (finished) throw new Error("chat_stream_malformed");
          text += delta; chunks++; onChunk(text);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== "string" || !choice.finish_reason) throw new Error("chat_stream_malformed");
          finished = true;
        }
      };
      while (!doneMarker) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, {stream: true});
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!finished) throw new Error("chat_stream_incomplete");
    } catch (error) {
      // Transport exceptions may embed headers/URLs. Only our fixed parser and HTTP errors are surfaced.
      const reason = error instanceof Error ? error.message : "";
      failure = /^(chat_stream_(error|malformed|incomplete)$|Hosted chat failed: HTTP \d{3})/.test(reason)
        ? scrubHostedError(reason, this.config.apiKey) : "Hosted chat transport failed";
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
    const settlement = this.spend.settle(reservation, usage, failure !== undefined);
    this.onSettlement(settlement);
    const hosted = { ...usage, settled_usd: settlement.settled_usd, basis: settlement.basis };
    if (failure) throw new HostedChatError(failure, hosted);
    return { completed: true, text, hosted, tokenRate: Math.round(chunks / Math.max((Date.now() - started) / 1000, 0.001) * 10) / 10 };
  }
}
