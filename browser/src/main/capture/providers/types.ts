import type { ProviderName } from "../../../shared/types";

export type TurnFields = {
  user_prompt: string;
  assistant_text: string;
  conversation_id: string | null;
};

export type NetworkRequestParse = {
  user_prompt: string | null;
};

export type NetworkResponseParse = {
  assistant_text: string | null;
};

export interface NetworkParser {
  isCompletionRequestUrl(url: string, method: string): boolean;
  parseRequest(rawBody: string): NetworkRequestParse;
  parseResponse(rawBody: string): NetworkResponseParse;
  extractConversationId(url: string, requestBody: string, responseBody: string): string | null;
  pathSafeSegments?: ReadonlyArray<string>;
}

export interface DomSelectors {
  conversationContainerSelector: string;
  userMessageSelectors: ReadonlyArray<string>;
  assistantMessageSelectors: ReadonlyArray<string>;
  textSelectors?: ReadonlyArray<string>;
  completeSelectors?: ReadonlyArray<string>;
}

export interface ProviderSpec {
  name: ProviderName;
  primary: "network" | "dom";
  networkParser?: NetworkParser;
  domSelectors?: DomSelectors;
  domEnabled: boolean;
  enabled: boolean;
  experimental?: boolean;
  matches(url: string): boolean;
}

export function parseSseEvents(responseBody: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of responseBody.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const lines = block.split("\n");
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
  }
  return events;
}

// URL redaction lives in ../urlRedaction.ts, shared with the main-log path.
