import type { HostedUsage, HostedChatMetadata, HostedSpendState } from "../shared/types";
import { HOSTED_COPY } from "../shared/hostedCopy";
import type { ChatMessage } from "./chatClient";
import { HOSTED_MAX_PROMPT_TOKENS, HOSTED_MAX_TOKENS, type HostedModel } from "./config";

export type HostedSpendRecord = {
  record_type: "hosted_spend";
  model: string;
  generation_id?: string;
  reserved_usd: number;
  settled_usd: number;
  basis: HostedChatMetadata["basis"];
  cumulative_usd: number;
  cap_usd: number;
  estimated: true;
};
type Reservation = { model: HostedModel; promptBound: number; units: number };
const SCALE = 1e9;
const units = (usd: number) => Math.ceil(usd * SCALE);

/** Text-only byte bound, plus deliberately large allowances for provider chat framing. */
export function promptTokenBound(messages: ChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8") + 1024 * messages.length + 4096;
}
export function reservationUsd(model: HostedModel, promptBound: number): number {
  return (promptBound * model.prompt_usd_per_mtok + HOSTED_MAX_TOKENS * model.completion_usd_per_mtok) / 1e6;
}
export class HostedCapError extends Error {
  readonly code = "hosted_cap_reached";
  constructor(cap: number) { super(`${HOSTED_COPY.cap(cap)} (hosted_cap_reached)`); }
}

/** One launch, shared by every conversation; integer nanodollars avoid fractional cap drift. */
export class HostedSpend {
  private spent = 0;
  private inFlight = new Map<symbol, Reservation>();
  private overrun = false;
  private cap: number;
  constructor(readonly capUsd: number, private minimumReservationUsd = 0) {
    this.cap = Math.floor(capUsd * SCALE);
    if (!Number.isSafeInteger(this.cap) || this.cap <= 0) throw new Error("invalid_hosted_assistant_cap");
  }
  state(): HostedSpendState {
    const remaining = this.cap - this.spent - this.reserved();
    return { cap_usd: this.capUsd, spent_usd: this.spent / SCALE,
      exhausted: this.overrun || remaining <= 0 || remaining < units(this.minimumReservationUsd) };
  }
  reserve(model: HostedModel, messages: ChatMessage[]): symbol {
    const promptBound = promptTokenBound(messages);
    if (promptBound > HOSTED_MAX_PROMPT_TOKENS) throw new Error(HOSTED_COPY.promptLimit);
    if (![model.prompt_usd_per_mtok, model.completion_usd_per_mtok].every(validNumber)) throw new Error("invalid_hosted_prices");
    const amount = units(reservationUsd(model, promptBound));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid_hosted_prices");
    if (this.overrun || this.spent + this.reserved() + amount > this.cap) throw new HostedCapError(this.capUsd);
    const id = Symbol();
    this.inFlight.set(id, { model, promptBound, units: amount });
    return id;
  }
  settle(id: symbol, usage: HostedUsage = {}, failed = false): HostedSpendRecord {
    const reservation = this.inFlight.get(id);
    if (!reservation) throw new Error("hosted_reservation_already_settled");
    const { model, promptBound } = reservation;
    let amount = reservation.units;
    let basis: HostedChatMetadata["basis"] = "reservation";
    if (validNumber(usage.reported_cost_usd)) {
      amount = units(usage.reported_cost_usd);
      basis = "reported_cost";
    } else if (!failed && validTokens(usage.prompt_tokens) && validTokens(usage.completion_tokens)) {
      amount = units((usage.prompt_tokens * model.prompt_usd_per_mtok + usage.completion_tokens * model.completion_usd_per_mtok) / 1e6);
      basis = "token_prices";
    }
    if (!Number.isSafeInteger(amount)) { amount = reservation.units; basis = "reservation"; this.overrun = true; }
    this.overrun ||= amount > reservation.units || (usage.prompt_tokens ?? 0) > promptBound || (usage.completion_tokens ?? 0) > HOSTED_MAX_TOKENS;
    this.inFlight.delete(id);
    this.spent += amount;
    return { record_type: "hosted_spend", model: model.id, ...(usage.generation_id ? {generation_id: usage.generation_id} : {}),
      reserved_usd: reservation.units / SCALE, settled_usd: amount / SCALE, basis,
      cumulative_usd: this.spent / SCALE, cap_usd: this.capUsd, estimated: true };
  }
  /** Roll back only before dispatch, when another ledger refuses the same turn. */
  cancel(id: symbol): void {
    if (!this.inFlight.delete(id)) throw new Error("hosted_reservation_missing");
  }
  private reserved(): number { return [...this.inFlight.values()].reduce((n, r) => n + r.units, 0); }
}
export function validNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function validTokens(value: unknown): value is number { return validNumber(value) && Number.isSafeInteger(value); }

/** Atomic admission to a visitor and launch ledger; identical usage settles both. */
export class ComposedHostedSpend {
  private reservations = new Map<symbol, [symbol, symbol]>();
  constructor(private server: HostedSpend, private visitor: HostedSpend) {}
  state(): HostedSpendState {
    const own = this.visitor.state();
    return {...own, exhausted: own.exhausted || this.server.state().exhausted};
  }
  reserve(model: HostedModel, messages: ChatMessage[]): symbol {
    const first = this.server.reserve(model, messages);
    try {
      const second = this.visitor.reserve(model, messages), id = Symbol();
      this.reservations.set(id, [first, second]); return id;
    } catch (error) { this.server.cancel(first); throw error; }
  }
  settle(id: symbol, usage: HostedUsage = {}, failed = false): HostedSpendRecord {
    const pair = this.reservations.get(id);
    if (!pair) throw new Error("hosted_reservation_already_settled");
    this.reservations.delete(id);
    this.server.settle(pair[0], usage, failed);
    return this.visitor.settle(pair[1], usage, failed);
  }
  /** Cancel a web admission preview before any dispatch or settlement. */
  cancel(id: symbol): void {
    const pair = this.reservations.get(id);
    if (!pair) throw new Error("hosted_reservation_missing");
    this.reservations.delete(id);
    this.server.cancel(pair[0]); this.visitor.cancel(pair[1]);
  }
}
export type HostedSpendLedger = Pick<HostedSpend, "reserve" | "settle" | "state">;
