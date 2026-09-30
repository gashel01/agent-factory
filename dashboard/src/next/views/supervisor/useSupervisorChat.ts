/** Talking to the supervisor: POST the operator's turn to /api/chat, then poll
 *  /api/status until the `chat` job settles, surfacing its per-turn progress
 *  line meanwhile. Both turns land in the companion thread over SSE (the server
 *  persists them), so this hook only owns the "it's thinking" state.
 *
 *  Same request bodies and cadence as the classic CompanionRail; one addition:
 *  a panel opened while an answer is still being composed (a reload, a second
 *  tab) picks the thinking state back up instead of looking idle. */

import { useEffect, useState } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast, useManagedInterval } from "../../../core.js";

/** How often the thinking indicator re-reads the chat job's state. */
const CHAT_POLL_MS = 1500;

interface ChatStatus { chat: { state: string; progress?: string } }

export interface SupervisorChat {
  thinking: boolean;
  progress: string;
  /** Resolves true when the message was accepted (the caller then clears its draft). */
  send: (message: string) => Promise<boolean>;
}

export function useSupervisorChat(ws: string): SupervisorChat {
  const [thinking, setThinking] = useState(false);
  const [progress, setProgress] = useState("");
  const poll = useManagedInterval();

  const follow = (): void => {
    poll((stop) => {
      void (async () => {
        try {
          const st = await fetchJSON<ChatStatus>("/api/status");
          setProgress(st.chat.progress ?? "");
          if (st.chat.state === "running") return;
        } catch { /* keep polling */ }
        stop(); setThinking(false); setProgress("");
      })();
    }, CHAT_POLL_MS);
  };

  // Resume the indicator when an answer is already in flight for this workspace.
  useEffect(() => {
    let alive = true;
    setThinking(false); setProgress("");
    void fetchJSON<ChatStatus>("/api/status").then((st) => {
      if (!alive || st.chat.state !== "running") return;
      setThinking(true); setProgress(st.chat.progress ?? "");
      follow();
    }).catch(() => { /* offline: the shell says so */ });
    return () => { alive = false; };
  }, [ws]);

  const send = async (message: string): Promise<boolean> => {
    const text = message.trim();
    if (!text || thinking) return false;
    setThinking(true); setProgress("");
    try {
      await postJSON("/api/chat", { message: text });
      follow();
      return true;
    } catch (err) {
      setThinking(false); setProgress("");
      toast(String(err), true);
      return false;
    }
  };

  return { thinking, progress, send };
}
