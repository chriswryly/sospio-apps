import { parseSseEvents, type ProviderSpec } from "./types";
import { isProviderCompletionRequestUrl } from "./completionMatcher";
import { extractUserPromptFromRequestBody } from "./requestPrompt";

type UnknownRecord = Record<string, unknown>;

const CONVERSATION_ID_KEYS = ["conversation_id", "conversationId", "thread_id", "threadId", "chat_id", "chatId"];

/**
 * Grok consumer-web capture adapter.
 *
 * Grok's internal envelope has changed across releases, so parsing is strict
 * about provider/endpoint/role but tolerant about the nesting of text deltas.
 * Network capture is primary; the DOM selectors are a bounded fallback.
 */
export const grokSpec: ProviderSpec = {
  name: "grok",
  primary: "network",
  domEnabled: true,
  enabled: true,
  experimental: true,
  matches(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === "grok.com" || hostname.endsWith(".grok.com");
    } catch {
      return false;
    }
  },
  networkParser: {
    pathSafeSegments: ["rest", "app-chat", "chat", "conversation", "conversations", "response", "responses", "completion", "message", "messages"],
    isCompletionRequestUrl(url, method) {
      return isProviderCompletionRequestUrl("grok", url, method);
    },
    parseRequest(requestBody) {
      return { user_prompt: extractUserPromptFromRequestBody(requestBody) };
    },
    parseResponse(responseBody) {
      const payloads = responsePayloads(responseBody);
      let deltas = "";
      let latest = "";
      for (const payload of payloads) {
        const delta = deltaText(payload);
        if (delta) {
          deltas += delta;
        }
        const snapshot = latestRoleText(payload, "assistant") ?? responseText(payload);
        if (snapshot && snapshot.length >= latest.length) {
          latest = snapshot;
        }
      }
      const text = latest.length >= deltas.length ? latest : deltas;
      return { assistant_text: normalize(text) };
    },
    extractConversationId(url, requestBody, responseBody) {
      for (const payload of [...responsePayloads(responseBody), parseObject(requestBody)]) {
        const found = findString(payload, CONVERSATION_ID_KEYS);
        if (found) {
          return found;
        }
      }
      try {
        const segments = new URL(url).pathname.split("/").filter(Boolean);
        const index = segments.findIndex((segment) => segment === "conversations" || segment === "conversation");
        return index >= 0 ? segments[index + 1] ?? null : null;
      } catch {
        return null;
      }
    },
  },
  domSelectors: {
    conversationContainerSelector: "main",
    userMessageSelectors: [
      '[data-message-author-role="user"]',
      '[data-testid*="user" i][data-testid*="message" i]',
      '[class*="user-message" i]',
    ],
    assistantMessageSelectors: [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant" i][data-testid*="message" i]',
      '[data-testid*="response" i]',
      '[class*="assistant-message" i]',
    ],
    textSelectors: [".markdown", '[class*="markdown" i]', '[data-testid*="content" i]', "p"],
  },
};

export const grokAdapter = grokSpec;

function responsePayloads(raw: string): UnknownRecord[] {
  const events = parseSseEvents(raw);
  if (events.length > 0) {
    return events
      .filter((event) => event.data !== "[DONE]")
      .map((event) => parseObject(event.data))
      .filter((payload): payload is UnknownRecord => payload !== null);
  }
  const payload = parseObject(raw);
  return payload ? [payload] : [];
}

function responseText(payload: UnknownRecord): string | null {
  const roleText = nestedRoleText(payload, "assistant");
  if (roleText) {
    return roleText;
  }
  for (const key of ["response", "reply", "answer", "completion", "output", "message", "content", "text"]) {
    const text = latestTextUnderKey(payload, key);
    if (text) {
      return text;
    }
  }
  return null;
}

function deltaText(payload: UnknownRecord): string | null {
  const eventType = String(payload.type ?? payload.event ?? "").toLowerCase();
  for (const key of ["delta", "token", "chunk", "completion"]) {
    const text = latestTextUnderKey(payload, key);
    if (text && (key !== "completion" || eventType.includes("delta") || eventType.includes("token"))) {
      return text;
    }
  }
  const result = asRecord(payload.result);
  const response = asRecord(result?.response);
  return textValue(response?.token) ?? textValue(response?.delta);
}

function latestRoleText(payload: UnknownRecord, role: "user" | "assistant"): string | null {
  return nestedRoleText(payload, role);
}

function nestedRoleText(value: unknown, role: "user" | "assistant"): string | null {
  const candidates: string[] = [];
  collectRoleText(value, role, candidates);
  return candidates.at(-1) ?? null;
}

function collectRoleText(value: unknown, role: "user" | "assistant", candidates: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRoleText(item, role, candidates);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  const author = asRecord(record.author);
  const rawRole = String(author?.role ?? record.role ?? record.sender ?? record.source ?? "").toLowerCase();
  const matches = role === "assistant"
    ? ["assistant", "grok", "ai", "bot"].includes(rawRole)
    : ["user", "human"].includes(rawRole);
  if (matches) {
    const text = textValue(record.content) ?? textValue(record.message) ?? textValue(record.text);
    if (text) {
      candidates.push(text);
    }
  }
  for (const nested of Object.values(record)) {
    if (nested !== record.role && nested !== record.sender && nested !== record.source) {
      collectRoleText(nested, role, candidates);
    }
  }
}

function latestTextUnderKey(value: unknown, wanted: string): string | null {
  const candidates: string[] = [];
  collectTextUnderKey(value, wanted, candidates);
  return candidates.at(-1) ?? null;
}

function collectTextUnderKey(value: unknown, wanted: string, candidates: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextUnderKey(item, wanted, candidates);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  const direct = textValue(record[wanted]);
  if (direct) {
    candidates.push(direct);
  }
  for (const nested of Object.values(record)) {
    collectTextUnderKey(nested, wanted, candidates);
  }
}

function findString(value: unknown, keys: string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return normalize(value);
  if (Array.isArray(value)) {
    return normalize(value.map((item) => textValue(item) ?? "").join(""));
  }
  const record = asRecord(value);
  if (!record) return null;
  return textValue(record.text) ?? textValue(record.content) ?? textValue(record.parts);
}

function parseObject(raw: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function normalize(value: string | null | undefined): string | null {
  const text = String(value ?? "").replace(/\u00a0/g, " ").trim();
  return text && !["[done]", "done"].includes(text.toLowerCase()) ? text : null;
}
