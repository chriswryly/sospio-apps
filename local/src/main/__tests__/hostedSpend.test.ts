import { expect, it } from "vitest";
import { HostedSpend, promptTokenBound, reservationUsd } from "../hostedSpend";
import { model } from "./hostedFixtures";
const messages = [{role: "user" as const, content: "hello"}];
it("bounds UTF8 text and framing rather than estimating English token density", () => {
  const unicode = [{role: "user" as const, content: "😸漢字".repeat(20)}];
  expect(promptTokenBound(unicode)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(unicode)));
  expect(promptTokenBound(unicode)).toBeGreaterThan(promptTokenBound(messages));
});
it("refuses crossing and concurrent reservations without losing the first", () => {
  const reserve = reservationUsd(model, promptTokenBound(messages));
  const ledger = new HostedSpend(reserve * 1.5);
  const first = ledger.reserve(model, messages);
  expect(() => ledger.reserve(model, messages)).toThrow("hosted_cap_reached");
  expect(ledger.settle(first).settled_usd).toBeCloseTo(reserve, 8);
  expect(() => ledger.settle(first)).toThrow("already_settled");
});
it.each([
  [{reported_cost_usd: 0.001, prompt_tokens: 1, completion_tokens: 1}, false, "reported_cost", 0.001],
  [{prompt_tokens: 100, completion_tokens: 10}, false, "token_prices", (100 * model.prompt_usd_per_mtok + 10 * model.completion_usd_per_mtok) / 1e6],
  [{reported_cost_usd: 0}, true, "reported_cost", 0],
  [{}, false, "reservation", undefined],
  [{prompt_tokens: 1}, false, "reservation", undefined],
  [{reported_cost_usd: -1}, false, "reservation", undefined],
  [{reported_cost_usd: NaN}, false, "reservation", undefined],
  [{prompt_tokens: 1, completion_tokens: 1}, true, "reservation", undefined],
] as const)("settles usage %j (failed %s) with %s", (usage, failed, basis, amount) => {
  const ledger = new HostedSpend(1);
  const id = ledger.reserve(model, messages);
  const settled = ledger.settle(id, usage, failed);
  expect(settled.basis).toBe(basis);
  expect(settled.settled_usd).toBeCloseTo(amount ?? settled.reserved_usd, 9);
  expect(settled.cumulative_usd).toBe(settled.settled_usd);
  expect(settled.estimated).toBe(true);
});
it("records real overruns and latches further requests off", () => {
  const ledger = new HostedSpend(1);
  const id = ledger.reserve(model, messages);
  expect(ledger.settle(id, {reported_cost_usd: 1.2}).settled_usd).toBe(1.2);
  expect(ledger.state().exhausted).toBe(true);
  expect(() => ledger.reserve(model, messages)).toThrow("hosted_cap_reached");
});
it("latches a violated token bound even when cost is low", () => {
  const ledger = new HostedSpend(1);
  ledger.settle(ledger.reserve(model, messages), {reported_cost_usd: 0.001, completion_tokens: 1025});
  expect(ledger.state().exhausted).toBe(true);
});
it("rejects oversized prompts and releases the full reservation after settlement", () => {
  const ledger = new HostedSpend(1);
  expect(() => ledger.reserve(model, [{role: "user", content: "a".repeat(64000)}])).toThrow("prompt exceeds");
  for (let i = 0; i < 60; i++) ledger.settle(ledger.reserve(model, messages), {reported_cost_usd: 0});
  expect(ledger.state().spent_usd).toBe(0);
});
