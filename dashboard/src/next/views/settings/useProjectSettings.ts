/** The active project's settings, loaded from and saved to its factory.yaml.
 *
 *  Settings ↔ YAML goes through the classic model.ts (parseSettings /
 *  generateConfig) so both interfaces read and write the exact same file. The
 *  requests are workspace-scoped by api.ts (?ws=), and the hook reloads when the
 *  operator switches project, so an edit can never land in the wrong one. */

import { useEffect, useState } from "react";
import { fetchJSON, postJSON } from "../../../api.js";
import { toast, useManagedInterval } from "../../../core.js";
import { generateConfig, parseSettings } from "../../../model.js";
import type { Settings } from "../../../model.js";

export interface ProjectSettings {
  /** The form's current values, null while loading. */
  s: Settings | null;
  /** Couldn't read factory.yaml (plain words, for the page). */
  error: string | null;
  /** The form differs from what is on disk. */
  dirty: boolean;
  set: (patch: Partial<Settings>) => void;
  save: () => Promise<boolean>;
  reload: () => void;
  /** The doctor's report ("Test these settings"), null until a test ran. */
  testOut: string | null;
  testing: boolean;
  test: () => Promise<void>;
  /** Flip the knowledge base: the server scaffolds it and edits factory.yaml itself. */
  setKnowledge: (on: boolean) => Promise<void>;
}

/** How often the doctor's state is polled while a test runs. */
const DOCTOR_POLL_MS = 2000;

export function useProjectSettings(ws: string): ProjectSettings {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<string | null>(null);
  const pollDoctor = useManagedInterval();

  useEffect(() => {
    let alive = true;
    setS(null); setSaved(null); setError(null); setTestOut(null);
    fetchJSON<{ content: string }>("/api/config")
      .then(({ content }) => {
        if (!alive) return;
        const parsed = parseSettings(content);
        setS(parsed); setSaved(parsed);
      })
      .catch(() => { if (alive) setError("Couldn't read this project's settings — is the Warden server still running?"); });
    return () => { alive = false; };
  }, [ws, nonce]);

  const set = (patch: Partial<Settings>): void => setS((cur) => (cur ? { ...cur, ...patch } : cur));

  const write = async (): Promise<void> => {
    if (!s) return;
    await fetchJSON("/api/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: generateConfig(s) }),
    });
    setSaved(s);
  };

  const save = async (): Promise<boolean> => {
    try { await write(); toast("Saved. Your next run uses these settings."); return true; }
    catch (err) { toast(String(err), true); return false; }
  };

  // Same flow as the classic panel: save first (the doctor reads factory.yaml),
  // start the doctor, then poll its job until it settles.
  const test = async (): Promise<void> => {
    try { await write(); await postJSON("/api/doctor", {}); }
    catch (err) { toast(String(err), true); return; }
    setTesting(true);
    setTestOut("Testing for real — one tiny agent tries the web and your commands (~30s)…");
    pollDoctor((stop) => {
      void (async () => {
        try {
          const st = await fetchJSON<{ doctor: { state: string; output: string } }>("/api/status");
          if (st.doctor.state === "running") return;
          stop(); setTesting(false);
          setTestOut(st.doctor.output.trim() || (st.doctor.state === "error" ? "The check failed — see the server logs." : "(no result)"));
        } catch { /* a missed poll: the next tick retries */ }
      })();
    }, DOCTOR_POLL_MS);
  };

  const setKnowledge = async (on: boolean): Promise<void> => {
    try {
      await postJSON("/api/knowledge/enable", { enabled: on });
      // The server already wrote factory.yaml: mirror it on both sides so the
      // toggle doesn't read as an unsaved change and a later Save keeps it.
      setS((cur) => (cur ? { ...cur, knowledge: on } : cur));
      setSaved((cur) => (cur ? { ...cur, knowledge: on } : cur));
      toast(on ? "Knowledge base wired into your agents' next run." : "Knowledge base unplugged from your agents.");
    } catch (err) { toast(String(err), true); }
  };

  const dirty = s !== null && saved !== null && JSON.stringify(s) !== JSON.stringify(saved);
  return { s, error, dirty, set, save, reload: () => setNonce((n) => n + 1), testOut, testing, test, setKnowledge };
}
