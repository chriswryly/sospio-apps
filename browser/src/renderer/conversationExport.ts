import { stateForSharing } from "../shared/emotionalDependencePrivacy";
import type { HarnessState, GovernorActionRecord } from "../shared/types";
export type ExportMeta = { exported_at: string; surface: "electron" | "web"; app_version: string };

function scopedTurns(state: HarnessState) {
  const session = state.turns.at(-1)?.turn.session_id;
  return state.turns.filter(record => record.turn.session_id === session);
}
function noticeText(receipt: GovernorActionRecord): string | undefined {
  const text = receipt.presented_text, original = receipt.original_candidate_text;
  return text && original && text.endsWith("\n\n" + original) ? text.slice(0, -original.length - 2) : text;
}
export function browserTranscriptText(state: HarnessState): string {
  state = stateForSharing(state);
  const lines: string[] = [];
  for (const {turn, governorActions} of scopedTurns(state)) {
    lines.push(`You: ${turn.user_prompt}`, `Assistant: ${turn.assistant_text}`);
    for (const receipt of governorActions ?? []) {
      if (receipt.pooled_notice) {
        if (receipt.pooled_notice.kind !== "suppressed") lines.push(`Sospio: ${receipt.pooled_notice.text}`);
        continue;
      }
      if (receipt.executions.some(e => e.status === "applied" && ["display_governor_notice", "terminate_exchange"].includes(e.mechanism))) {
        const text = noticeText(receipt);
        if (text) lines.push(`Sospio: ${text}`);
      }
      const note = receipt.executions.find(e => e.mechanism === "augment_request_context");
      if (note && (receipt.tier === 2 || receipt.tier === 3)) {
        const status = note.status === "applied" ? "added" : note.status === "armed" ? "queued" : "not added";
        for (const text of receipt.context_additions ?? []) lines.push(`Sospio (note for your next message, ${status}): ${text}`);
      }
    }
  }
  return lines.join("\n\n");
}
export function buildConversationExport(state: HarnessState, meta: ExportMeta) {
  state = stateForSharing(state);
  const turns = scopedTurns(state);
  const receipts = turns.flatMap(record => record.governorActions ?? []);
  const ladders = turns.flatMap(record => record.verdict?.judge_ladder ? [record.verdict.judge_ladder] : []);
  return {
    schema: "sospio_conversation_export_v1", exported_at: meta.exported_at,
    app: "browser", surface: meta.surface, app_version: meta.app_version,
    scope: "latest_captured_conversation", session_id: turns.at(-1)?.turn.session_id ?? null,
    captured_turns_only: true, orphan_actions_excluded: state.orphanGovernorActions?.length ?? 0,
    monitor: {
      monitorIdentity: state.monitorIdentity ?? null,
      pooled_version: [...new Set(ladders.map(v => v.pooled_version))],
    },
    assistant: turns.map(({turn}) => ({turn_id: turn.turn_id, provider: turn.provider})),
    transcript_text: browserTranscriptText(state),
    turns: turns.map(({turn, verdict, monitorStatus}, index) => ({
      turn_id: turn.turn_id, ordinal: index + 1, completed_at: turn.completed_at, monitorStatus,
      user_prompt: turn.user_prompt, assistant_text: turn.assistant_text,
      verdict_present: Boolean(verdict), judge_ladder: verdict?.judge_ladder ?? null,
    })),
    receipts,
    termination: receipts.filter(r => r.tier === 4 && r.state_at_termination).map(r => r.state_at_termination),
  };
}
