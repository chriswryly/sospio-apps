import { turnSelectorsFor } from "../providerDomSelectors";
import { parseSseEvents, type ProviderSpec } from "./types";
import { isProviderCompletionRequestUrl } from "./completionMatcher";
import { extractUserPromptFromRequestBody } from "./requestPrompt";

type UnknownRecord = Record<string, unknown>;

const COMPLETION_RE =
  /^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion$/;

export const claudeaiSpec: ProviderSpec = {
  name: "claudeai",
  primary: "dom",
  domEnabled: true,
  domSelectors: {
    conversationContainerSelector: "main",
    userMessageSelectors: turnSelectorsFor("claudeai").user,
    assistantMessageSelectors: turnSelectorsFor("claudeai").assistant,
  },
  enabled: true,
  matches(url) {
    try {
      return new URL(url).hostname === "claude.ai";
    } catch {
      return false;
    }
  },
  networkParser: {
    pathSafeSegments: ["api", "organizations", "chat_conversations", "completion"],
    isCompletionRequestUrl(url, method) {
      return isProviderCompletionRequestUrl("claudeai", url, method);
    },
    parseRequest(requestBody) {
      return { user_prompt: extractUserPromptFromRequestBody(requestBody) };
    },
    parseResponse(responseBody) {
      let deltaText = "";
      let latestSnapshot = "";
      const sseEvents = parseSseEvents(responseBody);
      const payloads = sseEvents.length > 0
        ? sseEvents.map((event) => parseObject(event.data))
        : [parseObject(responseBody)];
      for (const payload of payloads) {
        if (!payload) {
          continue;
        }
        deltaText += extractDeltaText(payload);
        const snapshotText = extractSnapshotText(payload);
        if (snapshotText) {
          latestSnapshot = snapshotText;
        }
      }
      const text = deltaText || latestSnapshot;
      return { assistant_text: text.trim() ? text : null };
    },
    extractConversationId(url) {
      try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(COMPLETION_RE);
        return match?.[1] ?? null;
      } catch {
        return null;
      }
    },
  },
};

export const claudeaiAdapter = claudeaiSpec;

function parseObject(text: string): UnknownRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : null;
  } catch {
    return null;
  }
}

function extractDeltaText(payload: UnknownRecord): string {
  if (payload.type === "completion" && typeof payload.completion === "string") {
    return payload.completion;
  }
  if (typeof payload.completion === "string") {
    return payload.completion;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  const delta = asRecord(payload.delta);
  if (delta && typeof delta.text === "string") {
    return delta.text;
  }
  const contentBlock = asRecord(payload.content_block);
  if (contentBlock?.type === "text" && typeof contentBlock.text === "string") {
    return contentBlock.text;
  }
  return "";
}

function extractSnapshotText(payload: UnknownRecord): string {
  const message = asRecord(payload.message);
  const messageText = textFromContent(message?.content);
  if (messageText) {
    return messageText;
  }
  return textFromContent(payload.content);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .join("");
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}
