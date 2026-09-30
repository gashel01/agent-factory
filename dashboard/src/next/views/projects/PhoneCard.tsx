/** "Open on your phone": a QR of the dashboard's LAN address. In LAN mode the
 *  server wants the operator token on every call, so the QR (and the copied
 *  link) carry it — the phone stores it on first load, like the desktop does.
 *  Dismissable; the Projects topbar brings it back. */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { fetchJSON, getToken } from "../../../api.js";
import { qrSvg } from "../../../qr.js";
import type { NetInfo } from "../../../api-shapes.js";
import { Check, Smartphone, X } from "../../icons.js";
import { Btn, IconBtn } from "../../ui.js";

/** Same storage key as the classic card: dismissing it in one UI hides it in both. */
const DISMISS_KEY = "factory.phonecard";

export function readPhoneDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === "off"; } catch { return false; }
}
export function writePhoneDismissed(off: boolean): void {
  try {
    if (off) localStorage.setItem(DISMISS_KEY, "off");
    else localStorage.removeItem(DISMISS_KEY);
  } catch { /* private mode */ }
}

export function PhoneCard({ onDismiss }: { onDismiss: () => void }): JSX.Element | null {
  const [net, setNet] = useState<NetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchJSON<NetInfo>("/api/netinfo").then((n) => { if (alive) setNet(n); }).catch(() => { /* no LAN: no card */ });
    return () => { alive = false; };
  }, []);

  if (!net?.url) return null;
  const token = getToken();
  const phoneUrl = token ? `${net.url}/?token=${encodeURIComponent(token)}` : `${net.url}/`;
  // currentColor: the modules follow the card's text colour, so the code reads in both themes.
  const svg = qrSvg(phoneUrl, { ec: "M", scale: 4, border: 2, dark: "currentColor", light: "transparent" });
  const copy = (): void => {
    void navigator.clipboard?.writeText(phoneUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard refused: the link is on screen */ });
  };

  return (
    <aside className="card pj-phone" aria-label="Open on your phone">
      <div className="pj-phone-qr" role="img" aria-label="QR code of the dashboard link" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="stack pj-phone-body">
        <div className="row pj-phone-head">
          <Smartphone size={16} />
          <b className="pj-phone-title">Open on your phone</b>
          <span className="spacer" />
          <IconBtn label="Hide the phone link" small onClick={onDismiss}><X size={15} /></IconBtn>
        </div>
        <p className="hint">Scan with your camera on the same Wi-Fi to drive Warden from your phone.</p>
        <div className="row pj-phone-url">
          <span className="mono pj-phone-addr">{net.url.replace(/^https?:\/\//, "")}</span>
          <Btn small kind="ghost" onClick={copy}>{copied ? <><Check size={13} /> Copied</> : "Copy link"}</Btn>
        </div>
        {token && <p className="hint pj-phone-note">The link carries your operator token — share it only with yourself.</p>}
      </div>
    </aside>
  );
}
