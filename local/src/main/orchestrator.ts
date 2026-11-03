import { HostedChatError } from "./hostedChatClient";
import { HOSTED_COPY } from "../shared/hostedCopy";
import { CLOSING_BODY } from "../shared/interventionCopy";
import { judgeTierText } from "../shared/judgeLadder";
import { randomUUID } from "node:crypto";
import type { MonitorVerdict, NoInterventionReason, TurnEvent } from "../shared/types";
import type { ChatPort } from "./chatClient";
import type { RuntimeConfig } from "./config";
import { ConversationStore } from "./conversationStore";
import {
  LocalInterventionExecutor,
  type LocalInterventionPlan,
} from "./localInterventionExecutor";
import {
  LocalPolicyAdapterError,
  planFromVerdictIntervention,
  type LocalPolicyDefaults,
} from "./localPolicyAdapter";
import type { MonitorClient } from "./monitorClient";

/** Mechanisms that act on a candidate reply rather than on a request or the session. */
const CANDIDATE_STEPS = new Set<string>([
  "display_governor_notice",
  "withhold_candidate",
  "visibly_redact_candidate",
  "replace_presentation",
]);

/** A Tier 1-3 plan, bound to the turn and session whose verdict produced it. */
type HeldPlan = {
  plan: LocalInterventionPlan;
  governingTurnId: string;
  sessionId: string;
};

export class Orchestrator {
  private disposed = false;
  private activeWrites = 0;
  private unresolvedMonitorTurns = new Set<string>();
  hasPendingWrites(): boolean { return this.activeWrites > 0 || this.unresolvedMonitorTurns.size > 0; }
  async prepareRecordDeletion(): Promise<void> {
    if (this.activeWrites) throw new Error("records_busy");
    const client=this.getMonitorClient();
    for(const id of this.unresolvedMonitorTurns) if(await client?.hasVerdict(id))this.unresolvedMonitorTurns.delete(id);
    if(this.hasPendingWrites())throw new Error("records_busy");
  }
  async handleUserMessage(message: string): Promise<void> {
    this.activeWrites++;
    try { await this.generate(message); } finally { this.activeWrites--; }
  }
  private async monitorTurn(turn: TurnEvent, assistantId: string): Promise<void> {
    this.activeWrites++;
    try { await this.monitorTurnInternal(turn, assistantId); } finally { this.activeWrites--; }
  }
  dispose(): void { this.disposed = true; this.held = null; this.latestTurn = null; }
  /**
   * The rest of the latest turn's plan, for the turn after it.
   *
   * A verdict on turn N exists only after turn N has been delivered. Its
   * notice is shown on turn N as soon as the verdict lands, as the browser
   * arm does; what must ride an outgoing request
   * (context augmentation) or a candidate still to come (replace, redact,
   * withhold) is held for N+1. The
   * held part governs N+1 and nothing else: the next turn to start consumes it,
   * and a verdict for any turn but the latest cannot install one. Tier 4 is not
   * held; it acts when its verdict lands.
   */
  private held: HeldPlan | null = null;
  /** The most recently started turn. Input is accepted while verdicts are pending. */
  private latestTurn: { sessionId: string; turnId: string } | null = null;

  constructor(
    private config: RuntimeConfig,
    private store: ConversationStore,
    private chatClient: ChatPort,
    private getMonitorClient: () => MonitorClient | undefined,
    private emitState: () => void,
  ) {
    this.resetLadderState();
  }

  /** A new conversation starts with no plan and no turn to succeed. */
  resetSession(): void {
    this.held = null;
    this.latestTurn = null;
    this.resetLadderState();
  }

  private resetLadderState(): void {
    this.store.setRuntimeState({
      ladder: { status: "none", reason: "no_verdict_yet" },
    });
  }

