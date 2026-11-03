import { stateForSharing } from "../shared/emotionalDependencePrivacy";
import type { HarnessState } from "../shared/types";
import { copyTranscriptText } from "./chat/ChatPane";
export type ExportMeta = { exported_at: string; surface: "electron" | "web"; app_version: string };

/** Explicit projection: credentials, diagnostics and recording paths are not export data. */
export function buildConversationExport(state: HarnessState, meta: ExportMeta) {
  state = stateForSharing(state);
  const turns = state.turns.filter(record => record.turn.session_id === state.sessionId);
  const ladders = turns.flatMap(record => record.verdict?.judge_ladder ? [record.verdict.judge_ladder] : []);
  return {
    schema: "sospio_conversation_export_v1", exported_at: meta.exported_at,
    app: "orchestrator", surface: meta.surface, app_version: meta.app_version,
    scope: "current_conversation", session_id: state.sessionId,
    turn_history: state.turnHistory ?? "complete",
    monitor: {
      monitorIdentity: state.monitorIdentity ?? null,
      pooled_version: [...new Set(ladders.map(v => v.pooled_version))],
    },
    assistant: turns.map(({turn}) => ({turn_id: turn.turn_id, provider: turn.chat_provider ?? turn.provider, model: turn.chat_model ?? null})),
    transcript_text: copyTranscriptText({...state, turns}),
    turns: turns.map(({turn, verdict, monitorStatus}, index) => ({
      turn_id: turn.turn_id, ordinal: state.turnHistory === "partial" ? null : index + 1,
      completed_at: turn.completed_at, monitorStatus,
      user_prompt: turn.user_prompt, assistant_text: turn.assistant_text,
      verdict_present: Boolean(verdict), judge_ladder: verdict?.judge_ladder ?? null,
    })),
    receipts: turns.flatMap(record => record.interventionReceipts ?? []),
    termination: state.termination?.session_id === state.sessionId ? state.termination : null,
  };
}
