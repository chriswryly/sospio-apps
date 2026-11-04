import { buildConversationExport, browserTranscriptText } from "./conversationExport";
import { CLEAR_TOKEN_CONFIRM, CLEAR_TOKEN_LABEL } from "../../../shared/clearToken";
import { version } from "../../package.json";
import { RecordsPanel } from "../../../cockpit/src/RecordsPanel";
import {Cockpit,type BannerAction} from '@sospio/cockpit';
import {cockpitAdapter,browserPooledSelection} from './cockpitAdapter';
import { JudgeNotices, JudgeDetails, selectCitedTurns } from "./JudgeNotices";
import { UtilityNotice } from "./UtilityNotice";
import React, { useEffect, useMemo, useState } from "react";
import { supportsMediation } from "../shared/types";
import type {
  HarnessState,
  ParserDiagnostic,
  ProviderName,
} from "../shared/types";
import {
  buildDemoRunView,
  outcomeLabel,
  type DemoRunView,
  type DemoTurnView,
  type FundedSignalView,
  type ReceiptSummary,
} from "./demoViewModel";

const initialState: HarnessState = {
  monitorConfigured: false,
  monitorUrl: "https://monitor.sosp.io",
  monitorHealth: "starting",
  governorLoopEnabled: true,
  governorAllowedMechanisms: null,
  turns: [],
  diagnostics: [],
};

export type PanelActions = {
  openProvider(provider: ProviderName): void;
  reloadChat(): void;
  openDevTools(): void;
  restartMonitor(): void;
};

export function Panel(): JSX.Element {
  if (!window.harness) {
    return (
      <main className="panel panel-error">
        <h1>Monitor panel failed to initialize</h1>
        <p>The Electron preload bridge is unavailable. Restart the harness and check the main log.</p>
      </main>
    );
  }
  const [state, setState] = useState<HarnessState>(initialState);
  const [selectedOrdinals,setSelectedOrdinals]=useState<number[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedDiagnostics, setExpandedDiagnostics] = useState(false);

  useEffect(() => {
    const syncState = (next: HarnessState): void => {
      setState(next);
      setSelectedTurnId((current) => selectedTurnIdForState(next, current, followLatest));
    };
    void window.harness.getState().then(syncState);
    const offState = window.harness.onState((next) => {
      syncState(next);
    });
    const offToast = window.harness.onToast((message) => {
      setToast(message);
      window.setTimeout(() => setToast(null), 5000);
    });
    return () => {
      offState();
      offToast();
    };
  }, [followLatest]);

  useEffect(()=>setSelectedOrdinals([]),[state.turns.at(-1)?.turn.session_id]);

  useEffect(() => {
    if (state.citedJudgeTurns && state.citedJudgeTurns.sessionId === state.turns.at(-1)?.turn.session_id) {setSelectedOrdinals(state.citedJudgeTurns.ordinals); selectCitedTurns(state.turns, state.citedJudgeTurns.sessionId, state.citedJudgeTurns.ordinals);}
  }, [state.turns, state.citedJudgeTurns]);

  const run=buildDemoRunView(state);

  if (state.monitorConfigured === false) return <MonitorSetup url={state.monitorUrl ?? "https://monitor.sosp.io"} error={state.monitorLastError} />;

  const onAction=async(action:BannerAction,ordinals?:number[])=>{
    if(ordinals)setSelectedOrdinals(ordinals);
    if(action==='copy_transcript')await navigator.clipboard.writeText(browserTranscriptText(state));
    if(action==='dismiss'||action==='carry_on'){const pooled=browserPooledSelection(run,state.dismissedJudgeNotices);if(pooled)await window.harness.dismissJudgeNotice(pooled.turn.turnId,pooled.event.signal);}
  };
  return (
    <div className="cockpit-column"><div className="cockpit-signout"><button className="sospio-clear-token" onClick={() => { if (window.confirm(CLEAR_TOKEN_CONFIRM)) void window.harness.clearMonitorSettings().catch(error => setToast(String(error))); }}>{CLEAR_TOKEN_LABEL}</button></div><RecordsPanel api={window.harness} onExport={async () => {
            const exported_at = new Date().toISOString();
            const data = buildConversationExport(state, {exported_at, surface: "electron", app_version: version});
            return window.harness.saveExport(`sospio-export-browser-${exported_at.replace(/[:.]/g, "-")}.json`, JSON.stringify(data, null, 2));
          }} /><CockpitErrorBoundary><ConversationCockpit run={run} dismissed={state.dismissedJudgeNotices} selectedOrdinals={selectedOrdinals} onAction={(a,ns)=>void onAction(a,ns).catch(e=>setToast(String(e)))}/></CockpitErrorBoundary><details className="operator"><summary>Operator</summary><PanelContent
      state={state}
      selectedTurnId={selectedTurnId}
      toast={toast}
      expandedDiagnostics={expandedDiagnostics}
      onSelectTurn={(turnId) => {
        setFollowLatest(shouldFollowLatest(state, turnId));
        setSelectedTurnId(turnId);
      }}
      onToggleDiagnostics={() => setExpandedDiagnostics((value) => !value)}
      actions={{
        openProvider: (provider) => window.harness.openProvider(provider),
        reloadChat: () => window.harness.reloadChat(),
        openDevTools: () => window.harness.openDevTools(),
        restartMonitor: () => window.harness.restartMonitor(),
      }}
    /></details></div>
  );
}

