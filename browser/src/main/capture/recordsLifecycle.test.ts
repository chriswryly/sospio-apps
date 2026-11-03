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
