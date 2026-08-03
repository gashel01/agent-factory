/**
 * QR rendering for the "Open on your phone" panel.
 *
 * Thin wrapper over the `qrcode-generator` library (synchronous, tiny, MIT).
 * We render the SVG ourselves rather than using the library's `createSvgTag`
 * so we keep full control over the module colours (theme-dependent `dark`,
 * transparent `light`) and emit a single compact `<path>`.
 */
import qrcode from "qrcode-generator";

// Encode byte-mode strings as UTF-8. The library only ships an SJIS encoder by
// default; our URLs are ASCII, but this is correct for any input and matches
// the QR byte-mode spec. `TextEncoder` exists in browsers and Node.
const utf8 = new TextEncoder();
qrcode.stringToBytes = (s: string) => Array.from(utf8.encode(s));

export type EC = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** Error-correction level. Default "M". */
  ec?: EC;
}

/** Encode `text` (UTF-8, byte mode) into a boolean module matrix (true = dark). */
export function qrMatrix(text: string, opts: QrOptions = {}): boolean[][] {
  const qr = qrcode(0, opts.ec ?? "M"); // typeNumber 0 = auto-fit smallest version
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const m: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    m.push(row);
  }
  return m;
}

export interface QrSvgOptions extends QrOptions {
  /** Pixel size of one module. Default 6. */
  scale?: number;
  /** Quiet-zone width in modules. ISO mandates 4; default 4. */
  border?: number;
  /** Dark module colour. Default "#000". */
  dark?: string;
  /** Light module / background colour. Default "#fff". */
  light?: string;
}

/**
 * Render `text` as a self-contained QR SVG string (byte mode). Dark modules are
 * drawn as a single `<path>` for compactness.
 */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const scale = opts.scale ?? 6;
  const border = opts.border ?? 4;
  const dark = opts.dark ?? "#000";
  const light = opts.light ?? "#fff";
  const m = qrMatrix(text, opts);
  const n = m.length;
  const dim = (n + border * 2) * scale;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (m[r]![c]) {
      const x = (c + border) * scale;
      const y = (r + border) * scale;
      d += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`;
}
