import { providerForUrl } from "./capture/providerRegistry";
import { supportsMediation, type ProviderName, type TurnEvent } from "../shared/types";

export function providerFromNavigation(url: string): ProviderName | undefined {
  const provider = providerForUrl(url);
  return provider?.enabled ? provider.name : undefined;
}

/** These URL IDs are also the network response/request conversation IDs. */
export function conversationIdFromUrl(url: string): string | null {
  const provider = providerFromNavigation(url);
  try {
    const path = new URL(url).pathname;
    const match = provider === "chatgpt" ? /^\/c\/([^/]+)/.exec(path)
      : provider === "claudeai" ? /^\/chat\/([^/]+)/.exec(path) : null;
    const id = match?.[1] ? decodeURIComponent(match[1]) : null;
    // ChatGPT assigns a local draft ID before replacing it with the response's server ID.
    return provider === "chatgpt" && id?.startsWith("local-chatgpt:") ? null : id;
  } catch { return null; }
}

export function conversationChanged(before: string, after: string): boolean {
  if (providerFromNavigation(before) !== providerFromNavigation(after)) return true;
  const oldId = conversationIdFromUrl(before), newId = conversationIdFromUrl(after);
  // A new chat acquires its server ID on the first send; this is not a different chat.
  return oldId !== null && oldId !== newId;
}

export function governorSurfaceBlock(
  provider: ProviderName | undefined, conversationId: string | null, turn: TurnEvent,
): { status: "failed" | "superseded"; detail: string } | null {
  if (!supportsMediation(provider) || provider !== turn.provider) {
    return { status: "failed", detail: "no active provider surface for this turn" };
  }
  return turn.session_id !== conversationId
    ? { status: "superseded", detail: "conversation changed before the verdict arrived" } : null;
}
