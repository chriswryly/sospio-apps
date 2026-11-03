import type { WebContents } from "electron";
import { ipcMain } from "electron";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ParserDiagnostic, TurnEvent } from "../../shared/types";
import type { ProviderSpec } from "./providers/types";

export type DomObserverEvents = {
  turn: [TurnEvent];
  diagnostic: [ParserDiagnostic];
};

type DomObserverPayload = {
  kind: "ready" | "diagnostic" | "user_turn" | "assistant_complete";
  provider?: string;
  text?: string;
  final_text?: string;
  dom_id?: string;
  url?: string;
  reason?: string;
  occurred_at?: string;
};

type PendingDomTurn = {
  turn_id: string;
  session_id: string;
  provider: TurnEvent["provider"];
  user_prompt: string;
  started_at: string;
};

export class DomObserverBridge extends EventEmitter<DomObserverEvents> {
  private installed = false;
  private pendingByWebContents = new Map<number, PendingDomTurn>();
  private onEvent = (event: Electron.IpcMainEvent, payload: unknown) => {
    const record = asRecord(payload);
    if (record) this.handlePayload(event.sender.id, record);
  };
  hasPending(): boolean { return this.pendingByWebContents.size > 0; }
  forget(webContentsId: number): void { this.pendingByWebContents.delete(webContentsId); }
  dispose(): void {
    if (this.installed) ipcMain.off("harness:dom-event", this.onEvent);
    this.installed = false; this.pendingByWebContents.clear(); this.removeAllListeners();
  }

  configure(webContents: WebContents, provider: ProviderSpec | undefined): void {
    this.install();
    if (!provider?.domEnabled || !provider.domSelectors) {
      webContents.send("harness:dom-observer-config", { enabled: false });
      return;
    }
    webContents.send("harness:dom-observer-config", {
      enabled: true,
      provider: provider.name,
      selectors: provider.domSelectors,
    });
  }

  private install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    ipcMain.on("harness:dom-event", this.onEvent);
  }

  private handlePayload(webContentsId: number, payload: Record<string, unknown>): void {
    const kind = payload.kind;
    if (kind === "diagnostic") {
      this.emit("diagnostic", diagnostic(payload, "parse_error"));
      return;
    }
    if (kind === "user_turn") {
      const provider = providerName(payload.provider);
      const userPrompt = stringField(payload.text);
      if (!provider || !userPrompt) {
        this.emit("diagnostic", diagnostic(payload, "skipped", "DOM user turn lacked provider or text"));
        return;
      }
      this.pendingByWebContents.set(webContentsId, {
        turn_id: randomUUID(),
        session_id: stringField(payload.url) ?? provider,
        provider,
        user_prompt: userPrompt,
        started_at: stringField(payload.occurred_at) ?? new Date().toISOString(),
      });
      return;
    }
    if (kind === "assistant_complete") {
      const pending = this.pendingByWebContents.get(webContentsId);
      const assistantText = stringField(payload.final_text) ?? stringField(payload.text);
      if (!pending || !assistantText) {
        this.emit("diagnostic", diagnostic(payload, "skipped", "DOM assistant completion had no pending user turn"));
        return;
      }
      this.pendingByWebContents.delete(webContentsId);
      this.emit("turn", {
        turn_id: pending.turn_id,
        session_id: pending.session_id,
        provider: pending.provider,
        user_prompt: pending.user_prompt,
        assistant_text: assistantText,
        started_at: pending.started_at,
        completed_at: stringField(payload.occurred_at) ?? new Date().toISOString(),
        request_url: stringField(payload.url) ?? "dom://unknown",
      });
    }
  }
}

function diagnostic(
  payload: Record<string, unknown>,
  kind: ParserDiagnostic["kind"],
  reason = stringField(payload.reason) ?? "DOM observer event failed",
): ParserDiagnostic {
  return {
    id: randomUUID(),
    kind,
    provider: providerName(payload.provider),
    requestId: stringField(payload.dom_id),
    reason,
    timestamp: stringField(payload.occurred_at) ?? new Date().toISOString(),
  };
}

function providerName(value: unknown): TurnEvent["provider"] | undefined {
  return value === "chatgpt" || value === "claudeai" || value === "grok" || value === "piai"
    ? value
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
