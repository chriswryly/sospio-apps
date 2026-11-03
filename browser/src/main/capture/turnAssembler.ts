import { randomUUID } from "node:crypto";
import type { ProviderSpec } from "./providers/types";
import { describeBodyShape } from "./bodyShape";
import { sanitizeNetworkUrl } from "./urlRedaction";
import type { ParserDiagnostic, SessionSource, TurnEvent } from "../../shared/types";

type PendingTurn = {
  turn_id: string;
  requestId: string;
  raw_request_url: string;
  request_url: string;
  started_at: string;
  provider: ProviderSpec;
  user_prompt: string;
  conversation_id_hint: string | null;
};

export class TurnAssembler {
  private pending = new Map<string, PendingTurn>();

  start(requestId: string, requestUrl: string, requestBody: string, provider: ProviderSpec): ParserDiagnostic | null {
    const parser = provider.networkParser;
    if (!parser) {
      return diagnostic("parse_error", requestId, provider.name, "provider has no network parser");
    }
    const userPrompt = parser.parseRequest(requestBody).user_prompt;
    if (!userPrompt) {
      // Annotate with the body's key shape (paths and types only, never values) in a separate
      // field — `reason` stays stable because dedup keys and windows compare on it. Without the
      // shape this diagnostic says a prompt could not be found but not what the envelope looked
      // like, which is what left the browser Grok pass undiagnosable: no user turn registered, so
      // no armed mechanism could bind, and no record of which key now holds the prompt.
      return {
        ...diagnostic("skipped", requestId, provider.name, "completion request was not a plain user-text turn"),
        body_shape: describeBodyShape(requestBody),
        request_path: new URL(sanitizeNetworkUrl(requestUrl, parser)).pathname,
      };
    }
    this.pending.set(requestId, {
      turn_id: randomUUID(),
      requestId,
      raw_request_url: requestUrl,
      request_url: sanitizeNetworkUrl(requestUrl, parser),
      started_at: new Date().toISOString(),
      provider,
      user_prompt: userPrompt,
      conversation_id_hint: parser.extractConversationId(requestUrl, requestBody, ""),
    });
    return null;
  }

  /**
   * `responseBody` is the body chosen for display text, which for ChatGPT may be rendered screen
   * text with no conversation ID in it. `idSources` are the raw network bodies, searched first
   * for the ID so a display-source choice cannot orphan a new chat's first turn.
   */
  finish(
    requestId: string,
    responseBody: string,
    idSources: readonly string[] = [],
  ): { turn?: TurnEvent; diagnostic?: ParserDiagnostic } {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return {};
    }
    this.pending.delete(requestId);
    try {
      const parser = pending.provider.networkParser;
      if (!parser) {
        return {
          diagnostic: diagnostic("parse_error", requestId, pending.provider.name, "provider has no network parser"),
        };
      }
      const assistantText = parser.parseResponse(responseBody).assistant_text;
      if (!assistantText) {
        return {
          diagnostic: diagnostic("skipped", requestId, pending.provider.name, "response did not contain plain assistant text"),
        };
      }
      let sessionId: string | null = null;
      let sessionSource: SessionSource = "turn_id_fallback";
      for (const source of idSources) {
        if (!source.trim()) continue;
        sessionId = parser.extractConversationId(pending.raw_request_url, "", source);
        if (sessionId) {
          sessionSource = "network_response";
          break;
        }
      }
      if (!sessionId) {
        sessionId = parser.extractConversationId(pending.raw_request_url, "", responseBody);
        if (sessionId) sessionSource = "display_body";
      }
      if (!sessionId && pending.conversation_id_hint) {
        sessionId = pending.conversation_id_hint;
        sessionSource = "request_hint";
      }
      return {
        turn: {
          turn_id: pending.turn_id,
          session_id: sessionId ?? pending.turn_id,
          session_source: sessionSource,
          provider: pending.provider.name,
          user_prompt: pending.user_prompt,
          assistant_text: assistantText,
          started_at: pending.started_at,
          completed_at: new Date().toISOString(),
          request_url: pending.request_url,
        },
      };
    } catch (error) {
      return {
        diagnostic: diagnostic(
          "parse_error",
          requestId,
          pending.provider.name,
          error instanceof Error ? error.message : "unknown parser error",
        ),
      };
    }
  }

  syntheticTurn(requestId: string, assistantText: string): TurnEvent | null {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return null;
    }
    return {
      turn_id: pending.turn_id,
      session_id: pending.conversation_id_hint ?? pending.turn_id,
      session_source: pending.conversation_id_hint ? "request_hint" : "turn_id_fallback",
      provider: pending.provider.name,
      user_prompt: pending.user_prompt,
      assistant_text: assistantText,
      started_at: pending.started_at,
      completed_at: new Date().toISOString(),
      request_url: pending.request_url,
    };
  }

  fail(requestId: string, reason: string): ParserDiagnostic | null {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return null;
    }
    this.pending.delete(requestId);
    return diagnostic("loading_failed", requestId, pending.provider.name, reason);
  }
}

function diagnostic(
  kind: ParserDiagnostic["kind"],
  requestId: string,
  provider: ParserDiagnostic["provider"],
  reason: string,
): ParserDiagnostic {
  return {
    id: randomUUID(),
    kind,
    provider,
    requestId,
    reason,
    timestamp: new Date().toISOString(),
  };
}
