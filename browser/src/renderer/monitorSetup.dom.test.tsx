// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { expect, it, vi } from "vitest";
import { MonitorSetup, Panel } from "./panel";
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
    const clear = () => [...element.querySelectorAll("button")].find(button => button.textContent === "Clear monitor token (can't be undone)")!;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => clear().click());
    expect(clearMonitorSettings).not.toHaveBeenCalled();
    await act(async () => clear().click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(clearMonitorSettings).toHaveBeenCalledOnce();
    expect(element.querySelector("h1")?.textContent).toBe("Enter your Sospio monitor token");
  } finally { await act(async () => root.unmount()); }
});

it("claims through the main bridge with a password invite field while keeping pasted tokens", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const claimMonitorToken = vi.fn(async () => ({ok: true as const}));
  const saveMonitorSettings = vi.fn(async () => undefined);
  const fetchClaim = vi.fn();
  vi.stubGlobal("fetch", fetchClaim);
  window.harness = {claimMonitorToken, saveMonitorSettings} as unknown as HarnessApi;
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<MonitorSetup url="https://monitor.example" />));
    const claimForm = element.querySelector<HTMLFormElement>("form.setup-claim")!;
    const code = claimForm.querySelector<HTMLInputElement>("input")!;
    expect(code.type).toBe("password");
    expect(code.autocomplete).toBe("off");
    expect(claimForm.querySelector("button")!.disabled).toBe(true);
    await act(async () => Simulate.change(code, {target: {value: "fixture-invite"}} as any));
    await act(async () => Simulate.submit(claimForm));
    expect(claimMonitorToken).toHaveBeenCalledWith({url: "https://monitor.example", code: "fixture-invite"});
    expect(code.value).toBe("");
    expect(fetchClaim).not.toHaveBeenCalled();
    expect(saveMonitorSettings).not.toHaveBeenCalled();
    const tokenForm = element.querySelector<HTMLFormElement>("form:not(.setup-claim)")!;
    const token = tokenForm.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => Simulate.change(token, {target: {value: "pasted-fixture-token"}} as any));
    await act(async () => Simulate.submit(tokenForm));
    expect(saveMonitorSettings).toHaveBeenCalledWith({url: "https://monitor.example", token: "pasted-fixture-token"});
    expect(token.value).toBe("");
    expect(fetchClaim).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it.each([
  "That invite code didn't work.",
  "Too many tries. Wait 15 minutes.",
  "A token was already given to this network today. Use that token, or try again tomorrow.",
  "Lots of people are getting tokens right now. Try again in an hour.",
  "All trial tokens have been handed out. Contact the person who shared Sospio with you.",
])("shows the claim message: %s", async message => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const claimMonitorToken = vi.fn(async () => ({ok: false as const, message}));
  window.harness = {claimMonitorToken} as unknown as HarnessApi;
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<MonitorSetup url="https://monitor.example" />));
    const form = element.querySelector<HTMLFormElement>("form.setup-claim")!;
    await act(async () => Simulate.change(form.querySelector("input")!, {target: {value: "fixture-invite"}} as any));
    await act(async () => Simulate.submit(form));
    expect(element.querySelector('[role="alert"]')!.textContent).toBe(message);
    expect(form.querySelector("button")!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