export function MonitorSetup({url, error}: {url: string; error?: string | null}): JSX.Element {
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [relayUrl, setRelayUrl] = useState(url);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  return <main className="sospio-setup">
    <section className="setup-card" aria-labelledby="setup-title">
      <p className="setup-mark">Sospio</p>
      <h1 id="setup-title">Enter your Sospio monitor token</h1>
      <p className="setup-lead">Sospio watches your conversations for patterns such as over-reliance and sycophancy. Each message and reply you capture here is sent to the Sospio monitor server.</p>
      <form className="setup-claim" onSubmit={event => {
        event.preventDefault();
        setClaiming(true); setFailure(null);
        void window.harness.claimMonitorToken({url: relayUrl, code}).then(result => {
          if (result.ok) setCode("");
          else setFailure(result.message);
        }).catch(() => setFailure("Could not get a token. Try again later."))
          .finally(() => setClaiming(false));
      }}>
        <label className="setup-field">Invite code
          <input type="password" autoComplete="off" spellCheck={false} placeholder="Enter the code you were given" value={code} onChange={event => setCode(event.target.value)} required />
        </label>
        <button className="setup-submit" type="submit" disabled={saving || claiming || !code.trim()}>{claiming ? "Getting a token…" : "Get a token"}</button>
      </form>
      <form onSubmit={event => {
        event.preventDefault();
        setSaving(true); setFailure(null);
        void window.harness.saveMonitorSettings({url: relayUrl, token}).then(() => setToken(""))
          .catch(error => setFailure(error instanceof Error ? error.message : "Unable to save monitor token"))
          .finally(() => setSaving(false));
      }}>
        <label className="setup-field">Monitor token
          <input type="password" autoComplete="off" autoFocus spellCheck={false} placeholder="Paste the token you were given" value={token} onChange={event => setToken(event.target.value)} required />
          <span className="setup-hint">Saved encrypted on this Mac. You can clear it later.</span>
        </label>
        <details>
          <summary>Monitor server</summary>
          <label className="setup-field">Server address<input type="url" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} required /></label>
        </details>
        <button className="setup-submit" type="submit" disabled={saving || claiming || !token.trim()}>{saving ? "Connecting…" : "Connect"}</button>
        {(failure || error) && <p className="setup-error" role="alert">{failure ?? error}</p>}
      </form>
      <p className="setup-foot">Use an invite code to get a token, or paste a token you already have.</p>
    </section>
  </main>;
}

