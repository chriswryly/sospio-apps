import { parseSseEvents, type ProviderSpec } from "./types";
import { isProviderCompletionRequestUrl } from "./completionMatcher";
import { extractUserPromptFromRequestBody } from "./requestPrompt";

type UnknownRecord = Record<string, unknown>;

export const chatgptSpec: ProviderSpec = {
  name: "chatgpt",
  primary: "network",
  domEnabled: false,
  enabled: true,
  matches(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
    } catch {
      return false;
    }
  },
  networkParser: {
    pathSafeSegments: [
      "backend-api",
      "conversation",
      "responses",
      "completion",
      "message",
      "messages",
      "f",
      "c",
    ],
    isCompletionRequestUrl(url, method) {
      return isProviderCompletionRequestUrl("chatgpt", url, method);
    },
    parseRequest(requestBody) {
      return { user_prompt: extractUserPromptFromRequestBody(requestBody) };
    },
    parseResponse(responseBody) {
      const state = newDeltaState();
      const sseEvents = parseSseEvents(responseBody);
      const isSseStream = sseEvents.length > 0;
      const payloads = isSseStream ? sseEvents.map((event) => event.data) : [responseBody];
      for (const data of payloads) {
        if (data === "[DONE]") {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Not JSON at all. The capture layer also routes rendered-DOM text through this parser
          // as a fallback body, so plain text stays a valid assistant-text candidate.
          if (data.trim()) {
            state.plainText = bestText(state.plainText, data);
          }
          continue;
        }
        const payload = asRecord(parsed);
        if (!payload) {
          // A JSON scalar. Inside a stream that is protocol metadata -- the `data: "v1"` version
          // literal that opens a delta-encoded stream -- and never assistant text. A whole body
          // that is a scalar is a rendered-DOM fallback that happens to parse, such as a reply
          // consisting only of a quoted phrase, and must still be kept.
          if (!isSseStream && data.trim()) {
            state.plainText = bestText(state.plainText, data);
          }
          continue;
        }
        if (isDeltaOp(payload, state)) {
          applyDeltaOp(payload, state);
          continue;
        }
        consumeSnapshotPayload(payload, state);
      }
      const text = bestText(assembleAssistantText(state), state.plainText);
      return { assistant_text: text.trim() ? text : null };
    },
    extractConversationId(url, requestBody, responseBody) {
      for (const event of parseSseEvents(responseBody)) {
        if (event.data === "[DONE]") {
          continue;
        }
        const payload = parseObject(event.data);
        if (typeof payload?.conversation_id === "string") {
          return payload.conversation_id;
        }
        // A delta-encoded stream carries the id inside the opening `o:"add"` snapshot value.
        const nested = asRecord(payload?.v)?.conversation_id;
        if (typeof nested === "string") {
          return nested;
        }
      }
      const request = parseObject(requestBody);
      if (typeof request?.conversation_id === "string") {
        return request.conversation_id;
      }
      try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const conversationIndex = segments.indexOf("c");
        if (conversationIndex >= 0 && segments[conversationIndex + 1]) {
          return segments[conversationIndex + 1];
        }
      } catch {
        return null;
      }
      return null;
    },
  },
};

export const chatgptAdapter = chatgptSpec;

function parseObject(text: string): UnknownRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function extractAssistantMessageText(payload: UnknownRecord): string {
  const message = asRecord(payload.message) ?? asRecord(asRecord(payload.v)?.message);
  const author = asRecord(message?.author);
  if (author?.role !== "assistant") {
    return "";
  }
  return textFromContent(message?.content);
}

/**
 * ChatGPT's `v1` delta encoding, as observed on chatgpt.com/backend-api/f/conversation.
 *
 * A stream opens with `event: delta_encoding` / `data: "v1"`, then an `o:"add"` op at the root
 * path carrying the whole message object, then a run of ops that mutate it by JSON Pointer:
 *
 *   data: {"p":"/message/content/parts/0","o":"append","v":"The symbol "}
 *   data: {"v":"**⟂** is"}
 *   data: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":" used"}]}
 *
 * Three properties of that encoding defeated the previous shape-matching implementation. All are
 * reproduced by the fixtures in `__fixtures__/chatgpt_delta_encoding_v1*.response.sse`:
 *
 *  1. `p` is *sticky*. A continuation op omits it and inherits the previous op's path. The old
 *     parser required an explicit assistant-text `p` on every op, so it kept only the first
 *     chunk. Measured on 2026-07-30: a 7,841-byte body yielded the 39 characters
 *     "Test 2 received and acknowledged. Ready" out of a 70-character reply.
 *  2. `o:"patch"` batches sub-ops in an array, each with its own path. Those were never
 *     traversed, so a stream that batches its content yielded *nothing*.
 *  3. `data: "v1"` parses as a JSON string, not an object, so it fell through to the
 *     treat-as-rendered-text branch. With (2) recovering nothing, that version literal won the
 *     length contest and was recorded as the reply -- the 4-character capture in that session.
 *
 * A fourth defect followed from keying appends by pointer alone, with no notion of which message
 * they belonged to: reasoning content was spliced onto the front of the deliverable reply.
 *
 */
type DeltaState = {
  /** The sticky JSON Pointer. Empty until an op names one explicitly. */
  path: string;
  hasCursor: boolean;
  /** One entry per assistant message in the stream, in arrival order. */
  segments: MessageSegment[];
  /** Non-JSON body text (the rendered-DOM fallback the capture layer may hand us). */
  plainText: string;
};

