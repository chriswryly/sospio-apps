import type {InterventionTier} from "../shared/types";
import type { WebContents } from "electron";
import type { ProviderName } from "../shared/types";
import {
  describePersistence,
  readSurfacePersistence,
  surfacePersistedScript,
  SURFACE_PERSISTENCE_DELAY_MS,
  type SurfacePersistence,
} from "./capture/surfacePersistence";

export const GOVERNOR_NOTICE_MARKER = "rsh-governor-notice-v1";
export const TERMINATE_EXCHANGE_MARKER = "rsh-governor-terminate-exchange-v1";
export const DEFAULT_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS = 10;
/** Slack after the countdown before re-probing, so the final tick has landed. */
export const TERMINATE_VERIFY_GRACE_MS = 750;

/**
 * A terminate outcome the harness actually observed.
 *
 * `"unverified"` is a real answer and must stay reachable: the page can
 * navigate or the window can close during the countdown, and a receipt that
 * says `true` in that case is asserting something nobody watched. The policy
 * contract §0.3 requires interventions to be *recorded*, and a record of an
 * unobserved outcome is a claim.
 */
export type TerminateOutcome = boolean | "unverified";

export type GovernorNoticeResult = {
  mechanism: "display_governor_notice";
  provider: ProviderName;
  marker: typeof GOVERNOR_NOTICE_MARKER;
  demonstrated: true;
  recovery_handle: "dismiss_or_remove_notice";
  persistence: SurfacePersistence;
};

export type TerminateExchangeResult = {
  mechanism: "terminate_exchange";
  provider: ProviderName;
  marker: typeof TERMINATE_EXCHANGE_MARKER;
  demonstrated: true;
  recovery_handle: "start_new_exchange";
  persistence: SurfacePersistence;
  countdown_seconds: number;
  // Read back from the page after the countdown elapses, never assumed. These
  // were literal `true` in the first implementation, which recorded the
  // exchange as closed roughly ten seconds before the code that closes it ran.
  transcript_preserved: TerminateOutcome;
  closed_to_further_turns: TerminateOutcome;
  verified_at: string | null;
};

/** Shape returned by the post-countdown probe. */
export type TerminateVerification = {
  closed_to_further_turns: TerminateOutcome;
  transcript_preserved: TerminateOutcome;
  verified_at: string | null;
};

type ScriptTarget = Pick<WebContents, "executeJavaScript">;

type ProbeResponse = {
  ok?: unknown;
  marker?: unknown;
  provider?: unknown;
  countdown_seconds?: unknown;
};

/**
 * The first realized browser-governor mechanism.
 *
 * This controller owns only an attributed presentation overlay. It does not
 * edit provider content, impersonate either party, or imply control over
 * requests/generation. The injected notice is isolated in a shadow root and
 * carries its own user recovery control (Dismiss).
 */
export class BrowserInterventionExecutor {
  async displayGovernorNotice(
    target: ScriptTarget,
    provider: ProviderName,
    message: string,
    tier?: InterventionTier,
    hasNextTurnAugment = false,
    actionId?: string,
  ): Promise<GovernorNoticeResult> {
    const result = await target.executeJavaScript(
      buildGovernorNoticeScript(provider, message, tier, hasNextTurnAugment, actionId),
      true,
    ) as ProbeResponse;
    if (
      result?.ok !== true ||
      result.marker !== GOVERNOR_NOTICE_MARKER ||
      result.provider !== provider
    ) {
      throw new Error(`governor notice probe failed for ${provider}`);
    }
    // Injection-time presence is not the claim being made. A notice discarded by the page's
    // next render was never a governor presentation the user could see or dismiss, so it must
    // not be recorded as a demonstration.
    const persistence = readSurfacePersistence(
      await target.executeJavaScript(
        surfacePersistedScript(`#${GOVERNOR_NOTICE_MARKER}`),
        true,
      ),
      SURFACE_PERSISTENCE_DELAY_MS,
    );
    if (!persistence.present) {
      throw new Error(
        `governor notice probe failed for ${provider}: ${describePersistence(persistence)}`,
      );
    }
    return {
      mechanism: "display_governor_notice",
      provider,
      marker: GOVERNOR_NOTICE_MARKER,
      demonstrated: true,
      recovery_handle: "dismiss_or_remove_notice",
      persistence,
    };
  }

