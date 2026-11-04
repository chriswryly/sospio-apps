import { buildConversationExport } from "./conversationExport";
import { version } from "../../package.json";
import { RecordsPanel } from "../../../cockpit/src/RecordsPanel";
import { HOSTED_COPY } from "../shared/hostedCopy";
import { Cockpit, type BannerAction } from "@sospio/cockpit";
import { cockpitViewModel, pooledSelection } from "./cockpitViewModel";
import { ChatPane, copyTranscriptText } from "./chat/ChatPane";
import { JudgeNotices, JudgeDetails } from "./JudgeNotices";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  HarnessState,
  LocalDiagnostic,
  MonitorSignal,
  TurnRecord,
} from "../shared/types";
import {
  LadderStatus,
  ReceiptInspector,
  TerminationBanner,
} from "./governorSurface";
import "./styles.css";
import "../../../shared/monitorSetup.css";
import { UtilityNotice } from "./UtilityNotice";
import type { MonitorClaimRequest, MonitorClaimResult } from "../../../shared/types";

const initialState: HarnessState = {
  sessionId: "",
  monitorHealth: "starting",
  messages: [],
  turns: [],
  diagnostics: [],
  isGenerating: false,
  modelState: {
    chatModel: "unknown",
    monitorModel: "unknown",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaHealth: "checking",
    chatModelPresent: false,
    monitorModelPresent: false,
    modelWarmth: "cold",
  },
};

export function App(): JSX.Element {
  const harness = window.harness;
  const [state, setState] = useState<HarnessState>(initialState);
  const [selectedOrdinals, setSelectedOrdinals] = useState<number[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!harness) return;
    void harness.getState().then(setState);
    const off = harness.onState(setState);
    const offToast = harness.onToast(setToast);
    return () => {
      off();
      offToast();
    };
  }, [harness]);
  useEffect(() => setSelectedOrdinals([]), [state.turns[0]?.turn.session_id]);
  if (!harness)
    return (
      <main className="app-error">
        <h1>Local harness failed to initialize</h1>
        <p>The Electron preload bridge is unavailable.</p>
      </main>
    );
  if (!state.monitorSetup?.configured) return <MonitorSetup url={state.monitorSetup?.url ?? "https://monitor.sosp.io"} save={async value => {await harness.saveMonitorSettings!(value); setState(await harness.getState());}} claim={async value => {const result = await harness.claimMonitorToken!(value); if (result.ok) setState(await harness.getState()); return result;}} />;
  const view = cockpitViewModel(state, now);
  const onAction = async (action: BannerAction, ordinals?: number[]) => {
    if (ordinals) setSelectedOrdinals(ordinals);
    if (action === "copy_transcript")
      await navigator.clipboard.writeText(copyTranscriptText(state));
    if (action === "new_conversation") await harness.newConversation();
    if (action === "dismiss" || action === "carry_on") {
      const pooled = pooledSelection(state);
      if (pooled)
        await harness.dismissJudgeNotice(
          pooled.record.turn.turn_id,
          pooled.event.signal,
        );
    }
  };
  const selected =
    state.turns.find((r) => r.turn.turn_id === selectedTurnId) ??
    state.turns.at(-1);
  return (
    <main className="shell">
      {toast && <aside className="toast">{toast}</aside>}
      {state.monitorHealth === "error" && state.monitorRemote && <p role="status">{state.monitorLastError ?? "Monitor unavailable"}</p>}
      <ChatPane
        state={state}
        models={
          state.chatModels ?? [
            { provider: "ollama", name: state.modelState.chatModel },
          ]
        }
        onSelectModel={(name) =>
          void harness
            .setConversationModel(name)
            .catch((e) => setToast(String(e)))
        }
        onClearToken={() => void harness.clearMonitorSettings!().then(() => harness.getState()).then(setState).catch(error => setToast(String(error)))}
        onShowTurns={setSelectedOrdinals}
        onShowTurn={(ordinal) => setSelectedOrdinals([ordinal])}
      />
        <aside className="cockpit-column">
          <RecordsPanel api={harness} web={false} exportDisabled={state.isGenerating} onExport={async () => {
            const exported_at = new Date().toISOString();
            const data = buildConversationExport(state, {exported_at, surface: false ? "web" : "electron", app_version: version});
            return harness.saveExport(`sospio-export-orchestrator-${exported_at.replace(/[:.]/g, "-")}.json`, JSON.stringify(data, null, 2));
          }} />
          <Cockpit
            view={view}
            now={now}
            selectedOrdinals={selectedOrdinals}
            onAction={(a, ns) =>
              void onAction(a, ns).catch((e) => setToast(String(e)))
            }
          />
          {!false && <details className="operator">
            <summary>Operator</summary>
            <button onClick={() => void harness.openDevTools()}>
              DevTools
            </button>
            <SidePanel
              state={state}
              selected={selected}
              selectedTurnId={selectedTurnId}
              onSelect={setSelectedTurnId}
            />
          </details>}
        </aside>
    </main>
  );
}