type MessageSegment = {
  /**
   * False for messages whose content is not deliverable text -- reasoning "thoughts", recaps,
   * tool output. Their deltas must not be spliced into the reply the monitor scores.
   */
  accepted: boolean;
  /** Text carried by a full-message snapshot rather than by append ops. */
  snapshot: string;
  /** Appended text per content-part pointer, in arrival order. */
  parts: Map<string, string>;
};

const ASSISTANT_TEXT_CONTENT_TYPES = ["text", "multimodal_text", "input_text", "output_text"];

/** Map key for deltas that arrive without a JSON Pointer (older non-delta-encoded shapes). */
const INLINE_PART_KEY = "inline";

function newDeltaState(): DeltaState {
  return { path: "", hasCursor: false, segments: [], plainText: "" };
}

/**
 * An empty root pointer is still a cursor. A bare `{"v": "..."}` is only an op once a cursor exists; before that it is an unrelated
 * envelope that happens to have a `v` field, and inheriting a path for it would invent text.
 */
function isDeltaOp(payload: UnknownRecord, state: DeltaState): boolean {
  if (!("v" in payload)) {
    return false;
  }
  return typeof payload.p === "string" || typeof payload.o === "string" || state.hasCursor;
}

function applyDeltaOp(op: UnknownRecord, state: DeltaState): void {
  state.hasCursor = true;
  if (typeof op.p === "string") {
    state.path = op.p;
  }
  const path = state.path;
  const operation = typeof op.o === "string" ? op.o : "append";

  if (operation === "patch" && Array.isArray(op.v)) {
    for (const sub of op.v) {
      const record = asRecord(sub);
      if (record) {
        applyDeltaOp(record, state);
      }
    }
    return;
  }

  if (typeof op.v === "string") {
    if (!isAssistantTextPath(path)) {
      return;
    }
    if (operation === "append") {
      appendPart(state, path, op.v);
    } else {
      setPart(state, path, op.v);
    }
    return;
  }

  // An object value at the root is a whole message: the start of a new message in the stream.
  // On a metadata path it is just metadata, and carries no deliverable text.
  const message = messageFrom(op.v);
  if (message) {
    startSegment(state, message);
  }
}

/** Handles payloads that are not delta ops: full-message snapshots and older delta shapes. */
function consumeSnapshotPayload(payload: UnknownRecord, state: DeltaState): void {
  const inline = inlineDeltaText(payload);
  if (inline) {
    appendPart(state, INLINE_PART_KEY, inline);
  }
  const snapshot = extractAssistantMessageText(payload);
  if (snapshot.trim()) {
    const segment = currentSegment(state);
    if (segment.accepted) {
      // Progressive snapshots of one message: keep the fullest seen.
      segment.snapshot = bestText(segment.snapshot, snapshot);
    }
  }
}

function inlineDeltaText(payload: UnknownRecord): string {
  if (typeof payload.text === "string" && isAssistantTextPath(payload.p)) {
    return payload.text;
  }
  const delta = asRecord(payload.delta);
  if (delta) {
    if (typeof delta.text === "string") {
      return delta.text;
    }
    return textFromContent(delta.content);
  }
  return "";
}

function messageFrom(value: unknown): UnknownRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const nested = asRecord(record.message);
  if (nested) {
    return nested;
  }
  return asRecord(record.author) ? record : null;
}

function startSegment(state: DeltaState, message: UnknownRecord): void {
  const author = asRecord(message.author);
  const content = asRecord(message.content);
  const contentType = content?.content_type ?? content?.type;
  // Permissive about a missing author, strict about content type: content type is what separates
  // a deliverable reply from reasoning traces, and rejecting on an absent field is how the reply
  // got dropped in the first place.
  const accepted =
    (author?.role === undefined || author.role === "assistant") &&
    (contentType === undefined || ASSISTANT_TEXT_CONTENT_TYPES.includes(String(contentType)));
  state.segments.push({
    accepted,
    snapshot: accepted ? textFromContent(message.content) : "",
    parts: new Map(),
  });
}

function currentSegment(state: DeltaState): MessageSegment {
  const last = state.segments.at(-1);
  if (last) {
    return last;
  }
  // A stream that appends without ever sending an opening snapshot.
  const segment: MessageSegment = { accepted: true, snapshot: "", parts: new Map() };
  state.segments.push(segment);
  return segment;
}

function appendPart(state: DeltaState, key: string, text: string): void {
  const segment = currentSegment(state);
  if (!segment.accepted) {
    return;
  }
  segment.parts.set(key, (segment.parts.get(key) ?? "") + text);
}

function setPart(state: DeltaState, key: string, text: string): void {
  const segment = currentSegment(state);
  if (!segment.accepted) {
    return;
  }
  segment.parts.set(key, text);
}

function assembleAssistantText(state: DeltaState): string {
  let best = "";
  for (const segment of state.segments) {
    if (!segment.accepted) {
      continue;
    }
    const appended = [...segment.parts.values()].join("");
    best = bestText(best, bestText(segment.snapshot, appended));
  }
  return best;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  const contentRecord = asRecord(content);
  if (contentRecord) {
    const contentType = contentRecord.content_type ?? contentRecord.type;
    if (
      contentType &&
      !["text", "multimodal_text", "input_text", "output_text"].includes(String(contentType))
    ) {
      return "";
    }
    const parts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
    const partText = parts.map(textFromPart).join("");
    if (partText.trim()) {
      return partText;
    }
    return textFromPart(contentRecord);
  }
  if (Array.isArray(content)) {
    return content.map(textFromPart).join("");
  }
  return "";
}

function textFromPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  const record = asRecord(part);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  return textFromContent(record.content);
}

function isAssistantTextPath(path: unknown): boolean {
  return typeof path === "string" && path.includes("/message/content/parts");
}

function bestText(left: string, right: string): string {
  return right.trim().length > left.trim().length ? right : left;
}
