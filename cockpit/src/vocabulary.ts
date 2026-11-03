import type { Reading, ReceiptStatus, SignalKey } from "./contract";
export const SIGNALS: Record<
  SignalKey,
  { name: string; side: string; icon: string }
> = {
  sycophancy: { name: "Sycophancy", side: "Assistant’s side", icon: "S" },
  overreliance: { name: "Overreliance", side: "User’s side", icon: "O" },
  emotional_dependence: { name: "Emotional dependence", side: "User and assistant", icon: "E" },
};
export const RUNGS = ["Notice", "Shared note", "Final note", "Close"] as const;
export const READINGS = {
  clear: "Clear",
  uncertain: "Uncertain",
  unavailable: "Unavailable",
  monitoring_unavailable: "Monitoring unavailable",
  pending: "Pending…",
  not_covered: "Not covered",
  starting: "Starting up…",
  no_turns: "No turns yet",
};
export const TURN_LIMIT_REACHED = "Turn limit reached";
export function readingLabel(r: Reading): string {
  if (r.kind === "unavailable" && r.limit) return TURN_LIMIT_REACHED;
  return r.kind === "flagged" ? `Flagged · ${r.strength}` : READINGS[r.kind];
}
export const RECEIPTS: Record<
  ReceiptStatus,
  { label: string; icon: string; fg: string; bg: string; border: string }
> = {
  verified: {
    label: "Done · verified",
    icon: "✓",
    fg: "ink",
    bg: "paper",
    border: "solid",
  },
  unverified: {
    label: "Done · not verified",
    icon: "?",
    fg: "ink",
    bg: "paper",
    border: "dashed",
  },
  failed: {
    label: "Failed",
    icon: "✕",
    fg: "red",
    bg: "red-tint",
    border: "solid",
  },
  capped: {
    label: "Capped",
    icon: "▭",
    fg: "blue",
    bg: "blue-tint",
    border: "solid",
  },
  not_permitted: {
    label: "Not permitted on this run",
    icon: "⊘",
    fg: "muted",
    bg: "paper",
    border: "dashed",
  },
  queued: {
    label: "Waiting for your next message",
    icon: "…",
    fg: "muted",
    bg: "paper",
    border: "dotted",
  },
  running: {
    label: "In progress",
    icon: "◷",
    fg: "ink",
    bg: "paper",
    border: "dotted",
  },
  shown: {
    label: "Shown · no reply yet",
    icon: "✓",
    fg: "ink",
    bg: "paper",
    border: "solid",
  },
  shown_with_reply: {
    label: "Shown with the reply",
    icon: "✓",
    fg: "ink",
    bg: "paper",
    border: "solid",
  },
  sent_to_assistant: {
    label: "Sent to the assistant",
    icon: "→",
    fg: "ink",
    bg: "paper",
    border: "solid",
  },
};
// A pending verdict must not read as "clear" (design brief, "Other states").
export function pendingHealth(ordinal: number) {
  return {
    title: `Reading turn ${ordinal}…`,
    tag: "Verdict pending",
    sub: `Readings for the latest turn aren’t in yet. Until they are, turn ${ordinal} isn’t clear or flagged.`,
  };
}
export const PENDING_TURN_NOTE =
  "Waiting for the monitors. This turn isn’t clear or flagged yet.";
export function lastReadingNote(r: Reading, ordinal: number): string {
  const label =
    r.kind === "flagged"
      ? `flagged (${r.strength})`
      : readingLabel(r).toLowerCase();
  return `Last reading: ${label} on turn ${ordinal}.`;
}
