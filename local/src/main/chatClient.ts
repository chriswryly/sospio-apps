import type { HostedChatMetadata, ConversationMessage } from "../shared/types";
import type { RuntimeConfig } from "./config";

export type ChatRequest = {
  model?: string;
  messages: ConversationMessage[];
  systemPrompt: string;
};

export type StreamResult = {
  completed: true;
  hosted?: HostedChatMetadata;
  text: string;
  tokenRate?: number;
};

export type ChatPort = {
  prewarm(model: string): Promise<void>;
  streamChat(request: ChatRequest, onChunk: (text: string) => void): Promise<StreamResult>;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class ChatClient implements ChatPort {
  constructor(private config: RuntimeConfig) {}

  async prewarm(model: string): Promise<void> {
    await fetch(`${this.baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAliveValue(this.config.keepAlive),
        messages: [{ role: "user", content: "ping" }],
        options: { num_predict: 1 },
      }),
    });
  }

  async streamChat(request: ChatRequest, onChunk: (text: string) => void): Promise<StreamResult> {
    const started = Date.now();
    let chunkCount = 0;
    let text = "";
    const response = await fetch(`${this.baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model ?? this.config.chatModel,
        stream: true,
        keep_alive: keepAliveValue(this.config.keepAlive),
        messages: toChatMessages(request),
      }),
    });
    if (!response.ok || !response.body) {
      // Ollama puts the actual reason in the body; without it an HTTP 400 says
      // nothing about which field it rejected.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Ollama chat failed: HTTP ${response.status}${detail ? ` - ${detail.trim().slice(0, 300)}` : ""}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    const consume = (line: string): void => {
      if (!line.trim()) return;
      if (completed) throw new Error("chat_data_after_completion");
      const payload = JSON.parse(line) as { message?: { content?: unknown; tool_calls?: unknown }; done?: unknown; error?: unknown };
      if (!payload || typeof payload !== "object" || payload.error !== undefined || payload.message?.tool_calls !== undefined) throw new Error("chat_stream_error");
      if (typeof payload.done !== "boolean" || (payload.message?.content !== undefined && typeof payload.message.content !== "string")) throw new Error("chat_stream_malformed");
      const delta = payload.message?.content ?? "";
      if (typeof delta === "string" && delta) {
        chunkCount += 1; text += delta; onChunk(text);
      }
      completed = payload.done;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!completed) throw new Error("chat_stream_incomplete");
    const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
    return { text, completed: true, tokenRate: Math.round((chunkCount / elapsedSeconds) * 10) / 10 };
  }

  private baseUrl(): string {
    return this.config.ollamaUrl.replace(/\/$/, "");
  }
}

/**
 * Ollama parses a string `keep_alive` as a Go duration, so the "keep loaded"
 * sentinel "-1" is rejected with `time: missing unit in duration "-1"` and the
 * whole chat call fails with HTTP 400. Numeric values have to go over the wire
 * as numbers; real durations like "5m" stay strings.
 *
 * Config keeps it a string because it comes from an environment variable, so
 * the coercion belongs here, next to the request that cares.
 */
export function keepAliveValue(raw: string): string | number {
  const trimmed = raw.trim();
  const numeric = Number(trimmed);
  return trimmed !== "" && Number.isFinite(numeric) ? numeric : trimmed;
}

export function toChatMessages(request: ChatRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.systemPrompt.trim()) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  for (const message of request.messages) {
    if (message.role === "governor") continue;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}
