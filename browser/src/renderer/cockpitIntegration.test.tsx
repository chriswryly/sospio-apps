// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Panel } from "./panel";
import { DEMO_FIXTURE_STATES } from "./__fixtures__/demoStates";
import type { HarnessApi, HarnessState } from "../shared/types";
it("keeps every operator action and synchronizes page-selected turns", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let update: (s: HarnessState) => void = () => {};
  const api = {
    saveExport: vi.fn(async () => true),
    getState: vi
      .fn()
      .mockResolvedValue({
        ...DEMO_FIXTURE_STATES.tier_1_notice,
        citedJudgeTurns: {
          sessionId: DEMO_FIXTURE_STATES.tier_1_notice.turns[0].turn.session_id,
          ordinals: [1],
        },
      }),
    onState: (cb: (s: HarnessState) => void) => {
      update = cb;
      return () => {};
    },
    onToast: () => () => {},
    openProvider: vi.fn().mockResolvedValue(undefined),
    reloadChat: vi.fn().mockResolvedValue(undefined),
    openDevTools: vi.fn().mockResolvedValue(undefined),
    restartMonitor: vi.fn().mockResolvedValue(undefined),
  };
  window.harness = api as unknown as HarnessApi;
  const el = document.createElement("div"),
    root = createRoot(el);
  await act(async () => root.render(<Panel />));
  expect(
    el.querySelector('[data-ordinal="1"]')?.getAttribute("aria-current"),
  ).toBe("true");
  expect(el.querySelector("details.operator")).not.toBeNull();
  for (const label of [
    "ChatGPT",
    "Claude",
    "Reload Chat",
    "Restart Monitor",
    "DevTools",
  ]) {
    await act(async () =>
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent === label)!
        .click(),
    );
  }
  expect(api.openProvider.mock.calls).toEqual([["chatgpt"], ["claudeai"]]);
  expect(api.reloadChat).toHaveBeenCalledOnce();
  expect(api.restartMonitor).toHaveBeenCalledOnce();
  expect(api.openDevTools).toHaveBeenCalledOnce();
  expect(el.querySelector(".probe-controls, .manual-interventions")).toBeNull();
  await act(async () =>
    update({
      ...DEMO_FIXTURE_STATES.tier_1_notice,
      citedJudgeTurns: {
        sessionId: DEMO_FIXTURE_STATES.tier_1_notice.turns[0].turn.session_id,
        ordinals: [1],
      },
    }),
  );
  expect(
    el.querySelector('[data-ordinal="1"]')?.getAttribute("aria-current"),
  ).toBe("true");
  act(() => root.unmount());
});

it("wires conversation export and allows it while monitoring captured turns", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const {exportFixture} = await import("./__fixtures__/conversationExport");
  const state = exportFixture(); state.turns[0].monitorStatus = "pending";
  let update: (s: HarnessState) => void = () => {};
  const saveExport = vi.fn(async () => true);
  window.harness = {saveExport, getState: async () => state, onState: (cb: (s: HarnessState) => void) => {update=cb;return()=>{};}, onToast:()=>()=>{},
    recordsInfo:async()=>({days:14,surface:"computer",judges:[],hosted:false,export_enabled:true})} as unknown as HarnessApi;
  const node=document.createElement("div"),root=createRoot(node);
  try {
    await act(async()=>root.render(<Panel/>));
    const button=()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="Export conversation")!;
    expect(button().disabled).toBe(false);
    await act(async()=>button().click());expect(saveExport).toHaveBeenCalledOnce();
    const [name,contents]=saveExport.mock.calls[0] as unknown as [string,string];
    expect(name).toMatch(/^sospio-export-browser-.*\.json$/);
    const exported=JSON.parse(contents);expect(exported.schema).toBe("sospio_conversation_export_v1");
    expect(exported.session_id).toBe(state.turns[0].turn.session_id);
  } finally {await act(async()=>root.unmount());}
});
