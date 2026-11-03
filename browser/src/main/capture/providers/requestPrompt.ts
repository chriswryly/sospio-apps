type UnknownRecord = Record<string, unknown>;

const DIRECT_PROMPT_KEYS = ["prompt", "query", "input_text", "input", "message", "text", "content"];
const DIRECT_PROMPT_ENVELOPE_KEYS = ["body", "request", "payload", "data", "variables"];

export function extractUserPromptFromRequestBody(rawBody: string): string | null {
  const payload = parseObject(rawBody);
  if (!payload) {
    return null;
  }
  return latestRoleText(payload, "user") ?? latestDirectText(payload, DIRECT_PROMPT_KEYS);
}

export function requestPromptExtractorShimSource(): string {
  return [
    `const RSH_DIRECT_PROMPT_KEYS = ${JSON.stringify(DIRECT_PROMPT_KEYS)};`,
    `const RSH_DIRECT_PROMPT_ENVELOPE_KEYS = ${JSON.stringify(DIRECT_PROMPT_ENVELOPE_KEYS)};`,
    isRecord.toString(),
    asRecord.toString(),
    parseObject.toString(),
    normalize.toString(),
    textFromContent.toString(),
    latestRoleText.toString(),
    collectRoleText.toString(),
    latestDirectText.toString(),
    `function rshExtractUserPrompt(rawBody) {
      const payload = parseObject(rawBody);
      if (!payload) return "";
      return latestRoleText(payload, "user") || latestDirectText(payload, RSH_DIRECT_PROMPT_KEYS, RSH_DIRECT_PROMPT_ENVELOPE_KEYS) || "";
    }`,
  ].join("\n");
}

function latestRoleText(value: unknown, role: "user" | "assistant"): string | null {
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
  if (!isRecord(value)) {
    return;
  }
  const author = isRecord(value.author) ? value.author : undefined;
  const rawRole = String(author?.role ?? value.role ?? value.sender ?? value.source ?? "").toLowerCase();
  const matches = role === "assistant"
    ? ["assistant", "grok", "ai", "bot"].includes(rawRole)
    : ["user", "human"].includes(rawRole);
  if (matches) {
    const text = textFromContent(value.content) ||
      textFromContent(value.message) ||
      textFromContent(value.text) ||
      textFromContent(value.parts);
    if (text) {
      candidates.push(text);
    }
  }
  for (const nested of Object.values(value)) {
    collectRoleText(nested, role, candidates);
  }
}

function latestDirectText(value: unknown, keys: string[], envelopeKeys = DIRECT_PROMPT_ENVELOPE_KEYS): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const text = textFromContent(value[key]);
    if (text) {
      return text;
    }
  }
  for (const key of envelopeKeys) {
    const text = latestDirectText(value[key], keys, envelopeKeys);
    if (text) {
      return text;
    }
  }
  return null;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return normalize(content);
  }
  if (Array.isArray(content)) {
    return normalize(content.map((item) => textFromContent(item) ?? "").join(""));
  }
  if (!isRecord(content)) {
    return null;
  }
  const contentType = content.content_type ?? content.type;
  if (
    contentType &&
    !["text", "multimodal_text", "input_text", "output_text"].includes(String(contentType))
  ) {
    return null;
  }
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const partText = normalize(parts.map((part) => textFromContent(part) ?? "").join(""));
  if (partText) {
    return partText;
  }
  return textFromContent(content.text) ??
    textFromContent(content.content) ??
    textFromContent(content.message);
}

function parseObject(text: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalize(value: string | null | undefined): string | null {
  const text = String(value ?? "").replace(/\u00a0/g, " ").trim();
  return text ? text : null;
}
