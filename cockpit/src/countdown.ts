import { useEffect, useState } from "react";
export function secondsLeft(endsAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - now.getTime()) / 1000));
}
export function useCountdown(endsAt: string | undefined, now?: Date): number {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (now || !endsAt) return;
    const timer = setInterval(() => setClock(new Date()), 250);
    return () => clearInterval(timer);
  }, [endsAt, now]);
  return endsAt ? secondsLeft(endsAt, now ?? clock) : 0;
}
