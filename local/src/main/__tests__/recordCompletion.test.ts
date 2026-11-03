import {afterEach,expect,it,vi} from 'vitest';
import {MonitorClient as LocalClient} from '../monitorClient';
afterEach(()=>vi.unstubAllGlobals());
it.each([LocalClient])('checks completion without dispatching another judge request',async(Client)=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({verdict:{turn_id:'turn/one'}})}));vi.stubGlobal('fetch',fetch);
 expect(await new Client({baseUrl:"http://127.0.0.1:8799", token:"fixture-token"}).hasVerdict('turn/one')).toBe(true);
 expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8799/verdicts/turn%2Fone',expect.objectContaining({signal:expect.any(AbortSignal)}));
 expect(fetch.mock.calls[0]).toHaveLength(2);
});
it.each([LocalClient])('treats absent verdicts and transport errors as unfinished work',async(Client)=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,json:async()=>({})}).mockRejectedValueOnce(new Error('unavailable'));vi.stubGlobal('fetch',fetch);
 const client=new Client({baseUrl:"http://127.0.0.1:8799", token:"fixture-token"});for(let i=0;i<3;i++)expect(await client.hasVerdict('turn')).toBe(false);
});
