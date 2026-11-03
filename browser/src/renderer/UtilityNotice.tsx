import React, { useState } from "react";
import type { MonitorVerdict } from "../shared/types";

/** Hiding a notice is presentation only; the persisted observation remains intact. */
export function UtilityNotice({ verdict }: { verdict?: MonitorVerdict }): JSX.Element | null {
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  if (!verdict?.monitor_utility) return null;
  const notice = verdict.utility_notice;
  if (verdict.monitor_utility.decision === "U") {
    return <aside role="status">Current-user monitor unavailable: {verdict.error ?? "one or both branches could not assess this turn"}. This is not a clear result.</aside>;
  }
  if (!notice || typeof notice.text !== "string" || typeof notice.notice_id !== "string") return null;
  return <aside className="utility-notice" aria-label="Sospio observation">
    <strong>Sospio observation · turn {verdict.turn_id}</strong>
    {hiddenId === notice.notice_id ? <button onClick={() => setHiddenId(null)}>Show hidden notice</button> : <>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{notice.text}</p>
      <button onClick={() => setHiddenId(notice.notice_id)}>Hide notice and continue</button>
    </>}
  </aside>;
}
