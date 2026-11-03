// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MonitorSetup } from "./App";

it("shows the first-run token screen and submits through the protected app bridge", async () => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); const root = createRoot(node); const save = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<MonitorSetup url="https://monitor.sosp.io" save={save} />));
  expect(node.textContent).toContain("Enter your Sospio monitor token");
  expect(node.querySelector<HTMLInputElement>('input[type="password"]')?.getAttribute("autocomplete")).toBe("off");
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(save).toHaveBeenCalledWith({url: "https://monitor.sosp.io", token: ""});
  await act(async () => root.unmount());
});
