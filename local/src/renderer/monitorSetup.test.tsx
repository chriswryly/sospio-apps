// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MonitorSetup } from "./App";

afterEach(() => vi.unstubAllGlobals());

it("shows the first-run token screen and submits through the protected app bridge", async () => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); const root = createRoot(node); const save = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<MonitorSetup url="https://monitor.sosp.io" save={save} claim={vi.fn()} />));
  expect(node.textContent).toContain("Enter your Sospio monitor token");
  expect(node.querySelector<HTMLInputElement>('input[type="password"]')?.getAttribute("autocomplete")).toBe("off");
  await act(async () => node.querySelector("form:not(.setup-claim)")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(save).toHaveBeenCalledWith({url: "https://monitor.sosp.io", token: ""});
  await act(async () => root.unmount());
});

it("sends the invite code only through the app bridge and clears it on success", async () => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const node = document.createElement("div"); const root = createRoot(node);
  const save = vi.fn(); const claim = vi.fn().mockResolvedValue({ok: true});
  await act(async () => root.render(<MonitorSetup url="https://monitor.sosp.io" save={save} claim={claim} />));
  const input = node.querySelector<HTMLInputElement>(".setup-claim input")!;
  expect(input.type).toBe("password");
  expect(input.autocomplete).toBe("off");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "private-invite-fixture");
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
  await act(async () => node.querySelector(".setup-claim")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(claim).toHaveBeenCalledWith({url: "https://monitor.sosp.io", code: "private-invite-fixture"});
  expect(fetch).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(input.value).toBe("");
  await act(async () => root.unmount());
});

it.each([
  "That invite code didn't work.",
  "Too many tries. Wait 15 minutes.",
  "A token was already given to this network today. Use that token, or try again tomorrow.",
  "Lots of people are getting tokens right now. Try again in an hour.",
  "All trial tokens have been handed out. Contact the person who shared Sospio with you.",
])("shows the main process claim message: %s", async message => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); const root = createRoot(node);
  await act(async () => root.render(<MonitorSetup url="https://monitor.sosp.io" save={vi.fn()} claim={vi.fn().mockResolvedValue({ok: false, message})} />));
  await act(async () => node.querySelector(".setup-claim")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(message);
  await act(async () => root.unmount());
});
