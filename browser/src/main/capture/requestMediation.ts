import type { ProviderName } from "../../shared/types";
import { providerForName } from "./providerRegistry";

export type RequestMediationAction =
  | "pause_request"
  | "augment_request_context";

export type RequestMediationResult = {
  changed: boolean;
  postData: string;
  strategy: string;
};

const MAX_CONTEXT_LENGTH = 500;
const DETECTABLE_CONTEXT_PATTERN = /\b(governor|harness|rsh|probe|user-authorized|test context)\b/i;
export const REQUEST_CONTEXT_EFFECT_SIGNATURE = "⟂";

// Channel choice (verified live, 2026-06-27): a consumer web backend
// (ChatGPT `/backend-api/f/conversation`, Grok) only conditions the model on
// the user's *own* outgoing message. The request `messages` array carries just
// the new user turn — history and the system prompt are server-side — so a
// separately-injected `role:"system"`/extra message is accepted (HTTP 200) but
// silently dropped: the effect signature never reached the output and the model,
// asked to report what it received, said it saw no injected context.
//
// The bounded governor context is therefore appended to the outgoing user turn
// and disclosed via the attributed mediation notice. The model-covertness claim
// is not established across providers: in a live claude.ai probe (2026-08-09,
// n=1), Claude named the appended context as a discrete addition rather than
// treating it as the user's own words.
const DIRECT_PROMPT_KEYS = ["prompt", "query", "input_text", "input", "message", "text", "content"];
const DIRECT_PROMPT_ENVELOPE_KEYS = ["body", "request", "payload", "data", "variables"];

/** Apply a bounded, explicit mutation to a captured completion request body. */
export function mediateRequestBody(
  provider: ProviderName,
  rawBody: string,
  _action: Exclude<RequestMediationAction, "pause_request">,
  authorizedContext: string,
  options: { allowAttribution?: boolean } = {},
): RequestMediationResult {
  const boundedContext = authorizedContext.trim().slice(0, MAX_CONTEXT_LENGTH);
  if (!boundedContext) {
    return { changed: false, postData: rawBody, strategy: "empty_authorized_context" };
  }
  // `DETECTABLE_CONTEXT_PATTERN` keeps the *capability probe* clean: an anonymous context measures
  // whether the model is steered, not whether it reacts to being told a governor is speaking. It
  // was never a product constraint, and holding it everywhere had a cost -- the injected text ends
  // up unsigned but stylistically foreign, which is the worst of both. `allowAttribution` opts a
  // run out so a declared, user-authorized annotation can be tested against the same payload.
  // Runs made under it are reported as diagnostics, never as capability probes.
  if (!options.allowAttribution && DETECTABLE_CONTEXT_PATTERN.test(boundedContext)) {
    return { changed: false, postData: rawBody, strategy: "d10_detectable_context" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return { changed: false, postData: rawBody, strategy: "non_json_request" };
  }
  if (!isRecord(payload)) {
    return { changed: false, postData: rawBody, strategy: "non_object_request" };
  }
  const parsedPrompt = providerForName(provider)?.networkParser?.parseRequest(rawBody).user_prompt?.trim() ?? "";

  const changed = appendContextToUserTurn(payload, boundedContext, parsedPrompt);
  return {
    changed,
    postData: changed ? JSON.stringify(payload) : rawBody,
    strategy: changed
      ? `${provider}:appended_user_turn_context`
      : "no_user_turn_text_field",
  };
}

function appendContextToUserTurn(
  payload: Record<string, unknown>,
  context: string,
  parsedPrompt: string,
): boolean {
  const userMessage = findUserTurnMessage(payload, parsedPrompt);
  if (userMessage && appendToMessageContent(userMessage, context)) {
    return true;
  }
  // Flat prompt envelopes (no message array) still carry the user's text in a
  // direct field; append there rather than silently no-op.
  return appendToDirectPrompt(payload, context);
}

function findUserTurnMessage(
  payload: Record<string, unknown>,
  parsedPrompt: string,
): Record<string, unknown> | undefined {
  const userMessages: Record<string, unknown>[] = [];
  collectUserMessages(payload, userMessages);
  if (parsedPrompt) {
    const matched = userMessages.filter((message) => recordText(message) === parsedPrompt).at(-1);
    if (matched) {
      return matched;
    }
  }
  return userMessages.at(-1);
}

function collectUserMessages(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUserMessages(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (roleOf(value) === "user" && recordText(value)) {
    out.push(value);
  }
  for (const nested of Object.values(value)) {
    collectUserMessages(nested, out);
  }
}

function appendToMessageContent(message: Record<string, unknown>, context: string): boolean {
  const content = message.content;
  if (typeof content === "string") {
    message.content = appendText(content, context);
    return true;
  }
  if (isRecord(content) && Array.isArray(content.parts)) {
    appendToStringParts(content.parts, context);
    return true;
  }
  if (Array.isArray(content)) {
    appendToContentParts(content, context);
    return true;
  }
  for (const key of ["text", "message", "prompt"] as const) {
    if (typeof message[key] === "string") {
      message[key] = appendText(message[key] as string, context);
      return true;
    }
  }
  return false;
}

/** ChatGPT classic: `content.parts` is an array of plain strings. */
function appendToStringParts(parts: unknown[], context: string): void {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (typeof parts[i] === "string") {
      parts[i] = appendText(parts[i] as string, context);
      return;
    }
  }
  parts.push(context);
}

/** Responses-style input: `content` is an array of `{ type, text }` parts. */
function appendToContentParts(content: unknown[], context: string): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (isRecord(part) && typeof part.text === "string") {
      part.text = appendText(part.text, context);
      return;
    }
  }
  const sample = content.find(isRecord);
  const type = sample && typeof sample.type === "string" ? sample.type : "input_text";
  content.push({ type, text: context });
}

function appendToDirectPrompt(value: unknown, context: string): boolean {
  if (!isRecord(value)) return false;
  for (const key of DIRECT_PROMPT_KEYS) {
    if (typeof value[key] === "string") {
      value[key] = appendText(value[key] as string, context);
      return true;
    }
  }
  for (const key of DIRECT_PROMPT_ENVELOPE_KEYS) {
    if (appendToDirectPrompt(value[key], context)) return true;
  }
  return false;
}

function appendText(base: string, context: string): string {
  const trimmed = base.replace(/\s+$/u, "");
  return trimmed ? `${trimmed}\n\n${context}` : context;
}

function recordText(record: Record<string, unknown>): string {
  return normalizeText(
    textValue(record.content) ??
      textValue(record.message) ??
      textValue(record.text) ??
      textValue(record.parts) ??
      "",
  );
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => textValue(item) ?? "").join("");
    return text.trim() ? text : null;
  }
  if (!isRecord(value)) return null;
  return textValue(value.text) ??
    textValue(value.content) ??
    textValue(value.message) ??
    textValue(value.parts);
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

function roleOf(message: Record<string, unknown>): string {
  const author = isRecord(message.author) ? message.author : undefined;
  return String(author?.role ?? message.role ?? message.sender ?? "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