  /**
   * Start a turn: record it as the latest and consume the held plan.
   *
   * The held plan applies only if it was produced by the turn immediately
   * before this one, in this session. Either way it is used up here.
   */
  private startTurn(sessionId: string, turnId: string): LocalInterventionExecutor | undefined {
    const previous = this.latestTurn;
    const held = this.held;
    this.held = null;
    this.latestTurn = { sessionId, turnId };
    if (held) {
      this.store.setRuntimeState({ ladder: { status: "none", reason: "consumed", turn_id: held.governingTurnId } });
    }
    const applies =
      held !== null &&
      previous !== null &&
      held.sessionId === sessionId &&
      previous.sessionId === sessionId &&
      held.governingTurnId === previous.turnId;
    return applies ? new LocalInterventionExecutor(held.plan) : undefined;
  }

  private isLatestTurn(turnId: string): boolean {
    return this.latestTurn?.turnId === turnId && this.latestTurn.sessionId === this.store.sessionId;
  }

  private policyDefaults(): LocalPolicyDefaults {
    return {
      contextAddition: this.config.interventionContext,
      noticeText: this.config.interventionNotice,
      withheldText: this.config.interventionWithheld,
      redactionText: this.config.interventionRedaction,
      replacementText: this.config.interventionReplacement,
    };
  }

  private async generate(userMessage: string): Promise<void> {
    const trimmed = userMessage.trim();
    if (this.disposed || !trimmed || this.store.getState().isGenerating) {
      return;
    }
    const termination = this.store.getState().termination;
    if (termination) {
      // Tier 4 closed the exchange. Refuse visibly rather than silently, so the
      // user can tell the governor acted from the app breaking.
      this.store.addDiagnostic(
        "warning",
        `conversation closed by Sospio after turn ${termination.governing_turn_id}; start a new conversation to continue`,
      );
      this.emitState();
      return;
    }
    if (this.store.chatProvider() === "openrouter" &&
      !this.config.hosted?.models.some(m => m.id === this.store.getState().modelState.chatModel)) {
      this.store.setRuntimeState({setupMessage: HOSTED_COPY.unavailable}); this.emitState(); return;
    }
    const sessionId = this.store.sessionId;
    const current = () => !this.disposed && this.store.sessionId === sessionId;
    const turnId = randomUUID();
    const interventions = this.startTurn(sessionId, turnId);
    const startedAt = new Date().toISOString();
    this.store.setRuntimeState({ isGenerating: true, setupMessage: undefined });
    this.store.appendUser(trimmed, turnId);
    const assistant = this.store.beginAssistant(turnId);
    this.emitState();
    let requestIntervention: ReturnType<LocalInterventionExecutor["executeBeforeChat"]> | undefined;
    try {
      const history = this.store.getRecentMessages(this.config.contextTurns).filter((message) => message.id !== assistant.id);
      requestIntervention = interventions?.executeBeforeChat({
        turnId,
        systemPrompt: this.config.systemPrompt,
        messages: history,
      });
      const result = await this.chatClient.streamChat(
        {
          model: this.store.getState().modelState.chatModel,
          systemPrompt: requestIntervention?.systemPrompt ?? this.config.systemPrompt,
          messages: requestIntervention?.messages ?? history,
        },
        (text) => {
          if (!current()) return;
          this.store.updateAssistant(assistant.id, text);
          this.emitState();
        },
      );
      if (!current()) return;
      if (result.completed !== true) throw new Error("chat_stream_incomplete");
      const candidateIntervention = interventions?.executeAfterCandidate({
        turnId,
        candidateText: result.text,
      });
      const assistantText = candidateIntervention?.presentedText ?? result.text;
      this.store.finalizeAssistant(assistant.id, assistantText);
      this.store.setModelState({ lastTokenRate: result.tokenRate });
      const turn = {...this.turnEvent(turnId, trimmed, assistantText, startedAt, requestIntervention?.systemPrompt), ...(result.hosted ? {hosted_chat: result.hosted} : {})};
      this.store.addTurn(turn, "queued");
      for (const receipt of [requestIntervention?.receipt, candidateIntervention?.receipt]) {
        if (receipt) {
          this.store.addInterventionReceipt(turn.turn_id, receipt);
        }
      }
      this.store.setRuntimeState({
        isGenerating: false,
        monitorHealth: this.store.getState().monitorHealth,
      });
      this.emitState();
      await this.monitorTurn(turn, assistant.id);
    } catch (error) {
      if (!current()) return;
      const reason = error instanceof Error ? error.message : "chat generation failed";
      this.store.finalizeAssistantFailure(assistant.id, `${this.store.chatProvider() === "openrouter" ? "Hosted" : "Local"} model error: ${reason}`);
      if (requestIntervention?.receipt) {
        // assistant_text stays empty: the model produced nothing, and writing
        // the error here would put a harness failure into the record as though
        // the assistant had said it.
        const turn = {
          ...this.turnEvent(turnId, trimmed, "", startedAt, requestIntervention.systemPrompt),
          error: reason,
          ...(error instanceof HostedChatError && error.hosted ? {hosted_chat: error.hosted} : {}),
        };
        this.store.addTurn(turn, "error");
        this.store.addInterventionReceipt(turn.turn_id, requestIntervention.receipt);
      }
      this.store.addDiagnostic("error", reason);
      this.store.setRuntimeState({ isGenerating: false });
      this.emitState();
    }
  }

