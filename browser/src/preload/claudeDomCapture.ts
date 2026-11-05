import type { DomSelectors } from "../main/capture/providers/types";

export const DOM_TEXT_SETTLE_MS = 300;
type Pending = { text: string; user: Element; prompt: string; timer: ReturnType<typeof setTimeout> };

/** Claude's completion marker belongs to each assistant node, not the whole page. */
export class ClaudeDomCapture {
  private observer: MutationObserver;
  private emitted = new WeakSet<Element>();
  // Only replies seen streaming are captured. A conversation opened from history (or switched to
  // in the sidebar) renders every past reply already complete; capturing those would send the
  // whole history to the monitor as new turns.
  private streamed = new WeakSet<Element>();
  private pending = new Map<Element, Pending>();
  private missingTimer?: ReturnType<typeof setTimeout>;
  private missingReports = 0;
  private stopped = false;

  constructor(
    private selectors: DomSelectors,
    private readText: (node: Element) => string,
    private emit: (payload: Record<string, unknown>) => void,
  ) {
    this.observer = new MutationObserver(records => {
      for (const record of records) {
        // A flip can land between callbacks, so the old value is the evidence it streamed.
        if (record.type === "attributes" && record.oldValue === "true" && record.target instanceof Element) {
          this.streamed.add(record.target);
        }
      }
      this.scan();
    });
    this.observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-is-streaming"], attributeOldValue: true,
    });
    this.scan();
  }

  private nodes(selectors: ReadonlyArray<string>): Element[] {
    const container = document.querySelector(this.selectors.conversationContainerSelector);
    if (!container) return [];
    return Array.from(container.querySelectorAll(selectors.join(",")));
  }

  private precedingUser(node: Element): Element | undefined {
    return this.nodes(this.selectors.userMessageSelectors).filter(user =>
      Boolean(user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && !user.contains(node)).at(-1);
  }

  private complete(node: Element): boolean {
    return node.hasAttribute("data-is-streaming") && node.getAttribute("data-is-streaming") !== "true";
  }

  private scan(): void {
    if (this.stopped) return;
    for (const [node, pending] of this.pending) {
      if (!node.isConnected || !this.complete(node)) {
        clearTimeout(pending.timer); this.pending.delete(node);
      }
    }
    for (const node of this.nodes(this.selectors.assistantMessageSelectors)) {
      if (node.getAttribute("data-is-streaming") === "true") this.streamed.add(node);
      if (this.emitted.has(node) || !this.streamed.has(node) || !this.complete(node)) continue;
      const user = this.precedingUser(node);
      const text = this.readText(node), prompt = user ? this.readText(user) : "";
      const pending = this.pending.get(node);
      if (pending?.text === text && pending?.user === user && pending?.prompt === prompt) continue;
      if (pending) { clearTimeout(pending.timer); this.pending.delete(node); }
      if (!user || !text || !prompt) continue;
      const timer = setTimeout(() => {
        this.pending.delete(node);
        if (this.stopped || !node.isConnected || !this.complete(node) || this.emitted.has(node)) return;
        if (this.readText(node) !== text || this.precedingUser(node) !== user || this.readText(user) !== prompt) {
          this.scan(); return;
        }
        this.emitted.add(node);
        // Emit the pair together: repeated prompts and regenerations still get their own turn.
        this.emit({kind: "user_turn", text: prompt});
        this.emit({kind: "assistant_complete", final_text: text});
      }, DOM_TEXT_SETTLE_MS);
      this.pending.set(node, {text, user, prompt, timer});
    }
  }

  userSend(): void {
    if (this.stopped || this.missingTimer || this.missingReports >= 3) return;
    this.missingTimer = setTimeout(() => {
      this.missingTimer = undefined;
      const users = this.nodes(this.selectors.userMessageSelectors).length;
      const assistants = this.nodes(this.selectors.assistantMessageSelectors).length;
      if (!users || !assistants) {
        this.missingReports++;
        this.emit({kind: "diagnostic", reason: `Claude DOM selector matches after send: user=${users} assistant=${assistants}`});
      }
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    this.observer.disconnect();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    clearTimeout(this.missingTimer);
  }
}