export function PanelContent({
  state,
  selectedTurnId,
  toast,
  expandedDiagnostics,
  onSelectTurn,
  onToggleDiagnostics,
  actions,
}: {
  state: HarnessState;
  selectedTurnId: string | null;
  toast: string | null;
  expandedDiagnostics: boolean;
  onSelectTurn: (turnId: string) => void;
  onToggleDiagnostics: () => void;
  actions: PanelActions;
}): JSX.Element {
  const view = useMemo(() => buildDemoRunView(state, selectedTurnId), [state, selectedTurnId]);
  const counts = useMemo(() => diagnosticCounts(state.diagnostics), [state.diagnostics]);
  const nonCaptured = state.diagnostics.filter((item) => item.kind !== "captured");

  return (
    <main className="panel demo-panel">
      <RunHeader view={view} state={state} actions={actions} />
      {toast && <aside className="toast">{toast}</aside>}
      <UtilityNotice verdict={state.turns.at(-1)?.verdict} />
      <JudgeDetails verdict={state.turns.find((r) => r.turn.turn_id === view.selectedTurn?.turnId)?.verdict} />
      <ValidationLoopPanel turn={view.selectedTurn} />
      <InterventionEventPanel
        turn={view.selectedTurn}
        orphanReceipts={view.orphanReceipts}
      />
      <TurnList turns={view.turns} selectedTurnId={view.selectedTurn?.turnId ?? null} onSelectTurn={onSelectTurn} />
      <AuditInspector turn={view.selectedTurn} />
      <details className="developer-controls">
        <summary>Diagnostics and tools</summary>
        <section className="diagnostics" aria-label="Chat window tools">
          <strong>Chat window</strong>
          <div className="actions">
            <button
              onClick={actions.openDevTools}
              title="Open detached DevTools on the chat window; also Cmd/Ctrl+I with that window focused"
            >
              DevTools
            </button>
          </div>
        </section>
        <DiagnosticPanel
          counts={counts}
          diagnostics={nonCaptured}
          expanded={expandedDiagnostics}
          onToggle={onToggleDiagnostics}
        />
      </details>
    </main>
  );
}

function RunHeader({
  view,
  state,
  actions,
}: {
  view: DemoRunView;
  state: HarnessState;
  actions: PanelActions;
}): JSX.Element {
  return (
    <header className="status run-header">
      <div className="run-title">
        <span className={`health ${view.monitorHealth}`}></span>
        <strong>{view.monitorIdentity}</strong>
        <span className="muted">{view.providerLabel}</span>
      </div>
      <div className="actions">
        <button onClick={() => actions.openProvider("chatgpt")}>ChatGPT</button>
        <button onClick={() => actions.openProvider("claudeai")}>Claude</button>
        <button onClick={actions.reloadChat}>Reload Chat</button>
        <button onClick={actions.restartMonitor}>Restart Monitor</button>
      </div>
      {/* Only the two that move during a run stay on the first screen. The rest is fixed for the
          session — reference data, not live status — so it collapses to one line. §5.1 asks for
          all of it and asks for the header to be compact; a disclosure is how both hold. */}
      <div className="run-metadata" aria-label="Run metadata">
        <Meta label="Health" value={view.monitorHealth} />
        <Meta label="Sospio actions" value={loopStatusLabel(view, state.provider)} />
      </div>
      {/* The monitor says why it failed; the surface used to say only that it had. "Ollama is not
          reachable at http://127.0.0.1:11434" is an answer; "error" is a prompt to go read a log. */}
      {view.monitorLastError && (
        <p className="monitor-error" role="status">
          <span>Monitor error</span>
          <span title={view.monitorLastError}>{view.monitorLastError}</span>
        </p>
      )}
      <details className="run-configuration">
        <summary>Run configuration</summary>
        <div className="run-config" aria-label="Run configuration">
          <Meta label="Subset" value={view.signalSubset.length ? view.signalSubset.join(", ") : "not reported"} />
          <Meta label="Dispatch" value={view.dispatchMode} />
          {/* Only when a run allowlist is set. Unset is the normal case and "all selected" said
              nothing; what the allowlist removes is on the receipt, not inferred from here. */}
          {view.allowedMechanisms.length > 0 && (
            <Meta label="Allowed" value={view.allowedMechanisms.join(", ")} />
          )}
          <Meta label="Monitor profile" value={view.monitorProfileId} />
          <Meta label="Intervention profile" value={view.interventionProfileId} />
          <Meta label="Policy" value={view.policyMode} />
          <Meta label="Fast path" value={fastPathLabel(view.fastPath)} />
          <label className="preset-control">
            <span>Preset</span>
            <select disabled aria-label="Reviewed profile pair selector" value="none" onChange={() => {}}>
              <option value="none">No reviewed preset active</option>
            </select>
          </label>
        </div>
      </details>
    </header>
  );
}

