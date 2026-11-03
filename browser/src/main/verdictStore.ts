import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  GovernorActionRecord,
  GovernorArmOutcome,
  CapabilityProbeRecord,
  HarnessState,
  MonitorVerdict,
  NetworkTag,
  ParserDiagnostic,
  TurnEvent,
  TurnRecord,
} from "../shared/types";

type RuntimeState = Pick<
  HarnessState,
  | "dismissedJudgeNotices"
  | "citedJudgeTurns"
  | "monitorRemote"
  | "monitorHealth"
  | "monitorLastError"
  | "monitorIdentity"
  | "emotionalDependenceMonitored"
  | "provider"
  | "monitorConfigured"
  | "monitorUrl"
  | "governorLoopEnabled"
  | "governorAllowedMechanisms"
>;

export class VerdictStore {
  sessionFile: string;
  private records: TurnRecord[] = [];
  private earlyArmOutcomes = new Map<string, GovernorArmOutcome>();
  private orphanGovernorActions: GovernorActionRecord[] = [];
  private diagnostics: ParserDiagnostic[] = [];
  private state: RuntimeState = {
    monitorHealth: "starting",
  };

  constructor(private sessionsDir: string) {
    mkdirSync(sessionsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionFile = join(sessionsDir, `${stamp}.jsonl`);
  }

  rotateRecording(): void {
    this.sessionFile = join(this.sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`);
    this.records = []; this.earlyArmOutcomes.clear(); this.orphanGovernorActions = []; this.diagnostics = [];
    this.state = {...this.state, dismissedJudgeNotices: undefined, citedJudgeTurns: undefined};
  }

  setRuntimeState(state: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...state };
  }

  addTurn(turn: TurnEvent): void {
    this.records.push({ turn, monitorStatus: "queued" });
    this.append({ record_type: "turn_event", turn });
  }

  markPending(turnId: string): void {
    this.updateTurn(turnId, { monitorStatus: "pending" });
  }

  addVerdict(verdict: MonitorVerdict): void {
    this.updateTurn(verdict.turn_id, { verdict, monitorStatus: verdict.monitor_status === "error" ? "error" : "ready" });
    this.append({ record_type: "verdict", verdict });
  }

  addDiagnostic(diagnostic: ParserDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (diagnostic.kind !== "captured") {
      this.append({ record_type: "diagnostic", diagnostic });
    }
  }

  addNetworkTag(tag: NetworkTag): void {
    this.append({ record_type: "network_tag", tag });
  }

  addCapabilityProbe(probe: CapabilityProbeRecord): void {
    this.append({ record_type: "capability_probe", probe });
  }

  addGovernorAction(action: GovernorActionRecord): void {
    const index = this.records.findIndex((record) => record.turn.turn_id === action.turn_id);
    if (index >= 0) {
      const record = this.records[index];
      this.records[index] = {
        ...record,
        governorActions: [...(record.governorActions ?? []), action],
      };
    } else {
      this.orphanGovernorActions.push(action);
      this.addDiagnostic({
        id: `governor-action-without-turn-${action.action_id}`,
        kind: "measurement",
        provider: action.provider,
        reason: "governor_action_without_turn",
        timestamp: new Date().toISOString(),
      });
    }
    this.append({ record_type: "governor_action", action });
    const early = this.earlyArmOutcomes.get(action.action_id);
    if (early) { this.earlyArmOutcomes.delete(action.action_id); this.updateGovernorArm(early); }
  }

  updateGovernorArm(outcome: GovernorArmOutcome): void {
    const actions = [...this.orphanGovernorActions, ...this.records.flatMap(r => r.governorActions ?? [])];
    if (!actions.some(action => action.action_id === outcome.actionId)) {
      this.earlyArmOutcomes.set(outcome.actionId, outcome);
      return;
    }
    const update = (action: GovernorActionRecord): GovernorActionRecord => {
      if (action.action_id !== outcome.actionId) return action;
      const updated = { ...action, executions: action.executions.map(execution =>
        execution.mechanism === outcome.mechanism && execution.status === "armed"
          ? { ...execution, status: outcome.status, detail: outcome.detail, updated_at: outcome.updatedAt }
          : execution) };
      this.append({ record_type: "governor_action_update", action: updated });
      return updated;
    };
    this.records = this.records.map(record => ({...record, governorActions: record.governorActions?.map(update)}));
    this.orphanGovernorActions = this.orphanGovernorActions.map(update);
  }

  getState(): HarnessState {
    return {
      ...this.state,
      turns: [...this.records],
      orphanGovernorActions: [...this.orphanGovernorActions],
      diagnostics: [...this.diagnostics],
    };
  }

  private updateTurn(turnId: string, patch: Partial<TurnRecord>): void {
    const index = this.records.findIndex((record) => record.turn.turn_id === turnId);
    if (index >= 0) {
      this.records[index] = { ...this.records[index], ...patch };
    }
  }

  private append(payload: unknown): void {
    appendFileSync(this.sessionFile, `${JSON.stringify(payload)}\n`, "utf8");
  }
}
