import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safePath } from "../../../records/recordsRetention";
import type { ProviderName, TurnEvent } from "../shared/types";
import { conversationIdFromUrl, providerFromNavigation } from "./conversationSurface";
import { buildTerminateExchangeScript, removeGovernorNoticeScript } from "./interventionExecutor";
import { BROWSER_GOVERNOR_TERMINATE_EXCHANGE_TEXT } from "./governorLoop";

type ClosingTurn = { provider: ProviderName; session_id: string | null; turn_id: string };

type ClosedConversation = {
  provider: ProviderName;
  conversation_id: string;
  governing_turn_id: string;
  closed_at: string;
};

/** Read through on every lookup so retention and Delete recorded conversations take effect immediately. */
export class ClosedConversations {
  readonly path: string;
  constructor(private directory: string, private diagnostic: (message: string) => void) {
    this.path = join(directory, "closed-conversations.jsonl");
  }
  has(provider: ProviderName, id: string | null): boolean {
    if (!id || !existsSync(safePath(this.path))) return false;
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).some(line => {
      // A line cut short by a crash must not stop the governor on every later turn.
      let record: ClosedConversation;
      try { record = JSON.parse(line) as ClosedConversation; } catch { return false; }
      return record.provider === provider && record.conversation_id === id;
    });
  }
  record(turn: ClosingTurn): void {
    if (!turn.session_id) {
      this.diagnostic("closed conversation: missing conversation ID; close not persisted");
      return;
    }
    if (this.has(turn.provider, turn.session_id)) return;
    mkdirSync(safePath(this.directory), { recursive: true });
    const record: ClosedConversation = {provider: turn.provider, conversation_id: turn.session_id,
      governing_turn_id: turn.turn_id, closed_at: new Date().toISOString()};
    appendFileSync(safePath(this.path), JSON.stringify(record) + "\n", {mode: 0o600});
  }
  async applyClose<T>(turn: ClosingTurn | undefined, apply: () => Promise<T>): Promise<T> {
    const result = await apply();
    if (turn) this.record(turn);
    else this.diagnostic("closed conversation: no governing turn; close not persisted");
    return result;
  }
  skipTurn(turn: Pick<TurnEvent, "provider" | "session_id">): boolean {
    if (!this.has(turn.provider, turn.session_id)) return false;
    this.diagnostic("closed conversation: captured turn ignored by governor");
    return true;
  }
  async runIfOpen(turn: Pick<TurnEvent, "provider" | "session_id">, run: () => Promise<void>): Promise<void> {
    if (!this.skipTurn(turn)) await run();
  }
  /** One page operation avoids an asynchronous release racing with a re-close. */
  async enter(url: string, release: boolean, execute: (script: string) => Promise<unknown>): Promise<void> {
    const provider = providerFromNavigation(url);
    const closed = provider && this.has(provider, conversationIdFromUrl(url));
    if (!release && !closed) return;
    const script = `(() => {
      if (location.href !== ${JSON.stringify(url)}) return false;
      ${release ? removeGovernorNoticeScript() + ";" : ""}
      ${closed ? buildTerminateExchangeScript(provider, BROWSER_GOVERNOR_TERMINATE_EXCHANGE_TEXT, 0) + ";" : ""}
      return true;
    })()`;
    const applied = await execute(script);
    if (closed && applied) this.diagnostic("closed conversation: restored overlay and composer lock");
  }
}
