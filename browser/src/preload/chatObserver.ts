import { ClaudeDomCapture, DOM_TEXT_SETTLE_MS } from "./claudeDomCapture";
import { mountJudgeNotice, type PageJudgeNotice } from "./judgeNotice";
import { ipcRenderer } from "electron";

type DomObserverConfig = {
  enabled: boolean;
  provider?: "chatgpt" | "claudeai" | "grok" | "piai";
  selectors?: {
    conversationContainerSelector: string;
    userMessageSelectors: ReadonlyArray<string>;
    assistantMessageSelectors: ReadonlyArray<string>;
    textSelectors?: ReadonlyArray<string>;
    completeSelectors?: ReadonlyArray<string>;
  };
};

let claudeCapture: ClaudeDomCapture | undefined;
let observer: MutationObserver | undefined;
let config: DomObserverConfig = { enabled: false };
let seenUserText = "";
let lastAssistantText = "";
let assistantTimer: number | undefined;

ipcRenderer.on("harness:dom-observer-config", (_event, nextConfig: DomObserverConfig) => {
  config = nextConfig;
  stopObserver();
  if (config.enabled) {
    void startObserver();
  }
});

ipcRenderer.on("harness:dom-user-send", () => claudeCapture?.userSend());
window.addEventListener("beforeunload", stopObserver);

async function startObserver(): Promise<void> {
  const selectors = config.selectors;
  if (!config.provider || !selectors) {
    emitDiagnostic("DOM observer enabled without provider selectors");
    return;
  }
  if (config.provider === "claudeai") {
    claudeCapture = new ClaudeDomCapture(selectors, node => {
      const text = extractText(node, selectors.textSelectors);
      return isSubstantive(text) ? text : "";
    }, payload => ipcRenderer.send("harness:dom-event", {
      ...payload, provider: "claudeai", url: location.origin + location.pathname,
      occurred_at: new Date().toISOString(),
    }));
    return;
  }
  const container = await waitForElement(selectors.conversationContainerSelector, 30_000);
  if (!container) {
    emitDiagnostic(`DOM observer container not found: ${selectors.conversationContainerSelector}`);
    return;
  }
  observer = new MutationObserver(() => scan(container));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  ipcRenderer.send("harness:dom-event", {
    kind: "ready",
    provider: config.provider,
    url: location.href,
    occurred_at: new Date().toISOString(),
  });
  scan(container);
}

function stopObserver(): void {
  claudeCapture?.stop();
  claudeCapture = undefined;
  if (observer) {
    observer.disconnect();
    observer = undefined;
  }
  if (assistantTimer !== undefined) {
    window.clearTimeout(assistantTimer);
    assistantTimer = undefined;
  }
}

function scan(container: Element): void {
  const selectors = config.selectors;
  if (!config.enabled || !config.provider || !selectors) {
    return;
  }
  const userText = latestText(container, selectors.userMessageSelectors, selectors.textSelectors);
  if (userText && userText !== seenUserText) {
    seenUserText = userText;
    ipcRenderer.send("harness:dom-event", {
      kind: "user_turn",
      provider: config.provider,
      text: userText,
      dom_id: `dom-user-${Date.now()}`,
      url: location.origin + location.pathname,
      occurred_at: new Date().toISOString(),
    });
  }
  const assistantText = latestText(container, selectors.assistantMessageSelectors, selectors.textSelectors);
  if (assistantText && assistantText !== lastAssistantText) {
    lastAssistantText = assistantText;
    if (assistantTimer !== undefined) {
      window.clearTimeout(assistantTimer);
    }
    assistantTimer = window.setTimeout(() => {
      if (!lastAssistantText || !assistantComplete(container, selectors)) {
        return;
      }
      ipcRenderer.send("harness:dom-event", {
        kind: "assistant_complete",
        provider: config.provider,
        final_text: lastAssistantText,
        dom_id: `dom-assistant-${Date.now()}`,
        url: location.origin + location.pathname,
        occurred_at: new Date().toISOString(),
      });
    }, DOM_TEXT_SETTLE_MS);
  }
}

function latestText(
  container: Element,
  messageSelectors: ReadonlyArray<string>,
  textSelectors: ReadonlyArray<string> | undefined,
): string {
  const messages = queryAll(container, messageSelectors);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractText(messages[index], textSelectors);
    if (isSubstantive(text)) {
      return text;
    }
  }
  return "";
}

function extractText(root: Element, textSelectors: ReadonlyArray<string> | undefined): string {
  if (textSelectors?.length) {
    const textNodes = queryAll(root, textSelectors);
    for (let index = textNodes.length - 1; index >= 0; index -= 1) {
      const text = cleanText((textNodes[index] as HTMLElement).innerText || textNodes[index].textContent || "");
      if (isSubstantive(text)) {
        return text;
      }
    }
  }
  const clone = root.cloneNode(true);
  if (clone instanceof HTMLElement) {
    for (const selector of ["button", "[role='button']", "svg", "textarea", "input", "select", "nav", "menu"]) {
      for (const removable of clone.querySelectorAll(selector)) {
        removable.remove();
      }
    }
    return cleanText(clone.innerText || clone.textContent || "");
  }
  return cleanText(root.textContent || "");
}

function assistantComplete(container: Element, selectors: NonNullable<DomObserverConfig["selectors"]>): boolean {
  if (!selectors.completeSelectors?.length) {
    return true;
  }
  return queryAll(container, selectors.completeSelectors).length > 0;
}

function queryAll(root: Element | Document, selectors: ReadonlyArray<string>): Element[] {
  const seen = new Set<Element>();
  const matches: Element[] = [];
  for (const selector of selectors) {
    try {
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          matches.push(element);
        }
      }
    } catch {
      emitDiagnostic(`invalid DOM observer selector: ${selector}`);
    }
  }
  return matches;
}

function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 250);
    };
    tick();
  });
}

function emitDiagnostic(reason: string): void {
  ipcRenderer.send("harness:dom-event", {
    kind: "diagnostic",
    provider: config.provider,
    reason,
    url: location.origin + location.pathname,
    occurred_at: new Date().toISOString(),
  });
}

function cleanText(text: string): string {
  return text.replace(/\u00a0/g, " ").trim();
}

function isSubstantive(text: string): boolean {
  const normalized = cleanText(text);
  if (!normalized || normalized.length > 12_000) {
    return false;
  }
  return !UI_CHROME_TEXT.has(normalized.toLowerCase()) && /[\p{L}\p{N}]/u.test(normalized);
}

const UI_CHROME_TEXT = new Set([
  "copy",
  "copied",
  "dislike",
  "like",
  "bad response",
  "good response",
  "more options",
  "regenerate",
  "retry",
  "share",
]);

// The privileged bridge exposes only actions on notice IDs issued by the main process.
ipcRenderer.on("harness:judge-notice", (_event, payload: PageJudgeNotice) => {
  mountJudgeNotice(payload, (id, action) => ipcRenderer.invoke("harness:judge-notice-action", id, action));
});
ipcRenderer.on("harness:remove-judge-notice", (_event, id: string) => document.getElementById(id)?.remove());
