import { mkdtempSync, realpathSync, readFileSync, existsSync, utimesSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { ClosedConversations } from "./closedConversations";
import { RetentionController } from "../../../records/retentionController";
import { conversationChanged } from "./conversationSurface";
import { removeGovernorNoticeScript, TERMINATE_EXCHANGE_MARKER } from "./interventionExecutor";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, {recursive:true,force:true}); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "closed-conversations-"))); directories.push(dir);
  const diagnostic = vi.fn();
  return {dir, diagnostic, store:new ClosedConversations(dir, diagnostic)};
}
const turn = {provider:"chatgpt" as const, session_id:"closed", turn_id:"turn-one"};
it("records an applied close and recovers it after relaunch without conversation text", async () => {
  const {store,dir} = fixture();
  await store.applyClose(turn, async () => ({closed_to_further_turns:true}));
  const row = JSON.parse(readFileSync(store.path,"utf8"));
  expect(row).toEqual({provider:"chatgpt",conversation_id:"closed",governing_turn_id:"turn-one",closed_at:expect.any(String)});
  expect(new ClosedConversations(dir,vi.fn()).has("chatgpt","closed")).toBe(true);
  expect(store.has("claudeai","closed")).toBe(false);
  store.record(turn);
  expect(readFileSync(store.path,"utf8").trim().split("\n")).toHaveLength(1);
});
it("does not record a failed close or null conversation ID", async () => {
  const {store,diagnostic} = fixture();
  await expect(store.applyClose(turn,async()=>{throw new Error("failed");})).rejects.toThrow("failed");
  await store.applyClose({...turn,session_id:null},async()=>undefined);
  expect(existsSync(store.path)).toBe(false);
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("missing conversation ID"));
});
it("skips a damaged line and still finds the closes around it", () => {
  const {store} = fixture();
  writeFileSync(store.path, '{"provider":"chatgpt","conversation_id":"first","governing_turn_id":"t","closed_at":"x"}\n{"provider":"chat\n');
  store.record({...turn, session_id:"second"});
  expect(store.has("chatgpt","first")).toBe(true);
  expect(store.has("chatgpt","second")).toBe(true);
  expect(store.has("chatgpt","other")).toBe(false);
  expect(store.skipTurn({provider:"chatgpt", session_id:"other"})).toBe(false);
});
it("skips governor execution for captured turns in a closed conversation", async () => {
  const {store,diagnostic} = fixture(); store.record(turn);
  const governorAction = vi.fn(async () => {});
  await store.runIfOpen(turn, governorAction);
  expect(governorAction).not.toHaveBeenCalled();
  expect(store.skipTurn({...turn,session_id:"other"})).toBe(false);
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("captured turn ignored"));
});
it.each([false,true])("retention/delete remove the store and existing instances observe removal, delete=%s", all => {
  const {store,dir} = fixture(); store.record(turn);
  const old = new Date(Date.now()-366*86400000); utimesSync(store.path,old,old);
  const retention = new RetentionController(()=>[{path:dir,kind:"sessions"}],()=>({}));
  if(all) retention.deleteAll(); else retention.sweep();
  expect(existsSync(store.path)).toBe(false);
  expect(store.has("chatgpt","closed")).toBe(false);
});
it("restores on entry and relaunch, releases on leaving, and locks a late editor", async () => {
  const {store,dir} = fixture(); store.record(turn);
  const closedUrl="https://chatgpt.com/c/closed", otherUrl="https://chatgpt.com/c/other";
  const dom = new JSDOM('<main><div>readable transcript</div></main><textarea></textarea>',{url:closedUrl,runScripts:"outside-only"});
  const scripts: string[] = [];
  const execute = async (script:string) => {scripts.push(script);return dom.window.eval(script);};
  try {
    await new ClosedConversations(dir,vi.fn()).enter(closedUrl,false,execute);
    expect(scripts[0]).toContain("const initialCountdown = 0;");
    expect(dom.window.document.querySelector('textarea').getAttribute('data-rsh-exchange-terminated')).toBe("true");
    dom.reconfigure({url:otherUrl});
    await store.enter(otherUrl,conversationChanged(closedUrl,otherUrl),execute);
    expect(dom.window.document.getElementById(TERMINATE_EXCHANGE_MARKER)).toBeNull();
    expect(dom.window.document.querySelector('textarea').disabled).toBe(false);
    dom.window.document.querySelector('textarea').remove();
    dom.reconfigure({url:closedUrl});
    await store.enter(closedUrl,conversationChanged(otherUrl,closedUrl),execute);
    const editor=dom.window.document.createElement("textarea"); dom.window.document.body.append(editor);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(editor.getAttribute('data-rsh-exchange-terminated')).toBe("true");
    expect(editor.disabled).toBe(true);
    expect(dom.window.document.querySelector('main').textContent).toBe("readable transcript");
    dom.reconfigure({url:"https://chatgpt.com/"});
    await store.enter("https://chatgpt.com/",true,execute);
    expect(editor.disabled).toBe(false);
  } finally {dom.window.eval(removeGovernorNoticeScript());dom.window.close();}
});
it("does not reclose another conversation if navigation outruns the queued script", async () => {
  const {store} = fixture(); store.record(turn);
  const dom=new JSDOM('<textarea></textarea>',{url:"https://chatgpt.com/c/other",runScripts:"outside-only"});
  try {await store.enter("https://chatgpt.com/c/closed",true,async script=>dom.window.eval(script));
    expect(dom.window.document.getElementById(TERMINATE_EXCHANGE_MARKER)).toBeNull();
  }finally{dom.window.close();}
});
