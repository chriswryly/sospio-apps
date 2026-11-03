import type { ProviderName } from "../../shared/types";

/**
 * The single per-provider table of conversation-turn selectors.
 *
 * Before this module the same knowledge lived as two independent ternaries inside page-script
 * template literals — `assistantSelectors()` in pageInterventionShim and `latestUserTurn()` in
 * cdpClient — each with a ChatGPT branch and a Grok-shaped "generic" fallback. When claude.ai
 * became a study provider both silently fell through to the Grok selectors, which match nothing
 * on Claude: `replace_presentation` failed with `assistant_not_found`, and the withhold marker
 * lost its anchor and was appended to the end of `<main>` instead of after the user's turn.
 *
 * Page scripts cannot import, so the table is serialized into them via
 * `providerTurnSelectorsShimSource()`. Adding a provider is one edit here.
 */
export type TurnSelectors = {
  user: string[];
  assistant: string[];
};

/**
 * Heuristic selectors that happen to fit Grok's consumer web surface. Kept only for providers
 * whose surface was never characterized. It is NOT a safe default for a study provider — a
 * provider that lands here silently behaves as if the DOM were empty.
 */
const UNCHARACTERIZED_FALLBACK: TurnSelectors = {
  user: [
    '[data-message-author-role="user"]',
    '[data-testid*="user" i][data-testid*="message" i]',
    '[class*="user-message" i]',
  ],
  assistant: [
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant" i][data-testid*="message" i]',
    '[data-testid*="response" i]',
    '[class*="assistant-message" i]',
  ],
};

const PROVIDER_TURN_SELECTORS: Record<ProviderName, TurnSelectors> = {
  // Characterized 2026-10-03 from DevTools counts on a live conversation.
  // New user and assistant markers each matched seven nodes; nesting not established.
  chatgpt: {
    user: ['[data-user-message-bubble]', '[data-message-author-role="user"]'],
    assistant: ['[data-conversation-role="assistant"]', '[data-message-author-role="assistant"]'],
  },
  // Characterized 2026-08-09 from a live `describeConversationDomScript()` run against
  // claude.ai build 56315ec993 (14-exchange conversation, 1738 elements).
  //
  // `div[role="article"]` wraps both roles (28 = 14 user + 14 assistant) so it identifies a turn
  // but cannot tell whose it is. The two role-discriminating markers each matched exactly 14:
  // `data-cds="UserMessage"` (a design-system component marker, short texts) and
  // `data-is-streaming` (assistant-only by meaning, long texts).
  //
  // `data-is-streaming` is matched on attribute *presence*, never `="false"`. The value flips to
  // "true" while a response streams, and a governor whose selector only matched completed turns
  // would fail to see the very turn it is trying to mediate.
  claudeai: {
    user: ['div[data-cds="UserMessage"]', '[data-testid="user-message"]'],
    assistant: ["div[data-is-streaming]"],
  },
  grok: UNCHARACTERIZED_FALLBACK,
  piai: UNCHARACTERIZED_FALLBACK,
};

export function turnSelectorsFor(provider: ProviderName): TurnSelectors {
  return PROVIDER_TURN_SELECTORS[provider] ?? { user: [], assistant: [] };
}

export function hasCharacterizedDom(provider: ProviderName): boolean {
  const selectors = turnSelectorsFor(provider);
  return selectors.user.length > 0 && selectors.assistant.length > 0;
}

/**
 * Emits `rshTurnSelectors(provider, role)` into a page script, backed by the same table.
 * Returns `[]` for an uncharacterized provider so callers can distinguish "no selectors" from
 * "selectors matched nothing".
 */
export function providerTurnSelectorsShimSource(): string {
  return `
  const RSH_TURN_SELECTORS = ${JSON.stringify(PROVIDER_TURN_SELECTORS)};
  function rshTurnSelectors(provider, role) {
    const entry = RSH_TURN_SELECTORS[provider];
    if (!entry) return [];
    return (role === "user" ? entry.user : entry.assistant) || [];
  }
  // Callers take .at(-1) to mean "the most recent turn". Nodes gathered selector-by-selector are
  // in per-selector order, so with more than one selector the last element is the last match of
  // the last selector, not the last turn on the page. Re-sort into document order so "latest"
  // means latest. 4 = Node.DOCUMENT_POSITION_FOLLOWING.
  function rshDocumentOrder(nodes) {
    return nodes.slice().sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
  }`;
}

export { PROVIDER_TURN_SELECTORS, UNCHARACTERIZED_FALLBACK };
