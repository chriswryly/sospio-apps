import React, {useEffect,useState} from 'react';
import {recordsDisclosure, recordsSummary, type RecordsInfo} from '../../records/disclosure';
type Api = { recordsInfo?():Promise<RecordsInfo>; deleteRecords?():Promise<string> };
/** Initially open on every launch; stays reachable without a separate preference store. */
export function RecordsPanel({api, web=false, onExport, exportDisabled=false}: {api:Api;web?:boolean;onExport?:()=>Promise<boolean>;exportDisabled?:boolean}): JSX.Element | null {
  const [info,setInfo]=useState<RecordsInfo>();
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[result,setResult]=useState('');
  useEffect(()=>{let alive=true;void api.recordsInfo?.().then(v=>{if(alive)setInfo(v);}).catch(()=>{if(alive)setResult('Record settings unavailable.');});return()=>{alive=false;};},[api]);
  if(!api.recordsInfo)return null;
  const label=web?'Delete my data (resets demo)':'Delete recorded conversations';
  async function remove() {
    setBusy(true);setConfirm(false);
    try{setResult(await api.deleteRecords!());}catch(error){setResult(String(error).includes('records_busy')?'Work is still running. Wait for it to finish and retry.':'Some records could not be removed. Retry; contact the operator if this continues.');}
    finally{setBusy(false);}
  }
  async function exportConversation() {
    setBusy(true);
    try { setResult(await onExport!() ? 'Conversation exported.' : 'Export cancelled or unavailable.'); }
    catch { setResult('Conversation could not be exported.'); }
    finally { setBusy(false); }
  }
  return <details open className="sospio-ck records-panel"><summary>Your data</summary>
    {info && <p>{recordsSummary(info)}</p>}
    <div className="sospio-ck-buttons">
    {confirm ? <div><p>Delete the recorded conversations covered by this control?</p>{web && <p>This also ends the current conversation and signs you out; you will need the demo password to start again.</p>}<button className="records-destructive" onClick={()=>void remove()}>Confirm deletion</button><button onClick={()=>setConfirm(false)}>Cancel</button></div> :
      <button className="records-destructive" disabled={busy || !info} onClick={()=>setConfirm(true)}>{label}</button>}
    {onExport && info?.export_enabled === true && <button disabled={busy || exportDisabled} onClick={()=>void exportConversation()}>Export conversation</button>}
    </div>
    {info && <details><summary>Details</summary><p>{recordsDisclosure(info)}</p></details>}
    <p role="status">{result}</p></details>;
}