function SidePanel({
  state,
  selected,
  selectedTurnId,
  onSelect,
}: {
  state: HarnessState;
  selected?: TurnRecord;
  selectedTurnId: string | null;
  onSelect: (turnId: string) => void;
}): JSX.Element {
  const fired =
    selected?.verdict?.signals.filter((signal) => signal.fired) ?? [];
  return (
    <aside className="panel">
      <header className="status">
        <div>
          <span className={`health ${state.monitorHealth}`}></span>
          <strong>{state.monitorIdentity ?? "monitor starting"}</strong>
          <span className="muted">Sospio monitor server</span>
        </div>
        {!false && <div className="actions">
          <button onClick={() => window.harness?.restartMonitor()}>
            Restart
          </button>
          <button onClick={() => window.harness?.reconnectMonitor()}>
            Reconnect
          </button>
        </div>}
      </header>

      {state.monitorHealth === "fallback" && (
        <section className="banner">
          MONITOR: baseline (Ollama unavailable - verdicts limited)
        </section>
      )}

      <JudgeDetails verdict={selected?.verdict} />
      <LadderStatus state={state} />

      <TerminationBanner state={state} />

      <section className="diagnostics">
        <span>chat: {state.modelState.chatModel}{state.modelState.chatProvider === "openrouter" ? HOSTED_COPY.hostedSuffix : state.hostedSpend ? HOSTED_COPY.localSuffix : ""}</span>
        <span>monitor: {state.monitorRemote ? "not shown in remote mode" : state.modelState.monitorModel}</span>
        <span>ollama: {state.modelState.ollamaHealth}</span>
        <span>tok/s: {state.modelState.lastTokenRate ?? "-"}</span>
      </section>

      <section className="turns" aria-label="Captured turns">
        {state.turns.length === 0 ? (
          <div className="empty">
            Turns will appear after a response completes.
          </div>
        ) : (
          state.turns.map((record) => (
            <TurnRow
              key={record.turn.turn_id}
              record={record}
              selected={record.turn.turn_id === selectedTurnId}
              onSelect={() => onSelect(record.turn.turn_id)}
            />
          ))
        )}
      </section>

      <section className="inspector">
        <h2>Inspector</h2>
        {state.monitorRemote && <p>Monitor context, rationale and configuration: not shown in remote mode.</p>}
        {selected ? (
          <>
            <div className="signal-strip">
              {fired.length ? (
                fired.map((signal) => (
                  <Signal
                    key={`${signal.channel}-${signal.name}`}
                    signal={signal}
                  />
                ))
              ) : (
                <span className="muted">no fired signals</span>
              )}
            </div>
            <div className="window">
              <h3>System Prompt</h3>
              <p>{selected.turn.system_prompt || "none"}</p>
            </div>
            <div className="window">
              <h3>Prior Window</h3>
              <p className="muted">Not shown in remote mode.</p>
            </div>
            <ReceiptInspector
              receipts={selected.interventionReceipts ?? []}
              turns={state.turns}
              history={state.turnHistory}
            />
            <pre>
              {JSON.stringify(selected.verdict ?? selected.turn, null, 2)}
            </pre>
            <p className="provenance">capture: orchestrator (in-process)</p>
          </>
        ) : (
          <p className="muted">Select a turn to inspect the verdict JSON.</p>
        )}
      </section>

      {state.diagnostics.length > 0 && (
        <DiagnosticList diagnostics={state.diagnostics} />
      )}
    </aside>
  );
}

