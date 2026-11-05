import type { ParserDiagnostic } from "../../shared/types";

// Path segments are redacted unless they are on the allow-list or look like an endpoint or RPC
// name: letters with dots, underscores or hyphens, no digits, at most 64 characters. Account,
// organization and conversation ids carry digits, so they stay redacted; new endpoint names
// such as `ConversationService/SendMessage` stay readable, which is what this log is for.
const SAFE_SEGMENTS = new Set([
  "api", "organizations", "chat_conversations", "completion", "claudeai-rpc",
  "anthropic.bard.api.v1alpha.ConversationService", "PerformAction",
]);
const NAME_SEGMENT = /^[A-Za-z][A-Za-z._-]{0,63}$/;
export const CLAUDE_NO_REQUEST_WAIT_MS = 5_000;

export class ClaudeDiagnostics {
  private counts = new Map<string, number>();
  private pending = new Map<object, ReturnType<typeof setTimeout>>();
  private reportedSilence = false;

  constructor(private emit: (diagnostic: ParserDiagnostic) => void) {}

  unmatched(url: string, method: string, streaming = false): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.hostname !== "claude.ai" || (method.toUpperCase() !== "POST" && !streaming)) return;
    const safeMethod = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method.toUpperCase())
      ? method.toUpperCase() : "OTHER";
    const path = parsed.pathname.split("/").map(segment =>
      !segment || SAFE_SEGMENTS.has(segment) || NAME_SEGMENT.test(segment) ? segment : "[redacted]").join("/");
    const reason = `unmatched Claude endpoint: method=${safeMethod} host=claude.ai path=${path} streaming=${streaming}`;
    const count = this.counts.get(reason) ?? 0;
    if (count >= 3 || (!this.counts.has(reason) && this.counts.size >= 100)) return;
    this.counts.set(reason, count + 1);
    this.report(reason);
  }

  userSend(target: object, isClaude: () => boolean): void {
    if (this.reportedSilence || this.pending.has(target) || !isClaude()) return;
    this.pending.set(target, setTimeout(() => {
      this.pending.delete(target);
      if (this.reportedSilence || !isClaude()) return;
      this.reportedSilence = true;
      this.report("Claude page target saw no request within 5000ms after user send");
    }, CLAUDE_NO_REQUEST_WAIT_MS));
  }

  // Only claude.ai's own POST or streaming traffic counts as "the send was seen". The page also
  // fires analytics requests every second or so, which must not cancel the silence report.
  request(target: object, url: string, method: string, streaming = false): void {
    try {
      if (new URL(url).hostname !== "claude.ai") return;
    } catch {
      return;
    }
    if (method.toUpperCase() !== "POST" && !streaming) return;
    const timer = this.pending.get(target);
    if (timer) clearTimeout(timer);
    this.pending.delete(target);
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private report(reason: string): void {
    this.emit({ id: "claude-capture-diagnostic", kind: "measurement", provider: "claudeai",
      reason, timestamp: new Date().toISOString() });
  }
}
