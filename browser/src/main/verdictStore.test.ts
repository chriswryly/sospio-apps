import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerdictStore } from "./verdictStore";
import type { GovernorActionRecord, TurnEvent } from "../shared/types";

describe("verdict store", () => {
  it.each(["applied", "failed"] as const)("updates armed receipt to %s preserving original time", status => {
    const store = new VerdictStore(mkdtempSync(join(tmpdir(), "sospio-browser-")));
    const action = governorAction("turn-1");
    action.executions = [{ mechanism: "augment_request_context", timing: "next_turn", status: "armed", detail: "queued", armed_at: "original" }];
    store.addTurn(turnEvent("turn-1"));store.addGovernorAction(action);
    store.updateGovernorArm({actionId:action.action_id,mechanism:"augment_request_context",status,detail:"request-id or cancellation reason",updatedAt:"later"});
    expect(store.getState().turns[0].governorActions?.[0].executions[0]).toMatchObject({status,armed_at:"original",updated_at:"later",detail:"request-id or cancellation reason"});
    expect(readFileSync(store.sessionFile,"utf8")).toContain('"record_type":"governor_action_update"');
  });

  it("appends browser governor action v3 records with receipt content fields", () => {
    const store = new VerdictStore(mkdtempSync(join(tmpdir(), "sospio-browser-")));
    const action = governorAction("turn-1");

    store.addGovernorAction(action);

    const records = readFileSync(store.sessionFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(records).toContainEqual({ record_type: "governor_action", action });
  });

  it("joins a governor action onto the matching live turn", () => {
    const store = new VerdictStore(mkdtempSync(join(tmpdir(), "sospio-browser-")));
    const turn = turnEvent("turn-1");
    const action = governorAction("turn-1");

    store.addTurn(turn);
    store.addGovernorAction(action);

    expect(store.getState().turns[0]?.governorActions).toEqual([action]);
  });

  it("preserves multiple action order for the same turn", () => {
    const store = new VerdictStore(mkdtempSync(join(tmpdir(), "sospio-browser-")));
    const first = governorAction("turn-1", "action-1");
    const second = governorAction("turn-1", "action-2");

    store.addTurn(turnEvent("turn-1"));
    store.addGovernorAction(first);
    store.addGovernorAction(second);

    expect(store.getState().turns[0]?.governorActions).toEqual([first, second]);
  });

  it("persists a no-match action and surfaces a non-fatal diagnostic", () => {
    const store = new VerdictStore(mkdtempSync(join(tmpdir(), "sospio-browser-")));
    const action = governorAction("missing-turn");

    store.addGovernorAction(action);

    const records = readFileSync(store.sessionFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(records.filter((record) => record.record_type === "governor_action")).toEqual([
      { record_type: "governor_action", action },
    ]);
    expect(store.getState().diagnostics).toContainEqual(expect.objectContaining({
      kind: "measurement",
      provider: "chatgpt",
      reason: "governor_action_without_turn",
    }));
    expect(store.getState().orphanGovernorActions).toEqual([action]);
  });
});

function turnEvent(turn_id: string): TurnEvent {
  return {
    turn_id,
    session_id: "session-1",
    provider: "chatgpt",
    user_prompt: "user prompt",
    assistant_text: "assistant text",
    started_at: "2026-09-05T00:00:00.000Z",
    completed_at: "2026-09-05T00:00:01.000Z",
    request_url: "https://chatgpt.com/backend-api/conversation",
  };
}

function governorAction(turn_id: string, action_id = "action-1"): GovernorActionRecord {
  return {
    schema_version: "rsh_browser_governor_action_v3",
    action_id,
    turn_id,
    provider: "chatgpt",
    policy_version: "browser_policy_adapter_v1",
    authority_profile_id: "browser_governor_surface_v1",
    observed_at: "2026-08-18T00:00:00.000Z",
    monitor_version: "Sospio remote monitor",
    threshold: 0.7,
    tier: 4,
    tier_reason: "persistence",
    monitor_profile_id: "m0_default",
    intervention_profile_id: "m0_default",
    policy_mode: "m0_ladder",
    triggering_signals: [{ name: "harmful_content", confidence: 0.93, intensity: 0.88 }],
    user_visible: true,
    executions: [
      {
        mechanism: "replace_presentation",
        timing: "retroactive",
        status: "applied",
        detail: "flagged turn hidden behind a governor surface with a restore handle",
      },
    ],
    context_additions: ["Check uncertainty before answering."],
    original_candidate_text: "raw candidate",
    presented_text: "The original candidate presentation was replaced by the governor.",
  };
}

it("rotates recording before deletion and records new turns in a fresh file", async () => {
  const {realpathSync,existsSync,rmSync}=await import('node:fs');
  const {sweepRoot}=await import('../../../records/recordsRetention');
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'browser-delete-')),store=new VerdictStore(dir);
  try {
    store.addTurn({...turnEvent('old'),user_prompt:'recognizable old secret'});const old=store.sessionFile;
    store.rotateRecording();expect(store.sessionFile).not.toBe(old);expect(store.getState().turns).toEqual([]);
    sweepRoot({path:dir,kind:'sessions'},{days:14,all:true,protectedPaths:[store.sessionFile]});expect(existsSync(old)).toBe(false);
    store.addTurn(turnEvent('new'));expect(readFileSync(store.sessionFile,'utf8')).not.toContain('recognizable old secret');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
