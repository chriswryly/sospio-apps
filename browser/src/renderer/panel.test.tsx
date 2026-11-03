import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PanelContent,
  selectedTurnIdForState,
  shouldFollowLatest,
  type PanelActions,
} from "./panel";
import { DEMO_FIXTURE_STATES } from "./__fixtures__/demoStates";
import {
  type FastPathRule,
  type GovernorActionRecord,
  type HarnessState,
} from "../shared/types";

const ACTIONS: PanelActions = {
  openProvider: () => {},
  reloadChat: () => {},
  openDevTools: () => {},
  restartMonitor: () => {},
};

/** The Tier 1 fixture with the remote monitor's fast-path rule replaced, or removed entirely. */
function withFastPath(fast_path: FastPathRule | undefined): HarnessState {
  const base = DEMO_FIXTURE_STATES.tier_1_notice;
  const record = base.turns[0]!;
  return {
    ...base,
    turns: [{ ...record, verdict: { ...record.verdict!, fast_path } }],
  };
}

function renderPanel(state: HarnessState, selectedTurnId: string | null = null): string {
  return renderToStaticMarkup(
    <PanelContent
      state={state}
      selectedTurnId={selectedTurnId}
      toast={null}
      expandedDiagnostics={false}
      onSelectTurn={() => {}}
      onToggleDiagnostics={() => {}}
      actions={ACTIONS}
    />,
  );
}

