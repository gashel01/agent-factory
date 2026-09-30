/** Put a built artifact (an APK…) on a device: a QR code a phone on the same
 *  Wi-Fi can scan, a plain download, and a direct install per device detected
 *  over USB. Same endpoints as the classic cockpit-device.tsx. */

import type { JSX } from "react";
import { api, getWs, postJSON } from "../../../api.js";
import { toast } from "../../../core.js";
import { qrSvg } from "../../../qr.js";
import type { CapsuleAction } from "../../../types.js";
import { Download, Smartphone } from "../../icons.js";
import { Btn } from "../../ui.js";
import { plainError } from "../repo/errors.js";

// A QR code must stay black-on-white whatever the theme, or phones can't read it.
const QR_DARK = "#000000";
const QR_LIGHT = "#ffffff";

export function DeviceInstall({ action, devices, lanBase }: { action: CapsuleAction; devices: string[]; lanBase: string }): JSX.Element {
  const artifactUrl = lanBase
    ? `${lanBase}/api/capsule/artifact?ws=${encodeURIComponent(getWs())}&id=${encodeURIComponent(action.id)}`
    : null;
  const qr = artifactUrl ? qrSvg(artifactUrl, { ec: "M", scale: 5, border: 2, dark: QR_DARK, light: QR_LIGHT }) : "";
  const install = async (d: string): Promise<void> => {
    try {
      const r = await postJSON<{ output: string }>("/api/capsule/install", { id: action.id, device: d });
      toast(`Installed on ${d}.`);
      if (r.output) toast(r.output.slice(-160));
    } catch (e) { toast(plainError(e, `Couldn't install on ${d}.`).text, true); }
  };
  return (
    <div className="rn-device">
      {qr && <div className="rn-qr" role="img" aria-label="QR code to download the build" dangerouslySetInnerHTML={{ __html: qr }} />}
      <div className="stack rn-gap-6">
        <b className="row rn-gap-6"><Smartphone size={15} aria-hidden="true" /> Install on a device</b>
        <p className="hint">Scan the code with a device on the same Wi-Fi, download, then open it (allow “install from unknown sources”).</p>
        <div className="row rn-wrap">
          <Btn small onClick={() => { window.open(api(`/api/capsule/artifact?id=${encodeURIComponent(action.id)}`), "_blank"); }}>
            <Download size={14} /> Download
          </Btn>
          {devices.map((d) => <Btn key={d} small kind="fill" onClick={() => install(d)}><Smartphone size={14} /> Install to {d}</Btn>)}
        </div>
        {devices.length === 0 && <p className="faint rn-small">No device detected over USB — plug one in (debugging on) to install directly, or use the QR code.</p>}
      </div>
    </div>
  );
}