  async removeGovernorNotice(target: ScriptTarget): Promise<boolean> {
    return target.executeJavaScript(
      `(() => {
        const notice = document.getElementById(${JSON.stringify(GOVERNOR_NOTICE_MARKER)});
        if (!notice) return false;
        notice.remove();
        return true;
      })()`,
      true,
    ) as Promise<boolean>;
  }

  async terminateExchange(
    target: ScriptTarget,
    provider: ProviderName,
    message: string,
    countdownSeconds = DEFAULT_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS,
    options: {
      // Awaiting the countdown is safe precisely here: Tier 4 ends the
      // exchange, so no next turn is racing this. Tests pass `verify: false`
      // or their own waiter rather than sleeping ten seconds.
      verify?: boolean;
      wait?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<TerminateExchangeResult> {
    if (!Number.isFinite(countdownSeconds) || countdownSeconds < 0) {
      throw new Error(`terminate_exchange countdown must be a finite non-negative number; got ${countdownSeconds}`);
    }
    const normalizedCountdown = Math.floor(countdownSeconds);
    const result = await target.executeJavaScript(
      buildTerminateExchangeScript(provider, message, normalizedCountdown),
      true,
    ) as ProbeResponse;
    if (
      result?.ok !== true ||
      result.marker !== TERMINATE_EXCHANGE_MARKER ||
      result.provider !== provider ||
      result.countdown_seconds !== normalizedCountdown
    ) {
      throw new Error(`terminate_exchange failed for ${provider}`);
    }
    const persistence = readSurfacePersistence(
      await target.executeJavaScript(
        surfacePersistedScript(`#${TERMINATE_EXCHANGE_MARKER}`),
        true,
      ),
      SURFACE_PERSISTENCE_DELAY_MS,
    );
    if (!persistence.present) {
      throw new Error(
        `terminate_exchange failed for ${provider}: ${describePersistence(persistence)}`,
      );
    }
    // Everything above is observed at T+0: the injected script returns as soon
    // as it has scheduled the countdown, and `closeNow` runs at T+countdown.
    // The outcome fields are read after that, or recorded as unverified.
    const verify = options.verify ?? true;
    const unverified: TerminateVerification = {
      closed_to_further_turns: "unverified",
      transcript_preserved: "unverified",
      verified_at: null,
    };
    let verification = unverified;
    if (verify) {
      const wait =
        options.wait ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      try {
        await wait(normalizedCountdown * 1000 + TERMINATE_VERIFY_GRACE_MS);
        verification = readTerminateVerification(
          await target.executeJavaScript(buildTerminateVerifyScript(), true),
        );
      } catch {
        // Navigation, a closed window, a torn-down webContents. Unverified is
        // the honest record; throwing would lose the receipt entirely.
        verification = unverified;
      }
    }
    if (verify) {
      try {
        await target.executeJavaScript(buildTerminateOutcomeScript(verification.closed_to_further_turns), true);
      } catch {
        // Display failure must not alter the observed outcome or lose its receipt.
      }
    }
    return {
      mechanism: "terminate_exchange",
      provider,
      marker: TERMINATE_EXCHANGE_MARKER,
      demonstrated: true,
      recovery_handle: "start_new_exchange",
      persistence,
      countdown_seconds: normalizedCountdown,
      transcript_preserved: verification.transcript_preserved,
      closed_to_further_turns: verification.closed_to_further_turns,
      verified_at: verification.verified_at,
    };
  }
}

export function buildGovernorNoticeScript(provider: ProviderName, message: string, tier?: InterventionTier, hasNextTurnAugment = false, actionId?: string): string {
  const marker = JSON.stringify(GOVERNOR_NOTICE_MARKER);
  const providerText = JSON.stringify(provider);
  const extra = tier===1&&!message.includes("Only you see this") ? "Only you see this. The assistant doesn't receive it." : (tier===2||tier===3)&&hasNextTurnAugment ? "Sospio will add this note to the end of your next message, marked as Sospio's." : "";
  const delivery = (tier === 2 || tier === 3) && hasNextTurnAugment;
  const bodyText = JSON.stringify(message + (extra && !delivery ? "\n\n" + extra : ""));
  const headingText = JSON.stringify(tier===1?"Sospio · Tier 1 notice":tier===2?"Sospio · Tier 2 shared note":tier===3?"Sospio · Tier 3 final note":"Sospio notice");
  return `(() => {
    const marker = ${marker};
    const provider = ${providerText};
    document.getElementById(marker)?.remove();
    const host = document.createElement("div");
    host.id = marker;
    host.dataset.rshGovernorMechanism = "display_governor_notice";
    host.dataset.rshProvider = provider;
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host { all: initial; }",
      "aside { position: fixed; z-index: 2147483647; top: 16px; right: 16px; box-sizing: border-box; width: min(420px, calc(100vw - 32px)); padding: 14px 16px; border: 1px solid #d89c35; border-radius: 10px; background: #241c0f; color: #fff7e6; box-shadow: 0 10px 32px rgba(0,0,0,.35); font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
      "strong { display: block; margin-bottom: 5px; color: #ffd78c; }",
      "p { margin: 0; white-space: pre-wrap; }",
      "footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 10px; color: #d8c9ac; font-size: 12px; }",
      "button { border: 1px solid #80642f; border-radius: 6px; padding: 4px 8px; background: transparent; color: inherit; cursor: pointer; font: inherit; }",
    ].join("");
    const notice = document.createElement("aside");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "assertive");
    const heading = document.createElement("strong");
    heading.textContent = ${headingText};
    const body = document.createElement("p");
    body.textContent = ${bodyText};
    const deliveryLine = document.createElement("p");
    if (${delivery}) {
      deliveryLine.dataset.rshGovernorDeliveryAction = ${JSON.stringify(actionId ?? "")};
      deliveryLine.style.marginTop = "14px";
      deliveryLine.textContent = ${JSON.stringify(extra)};
    }
    const footer = document.createElement("footer");
    const provenance = document.createElement("span");
    provenance.textContent = "Sospio · " + provider;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Hide";
    dismiss.setAttribute("aria-label", "Hide Sospio notice");
    dismiss.addEventListener("click", () => host.remove(), { once: true });
    footer.append(provenance, dismiss);
    notice.append(heading, body);
    if (${delivery}) notice.append(deliveryLine);
    notice.append(footer);
    root.append(style, notice);
    document.documentElement.appendChild(host);
    return { ok: document.getElementById(marker) === host, marker, provider };
  })()`;
}

/**
 * Reads the page's actual state after the countdown should have fired.
 *
 * Deliberately reads what `closeNow` does, not whether it was called:
 * `data-rsh-exchange-closed` on the host, the `data-rsh-exchange-terminated`
 * attribute `markDisabled` stamps on every editor and send control, and whether
 * any transcript node survives.
 */
export function buildTerminateVerifyScript(): string {
  return `(() => {
    const marker = ${JSON.stringify(TERMINATE_EXCHANGE_MARKER)};
    const host = document.getElementById(marker);
    if (!host) {
      return { present: false };
    }
    const editableSelectors = [
      "textarea",
      "input:not([type])",
      "input[type='text']",
      "input[type='search']",
      "[contenteditable='true']",
      "[contenteditable='']",
      "[role='textbox']",
      "[data-lexical-editor='true']"
    ].join(",");
    const editors = Array.from(document.querySelectorAll(editableSelectors))
      .filter((element) => !element.closest("#" + marker));
    const blocked = editors.length === 0
      ? null
      : editors.every((element) => element.getAttribute("data-rsh-exchange-terminated") === "true");
    const transcriptNodes = document.querySelectorAll(
      "[data-turn-key],[data-conversation-role],[data-user-message-bubble],[data-message-author-role],[data-testid^='conversation-turn'],article,[data-test-render-count]"
    ).length;
    return {
      present: true,
      closed_flag: host.dataset.rshExchangeClosed === "true",
      editors_seen: editors.length,
      composer_blocked: blocked,
      transcript_nodes: transcriptNodes
    };
  })()`;
}

/** Fold a probe payload into a verification verdict. Unknown shapes stay unverified. */
export function readTerminateVerification(raw: unknown): TerminateVerification {
  const unverified: TerminateVerification = {
    closed_to_further_turns: "unverified",
    transcript_preserved: "unverified",
    verified_at: null,
  };
  if (typeof raw !== "object" || raw === null) {
    return unverified;
  }
  const payload = raw as Record<string, unknown>;
  if (payload.present !== true) {
    // The overlay is gone. Something removed it, and we did not watch what.
    return unverified;
  }
  const closedFlag = payload.closed_flag === true;
  const blocked = payload.composer_blocked;
  // No editors on the page is not evidence of closure; it is evidence we could
  // not tell. Only an explicit all-blocked reading counts.
  const composerClosed = blocked === true ? true : blocked === false ? false : "unverified";
  const closed: TerminateOutcome = !closedFlag
    ? false
    : composerClosed === true
      ? true
      : composerClosed;
  const nodes = payload.transcript_nodes;
  const transcript: TerminateOutcome =
    typeof nodes === "number" ? nodes > 0 : "unverified";
  return {
    closed_to_further_turns: closed,
    transcript_preserved: transcript,
    verified_at: new Date().toISOString(),
  };
}

export function buildTerminateExchangeScript(
  provider: ProviderName,
  message: string,
  countdownSeconds = DEFAULT_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS,
): string {
  const normalizedCountdown = Math.max(0, Math.floor(countdownSeconds));
  const marker = JSON.stringify(TERMINATE_EXCHANGE_MARKER);
  const providerText = JSON.stringify(provider);
  const bodyText = JSON.stringify(message);
  return `(() => {
    const marker = ${marker};
    const provider = ${providerText};
    const bodyText = ${bodyText};
    const initialCountdown = ${normalizedCountdown};
    globalThis.__rshGovernorTerminatedExchange?.release?.();
    document.getElementById(marker)?.remove();
    const host = document.createElement("div");
    host.id = marker;
    host.dataset.rshGovernorMechanism = "terminate_exchange";
    host.dataset.rshProvider = provider;
    host.dataset.rshTranscriptPreserved = "true";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host { all: initial; }",
      "aside { position: fixed; z-index: 2147483647; inset: auto 16px 16px auto; box-sizing: border-box; width: min(460px, calc(100vw - 32px)); padding: 16px; border: 1px solid #e05252; border-radius: 10px; background: #2a1214; color: #fff1f1; box-shadow: 0 14px 38px rgba(0,0,0,.42); font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
      "strong { display: block; margin-bottom: 6px; color: #ffb8b8; font-size: 15px; }",
      "p { margin: 0 0 10px; white-space: pre-wrap; }",
      "small { display: block; color: #f0c2c2; }",
    ].join("");
    const surface = document.createElement("aside");
    surface.setAttribute("role", "alert");
    surface.setAttribute("aria-live", "assertive");
    const heading = document.createElement("strong");
    heading.textContent = "Sospio · closing conversation";
    const body = document.createElement("p");
    body.textContent = bodyText;
    const countdown = document.createElement("small");
    surface.append(heading, body, countdown);
    root.append(style, surface);
    document.documentElement.appendChild(host);

    const state = {
      provider,
      marker,
      closed: false,
      closedAt: null,
      transcriptPreserved: true,
      countdownSeconds: initialCountdown,
      guardInstalled: false,
      observerInstalled: false,
      interval: null,
      restore: []
    };
    globalThis.__rshGovernorTerminatedExchange = state;

    function editableSelectors() {
      return [
        "textarea",
        "input:not([type])",
        "input[type='text']",
        "input[type='search']",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='textbox']",
        "[data-lexical-editor='true']"
      ].join(",");
    }
    function isElement(value) {
      return value instanceof Element;
    }
    function textFor(element) {
      return [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-test-id"),
        element.id,
        element.className,
        element.textContent
      ].filter(Boolean).join(" ").toLowerCase();
    }
    function isEditable(element) {
      if (!isElement(element)) return false;
      return element.matches(editableSelectors()) || Boolean(element.closest(editableSelectors()));
    }
    function likelyComposerScope(element) {
      if (!isElement(element)) return null;
      const form = element.closest("form");
      if (form) return form;
      let current = element;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = textFor(current);
        if (/composer|prompt|chat-input|chatinput|message-input|input-area/.test(text)) {
          return current;
        }
      }
      return element.parentElement;
    }
    function likelySendControl(element) {
      if (!isElement(element)) return false;
      if (element.tagName === "BUTTON" && element.getAttribute("type") === "submit") return true;
      return /\\bsend\\b|submit|arrow-up|paper-airplane|composer-submit/.test(textFor(element));
    }
    function markDisabled(element) {
      if (!isElement(element)) return;
      if (element.closest("#" + marker)) return;
      if (element.getAttribute("data-rsh-exchange-terminated") === "true") return;
      state.restore.push({
        element,
        ariaDisabled: element.getAttribute("aria-disabled"),
        tabindex: element.getAttribute("tabindex"),
        disabled: "disabled" in element ? element.disabled : undefined,
        pointerEvents: element instanceof HTMLElement ? element.style.pointerEvents : undefined,
        contentEditable: element.getAttribute("contenteditable")
      });
      element.setAttribute("data-rsh-exchange-terminated", "true");
      element.setAttribute("aria-disabled", "true");
      element.setAttribute("tabindex", "-1");
      if ("disabled" in element) {
        try { element.disabled = true; } catch {}
      }
      if (element instanceof HTMLElement) {
        element.style.pointerEvents = "none";
      }
      if (element.isContentEditable) {
        element.contentEditable = "false";
      }
    }
    function blockComposer() {
      const editors = Array.from(document.querySelectorAll(editableSelectors())).filter((element) => {
        if (!isElement(element) || element.closest("#" + marker)) return false;
        const tag = element.tagName;
        return tag !== "INPUT" || !["button", "checkbox", "radio", "range", "submit"].includes(String(element.getAttribute("type") || "").toLowerCase());
      });
      const scopes = new Set();
      for (const editor of editors) {
        markDisabled(editor);
        const scope = likelyComposerScope(editor);
        if (scope) scopes.add(scope);
      }
      for (const scope of scopes) {
        for (const control of scope.querySelectorAll("button,[role='button'],input[type='submit']")) {
          if (likelySendControl(control)) markDisabled(control);
        }
      }
      for (const control of document.querySelectorAll("button,[role='button'],input[type='submit']")) {
        if (likelySendControl(control)) markDisabled(control);
      }
    }
    function terminatedTarget(target) {
      if (!state.closed || !isElement(target)) return false;
      if (target.closest("#" + marker)) return false;
      if (target.closest("[data-rsh-exchange-terminated='true']")) return true;
      if (target.tagName === "FORM" && target.querySelector("[data-rsh-exchange-terminated='true']")) return true;
      if (isEditable(target)) return true;
      const clickable = target.closest("button,[role='button'],input[type='submit']");
      return Boolean(clickable && likelySendControl(clickable));
    }
    function stopIfTerminated(event) {
      if (!terminatedTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    }
    function installGuards() {
      if (!state.guardInstalled) {
        for (const name of ["beforeinput", "input", "paste", "drop", "keydown", "submit", "click"]) {
          document.addEventListener(name, stopIfTerminated, true);
        }
        state.guardInstalled = true;
      }
      if (!state.observerInstalled && typeof MutationObserver === "function") {
        const observer = new MutationObserver(() => blockComposer());
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        state.observerInstalled = true;
        state.observer = observer;
      }
    }
    function restoreAttribute(element, name, value) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    // The close belongs to one conversation. A single-page provider keeps this document across an
    // in-app New chat, so the harness calls release() at the conversation boundary.
    state.release = () => {
      if (state.interval !== null) window.clearInterval(state.interval);
      state.interval = null;
      state.closed = false;
      if (state.guardInstalled) {
        for (const name of ["beforeinput", "input", "paste", "drop", "keydown", "submit", "click"]) {
          document.removeEventListener(name, stopIfTerminated, true);
        }
        state.guardInstalled = false;
      }
      state.observer?.disconnect();
      state.observerInstalled = false;
      for (const saved of state.restore.splice(0)) {
        const element = saved.element;
        element.removeAttribute("data-rsh-exchange-terminated");
        restoreAttribute(element, "aria-disabled", saved.ariaDisabled);
        restoreAttribute(element, "tabindex", saved.tabindex);
        if (saved.disabled !== undefined) {
          try { element.disabled = saved.disabled; } catch {}
        }
        if (saved.pointerEvents !== undefined) element.style.pointerEvents = saved.pointerEvents;
        restoreAttribute(element, "contenteditable", saved.contentEditable);
      }
      host.remove();
      if (globalThis.__rshGovernorTerminatedExchange === state) {
        delete globalThis.__rshGovernorTerminatedExchange;
      }
    };
    function closeNow() {
      if (state.closed) return;
      state.closed = true;
      state.closedAt = new Date().toISOString();
      host.dataset.rshExchangeClosed = "true";
      countdown.textContent = "Closing now.";
      blockComposer();
      installGuards();
    }
    function renderCountdown(remaining) {
      countdown.textContent = remaining > 0
        ? "Closing in " + remaining + " second" + (remaining === 1 ? "" : "s") + "."
        : "Closing now.";
    }

    let remaining = initialCountdown;
    renderCountdown(remaining);
    if (remaining <= 0) {
      closeNow();
    } else {
      state.interval = window.setInterval(() => {
        remaining -= 1;
        renderCountdown(remaining);
        if (remaining <= 0) {
          window.clearInterval(state.interval);
          state.interval = null;
          closeNow();
        }
      }, 1000);
    }

    return {
      ok: document.getElementById(marker) === host,
      marker,
      provider,
      countdown_seconds: initialCountdown
    };
  })()`;
}

/**
 * Clears every governor-owned page surface that belongs to one conversation: the tier notice, the
 * request-mediation attribution banner ("…appended context to this turn…") and a Tier 4 close,
 * including its input guards and composer lock. All live in the page itself, so a single-page
 * provider keeps them across an in-app New chat unless removed.
 */
export function removeGovernorNoticeScript(): string {
  return `(() => {
    document.querySelectorAll("#${GOVERNOR_NOTICE_MARKER}, [data-rsh-governor-request-mediation]").forEach(node => node.remove());
    globalThis.__rshGovernorTerminatedExchange?.release?.();
    document.getElementById("${TERMINATE_EXCHANGE_MARKER}")?.remove();
  })()`;
}

/** Update only the still-visible notice belonging to this arm; never recreate it. */
export function updateGovernorDeliveryScript(actionId: string, status: "applied" | "failed"): string {
  const text = status === "applied"
    ? "Sospio added this note to the end of your message."
    : "This note was not added to your message.";
  return `(() => {
    const root = document.getElementById(${JSON.stringify(GOVERNOR_NOTICE_MARKER)})?.shadowRoot;
    const line = root?.querySelector("[data-rsh-governor-delivery-action]");
    if (!line || line.dataset.rshGovernorDeliveryAction !== ${JSON.stringify(actionId)}) return;
    line.textContent = ${JSON.stringify(text)};
  })()`;
}

export function buildTerminateOutcomeScript(outcome: TerminateOutcome): string {
  const confirmed = outcome === true;
  return `(() => {
    const root = document.getElementById(${JSON.stringify(TERMINATE_EXCHANGE_MARKER)})?.shadowRoot;
    if (!root) return;
    root.querySelector("strong").textContent = ${JSON.stringify(confirmed ? "Sospio · conversation closed" : "Sospio · close not confirmed")};
    root.querySelector("p").textContent = ${JSON.stringify(confirmed
      ? "No further messages can be sent here. The transcript remains readable."
      : "Sospio could not confirm that the page stopped accepting input. The conversation may still be open. The transcript remains readable.")};
    root.querySelector("small").textContent = "";
  })()`;
}
