export const COCKPIT_VIEW_SCHEMA = "sospio_cockpit_view_v1";
export type CockpitApp = "chat" | "browser";
export type SignalKey = "sycophancy" | "overreliance" | "emotional_dependence"; // always rendered in this order
export type Tier = 1 | 2 | 3 | 4;

export type Reading =
  | { kind: "clear" }
  | { kind: "flagged"; strength: "present" | "strong" } // D1: no "emergent" here
  | { kind: "uncertain" } // includes emergent (decision note §4.8); never carries a count
  | { kind: "unavailable"; limit?: true } // limit: the judge's per-launch turn or budget cap was reached
  | { kind: "monitoring_unavailable" } // signal-level only, after 3 in a row
  | { kind: "pending" }
  | { kind: "not_covered" }
  | { kind: "starting" }
  | { kind: "no_turns" };

export type ReceiptStatus =
  | "verified"
  | "unverified"
  | "failed"
  | "capped"
  | "not_permitted"
  | "queued" // "Waiting for your next message"
  | "running" // "In progress"
  | "shown" // "Shown · no reply yet" (check-in)
  | "shown_with_reply" // orchestrator: a notice Sospio put above the assistant's reply
  | "sent_to_assistant"; // orchestrator: a note Sospio added to the request for this reply

export type LadderState =
  | { known: true; tier: 0 | Tier } // 0 = no tier reached
  | { known: false }; // renders "Ladder not reported" (§4)

export type SignalView = {
  key: SignalKey;
  reading: Reading;
  ladder: LadderState;
  note?: string;
};

export type ReceiptView = {
  id: string;
  tier: Tier | null; // null renders the chip "Notice" (uncertainty notices, check-ins)
  signal: SignalKey | null;
  title: string;
  status: ReceiptStatus;
  why: string; // includes the verification method (plan D6)
  text?: { label: string; body: string; open: boolean };
  technical: Array<[key: string, value: string]>; // rendered "key: value" in the mono <pre>
};

export type EvidenceView = {
  signal: SignalKey;
  reading: Reading;
  quote: string;
  counter: string;
};

export type TurnCardView = {
  ordinal: number;
  unnumbered?: boolean; // ordinal is an ordering key only for unjudged captures
  time: string;
  user: string;
  assistant: string;
  readings: Record<Exclude<SignalKey, "emotional_dependence">, Reading> &
    Partial<Record<"emotional_dependence", Reading>>;
  note?: { text: string; hatched: boolean };
  evidence: EvidenceView[];
  receipts: ReceiptView[];
};

export type BannerButton = {
  label: string;
  primary: boolean;
  action: BannerAction;
};
export type BannerAction =
  | "dismiss"
  | "show_turns"
  | "look_together"
  | "carry_on"
  | "copy_transcript"
  | "new_conversation"
  | "retry_close";

export type BannerView =
  | {
      kind: "countdown";
      eyebrow: string;
      titleTemplate: string;
      body: string;
      endsAt: string;
      totalSeconds: number;
    }
  | {
      kind:
        | "closed"
        | "failed_close"
        | "monitoring_unavailable"
        | "uncertainty"
        | "checkin";
      eyebrow: string;
      title: string;
      body: string;
      signal?: SignalKey;
      buttons: BannerButton[];
      cited?: number[];
    }; // uncertainty/checkin: the ordinals the notice names (rev. 3)

export type CockpitView = {
  schema: typeof COCKPIT_VIEW_SCHEMA;
  app: CockpitApp;
  turnCountLabel: string;
  assistantModel: {
    name: string;
    provider?: string;
    note: string;
    known: boolean;
  };
  health: { title: string; tag: string; sub: string };
  latest?: { text: string; status: ReceiptStatus };
  signals: SignalView[];
  banner?: BannerView;
  turns: TurnCardView[]; // newest first
};
