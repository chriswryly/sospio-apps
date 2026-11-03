import { parseSseEvents, type ProviderSpec } from "./types";

type UnknownRecord = Record<string, unknown>;

const COMPLETION_PATH_RE = /\/(api\/)?(chat|talk|conversation|completion|message|messages)\b/i;
const USER_TEXT_KEYS = ["prompt", "text", "message", "input", "query", "content"];
const ASSISTANT_TEXT_KEYS = ["text", "message", "content", "response", "reply", "answer", "completion", "output"];
const CONVERSATION_ID_KEYS = ["conversation_id", "conversationId", "thread_id", "threadId", "chat_id", "chatId"];

export const piaiSpec: ProviderSpec = {
  name: "piai",
  primary: "network",
  domEnabled: false,
  enabled: false,
  experimental: true,
  matches(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "pi.ai" || parsed.hostname.endsWith(".pi.ai");
    } catch {
      return false;
    }
  },
  networkParser: {
    pathSafeSegments: ["api", "chat", "talk", "conversation", "conversations", "completion", "message", "messages"],
    isCompletionRequestUrl(url, method) {
      if (method.toUpperCase() !== "POST") {
        return false;
      }
      try {
        const parsed = new URL(url);
        return (parsed.hostname === "pi.ai" || parsed.hostname.endsWith(".pi.ai")) &&
          COMPLETION_PATH_RE.test(parsed.pathname);
      } catch {
        return false;
      }
    },
    parseRequest(requestBody) {
      const payload = parseObject(requestBody);
      if (!payload) {
        return { user_prompt: null };
      }
      const fromMessages = textFromLastRoleMessage(payload, "user");
      return { user_prompt: normalizeText(fromMessages || findTextByKeys(payload, USER_TEXT_KEYS)) };
    },
    parseResponse(responseBody) {
      const payloads = parsePayloads(responseBody);
      if (payloads.length === 0) {
        return { assistant_text: normalizeText(responseBody) };
      }
      let deltas = "";
      let latest = "";
      for (const payload of payloads) {
        const delta = extractDeltaText(payload);
        if (delta && isSubstantiveText(delta)) {
          deltas += delta;
        }
        const text = textFromLastRoleMessage(payload, "assistant") ||
          latestAssistantCandidate(payload) ||
          directResponseText(payload);
        if (text) {
          latest = text;
        }
      }
      const text = bestText(latest, deltas);
      return { assistant_text: normalizeText(text) };
    },
    extractConversationId(url, requestBody, responseBody) {
      const response = parseObject(responseBody);
      const request = parseObject(requestBody);
      return findStringByKeys(response, CONVERSATION_ID_KEYS) ??
        findStringByKeys(request, CONVERSATION_ID_KEYS) ??
        conversationIdFromUrl(url);
    },
  },
};

export const piaiAdapter = piaiSpec;

function textFromLastRoleMessage(payload: UnknownRecord, role: "user" | "assistant"): string | null {
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.conversation)
      ? payload.conversation
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== role) {
      continue;
    }
    const text = textFromContent(message.content) || findTextByKeys(message, USER_TEXT_KEYS);
    if (text) {
      return text;
    }
  }
  return null;
}