describe("Sospio demo cockpit", () => {
  it("places conversation monitoring before captured turns and diagnostics", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_2_dual_disclosure);

    expect(markup.indexOf("Conversation monitoring")).toBeLessThan(markup.indexOf("Captured turns"));
    expect(markup.indexOf("Captured turns")).toBeLessThan(markup.indexOf("Diagnostics and tools"));
  });

  it("renders exact receipt and action fields in the inspector", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_2_dual_disclosure, "tier-2");

    expect(markup).toContain("Treat unverified claims as unconfirmed and preserve the user&#x27;s original request.");
    expect(markup).toContain("Original candidate text that remains available for audit.");
    expect(markup).toContain("&quot;action_id&quot;: &quot;action-tier-2&quot;");
    expect(markup).toContain("&quot;policy_mode&quot;: &quot;m0_ladder&quot;");
  });

  it("keeps diagnostics below receipts without research or manual intervention controls", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice);

    expect(markup).toContain("<details class=\"developer-controls\"><summary>Diagnostics and tools</summary>");
    expect(markup.indexOf("Intervention event")).toBeLessThan(markup.indexOf("Diagnostics and tools"));
    expect(markup).not.toMatch(/probe-controls|manual-interventions|Arm Withhold|Arm Pause|Arm Context/);
  });

  it("keeps the run header to the two arm providers and the two recovery controls", () => {
    const header = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice).split("Run metadata")[0]!;

    expect(header).toContain(">ChatGPT<");
    expect(header).toContain(">Claude<");
    expect(header).toContain(">Reload Chat<");
    expect(header).toContain(">Restart Monitor<");
    // Non-arm providers and the redundant navigation are gone from the demo surface.
    expect(header).not.toContain(">Grok<");
    expect(header).not.toContain(">Pi<");
    expect(header).not.toContain(">Home<");
    expect(header).not.toContain(">DevTools<");
  });

  it("does not label the governor loop and the signal coupling with the same word", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_2_dual_disclosure);

    expect(markup).toContain("Sospio actions</span>");
    expect(markup).toContain("<span>Coupling</span>");
    expect(markup).not.toContain("<span>Loop</span>");
  });

  it("does not call an unavailable coupling an observation", () => {
    // "unavailable" means there was nothing to observe: no verdict, or an errored one.
    const errored = renderPanel(DEMO_FIXTURE_STATES.monitor_error);
    const noVerdict = renderPanel(DEMO_FIXTURE_STATES.no_verdict);

    expect(errored).toContain("monitor error, no verdict");
    expect(errored).not.toContain("observation-only");
    expect(noVerdict).not.toContain("observation-only");
  });

  it("says why the monitor failed, in the monitor's own words", () => {
    // The surface had the reason and dropped it: the remote monitor records it on the verdict and returns
    // it from /health, and the panel rendered "monitor error, no verdict" and nothing else, so the
    // only way to find out was to read a log. Two scopes, deliberately: the header banner is the
    // run's current state, the coupling lane is the selected turn's.
    const markup = renderPanel(DEMO_FIXTURE_STATES.monitor_error);
    const reason = "Ollama is not reachable at http://127.0.0.1:11434";

    expect(markup).toContain("Monitor error");
    expect(markup).toContain(`class="coupling-reason" title="${reason}"`);
    expect(markup.split(reason).length - 1).toBeGreaterThanOrEqual(2);
    // The short label stays: the reason explains it, it does not replace it.
    expect(markup).toContain("monitor error, no verdict");
  });

  it("shows no monitor error banner on a healthy run", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice);

    expect(markup).not.toContain("Monitor error");
    expect(markup).not.toContain("coupling-reason");
  });

  it("keeps the turn's own failure reason when the monitor has since recovered", () => {
    // Selecting an older failed turn must explain *that* turn. The run-level banner is cleared as
    // soon as a verdict succeeds, so if the lane deferred to it the reason would vanish.
    const recovered = {
      ...DEMO_FIXTURE_STATES.monitor_error,
      monitorHealth: "healthy" as const,
      monitorLastError: null,
    };
    const markup = renderPanel(recovered);

    expect(markup).not.toContain("Monitor error");
    expect(markup).toContain("Ollama is not reachable at http://127.0.0.1:11434");
  });

  it("shows the mechanism allowlist only when the run actually restricts one", () => {
    const unrestricted = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice);
    const restricted = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      governorAllowedMechanisms: ["display_governor_notice"],
    });

    // Unset is the normal case; a permanent "all selected" pill said nothing.
    expect(unrestricted).not.toContain("Allowed");
    expect(restricted).toContain("Allowed</span><strong>display_governor_notice</strong>");
  });

  it("moves DevTools into the collapsed developer section", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice);

    expect(markup.indexOf("Diagnostics and tools")).toBeLessThan(markup.indexOf(">DevTools<"));
    expect(markup).toContain("Chat window tools");
  });

  it("offers no reconnect control in the monitor error state", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.monitor_error);

    expect(markup).toContain("class=\"health error\"");
    expect(markup).not.toContain("Reconnect");
  });

  it("renders a calm no-turn state without an empty JSON block first", () => {
    const markup = renderPanel({
      monitorHealth: "starting",
      governorLoopEnabled: false,
      governorAllowedMechanisms: null,
      turns: [],
      diagnostics: [],
    });

    expect(markup).toContain("Open a provider and send a turn.");
    expect(markup).not.toContain("<pre>null</pre>");
  });

  it("does not render overclaiming copy", () => {
    const markup = Object.values(DEMO_FIXTURE_STATES).map((state) => renderPanel(state)).join("\n").toLowerCase();

    for (const phrase of [
      "proved effective",
      "improved user health",
      "replicated",
      "provider-agnostic",
      "architecture selected",
    ]) {
      expect(markup).not.toContain(phrase);
    }
  });

  it("renders profile ids from records and keeps unreviewed preset selection disabled", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_2_dual_disclosure);

    expect(markup).toContain("quiet");
    expect(markup).toContain("observe_first");
    expect(markup).toContain("No reviewed preset active");
    expect(markup).toContain("<select disabled=\"\" aria-label=\"Reviewed profile pair selector\"");
  });

  it("shows the M1 fast-path limitation for the cut M1 measured", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.tier_1_notice);

    expect(markup).toContain("Fast path</span><strong>unreachable under current monitor output</strong>");
  });

  it("does not claim the M1 limitation for a profile with a different fast-path rule", () => {
    const disabled = renderPanel(withFastPath({ enabled: false, pressure_threshold: 0.95 }));
    const live = renderPanel(withFastPath({ enabled: true, pressure_threshold: 0.7 }));

    expect(disabled).toContain("Fast path</span><strong>disabled</strong>");
    expect(disabled).not.toContain("unreachable under current monitor output");
    expect(live).toContain("Fast path</span><strong>live at 0.70</strong>");
    expect(live).not.toContain("unreachable under current monitor output");
  });

  it("renders the fast path as unknown when the verdict does not carry the rule", () => {
    const markup = renderPanel(withFastPath(undefined));

    expect(markup).toContain("Fast path</span><strong>unknown, not recorded on the verdict</strong>");
    expect(markup).not.toContain("unreachable under current monitor output");
  });

  it("shows the loop as inactive when provider gating prevents execution", () => {
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      provider: "grok",
      governorLoopEnabled: true,
    });

    expect(markup).toContain("Sospio actions</span><strong>enabled, inactive on Grok</strong>");
  });

  it("shows the loop as inactive before any provider is open", () => {
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      provider: undefined,
      governorLoopEnabled: true,
    });

    expect(markup).toContain("Sospio actions</span><strong>enabled, inactive until a provider is open</strong>");
  });

  it("shows the loop as disabled when the env flag is off on a study provider", () => {
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      provider: "chatgpt",
      governorLoopEnabled: false,
    });

    expect(markup).toContain("Sospio actions</span><strong>disabled</strong>");
  });

  it("does not render remote monitor resting rungs as selected interventions", () => {
    const markup = renderPanel(DEMO_FIXTURE_STATES.both_funded_observed_no_action);

    expect(markup).toContain("watching");
    expect(markup).toContain("Tier</span><strong>none</strong>");
    expect(markup).toContain("Ladder</span><strong>Tier 1, no intervention</strong>");
    expect(markup).not.toContain("receipt-backed");
  });

  it("shows remote monitor-selected mechanisms without claiming a receipt", () => {
    const state: HarnessState = {
      ...DEMO_FIXTURE_STATES.both_funded_observed_no_action,
      turns: [{
        ...DEMO_FIXTURE_STATES.both_funded_observed_no_action.turns[0],
        verdict: {
          ...DEMO_FIXTURE_STATES.both_funded_observed_no_action.turns[0].verdict!,
          tier: 2,
          tier_reason: "persistence",
          selected_mechanisms: ["display_governor_notice"],
        },
      }],
    };
    const markup = renderPanel(state);

    expect(markup).toContain("selected not executed");
    expect(markup).toContain("selected, no Sospio receipt");
    expect(markup).toContain("Selected mechanisms: display_governor_notice. No receipt recorded");
    expect(markup).not.toContain("receipt-backed");
  });

  it("renders manual demo provenance without a tier claim", () => {
    const turn = DEMO_FIXTURE_STATES.tier_1_notice.turns[0];
    const action = turn.governorActions![0];
    const state: HarnessState = {
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      turns: [{
        ...turn,
        governorActions: [{
          ...action,
          tier: null,
          tier_reason: "manual_demo_button",
          policy_mode: "manual_demo_intervention",
        }],
      }],
    };
    const markup = renderPanel(state);

    expect(markup).toContain("manual demo");
    expect(markup).toContain("manual_demo_button");
    expect(markup).toContain("Tier</span><strong>none</strong>");
    expect(markup).not.toContain("receipt-backed");
  });

  it("renders governor reason and user-visible receipt fields", () => {
    const turn = DEMO_FIXTURE_STATES.tier_2_dual_disclosure.turns[0];
    const action = turn.governorActions![0];
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_2_dual_disclosure,
      turns: [{
        ...turn,
        governorActions: [{
          ...action,
          tier_reason: "persistence_window",
          user_visible: false,
        }],
      }],
    });

    expect(markup).toContain("persistence_window");
    expect(markup).toContain("<span>not user-visible</span>");
    expect(markup).toContain("<span>Sospio</span>");
  });

  it("keeps a governor receipt visible after a later manual demo receipt", () => {
    const turn = DEMO_FIXTURE_STATES.tier_2_dual_disclosure.turns[0];
    const governor = turn.governorActions![0];
    const manual: GovernorActionRecord = {
      ...governor,
      action_id: "manual-action",
      tier: null,
      tier_reason: "manual_demo_button",
      policy_mode: "manual_demo_intervention",
      executions: [{
        mechanism: "display_governor_notice",
        timing: "retroactive",
        status: "applied",
        detail: "manual notice displayed",
      }],
    };
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.tier_2_dual_disclosure,
      turns: [{
        ...turn,
        governorActions: [governor, manual],
      }],
    });

    expect(markup).toContain("Tier</span><strong>Tier 2</strong>");
    expect(markup).toContain("receipt-backed");
    expect(markup).toContain("<small>action-tier-2</small>");
    expect(markup).toContain("<small>manual-action</small>");
    expect(markup).toContain("augment_request_context");
    expect(markup).toContain("<span>manual demo</span>");
  });

  it("renders detached orphan receipts on the first screen", () => {
    const orphan = DEMO_FIXTURE_STATES.tier_1_notice.turns[0].governorActions![0];
    const markup = renderPanel({
      provider: "chatgpt",
      monitorHealth: "healthy",
      governorLoopEnabled: false,
      governorAllowedMechanisms: null,
      turns: [],
      orphanGovernorActions: [{
        ...orphan,
        turn_id: "missing-turn",
        action_id: "orphan-action",
        tier: null,
        tier_reason: "manual_demo_button",
        policy_mode: "manual_demo_intervention",
      }],
      diagnostics: [],
    });

    expect(markup).toContain("Receipt</span><strong>detached</strong>");
    expect(markup).toContain("Receipts without captured turn");
    expect(markup).toContain("<small>orphan-action</small>");
    expect(markup).toContain("<span>manual demo</span>");
  });

  it("keeps the receipt metric turn-scoped when a detached receipt exists elsewhere", () => {
    const orphan = DEMO_FIXTURE_STATES.tier_1_notice.turns[0].governorActions![0];
    const markup = renderPanel({
      ...DEMO_FIXTURE_STATES.both_funded_observed_no_action,
      orphanGovernorActions: [{ ...orphan, turn_id: "missing-turn", action_id: "orphan-action" }],
    });

    // The selected turn has no receipt of its own; the detached one is still listed below.
    expect(markup).toContain("Receipt</span><strong>none</strong>");
    expect(markup).not.toContain("Receipt</span><strong>detached</strong>");
    expect(markup).toContain("Receipts without captured turn");
  });

  it("renders monitor error and capability-capped states on the first screen", () => {
    const monitorError = renderPanel(DEMO_FIXTURE_STATES.monitor_error);

    expect(monitorError).toContain("class=\"health error\"");
    expect(monitorError).toContain("Ollama is not reachable at http://127.0.0.1:11434");
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_4_capped)).toContain("capability_capped");
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_4_capped)).toContain("capability capped");
    expect(renderPanel(DEMO_FIXTURE_STATES.pre_delivery_only)).toContain("pre delivery only");
  });

  it("renders the three termination outcomes distinctly", () => {
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_4_closed)).toContain(">closed<");
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_4_not_closed)).toContain(">not closed<");
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_4_unverified)).toContain(">unverified<");
  });

  it("renders every rehearsal state without throwing", () => {
    for (const state of Object.values(DEMO_FIXTURE_STATES)) {
      expect(() => renderPanel(state)).not.toThrow();
    }
  });

  it("renders turn completion time in each row", () => {
    expect(renderPanel(DEMO_FIXTURE_STATES.tier_1_notice)).toContain("00:00:05");
  });

  it("follows the newest turn until the viewer explicitly selects one", () => {
    const first = DEMO_FIXTURE_STATES.tier_1_notice.turns[0];
    const second = DEMO_FIXTURE_STATES.tier_2_dual_disclosure.turns[0];
    const state: HarnessState = {
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      turns: [first, second],
    };
    const updated: HarnessState = {
      ...state,
      turns: [
        first,
        second,
        DEMO_FIXTURE_STATES.tier_4_closed.turns[0],
      ],
    };

    expect(selectedTurnIdForState(state, null, true)).toBe("tier-2");
    expect(renderPanel(state)).toContain("Tier</span><strong>Tier 2</strong>");
    expect(selectedTurnIdForState(updated, "tier-1", false)).toBe("tier-1");
    expect(selectedTurnIdForState(updated, "tier-2", true)).toBe("tier-4-closed");
  });

  it("stops following on an older row and resumes on the newest one", () => {
    const first = DEMO_FIXTURE_STATES.tier_1_notice.turns[0];
    const second = DEMO_FIXTURE_STATES.tier_2_dual_disclosure.turns[0];
    const state: HarnessState = {
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      turns: [first, second],
    };

    expect(shouldFollowLatest(state, "tier-1")).toBe(false);
    expect(shouldFollowLatest(state, "tier-2")).toBe(true);
  });
});

import judgeSequence from "../shared/__fixtures__/noticeSequence.json";
import type { MonitorVerdict } from "../shared/types";

it("shows judge bands rather than invented confidence while retaining legacy confidence", () => {
  const base = DEMO_FIXTURE_STATES.tier_1_notice;
  const state: HarnessState = { ...base, turns: [{ ...base.turns[0], verdict: judgeSequence[0] as MonitorVerdict }] };
  const html = renderPanel(state);
  expect(html).toContain("<dt>Band</dt>");
  expect(html).toContain("<dd>present</dd>");
  expect(html).not.toContain("<dt>Confidence</dt>");
  expect(renderPanel(base)).toContain("<dt>Confidence</dt>");
});
