import type { ProviderName } from "../../shared/types";
import { completionMatcherShimSource } from "./providers/completionMatcher";
import { providerTurnSelectorsShimSource } from "./providerDomSelectors";
import { requestPromptExtractorShimSource } from "./providers/requestPrompt";

export type ResponseMediationAction =
  | "withhold_candidate"
  | "replace_presentation";

export const PAGE_INTERVENTION_API = "__rshGovernorSpikeV2";
export const REPLACE_PRESENTATION_TEXT = "The original candidate presentation was replaced by Sospio.";

export function armResponseMediationScript(
  provider: ProviderName,
  action: ResponseMediationAction,
): string {
  return `(() => {
    const api = globalThis[${JSON.stringify(PAGE_INTERVENTION_API)}];
    if (!api || typeof api.arm !== "function") return { ok: false, reason: "shim_unavailable" };
    return api.arm(${JSON.stringify({ provider, action })});
  })()`;
}

export function probeLatestPresentationScript(
  provider: ProviderName,
  action: Exclude<ResponseMediationAction, "withhold_candidate">,
): string {
  return `(() => {
    const api = globalThis[${JSON.stringify(PAGE_INTERVENTION_API)}];
    if (!api || typeof api.probeLatest !== "function") return { ok: false, reason: "shim_unavailable" };
    return api.probeLatest(${JSON.stringify({ provider, action, emitEvidence: false })});
  })()`;
}

/**
 * Installed in the page's main world before provider scripts. It wraps both
 * fetch and EventSource, and owns only one explicitly armed action at a time.
 */