function latestAssistantCandidate(value: unknown): string | null {
  const candidates: string[] = [];
  collectRoleText(value, "assistant", candidates);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeText(candidates[index]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
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
  if (recordRole(record) === role) {
    const text = textFromContent(record.content) ||
      textFromContent(record.text) ||
      textFromContent(record.message) ||
      textFromContent(record.parts);
    if (text) {
      candidates.push(text);
    }
  }
  for (const key of ["message", "messages", "conversation", "response", "reply", "result", "data", "output"]) {
    collectRoleText(record[key], role, candidates);
  }
}

function recordRole(record: UnknownRecord): "user" | "assistant" | null {
  const author = asRecord(record.author);
  const rawRole = String(author?.role ?? record.role ?? record.sender ?? record.source ?? "").toLowerCase();
  if (["assistant", "ai", "bot", "pi"].includes(rawRole)) {
    return "assistant";
  }
  if (["user", "human"].includes(rawRole)) {
    return "user";
  }
  return null;
}

function extractDeltaText(payload: UnknownRecord): string | null {
  const delta = asRecord(payload.delta);
  const deltaText = findTextByKeys(delta, ASSISTANT_TEXT_KEYS);
  if (deltaText) {
    return deltaText;
  }
  return latestRawTextUnderKeys(payload, ["delta", "chunk", "completion", "content_block_delta"]);
}

function directResponseText(payload: UnknownRecord): string | null {
  const direct = findTextByKeys(payload, ASSISTANT_TEXT_KEYS);
  if (direct && isSubstantiveText(direct)) {
    return direct;
  }
  return latestTextUnderKeys(payload, ["response", "reply", "answer", "completion", "output", "result", "data"]);
}

function latestTextUnderKeys(value: unknown, keys: string[]): string | null {
  const candidates: string[] = [];
  collectTextUnderKeys(value, keys, candidates);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeText(candidates[index]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function latestRawTextUnderKeys(value: unknown, keys: string[]): string | null {
  const candidates: string[] = [];
  collectTextUnderKeys(value, keys, candidates);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (isSubstantiveText(candidates[index])) {
      return candidates[index];
    }
  }
  return null;
}

function collectTextUnderKeys(value: unknown, keys: string[], candidates: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextUnderKeys(item, keys, candidates);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of keys) {
    const text = textFromContent(record[key]);
    if (text) {
      candidates.push(text);
    }
  }
  for (const nested of Object.values(record)) {
    collectTextUnderKeys(nested, keys, candidates);
  }
}

function findTextByKeys(record: UnknownRecord | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const text = textFromContent(record[key]);
    if (text) {
      return text;
    }
  }
  return null;
}

function findStringByKeys(record: UnknownRecord | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content.map((part) => textFromContent(part) ?? "").join("");
    return text.trim() ? text : null;
  }
  const record = asRecord(content);
  if (!record) {
    return null;
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content;
  }
  const nestedContent = textFromContent(record.content);
  if (nestedContent) {
    return nestedContent;
  }
  return null;
}

function normalizeText(text: string | null): string | null {
  if (!text?.trim()) {
    return null;
  }
  const repaired = repairMojibake(text);
  const normalized = repaired.trim();
  if (!isSubstantiveText(normalized)) {
    return null;
  }
  return normalized;
}

function isSubstantiveText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || UI_CHROME_TEXT.has(normalized.toLowerCase())) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(normalized);
}

function repairMojibake(text: string): string {
  if (!/[ÃÂâð][\u0080-\u017f\u02c6-\u02dc\u2018-\u201e\u2020-\u2026]/.test(text)) {
    return text;
  }
  const repaired = Buffer.from(Array.from(text, windows1252Byte)).toString("utf8");
  if (!repaired || repaired.includes("\uFFFD")) {
    return text;
  }
  return repaired;
}

function windows1252Byte(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  const mapped = WINDOWS_1252_REVERSE.get(code);
  return mapped ?? code & 0xff;
}

const WINDOWS_1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

function conversationIdFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
      ["chat", "talk", "conversation", "conversations"].includes(segment),
    );
    return markerIndex >= 0 ? segments[markerIndex + 1] ?? null : null;
  } catch {
    return null;
  }
}

function parseObject(text: string): UnknownRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parsePayloads(responseBody: string): UnknownRecord[] {
  const sseEvents = parseSseEvents(responseBody);
  if (sseEvents.length > 0) {
    return sseEvents
      .filter((event) => event.data !== "[DONE]")
      .map((event) => parseObject(event.data))
      .filter((payload): payload is UnknownRecord => payload !== null);
  }
  const whole = parseObject(responseBody);
  if (whole) {
    return [whole];
  }
  return responseBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseObject(line.replace(/^data:\s*/, "")))
    .filter((payload): payload is UnknownRecord => payload !== null);
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function bestText(left: string, right: string): string {
  return right.trim().length > left.trim().length ? right : left;
}

const UI_CHROME_TEXT = new Set([
  "copy",
  "copied",
  "dislike",
  "like",
  "bad response",
  "good response",
  "more options",
  "regenerate",
  "retry",
  "share",
]);