function ValidationLoopPanel({ turn }: { turn: DemoTurnView | undefined }): JSX.Element {
  if (!turn) {
    return (
      <section className="validation-loop empty-loop" aria-label="Conversation monitoring">
        <h2>Conversation monitoring</h2>
        <p>Open a provider and send a turn. Captured turns, signal pressure, and receipts will appear here.</p>
      </section>
    );
  }
  return (
    <section className="validation-loop" aria-label="Conversation monitoring">
      <SignalLane signal={turn.fundedSignals[0]} />
      {/* "Coupling", not "Loop": the header's Loop is the governor execution loop, and having
          both on one screen under the same word made them read as one thing. §5.2 calls this
          the coupling status. */}
      <div className={`coupling coupling-${turn.couplingState}`}>
        <span>Coupling</span>
        <strong>{stateLabel(turn.couplingState)}</strong>
        <small>{couplingEvidenceLabel(turn)}</small>
        {/* Turn-scoped, where the header banner is run-scoped: selecting an older failed turn
            should explain that turn, not the monitor's current state. Clamped with the full text
            on hover, because a provider's HTTP body can be arbitrarily long. */}
        {turn.monitorError && (
          <small className="coupling-reason" title={turn.monitorError}>
            {turn.monitorError}
          </small>
        )}
      </div>
      <SignalLane signal={turn.fundedSignals[1]} />
    </section>
  );
}