  private async monitorTurnInternal(turn: TurnEvent, assistantId: string): Promise<void> {
    if (this.disposed) return;
    const monitorClient = this.getMonitorClient();
    if (!monitorClient) {
      this.store.setRuntimeState({ monitorHealth: "error" });
      this.emitState();
      return;
    }
    this.store.markPending(turn.turn_id);
    this.emitState();
    try {
      this.unresolvedMonitorTurns.add(turn.turn_id);
      await monitorClient.postTurn(turn);
      const verdict = await monitorClient.pollVerdict(turn.turn_id);
      this.unresolvedMonitorTurns.delete(turn.turn_id);
      if (this.disposed || turn.session_id !== this.store.sessionId) return;
      this.store.addVerdict(verdict);
      this.store.setRuntimeState({
        monitorHealth: verdict.monitor_status === "error" ? "error" : verdict.monitor_status === "fallback" ? "fallback" : "healthy",
        monitorIdentity: verdict.monitor_version,
        monitorLastError: verdict.monitor_status === "error" ? verdict.error ?? "Monitor unavailable" : null,
      });
      this.applyLadderDecision(turn.turn_id, verdict, assistantId);
    } catch (error) {
      this.store.addVerdict({
        turn_id: turn.turn_id,
        schema_version: "resilience_monitor_v1",
        signals: [],
        monitor_version: "unavailable",
        latency_ms: 0,
        monitor_status: "error",
        error: error instanceof Error ? error.message : "monitor request failed",
      });
      this.store.setRuntimeState({ monitorHealth: "error", monitorLastError: error instanceof Error ? error.message : "Monitor unavailable" });
      this.clearPlan(turn.turn_id, "monitor_unavailable");
    }
    this.emitState();
  }

