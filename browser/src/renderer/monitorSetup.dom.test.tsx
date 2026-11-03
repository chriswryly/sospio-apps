// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Panel } from "./panel";
import type { HarnessApi, HarnessState } from "../shared/types";

it("shows the token screen before opening browser controls", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.harness = {
    getState: async () => ({monitorConfigured: false, monitorHealth: "error", turns: [], diagnostics: []}),
    onState: () => () => {}, onToast: () => () => {},
  } as unknown as HarnessApi;
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Panel />));
    expect(element.querySelector("h1")?.textContent).toBe("Enter your Sospio monitor token");
    expect(element.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(element.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe("https://monitor.sosp.io");
    expect(element.querySelector("details.operator")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it("clears the monitor token from the app and returns to first run", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let update: (state: HarnessState) => void = () => {};
  const state: HarnessState = {monitorConfigured: true, monitorHealth: "healthy", turns: [], diagnostics: []};
  const clearMonitorSettings = vi.fn(async () => update({...state, monitorConfigured: false}));
  window.harness = {
    getState: async () => state, onState: (callback: (state: HarnessState) => void) => {update = callback; return () => {};},
    onToast: () => () => {}, clearMonitorSettings,
  } as unknown as HarnessApi;
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Panel />));
    await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Clear monitor token")!.click());
    expect(clearMonitorSettings).toHaveBeenCalledOnce();
    expect(element.querySelector("h1")?.textContent).toBe("Enter your Sospio monitor token");
  } finally { await act(async () => root.unmount()); }
});