function SignalLane({ signal }: { signal: FundedSignalView }): JSX.Element {
  return (
    <article className={`signal-lane ${signal.channel}`}>
      <div>
        <h2>{signal.label}</h2>
        <span>{signal.channel === "ai_system" ? "AI channel" : "User channel"}</span>
      </div>
      <div className={`pressure pressure-${signal.pressureBand}`}>
        <strong>{formatPressure(signal.intensity)}</strong>
        <span>intensity</span>
      </div>
      <dl>
        <div>
          <dt>{signal.judgeBand !== undefined && signal.confidence === "unavailable" ? "Band" : "Confidence"}</dt>
          <dd>{signal.judgeBand !== undefined && signal.confidence === "unavailable" ? signal.judgeBand ?? "unavailable" : formatPressure(signal.confidence)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{signal.fired ? "fired" : "not fired"}</dd>
        </div>
      </dl>
      <p>{signal.rationale}</p>
    </article>
  );
}

function InterventionEventPanel({
  turn,
  orphanReceipts,
}: {
  turn: DemoTurnView | undefined;
  orphanReceipts: ReceiptSummary[];
}): JSX.Element {
  // The metric row is turn-scoped. A detached receipt only describes it when there is no
  // selected turn at all; otherwise "detached" would report a run-level fact about some other
  // receipt on a turn that simply has none of its own.
  const detachedHeadline = turn ? undefined : orphanReceipts.at(-1);
  return (
    <section className="intervention-event" aria-label="Intervention event">
      <div className="event-summary">
        <Metric label="Tier" value={turn ? tierDisplayLabel(turn) : "none"} />
        {/* Only when the ladder rung and the selected tier disagree — which is the case it was
            added for (a quiet turn reads Tier none / Ladder Tier 1, no intervention). */}
        {turn && ladderDiffersFromTier(turn) && <Metric label="Ladder" value={ladderLabel(turn)} />}
        <Metric label="Action" value={turn ? receiptActionLabel(turn) : detachedHeadline ? receiptActionLabelForSummary(detachedHeadline) : "none"} />
        {/* Only when a terminate actually ran; otherwise this said "not applicable" on every turn. */}
        {turn && turn.terminationOutcome !== "not_applicable" && (
          <Metric label="Termination" value={outcomeLabel(turn.terminationOutcome)} />
        )}
        <Metric label="Receipt" value={turn ? (turn.receiptSummary.present ? "recorded" : "none") : detachedHeadline ? "detached" : "none"} />
      </div>
      {turn?.receiptSummaries.length ? (
        <ReceiptBlocks receipts={turn.receiptSummaries} />
      ) : turn?.selectedMechanisms.length ? (
        <p className="empty">Selected mechanisms: {turn.selectedMechanisms.join(", ")}. No receipt recorded for the selected turn.</p>
      ) : turn ? (
        <p className="empty">No receipt recorded for the selected turn.</p>
      ) : null}
      {orphanReceipts.length > 0 && (
        <section className="detached-receipts" aria-label="Receipts without captured turn">
          <h3>Receipts without captured turn</h3>
          <ReceiptBlocks receipts={orphanReceipts} />
        </section>
      )}
    </section>
  );
}

function TurnList({
  turns,
  selectedTurnId,
  onSelectTurn,
}: {
  turns: DemoTurnView[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
}): JSX.Element {
  return (
    <section className="turns" aria-label="Captured turns">
      {turns.length === 0 ? (
        <div className="empty">Captured turns will appear here after a response completes.</div>
      ) : (
        turns.map((turn) => (
          <TurnRow
            key={turn.turnId}
            turn={turn}
            selected={turn.turnId === selectedTurnId}
            onSelect={() => onSelectTurn(turn.turnId)}
          />
        ))
      )}
    </section>
  );
}

function TurnRow({ turn, selected, onSelect }: { turn: DemoTurnView; selected: boolean; onSelect: () => void }): JSX.Element {
  const fired = [
    ...turn.fundedSignals.filter((signal) => signal.fired).map((signal) => signal.name),
    ...turn.nonHeadlineFiredSignals,
  ];
  return (
    <button data-turn-id={turn.turnId} className={`turn ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="turn-meta">
        {timeLabel(turn.completedAt)} - {turn.providerLabel} - {turn.monitorStatus} - {tierDisplayLabel(turn)}
      </span>
      <strong>{turn.userExcerpt}</strong>
      <span className="excerpt">{turn.assistantExcerpt}</span>
      <span className="signals">
        {fired.length === 0 ? (
          <span className="muted">no fired signals</span>
        ) : (
          fired.map((name) => (
            <span key={name} className="signal">{name}</span>
          ))
        )}
        <span className={`receipt-badge summary-${turn.actionSummary}`}>
          {turn.receiptSummary.present ? receiptActionLabel(turn) : "no receipt"}
        </span>
      </span>
    </button>
  );
}

function AuditInspector({ turn }: { turn: DemoTurnView | undefined }): JSX.Element {
  return (
    <section className="inspector" aria-label="Audit inspector">
      <h2>Audit Inspector</h2>
      {turn?.auditDetails.verdictJson && (turn.auditDetails.verdictJson as {monitor_version?:string}).monitor_version === "Sospio remote monitor" ? <p>Monitor context, rationale and configuration: not shown in remote mode.</p> : null}
      {turn ? (
        <>
          {turn.auditDetails.priorWindow.length > 0 && (
            <InspectorGroup title="Prior Window">
              {turn.auditDetails.priorWindow.map((message, index) => (
                <p key={`${message.role}-${index}`}>
                  <strong>{message.role}</strong> {message.content}
                </p>
              ))}
            </InspectorGroup>
          )}
          {turn.auditDetails.presented_text !== undefined && (
            <InspectorGroup title="User-Visible Presentation">
              <pre>{turn.auditDetails.presented_text}</pre>
            </InspectorGroup>
          )}
          {turn.auditDetails.context_additions.length > 0 && (
            <InspectorGroup title="Model-Facing Payload">
              <pre>{turn.auditDetails.context_additions.join("\n\n")}</pre>
            </InspectorGroup>
          )}
          {turn.auditDetails.original_candidate_text !== undefined && (
            <InspectorGroup title="Original Candidate">
              <pre>{turn.auditDetails.original_candidate_text}</pre>
            </InspectorGroup>
          )}
          {/* Named rather than dropped: an absent payload is a fact about the turn, and a panel
              that silently omits it hides provenance. It just does not need a card each. */}
          {emptyAuditFields(turn).length > 0 && (
            <p className="muted audit-absent">Not recorded for this turn: {emptyAuditFields(turn).join(", ")}.</p>
          )}
          <p className="provenance">
            <span>{turn.auditDetails.captureProvenance.turnId}</span>
            <span>{turn.auditDetails.captureProvenance.sessionId}</span>
            <span>{turn.auditDetails.captureProvenance.completedAt}</span>
            <small>{turn.auditDetails.captureProvenance.requestUrl}</small>
          </p>
          <details className="raw-json">
            <summary>Raw verdict JSON</summary>
            <pre>{JSON.stringify(turn.auditDetails.verdictJson ?? null, null, 2)}</pre>
          </details>
          <details className="raw-json">
            <summary>Raw action JSON</summary>
            <pre>{JSON.stringify(turn.auditDetails.actionJson, null, 2)}</pre>
          </details>
        </>
      ) : (
        <p className="muted">Select a captured turn to inspect verdicts, receipts, and provenance.</p>
      )}
    </section>
  );
}

function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="inspector-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function DiagnosticPanel({
  counts,
  diagnostics,
  expanded,
  onToggle,
}: {
  counts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <section className="diagnostics">
      <button
        className="diagnostic-toggle"
        onClick={onToggle}
        disabled={diagnostics.length === 0}
      >
        captured: {counts.captured} - skipped: {counts.skipped} - parse errors: {counts.parse_error}
      </button>
      {expanded && diagnostics.length > 0 && (
        <div className="diagnostic-list">
          {diagnostics.map((item) => (
            <DiagnosticRow key={item.id} diagnostic={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: ParserDiagnostic }): JSX.Element {
  return (
    <div className="diagnostic-row">
      <strong>{diagnostic.kind}</strong>
      <span>{diagnostic.provider ?? "unknown"}</span>
      <span>{diagnostic.requestId ?? "-"}</span>
      <span>{diagnostic.reason}</span>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="meta-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReceiptBlocks({ receipts }: { receipts: ReceiptSummary[] }): JSX.Element {
  return (
    <div className="receipt-blocks">
      {receipts.map((receipt) => (
        <section className="receipt-block" key={receipt.actionId ?? `${receipt.source}-${receipt.policyMode}`}>
          <p className="receipt-caption" aria-label="Receipt details">
            <span>{receiptSourceLabel(receipt)}</span>
            <span>{receipt.tierReason}</span>
            <span>{receipt.userVisible ? "user-visible" : "not user-visible"}</span>
            <span>{receipt.policyMode}</span>
            <small>{receipt.actionId ?? "unknown action id"}</small>
          </p>
          <div className="mechanism-list">
            {receipt.mechanisms.map((execution, index) => (
              <div className={`mechanism-row status-${execution.status}`} key={`${receipt.actionId}-${execution.mechanism}-${index}`}>
                <strong>{execution.mechanism}</strong>
                <span>{execution.timing}</span>
                <span>{execution.status}</span>
                <small>{execution.detail}</small>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function diagnosticCounts(diagnostics: ParserDiagnostic[]): Record<string, number> {
  return diagnostics.reduce(
    (counts, item) => {
      if (item.kind === "captured") {
        counts.captured += 1;
      } else if (item.kind === "parse_error") {
        counts.parse_error += 1;
      } else {
        counts.skipped += 1;
      }
      return counts;
    },
    { captured: 0, skipped: 0, parse_error: 0 },
  );
}

function formatPressure(value: number | "unavailable"): string {
  return value === "unavailable" ? "unavailable" : value.toFixed(1);
}

function stateLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function tierLabel(value: string): string {
  if (value === "tier_1") return "Tier 1";
  if (value === "tier_2") return "Tier 2";
  if (value === "tier_3") return "Tier 3";
  if (value === "tier_4") return "Tier 4";
  if (value === "capped") return "capped";
  if (value === "unknown") return "unknown";
  return "none";
}

function actionLabel(value: string): string {
  if (value === "armed_next_turn") return "armed next turn";
  return stateLabel(value);
}

/**
 * Selecting the newest row resumes following it; selecting any older row pins the cockpit
 * there. Exported so the resume decision is testable rather than buried in a click handler.
 */
export function shouldFollowLatest(state: HarnessState, turnId: string): boolean {
  return turnId === state.turns.at(-1)?.turn.turn_id;
}

export function selectedTurnIdForState(
  state: HarnessState,
  selectedTurnId: string | null,
  followLatest: boolean,
): string | null {
  const latestTurnId = state.turns.at(-1)?.turn.turn_id ?? null;
  if (followLatest) {
    return latestTurnId;
  }
  if (selectedTurnId && state.turns.some((record) => record.turn.turn_id === selectedTurnId)) {
    return selectedTurnId;
  }
  return latestTurnId;
}

function couplingEvidenceLabel(turn: DemoTurnView): string {
  if (turn.couplingState === "fired") return "receipt-backed";
  if (turn.couplingState === "selected_not_executed") return "selected, no Sospio receipt";
  // "unavailable" means there is nothing to observe — no verdict, or one the monitor failed to
  // produce. Calling that "observation-only" claimed an observation the panel does not have.
  if (turn.couplingState === "unavailable") {
    return turn.monitorStatus === "error" ? "monitor error, no verdict" : "no verdict yet";
  }
  return "observation-only";
}

function tierDisplayLabel(turn: DemoTurnView): string {
  if (turn.receiptSummary.source === "manual_demo" && turn.tierState === "unknown") {
    return "none";
  }
  return tierLabel(turn.tierState);
}

function loopStatusLabel(view: DemoRunView, provider: ProviderName | undefined): string {
  if (!view.governorLoopEnabled) return "disabled";
  // runGovernorLoop returns early without a provider and on a non-study provider alike, so
  // neither may read as a plain "enabled".
  if (!provider) return "enabled, inactive until a provider is open";
  if (!supportsMediation(provider)) {
    return `enabled, inactive on ${view.providerLabel}`;
  }
  return "enabled";
}

function fastPathLabel(fastPath: DemoRunView["fastPath"]): string {
  if (fastPath.state === "unknown") return "unknown, not recorded on the verdict";
  if (fastPath.state === "disabled") return "disabled";
  if (fastPath.state === "unreachable_by_construction") return "unreachable by construction";
  if (fastPath.state === "unreachable_under_current_monitor_output") {
    return "unreachable under current monitor output";
  }
  return `live at ${fastPath.threshold === null ? "unknown" : fastPath.threshold.toFixed(2)}`;
}

/** The ladder rung only earns a metric when it disagrees with the tier that was acted on. */
function ladderDiffersFromTier(turn: DemoTurnView): boolean {
  return turn.ladderRungState !== turn.tierState;
}

/** Audit fields with nothing in them, named in one line instead of a card each. */
function emptyAuditFields(turn: DemoTurnView): string[] {
  const absent: string[] = [];
  if (turn.auditDetails.priorWindow.length === 0 && (turn.auditDetails.verdictJson as {monitor_version?: string} | undefined)?.monitor_version !== "Sospio remote monitor") absent.push("prior window");
  if (turn.auditDetails.presented_text === undefined) absent.push("user-visible presentation");
  if (turn.auditDetails.context_additions.length === 0) absent.push("model-facing payload");
  if (turn.auditDetails.original_candidate_text === undefined) absent.push("original candidate");
  return absent;
}

function ladderLabel(turn: DemoTurnView): string {
  const rung = tierLabel(turn.ladderRungState);
  if (turn.selectedMechanisms.length === 0) {
    return `${rung}, no intervention`;
  }
  return `${rung}, selected`;
}

function receiptSourceLabel(receipt: ReceiptSummary): string {
  if (receipt.source === "manual_demo") return "manual demo";
  if (receipt.source === "governor") return "Sospio";
  return "unknown";
}

function receiptActionLabel(turn: DemoTurnView): string {
  if (turn.actionSummary !== "none") {
    return actionLabel(turn.actionSummary);
  }
  return receiptActionLabelForSummary(turn.receiptSummary);
}

function receiptActionLabelForSummary(receipt: ReceiptSummary): string {
  const status = receipt.mechanisms[0]?.status;
  return status ? stateLabel(status) : "none";
}

function timeLabel(completedAt: string): string {
  const parsed = new Date(completedAt);
  if (Number.isNaN(parsed.valueOf())) {
    return completedAt;
  }
  return parsed.toISOString().slice(11, 19);
}

export class CockpitErrorBoundary extends React.Component<React.PropsWithChildren, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch(error: Error) { console.error("Sospio cockpit:", error.message); }
  render() {
    return this.state.failed ? <div role="alert">Sospio couldn't draw this conversation's turns. Reload the panel.<button onClick={() => window.location.reload()}>Reload panel</button></div> : this.props.children;
  }
}
function ConversationCockpit(props: {run: DemoRunView; dismissed?: string[]; selectedOrdinals: number[]; onAction: (action: BannerAction, ordinals?: number[]) => void}) {
  return <Cockpit view={cockpitAdapter(props.run, props.dismissed)} selectedOrdinals={props.selectedOrdinals} onAction={props.onAction}/>;
}