  /**
   * Turn one ladder decision into the plan for the next turn.
   *
   * Tier 4 is the exception: it acts on the session as soon as the verdict
   * lands, because the message it responded to has already been delivered. It
   * is exempt from the latest-turn rule: a later turn or a newer no-decision
   * verdict does not cancel it.
   */
  private applyLadderDecision(turnId: string, verdict: MonitorVerdict, assistantId: string): void {
    if (this.disposed) return;
    if (verdict.monitor_utility) {
      this.recordUtilityOutcome(turnId, verdict);
      return;
    }
    if (this.store.getState().termination) {
      // A turn sent before termination landed can still be scored afterwards.
      // Its verdict is stored and receipted, but installs nothing and does not
      // replace the governing turn of the termination already in force.
      this.store.addInterventionReceipt(
        turnId,
        LocalInterventionExecutor.noInterventionReceipt(turnId, "session_terminated"),
      );
      return;
    }
    if (verdict.judge_ladder) {
      for (const notice of verdict.judge_ladder.pooled.filter((e) => e.kind !== "suppressed")) {
        this.store.addInterventionReceipt(turnId, {
          schema_version: "rsh_local_intervention_receipt_v2", receipt_id: randomUUID(), turn_id: turnId,
          plan_id: "pooled_uncertainty", policy_version: verdict.judge_ladder.pooled_version,
          authority_profile_id: "notice_only", created_at: new Date().toISOString(), user_visible: true,
          tier: null, pooled_notice: notice, presented_text: notice.text, executions: [],
        });
      }
    }
    const intervention = verdict.intervention;
    if (!intervention) {
      this.clearPlan(turnId, "no_ladder_decision");
      return;
    }
    let plan: LocalInterventionPlan | null;
    try {
      const kind = intervention.tier === 1 ? "tier1" : intervention.tier === 3 ? "tier3" : "observation";
      const judgeText = intervention.tier === 4 ? undefined : judgeTierText(verdict, kind);
      const planIntervention = verdict.judge_ladder && intervention.tier === 3 && judgeText &&
        !intervention.selected_mechanisms.includes("display_governor_notice")
        ? { ...intervention, selected_mechanisms: ["display_governor_notice", ...intervention.selected_mechanisms] }
        : intervention;
      plan = planFromVerdictIntervention(planIntervention, { ...this.policyDefaults(),
        noticeText: intervention.tier === 4 ? CLOSING_BODY : judgeText ?? this.config.interventionNotice,
        contextAddition: judgeText ?? this.config.interventionContext,
      }, turnId);
    } catch (error) {
      this.store.addDiagnostic(
        "error",
        error instanceof LocalPolicyAdapterError
          ? error.message
          : "ladder decision could not be turned into a plan",
      );
      this.clearPlan(turnId, "no_applicable_mechanisms");
      return;
    }
    if (!plan) {
      this.clearPlan(turnId, "no_applicable_mechanisms");
      return;
    }
    const session = new LocalInterventionExecutor(plan).executeSessionControl(turnId);
    if (session.terminated) {
      this.held = null;
      this.store.setTermination({
        terminated_at: new Date().toISOString(),
        governing_turn_id: turnId,
        tier_reason: intervention.tier_reason,
        notice: session.notice ?? this.config.interventionNotice,
        plan_source: "live_verdict",
      });
      this.store.setRuntimeState({ ladder: { status: "none", reason: "terminated", turn_id: turnId } });
      if (session.receipt) {
        this.store.addInterventionReceipt(turnId, session.receipt);
      }
      return;
    }
    if (!this.isLatestTurn(turnId)) {
      // Its successor has already started without it. Recorded, never applied.
      this.store.addInterventionReceipt(
        turnId,
        LocalInterventionExecutor.noInterventionReceipt(turnId, "superseded_by_later_turn"),
      );
      return;
    }
    const rest = this.showNoticeOnGoverningTurn(turnId, assistantId, plan);
    if (!rest) {
      this.held = null;
      this.store.setRuntimeState({ ladder: { status: "none", reason: "shown_on_turn", turn_id: turnId } });
      return;
    }
    plan = rest;
    this.held = { plan, governingTurnId: turnId, sessionId: this.store.sessionId };
    this.store.setRuntimeState({
      ladder: {
        status: "held",
        tier: intervention.tier,
        tier_reason: intervention.tier_reason,
        governing_turn_id: turnId,
        mechanisms: [...plan.mechanisms],
      },
    });
  }

