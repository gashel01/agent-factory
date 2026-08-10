import type { JSX } from "react";
import type { CapsuleAction } from "./types.js";
import { api, getWs, postJSON } from "./api.js";
import { qrSvg } from "./qr.js";
import { ExternalLink, Smartphone } from "./icons.js";
import { Button, toast } from "./core.js";

export function DeviceInstall(
  { action, devices, lanBase }: { action: CapsuleAction; devices: string[]; lanBase: string },
): JSX.Element {
  const artifactUrl = lanBase
    ? `${lanBase}/api/capsule/artifact?ws=${encodeURIComponent(getWs())}&id=${encodeURIComponent(action.id)}`
    : null;
  const qr = artifactUrl ? qrSvg(artifactUrl, { ec: "M", scale: 5, border: 2, dark: "#0b0b0c", light: "#ffffff" }) : "";
  return (
    <div className="mobile-ready">
      {qr && <div className="mobile-qr"><div className="phone-qr" dangerouslySetInnerHTML={{ __html: qr }} /></div>}
      <div className="mobile-ready-body">
        <div className="mobile-ready-title"><Smartphone size={15} /> Install on a device</div>
        <p className="phone-sub">Scan the code with a device on the same Wi-Fi, download, then open it (allow "install from unknown sources").</p>
        <div className="mobile-actions">
          <button className="btn" onClick={() => window.open(api(`/api/capsule/artifact?id=${encodeURIComponent(action.id)}`), "_blank")}>
            <ExternalLink size={14} /> Download
          </button>
          {devices.map((d) => (
            <Button key={d} kind="btn" variant="primary" autoPending onClick={async () => {
              try {
                const r = await postJSON<{ output: string }>("/api/capsule/install", { id: action.id, device: d });
                toast(`Installed on ${d}.`);
                if (r.output) toast(r.output.slice(-160));
              } catch (e) { toast(String(e), true); }
            }}>
              <Smartphone size={14} /> Install to {d}
            </Button>
          ))}
        </div>
        {devices.length === 0 && (
          <p className="phone-sub subtle">No device detected over USB — plug one in (debugging on) to install directly, or just use the QR.</p>
        )}
      </div>
    </div>
  );
}
