/** Several named status polls at once. The cockpit watches an action, a
 *  service, the judge and the onboarding agent concurrently; the classic
 *  useManagedInterval holds one interval per hook, so two actions started
 *  back-to-back stopped each other's poll. Here each key owns its interval:
 *  restarting a key replaces it, everything stops on unmount, and ticks pause
 *  while the tab is hidden. */

import { useCallback, useEffect, useRef } from "react";

export type Tick = (stop: () => void) => void | Promise<void>;

export function usePollers(): (key: string, tick: Tick, ms: number) => void {
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearInterval(t); map.clear(); };
  }, []);
  return useCallback((key: string, tick: Tick, ms: number): void => {
    const map = timers.current;
    const prev = map.get(key);
    if (prev) clearInterval(prev);
    // A late tick of a replaced poll must not stop its successor: stop only our own id.
    const id: ReturnType<typeof setInterval> = setInterval(() => {
      if (!document.hidden) void Promise.resolve().then(() => tick(stop)).catch(() => { /* next tick retries */ });
    }, ms);
    function stop(): void {
      clearInterval(id);
      if (map.get(key) === id) map.delete(key);
    }
    map.set(key, id);
  }, []);
}
