// @vitest-environment jsdom
import React, {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {validateCockpitView} from "@sospio/cockpit";
import {CockpitErrorBoundary} from "./panel";
import {cockpitAdapter} from "./cockpitAdapter";
import {buildDemoRunView} from "./demoViewModel";
import {DEMO_FIXTURE_STATES} from "./__fixtures__/demoStates";
it("keeps a validator failure visible with a reload action", () => {
  const view = cockpitAdapter(buildDemoRunView(DEMO_FIXTURE_STATES.tier_1_notice));
  view.turns = [view.turns[0], view.turns[0]];
  function Invalid() { validateCockpitView(view); return <div>unexpected</div>; }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div"), root = createRoot(host);
  try {
    act(() => root.render(<CockpitErrorBoundary><Invalid/></CockpitErrorBoundary>));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sospio couldn't draw this conversation's turns. Reload the panel.");
    expect(host.querySelector("button")?.textContent).toBe("Reload panel");
    expect(log).toHaveBeenCalledWith("Sospio cockpit:", "Turns must be newest first");
  } finally { act(() => root.unmount()); log.mockRestore(); }
});
