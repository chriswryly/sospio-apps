/** Page notice DOM, isolated from provider markup. All evidence is rendered as text. */
export type PageJudgeNotice = { id: string; text: string; kind: "uncertainty_notice" | "check_in" | "unavailable" };

export function mountJudgeNotice(payload: PageJudgeNotice, action: (id: string, action: "shown" | "dismiss" | "look") => Promise<void>): void {
  document.getElementById(payload.id)?.remove();
  const host = document.createElement("div");
  host.id = payload.id;
  host.dataset.sospioNotice = "true";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ":host{display:block;margin:12px}aside{padding:16px;background:#241c0f;color:#fff7e6;border:1px solid #d89c35;border-radius:8px;font:14px/1.5 sans-serif}p{white-space:pre-wrap;overflow-wrap:anywhere}button{margin-right:10px;padding:6px;cursor:pointer}";
  const aside = document.createElement("aside");
  aside.setAttribute("role", "status");
  const heading = document.createElement("strong");
  heading.textContent = "Sospio";
  const body = document.createElement("p");
  body.textContent = payload.text;
  aside.append(heading, body);
  const button = (label: string, kind: "dismiss" | "look"): void => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      b.disabled = true;
      void action(payload.id, kind).then(() => { if (kind === "dismiss") host.remove(); })
        .catch(() => { b.textContent = "Try again: " + label; }).finally(() => { b.disabled = false; });
    });
    aside.append(b);
  };
  if (payload.kind === "check_in") button("Look at these turns", "look");
  if (payload.kind !== "unavailable") button(payload.kind === "check_in" ? "Continue" : "Dismiss", "dismiss");
  root.append(style, aside);
  const turns = document.querySelectorAll('[data-turn-key], [data-conversation-role], [data-message-author-role], [data-testid="assistant-message"], [data-testid="user-message"], .font-claude-message');
  const latest = turns.item(turns.length - 1);
  if (latest) latest.after(host);
  else (document.querySelector("main") ?? document.body).append(host);
  void action(payload.id, "shown");
}
