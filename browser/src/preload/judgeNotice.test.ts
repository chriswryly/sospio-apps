// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { mountJudgeNotice } from "./judgeNotice";

it("places a safe notice after the latest turn and sends shown, look and dismissal actions", async () => {
  document.body.innerHTML = '<main><div data-message-author-role="assistant">reply</div></main>';
  const action = vi.fn().mockResolvedValue(undefined);
  mountJudgeNotice({ id: "sospio-test", text: 'Turn 1: "<b>quote</b>"', kind: "check_in" }, action);
  const host = document.getElementById("sospio-test")!;
  expect(host.previousElementSibling?.textContent).toBe("reply");
  expect(host.shadowRoot!.querySelector("b")).toBeNull();
  expect(host.shadowRoot!.textContent).toContain('<b>quote</b>');
  expect(action).toHaveBeenCalledWith("sospio-test", "shown");
  host.shadowRoot!.querySelectorAll("button")[0].click();
  await Promise.resolve();
  expect(action).toHaveBeenCalledWith("sospio-test", "look");
  host.shadowRoot!.querySelectorAll("button")[1].click();
  await Promise.resolve();
  expect(action).toHaveBeenCalledWith("sospio-test", "dismiss");
  expect(document.getElementById("sospio-test")).toBeNull();
});


import { judgeUnavailableText } from "../shared/monitorNotices";

it("renders the same readable unavailable wording used by the browser page sender", () => {
  mountJudgeNotice({ id: "sospio-unavailable", text: judgeUnavailableText("overreliance_signals"), kind: "unavailable" }, vi.fn().mockResolvedValue(undefined));
  const text = document.getElementById("sospio-unavailable")!.shadowRoot!.textContent;
  expect(text).toContain("Sospio: overreliance monitoring is unavailable right now.");
  expect(text).not.toContain("_signals");
});

it("anchors after the latest current ChatGPT turn", () => {
  document.body.innerHTML = '<main><div data-turn-key="one">first</div><div data-turn-key="two">last</div><footer>footer</footer></main>';
  mountJudgeNotice({id:"new-markup",text:"notice",kind:"unavailable"},vi.fn().mockResolvedValue(undefined));
  expect(document.getElementById("new-markup")!.previousElementSibling?.getAttribute("data-turn-key")).toBe("two");
});
