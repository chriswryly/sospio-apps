import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: { on: vi.fn() } }));
import { CaptureService } from "./cdpClient";
import { chatgptSpec } from "./providers/chatgpt";
import { TurnAssembler } from "./turnAssembler";
import type { GovernorArmOutcome, ParserDiagnostic, TurnEvent } from "../../shared/types";

const url = "https://chatgpt.com/backend-api/f/conversation";
const body = (text: string) => JSON.stringify({ conversation_id: "X", messages: [{author:{role:"user"},content:{content_type:"text",parts:[text]}}] });
const stream = (text: string, done = true) => `data: ${JSON.stringify({message:{author:{role:"assistant"},content:{content_type:"text",parts:[text]}},conversation_id:"X"})}\n\n${done ? "data: [DONE]\n\n" : ""}`;
function rig() {
  vi.useFakeTimers();
  const service = new CaptureService();
  const turns: TurnEvent[] = [], diagnostics: ParserDiagnostic[] = [], outcomes: GovernorArmOutcome[] = [];
  service.on("turn", t => turns.push(t)); service.on("diagnostic", d => diagnostics.push(d));
  service.on("governorArmOutcome", o => outcomes.push(o));
  const bodies = new Map<string,string>();
  let rendered = "";
  const sendCommand = vi.fn(async (method: string, params?: Record<string,unknown>): Promise<unknown> => {
    if (method === "Network.getResponseBody") return {body:bodies.get(String(params?.requestId)) ?? ""};
    if (method === "Runtime.evaluate") return {result:{value:rendered}};
    return {};
  });
  const dbg = {isAttached:()=>true,sendCommand};
  const web = {debugger:dbg,getURL:()=>"https://chatgpt.com/c/X"};
  const handle = (method:string,params:Record<string,unknown>) => (service as unknown as {handleMessage(d:unknown,m:string,p:Record<string,unknown>):Promise<void>}).handleMessage(dbg,method,params);
  const start = (id:string) => handle("Network.requestWillBeSent",{requestId:id,request:{url,method:"POST",postData:body(id)}});
  const finish = (id:string,text:string,done=true) => {bodies.set(id,stream(text,done));return handle("Network.loadingFinished",{requestId:id});};
  const abort = async (id:string,text:string) => {
    await handle("Network.dataReceived",{requestId:id,data:Buffer.from(stream(text)).toString("base64")});
    await handle("Network.loadingFailed",{requestId:id,errorText:"net::ERR_ABORTED"});
  };
  return {service,turns,diagnostics,outcomes,web,handle,start,finish,abort,sendCommand,setRendered:(s:string)=>{rendered=s;}};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe("demo capture completion and ordering",()=>{
  it("emits complete network text before a settle tick with exactly one source diagnostic",async()=>{
    const r=rig();await r.start("a");await r.finish("a","reply");
    expect(r.turns.map(t=>t.assistant_text)).toEqual(["reply"]);
    expect(r.diagnostics.filter(d=>d.reason.startsWith("capture_source "))).toHaveLength(1);
    expect(r.diagnostics.at(-1)?.reason).toContain("settle=skipped_complete_network");
  });
  it("retains incomplete-network settling and rendered choice",async()=>{
    const r=rig();r.setRendered("a longer rendered reply");await r.start("a");const work=r.finish("a","short",false);
    expect(r.turns).toHaveLength(0);await vi.advanceTimersByTimeAsync(2100);await work;
    expect(r.turns[0].assistant_text).toBe("a longer rendered reply");
  });
  it("terminal marker with no extracted text does not bypass settling",async()=>{
    const r=rig();r.setRendered("rendered reply");await r.start("a");const work=r.finish("a","");
    expect(r.turns).toHaveLength(0);await vi.advanceTimersByTimeAsync(2100);await work;
    expect(r.turns[0].assistant_text).toBe("rendered reply");
  });
  it("reports a longer background render without rewriting the emitted turn",async()=>{
    const r=rig();r.setRendered("a longer rendered reply");await r.start("a");await r.finish("a","reply");
    await vi.advanceTimersByTimeAsync(2100);
    expect(r.diagnostics.some(d=>d.reason.startsWith("rendered_longer_than_network"))).toBe(true);
    expect(r.turns.map(t=>t.assistant_text)).toEqual(["reply"]);
  });
  it("holds abort recovery behind an earlier normal finish still settling",async()=>{
    const r=rig();await r.start("a");const work=r.finish("a","first",false);await r.start("b");await r.abort("b","second");
    expect(r.turns).toHaveLength(0);await vi.advanceTimersByTimeAsync(75_100);await work;
    expect(r.turns.map(t=>t.user_prompt)).toEqual(["a","b"]);
    expect(r.diagnostics.some(d=>d.reason.startsWith("emission_held_for_order"))).toBe(true);
  });
  it("releases later completion when the earlier request fails",async()=>{
    const r=rig();await r.start("a");await r.start("b");await r.finish("b","second");
    await r.handle("Network.loadingFailed",{requestId:"a",errorText:"failed"});
    expect(r.turns.map(t=>t.user_prompt)).toEqual(["b"]);
  });
  it("bounds the hold when an earlier transport never finishes", async () => {
    const r=rig();await r.start("a");await r.start("b");await r.finish("b","second");
    await vi.advanceTimersByTimeAsync(75_501);
    expect(r.turns.map(t=>t.user_prompt)).toEqual(["b"]);
    expect(r.diagnostics.some(d=>d.reason.includes("ordering wait exceeded settle bound"))).toBe(true);
  });
  it("navigation releases completed holds and discards a cancelled fallback",async()=>{
    const r=rig();await r.start("a");const work=r.finish("a","first",false);await r.start("b");await r.finish("b","second");
    (r.service as unknown as {cancelPendingCapture(d:unknown):void}).cancelPendingCapture(r.web.debugger);
    expect(r.turns.map(t=>t.user_prompt)).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(75_100);await work;expect(r.turns).toHaveLength(1);
  });
  it("does not hold sequential requests or register a metadata skip",async()=>{
    const r=rig();await r.handle("Network.requestWillBeSent",{requestId:"metadata",request:{url,method:"POST",postData:'{"conversation_id":"X"}'}});
    await r.start("a");await r.finish("a","first");await r.start("b");await r.finish("b","second");
    expect(r.turns).toHaveLength(2);expect(r.diagnostics.some(d=>d.reason.startsWith("emission_held_for_order"))).toBe(false);
  });
  it("records sanitized skip path without query values",()=>{
    const d=new TurnAssembler().start("id",url+"?secret=private",'{}',chatgptSpec);
    expect(d?.request_path).toBe("/backend-api/f/conversation");expect(JSON.stringify(d)).not.toContain("private");
  });
});
describe("governor request arm",()=>{
  it("survives 60 seconds and a non-text request, then applies with request ID",async()=>{
    const r=rig();await r.service.armRequestMediation(r.web as never,"chatgpt","augment_request_context","context",{attributed:true,actionId:"action",conversationId:"X"});
    await vi.advanceTimersByTimeAsync(60_000);expect(r.outcomes).toEqual([]);
    await r.handle("Fetch.requestPaused",{requestId:"meta",request:{url,method:"POST",postData:'{}'}});
    await r.handle("Runtime.bindingCalled",{name:"rshUserSend",payload:JSON.stringify({provider:"chatgpt",at:Date.now()})});
    await r.handle("Fetch.requestPaused",{requestId:"fetch",networkId:"net",request:{url,method:"POST",postData:body("hello")}});
    expect(r.outcomes).toContainEqual(expect.objectContaining({actionId:"action",status:"applied",detail:expect.stringContaining("net")}));
  });
  it("cancels on conversation change and reports why",async()=>{
    const r=rig();await r.service.armRequestMediation(r.web as never,"chatgpt","augment_request_context","context",{attributed:true,actionId:"action"});
    r.service.cancelGovernorArm(r.web as never,"conversation changed");
    expect(r.outcomes).toContainEqual(expect.objectContaining({status:"failed",detail:"conversation changed"}));
  });
  it("cancels on window teardown without accessing destroyed WebContents", async () => {
    const r=rig();const handlers = new Map<string, () => void>();
    const web = {...r.web, isDestroyed:()=>false, on:vi.fn(), once:(event:string,fn:()=>void)=>handlers.set(event,fn)};
    Object.assign(web.debugger,{on:vi.fn(),detach:vi.fn()});
    r.service.attach(web as never);
    await r.service.armRequestMediation(web as never,"chatgpt","augment_request_context","context",{attributed:true,actionId:"action"});
    Object.defineProperty(web,"debugger",{get:()=>{throw new Error("Object has been destroyed");}});
    expect(()=>handlers.get("destroyed")!()).not.toThrow();
    expect(r.outcomes).toContainEqual(expect.objectContaining({status:"failed",detail:"chat window closed"}));
  });
  it("preserves the 30-second capability-probe timeout",async()=>{
    const r=rig();const probes:unknown[]=[];r.service.on("capabilityProbe",p=>probes.push(p));
    await r.service.armRequestMediation(r.web as never,"chatgpt","augment_request_context","context");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(probes).toContainEqual(expect.objectContaining({status:"failed",detail:expect.stringContaining("timeout")}));
  });
  it("reports the 30-minute governor safety cap",async()=>{
    const r=rig();await r.service.armRequestMediation(r.web as never,"chatgpt","augment_request_context","context",{attributed:true,actionId:"action"});
    await vi.advanceTimersByTimeAsync(30*60_000+1);
    expect(r.outcomes).toContainEqual(expect.objectContaining({status:"failed",detail:expect.stringContaining("30 minute safety cap")}));
  });
});