export const PAGE_INTERVENTION_SHIM = `(() => {
  if (globalThis.${PAGE_INTERVENTION_API}) return;
  const originalFetch = globalThis.fetch;
  const OriginalEventSource = globalThis.EventSource;
  const PROBE_TIMEOUT_MS = 30000;
  const USER_SEND_WINDOW_MS = 15000;
  const state = { armed: null, recoveries: new Map(), lastUserSend: null };
  ${completionMatcherShimSource()}
  ${requestPromptExtractorShimSource()}
  ${providerTurnSelectorsShimSource()}

  function providerFor(url) {
    try {
      const hostname = new URL(url, location.href).hostname;
      if (hostname === "chatgpt.com" || hostname === "chat.openai.com") return "chatgpt";
      if (hostname === "claude.ai") return "claudeai";
      if (hostname === "grok.com" || hostname.endsWith(".grok.com")) return "grok";
    } catch {}
    return "unknown";
  }
  function isCompletionEndpoint(url, method, expectedProvider) {
    return rshIsCompletionRequestUrl(expectedProvider, url, method);
  }
  function isCompletionStream(url, expectedProvider) {
    return providerFor(url) === expectedProvider && rshIsCompletionUrl(expectedProvider, url);
  }
  function requestUrl(input) {
    return typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
  }
  function requestMethod(input, init) {
    return String((init && init.method) || (input && input.method) || "GET").toUpperCase();
  }
  async function requestBodyText(input, init) {
    if (init && typeof init.body === "string") return init.body;
    if (init && init.body instanceof URLSearchParams) return init.body.toString();
    if (input && typeof input.clone === "function") {
      try { return await input.clone().text(); } catch {}
    }
    return "";
  }
  function markDomUserSend() {
    const sent = { at: Date.now() };
    state.lastUserSend = sent;
    if (typeof globalThis.rshUserSend === "function") {
      const provider = providerFor(location.href);
      if (provider !== "unknown") {
        globalThis.rshUserSend(JSON.stringify({ provider, at: sent.at }));
      }
    }
  }
  document.addEventListener("submit", markDomUserSend, true);
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest("button,[role='button']")) {
      if (providerFor(location.href) === "claudeai") {
        const button = target.closest("button,[role='button']");
        const label = button.getAttribute("aria-label") || button.getAttribute("data-testid") || "";
        if (!/^(send|send message|send-message)( button)?$/i.test(label.trim()) && button.type !== "submit") return;
      }
      markDomUserSend();
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const target = event.target;
    if (target && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target.isContentEditable)) markDomUserSend();
  }, true);
  function emit(provider, mechanism, status, detail) {
    if (typeof globalThis.rshCapabilityEvidence !== "function") return;
    globalThis.rshCapabilityEvidence(JSON.stringify({ provider, mechanism, status, detail }));
  }
  function clearArmed() {
    const armed = state.armed;
    if (armed && armed.timeout) clearTimeout(armed.timeout);
    state.armed = null;
    return armed;
  }
  function armTimeout(armed) {
    return window.setTimeout(() => {
      if (state.armed !== armed) return;
      state.armed = null;
      emit(armed.provider, armed.action, "failed", "no prompt-correlated completion observed before timeout");
    }, PROBE_TIMEOUT_MS);
  }
  function promptCorrelatedFetch(url, method, rawBody, provider) {
    if (!isCompletionEndpoint(url, method, provider)) return false;
    const prompt = rshExtractUserPrompt(rawBody);
    if (!prompt) return false;
    state.lastUserSend = { at: Date.now() };
    return true;
  }
  function promptCorrelatedStream(url, provider, armed) {
    if (!isCompletionStream(url, provider)) return false;
    return Boolean(state.lastUserSend && state.lastUserSend.at >= armed.armedAt &&
      Date.now() - state.lastUserSend.at <= USER_SEND_WINDOW_MS);
  }
  function assistantSelectors(provider) {
    return rshTurnSelectors(provider, "assistant");
  }
  function latestAssistant(provider) {
    const nodes = [];
    for (const selector of assistantSelectors(provider)) {
      try { for (const node of document.querySelectorAll(selector)) if (!nodes.includes(node)) nodes.push(node); } catch {}
    }
    return rshDocumentOrder(nodes).at(-1) || null;
  }
  function governorSurface(text, mechanism) {
    const surface = document.createElement("section");
    surface.dataset.rshGovernorPresentation = mechanism;
    surface.setAttribute("role", "status");
    surface.style.cssText = "box-sizing:border-box;margin:8px 0;padding:12px 14px;border:1px solid #d89c35;border-radius:8px;background:#241c0f;color:#fff7e6;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    const heading = document.createElement("strong");
    heading.textContent = "Sospio";
    const body = document.createElement("p");
    body.style.margin = "6px 0 0";
    body.textContent = text;
    surface.append(heading, body);
    return surface;
  }
  function addControl(surface, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "margin-top:10px;border:1px solid #80642f;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit";
    button.addEventListener("click", handler, { once: true });
    surface.appendChild(button);
  }
  function displayInterruption(text, mechanism) {
    const surface = governorSurface(text, mechanism);
    surface.style.position = "fixed";
    surface.style.zIndex = "2147483647";
    surface.style.top = "16px";
    surface.style.right = "16px";
    surface.style.width = "min(420px, calc(100vw - 32px))";
    addControl(surface, "Dismiss", () => surface.remove());
    (document.body || document.documentElement).appendChild(surface);
  }
  function replacementSurface(recoveryId, action) {
    const surface = governorSurface(${JSON.stringify(REPLACE_PRESENTATION_TEXT)}, action);
    addControl(surface, "Restore original", () => recover(recoveryId));
    return surface;
  }
  function restoreReplacementControl(recoveryId) {
    const bar = document.createElement("div");
    bar.dataset.rshGovernorControl = "restore-replacement";
    bar.style.cssText = "margin:8px 0";
    addControl(bar, "Restore Sospio replacement", () => reapplyReplacement(recoveryId));
    return bar;
  }
  function recover(recoveryId) {
    // Restore the original answer in place and leave an affordance to re-apply
    // the governor replacement, so Restore is a toggle, not a one-shot. The clone
    // is never mutated, so the original can be restored and re-hidden repeatedly.
    const recovery = state.recoveries.get(recoveryId);
    if (!recovery || !recovery.target.isConnected) return false;
    const fresh = recovery.clone.cloneNode(true);
    recovery.target.replaceChildren(...fresh.childNodes);
    recovery.target.style.display = recovery.display;
    recovery.target.appendChild(restoreReplacementControl(recoveryId));
    recovery.replaced = false;
    return true;
  }
  function reapplyReplacement(recoveryId) {
    const recovery = state.recoveries.get(recoveryId);
    if (!recovery || !recovery.target.isConnected) return false;
    recovery.target.replaceChildren(replacementSurface(recoveryId, recovery.action));
    recovery.replaced = true;
    return true;
  }
  function mediateLatest(provider, action, emitEvidence = true) {
    // An uncharacterized provider has no selectors at all. Reporting that as
    // "assistant not found" would claim we looked; we never knew where to look.
    if (assistantSelectors(provider).length === 0) {
      if (emitEvidence) emit(provider, action, "failed", "no conversation-turn selectors are characterized for " + provider);
      return { ok: false, reason: "no_selectors_for_provider" };
    }
    const target = latestAssistant(provider);
    if (!target || !(target instanceof HTMLElement)) {
      if (emitEvidence) emit(provider, action, "failed", "assistant presentation not found");
      return { ok: false, reason: "assistant_not_found" };
    }
    const recoveryId = "rsh-recovery-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    state.recoveries.set(recoveryId, { target, clone: target.cloneNode(true), display: target.style.display, action, replaced: true });
    // In-place replacement keeps the assistant turn node in history (the judge
    // reads the governor surface as the turn's presentation); the surface and the
    // restored view each carry a control so the user can toggle either way.
    target.replaceChildren(replacementSurface(recoveryId, action));
    return { ok: true, provider, action, recoveryId };
  }
  async function withhold(provider, response) {
    try { await response.body?.cancel("withheld by governor capability probe"); } catch {}
    displayInterruption("The candidate response was withheld by Sospio.", "withhold_candidate");
    const body = [204, 205, 304].includes(response.status) ? null : "";
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (typeof originalFetch === "function") {
    globalThis.fetch = async function rshMediatedFetch(input, init) {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      const rawBody = state.armed ? await requestBodyText(input, init) : "";
      const response = await originalFetch.apply(this, arguments);
      const provider = providerFor(response.url || url);
      const armed = state.armed;
      if (!armed || armed.provider !== provider || !promptCorrelatedFetch(url, method, rawBody, provider)) return response;
      clearArmed();
      if (armed.action === "withhold_candidate") return withhold(provider, response);
      window.setTimeout(() => mediateLatest(provider, armed.action, false), 250);
      return response;
    };
  }
  if (typeof OriginalEventSource === "function") {
    globalThis.EventSource = class RshMediatedEventSource extends OriginalEventSource {
      constructor(url, options) {
        super(url, options);
        const provider = providerFor(String(url));
        const armed = state.armed;
        if (armed && armed.provider === provider && armed.action === "withhold_candidate" && promptCorrelatedStream(String(url), provider, armed)) {
          clearArmed();
          queueMicrotask(() => {
            this.close();
            displayInterruption("The candidate response stream was withheld by Sospio.", "withhold_candidate");
          });
        }
      }
    };
  }
  globalThis.${PAGE_INTERVENTION_API} = {
    arm(config) {
      if (!config || !["chatgpt", "claudeai"].includes(config.provider) ||
        !["withhold_candidate", "replace_presentation"].includes(config.action)) {
        return { ok: false, reason: "invalid_action" };
      }
      if (state.armed && state.armed.timeout) clearTimeout(state.armed.timeout);
      const armed = { provider: config.provider, action: config.action, armedAt: Date.now(), timeout: null };
      armed.timeout = armTimeout(armed);
      state.armed = armed;
      return { ok: true, provider: config.provider, action: config.action };
    },
    probeLatest(config) { return mediateLatest(config.provider, config.action, config.emitEvidence !== false); },
    recover(recoveryId) { return recover(recoveryId); },
    status() { return { installed: true, armed: state.armed ? { provider: state.armed.provider, action: state.armed.action } : null }; }
  };
})();`;
