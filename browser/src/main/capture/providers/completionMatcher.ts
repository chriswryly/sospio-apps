import type { ProviderName } from "../../../shared/types";

type CompletionRuleProviderName = Extract<ProviderName, "chatgpt" | "claudeai" | "grok">;

type CompletionRule = {
  exactHosts: string[];
  suffixHosts?: string[];
  pathStartsWith?: string;
  pathPattern: string;
  pathFlags: string;
  excludePathPattern?: string;
  excludePathFlags?: string;
};

const COMPLETION_RULES: Record<CompletionRuleProviderName, CompletionRule> = {
  chatgpt: {
    exactHosts: ["chatgpt.com", "chat.openai.com"],
    pathStartsWith: "/backend-api/",
    pathPattern: "(^|/)(conversation|responses|completion|message|messages)(/|$)",
    pathFlags: "i",
    // `/backend-api/f/conversation/prepare` is fired on the first keystroke of a draft, carrying
    // the one character typed so far. It matched on `/conversation/`, and because its response
    // holds no assistant text the page hook's DOM fallback paired it with the previous answer —
    // emitting a turn that never happened, into the session log and on to the monitor.
    excludePathPattern: "(/experimental/|(^|/)prepare(/|$))",
    excludePathFlags: "i",
  },
  claudeai: {
    exactHosts: ["claude.ai"],
    pathPattern: "^/api/organizations/[^/]+/chat_conversations/[^/]+/completion$",
    pathFlags: "",
  },
  grok: {
    exactHosts: ["grok.com"],
    suffixHosts: [".grok.com"],
    pathPattern: "/(rest/)?(app-chat|chat|conversation|conversations|responses?|completion|message|messages)(/|$)",
    pathFlags: "i",
    excludePathPattern: "(feedback|rating|telemetry|analytics)",
    excludePathFlags: "i",
  },
};

export function isProviderCompletionRequestUrl(
  provider: CompletionRuleProviderName,
  url: string,
  method: string,
): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }
  return completionRuleMatches(COMPLETION_RULES, provider, url);
}

export function isProviderCompletionUrl(
  provider: CompletionRuleProviderName,
  url: string,
): boolean {
  return completionRuleMatches(COMPLETION_RULES, provider, url);
}

export function completionMatcherShimSource(): string {
  return [
    `const RSH_COMPLETION_RULES = ${JSON.stringify(COMPLETION_RULES)};`,
    hostMatches.toString(),
    completionRuleMatches.toString(),
    `function rshIsCompletionRequestUrl(provider, url, method) {
      if (String(method || "GET").toUpperCase() !== "POST") return false;
      return completionRuleMatches(RSH_COMPLETION_RULES, provider, url);
    }`,
    `function rshIsCompletionUrl(provider, url) {
      return completionRuleMatches(RSH_COMPLETION_RULES, provider, url);
    }`,
  ].join("\n");
}

function completionRuleMatches(
  rules: Record<string, CompletionRule>,
  provider: string,
  url: string,
): boolean {
  const rule = rules[provider];
  if (!rule) {
    return false;
  }
  try {
    const parsed = new URL(url, typeof location === "undefined" ? undefined : location.href);
    if (!hostMatches(parsed.hostname, rule)) {
      return false;
    }
    if (rule.pathStartsWith && !parsed.pathname.startsWith(rule.pathStartsWith)) {
      return false;
    }
    if (rule.excludePathPattern && new RegExp(rule.excludePathPattern, rule.excludePathFlags || "").test(parsed.pathname)) {
      return false;
    }
    return new RegExp(rule.pathPattern, rule.pathFlags || "").test(parsed.pathname);
  } catch {
    return false;
  }
}

function hostMatches(hostname: string, rule: CompletionRule): boolean {
  if (rule.exactHosts.includes(hostname)) {
    return true;
  }
  return Boolean(rule.suffixHosts?.some((suffix) => hostname.endsWith(suffix)));
}
