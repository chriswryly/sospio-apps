import { chatgptSpec } from "./providers/chatgpt";
import { claudeaiSpec } from "./providers/claudeai";
import { grokSpec } from "./providers/grok";
import { piaiSpec } from "./providers/piai";
import type { ProviderName } from "../../shared/types";
import type { ProviderSpec } from "./providers/types";

const PIAI_ENABLED = process.env.RSH_BROWSER_HARNESS_ENABLE_PIAI === "1";

const PROVIDERS: ProviderSpec[] = [
  chatgptSpec,
  claudeaiSpec,
  grokSpec,
  { ...piaiSpec, enabled: PIAI_ENABLED },
];

export function providerForUrl(url: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.matches(url));
}

export function enabledProviderForUrl(url: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.enabled && provider.matches(url));
}

export function providerForName(name: ProviderName): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.name === name);
}

export function completionProviderFor(url: string, method: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) =>
    provider.enabled &&
    // Claude keeps its legacy completion parser alongside its primary DOM capture.
    (provider.primary === "network" || provider.name === "claudeai") &&
    provider.networkParser?.isCompletionRequestUrl(url, method)
  );
}

export { PROVIDERS };