  /**
   * Show a notice-only candidate step on the delivered turn that caused it,
   * and return what is left to hold for the next turn (null if nothing).
   *
   * Only a lone display_governor_notice moves: a replace, redact or withhold
   * would take back text the user has already read, so a plan carrying one
   * stays whole for N+1 exactly as before.
   */
  private showNoticeOnGoverningTurn(
    turnId: string,
    assistantId: string,
    plan: LocalInterventionPlan,
  ): LocalInterventionPlan | null {
    const candidate = plan.mechanisms.filter((m) => CANDIDATE_STEPS.has(m));
    const delivered = this.store.getMessages().find((m) => m.id === assistantId);
    if (candidate.length !== 1 || candidate[0] !== "display_governor_notice" || !delivered || delivered.failed) {
      return plan;
    }
    const shown = new LocalInterventionExecutor({ ...plan, mechanisms: ["display_governor_notice"] })
      .executeAfterCandidate({ turnId, candidateText: delivered.content });
    this.store.finalizeAssistant(assistantId, shown.presentedText);
    if (shown.receipt) this.store.addInterventionReceipt(turnId, shown.receipt);
    const mechanisms = plan.mechanisms.filter((m) => m !== "display_governor_notice");
    return mechanisms.length ? { ...plan, mechanisms } : null;
  }

  /**
   * The notice utility observes the turn it scored and shows its notice after
   * that turn; it holds no plan and cannot escalate. Its receipt says which of
   * notice, no notice or unavailable happened, instead of "no ladder decision".
   */
  private recordUtilityOutcome(turnId: string, verdict: MonitorVerdict): void {
    const decision = verdict.monitor_utility?.decision;
    const notice = verdict.utility_notice;
    if (decision === "U" || verdict.monitor_status === "error") {
      this.clearPlan(turnId, "monitor_unavailable");
      return;
    }
    if (decision === "P" && notice && typeof notice.notice_id === "string" && typeof notice.text === "string") {
      this.dropPlanIfLatest(turnId, "no_ladder_decision");
      // UtilityNotice renders the newest turn's verdict; an older turn's notice
      // is superseded on screen by the time its verdict lands.
      const shown = this.store.getState().turns.at(-1)?.turn.turn_id === turnId;
      this.store.addInterventionReceipt(
        turnId,
        LocalInterventionExecutor.utilityNoticeReceipt(turnId, notice.notice_id, shown),
      );
      return;
    }
    this.clearPlan(turnId, "utility_no_notice");
  }

  /** Fail closed: no decision means no plan, never the previous one. */
  private clearPlan(turnId: string, reason: NoInterventionReason): void {
    this.dropPlanIfLatest(turnId, reason);
    this.store.addInterventionReceipt(
      turnId,
      LocalInterventionExecutor.noInterventionReceipt(turnId, reason),
    );
  }

  /** Only the latest turn's outcome may change what the next turn receives. */
  private dropPlanIfLatest(turnId: string, reason: NoInterventionReason): void {
    // After termination the status stays "terminated": nothing is held, and a
    // later outcome must not make the exchange look open again.
    if (!this.isLatestTurn(turnId) || this.store.getState().termination) return;
    this.held = null;
    this.store.setRuntimeState({ ladder: { status: "none", reason, turn_id: turnId } });
  }

  private turnEvent(turnId: string, userPrompt: string, assistantText: string, startedAt: string, systemPrompt = this.config.systemPrompt): TurnEvent {
    const completedAt = new Date().toISOString();
    return {
      turn_id: turnId,
      session_id: this.store.sessionId,
      provider: "local",
      user_prompt: userPrompt,
      assistant_text: assistantText,
      started_at: startedAt,
      completed_at: completedAt,
      request_url: `${this.store.chatProvider()}://${this.store.getState().modelState.chatModel}`,
      ...(this.store.chatProvider() === "openrouter" ? {
        chat_provider: "openrouter" as const,
        chat_model: this.store.getState().modelState.chatModel,
      } : {}),
      system_prompt: systemPrompt,
      tool_calls: [],
    };
  }
}
