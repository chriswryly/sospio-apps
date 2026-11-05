import {expect,it,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,Function>());
vi.mock('electron',()=>({ipcMain:{on:vi.fn((name:string,fn:Function)=>handlers.set(name,fn)),off:vi.fn((name:string)=>handlers.delete(name))}}));
import {DomObserverBridge} from './domObserverBridge';
it('tracks pending DOM writes and releases its global listener on recording disposal',()=>{
 const bridge=new DomObserverBridge();bridge.configure({send:vi.fn()} as any,undefined);
 const event=handlers.get('harness:dom-event')!;
 event({sender:{id:1}},{kind:'user_turn',provider:'claudeai',text:'private pending text'});expect(bridge.hasPending()).toBe(true);
 bridge.forget(1);expect(bridge.hasPending()).toBe(false);
 bridge.dispose();expect(handlers.has('harness:dom-event')).toBe(false);
});

it('delivers identical Claude DOM regenerations as distinct turns without logging their text', async()=>{
 const {CaptureService}=await import('./cdpClient');
 const {claudeaiSpec}=await import('./providers/claudeai');
 const service=new CaptureService(), turns=vi.fn(), diagnostics=vi.fn();
 service.on('turn',turns);service.on('diagnostic',diagnostics);
 (service as any).domBridge.configure({send:vi.fn()} as any,claudeaiSpec);
 const event=handlers.get('harness:dom-event')!;
 for(let i=0;i<2;i++){
  event({sender:{id:1}},{kind:'user_turn',provider:'claudeai',text:'PRIVATE_PROMPT'});
  event({sender:{id:1}},{kind:'assistant_complete',provider:'claudeai',final_text:'PRIVATE_REPLY'});
 }
 expect(turns).toHaveBeenCalledTimes(2);
 expect(turns.mock.calls[0][0].turn_id).not.toBe(turns.mock.calls[1][0].turn_id);
 expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('PRIVATE');
 service.disposeRecording();
});

it('suppresses legacy-network copies of Claude DOM turns in either arrival order', async()=>{
 const {CaptureService}=await import('./cdpClient');
 const {completionProviderFor}=await import('./providerRegistry');
 expect(completionProviderFor('https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion','POST')?.name).toBe('claudeai');
 for(const domFirst of [true,false]){
  const service=new CaptureService(), turns=vi.fn();service.on('turn',turns);
  const turn={provider:'claudeai',turn_id:'one',user_prompt:'PRIVATE_PROMPT',assistant_text:'PRIVATE_REPLY'};
  const first=domFirst?'DOM turn pair captured':'network request/response turn pair captured';
  const second=domFirst?'network request/response turn pair captured':'DOM turn pair captured';
  (service as any).emitTurn(turn,first);(service as any).emitTurn({...turn,turn_id:'two'},second);
  expect(turns).toHaveBeenCalledTimes(1);service.disposeRecording();
 }
});
