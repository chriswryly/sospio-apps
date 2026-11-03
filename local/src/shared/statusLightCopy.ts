export const STATUS_LIGHT_COPY_VERSION = "status_light_copy_v0_1_provisional";

export const STATUS_LIGHT_COPY = {
  none: { label: "No reading yet", description: "Sospio hasn't read a reply yet." },
  green: { label: "Nothing stands out", description: "Sospio's check isn't seeing a pattern right now." },
  amber: { label: "Worth a look", description: "Sospio's check has noticed something that may be worth a second look." },
  red: { label: "Concern persisting", description: "Sospio's check keeps seeing a pattern and has stepped in." },
  grey: { label: "Not checking", description: "Sospio can't check this conversation right now." },
  checking: "Checking the latest reply…",
  basis: (n: number) => `Based on turn ${n}.`,
  showTurn: (n: number) => `Show turn ${n}`,
  tier: (n: number) => `Tier ${n} in force`,
  disclaimer: "This light shows what Sospio's check is reading. It can be wrong, and green doesn't mean the conversation is safe.",
};