function TurnRow({
  record,
  selected,
  onSelect,
}: {
  record: TurnRecord;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const fired = record.verdict?.signals.filter((signal) => signal.fired) ?? [];
  // Count only receipts that executed something. Every scored turn now records
  // a receipt, including "no intervention and here is why", and badging those
  // as interventions would say the governor acted on every turn.
  const receiptCount =
    record.interventionReceipts?.filter(
      (receipt) => receipt.executions.length > 0,
    ).length ?? 0;
  const tier = record.verdict?.intervention?.tier;
  return (
    <button
      data-turn-id={record.turn.turn_id}
      className={`turn ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <span className="turn-meta">
        {new Date(record.turn.completed_at).toLocaleTimeString()} · local ·{" "}
        {record.monitorStatus}
      </span>
      <strong>{record.turn.user_prompt}</strong>
      <span className="excerpt">{record.turn.assistant_text}</span>
      <span className="signals">
        {fired.length === 0 ? (
          <span className="muted">no fired signals</span>
        ) : (
          fired.map((signal) => (
            <Signal key={`${signal.channel}-${signal.name}`} signal={signal} />
          ))
        )}
        {tier !== undefined && (
          <span className={`tier tier-${tier}`}>tier {tier}</span>
        )}
        {receiptCount > 0 && (
          <span className="receipt-badge">
            {receiptCount} receipt{receiptCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
    </button>
  );
}

function Signal({ signal }: { signal: MonitorSignal }): JSX.Element {
  return <span className={`signal ${signal.channel}`}>{signal.name}</span>;
}

function DiagnosticList({
  diagnostics,
}: {
  diagnostics: LocalDiagnostic[];
}): JSX.Element {
  return (
    <section className="diagnostic-list">
      {diagnostics.slice(-4).map((diagnostic) => (
        <div key={diagnostic.id} className="diagnostic-row">
          <strong>{diagnostic.kind}</strong>
          <span>{diagnostic.reason}</span>
        </div>
      ))}
    </section>
  );
}

export function MonitorSetup({url: initialUrl, save, claim}: {url: string; save(value: {url: string; token: string}): Promise<void>; claim(value: MonitorClaimRequest): Promise<MonitorClaimResult>}) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return <main className="sospio-setup">
    <section className="setup-card" aria-labelledby="setup-title">
      <p className="setup-mark">Sospio</p>
      <h1 id="setup-title">Enter your Sospio monitor token</h1>
      <p className="setup-lead">Sospio watches your conversations for patterns such as over-reliance and sycophancy. Each message and reply in this app is sent to the Sospio monitor server.</p>
      <form className="setup-claim" onSubmit={event => {
        event.preventDefault();
        setSaving(true); setError("");
        void claim({url, code})
          .then(result => {if (result.ok) setCode(""); else setError(result.message);})
          .catch(() => setError("Could not get a token. Try again later."))
          .finally(() => setSaving(false));
      }}>
        <label className="setup-field">Invite code
          <input type="password" required autoComplete="off" spellCheck={false} placeholder="Enter the code you were given" value={code} onChange={event => setCode(event.target.value)} />
        </label>
        <button className="setup-submit" type="submit" disabled={saving || !code.trim()}>{saving ? "Connecting…" : "Get a token"}</button>
      </form>
      <form onSubmit={event => {
        event.preventDefault();
        setSaving(true); setError("");
        void save({url, token})
          .catch(() => setError("Could not save the monitor connection. Check the address and token, and make sure secure storage is available."))
          .finally(() => setSaving(false));
      }}>
        <label className="setup-field">Monitor token
          <input type="password" required autoComplete="off" autoFocus spellCheck={false} placeholder="Paste the token you were given" value={token} onChange={event => setToken(event.target.value)} />
          <span className="setup-hint">Saved encrypted on this Mac. You can clear it later.</span>
        </label>
        <details>
          <summary>Monitor server</summary>
          <label className="setup-field">Server address<input type="url" required value={url} onChange={event => setUrl(event.target.value)} /></label>
        </details>
        <button className="setup-submit" type="submit" disabled={saving || !token.trim()}>{saving ? "Connecting…" : "Connect"}</button>
        {error && <p className="setup-error" role="alert">{error}</p>}
      </form>
      <p className="setup-foot">No invite code? Ask the person who invited you to try Sospio.</p>
    </section>
  </main>;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
