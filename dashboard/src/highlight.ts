/** Tiny self-contained syntax highlighter. No CDN, no deps — the bundle ships
 *  offline. Tokenises ONE line at a time (the natural unit of a diff), so it is
 *  stateless: multi-line strings/comments are highlighted per visible line,
 *  which is exactly what a line-oriented diff needs. */

export interface Tok {
  cls: string;
  text: string;
}

interface LangSpec {
  line: string[]; // line-comment prefixes
  kw: Set<string>;
  tmpl?: boolean; // backtick template strings
}

const kw = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const CLIKE =
  "return if else for while do switch case break continue new function const let var " +
  "class extends super import export from default async await yield try catch finally " +
  "throw typeof instanceof void delete this null true false undefined in of static get set";

const LANGS: Record<string, LangSpec> = {
  ts: {
    line: ["//"], tmpl: true,
    kw: kw(CLIKE + " interface type enum namespace implements readonly public private " +
      "protected abstract as satisfies keyof infer declare is never unknown any"),
  },
  js: { line: ["//"], tmpl: true, kw: kw(CLIKE) },
  py: {
    line: ["#"],
    kw: kw("def class return if elif else for while import from as pass break continue with " +
      "try except finally raise lambda yield global nonlocal None True False and or not in is " +
      "async await del assert match case self"),
  },
  go: {
    line: ["//"],
    kw: kw("func package import var const type struct interface map chan go defer return if " +
      "else for range switch case break continue nil true false select fallthrough"),
  },
  rust: {
    line: ["//"],
    kw: kw("fn let mut const static struct enum impl trait use pub mod match if else for while " +
      "loop return break continue self Some None Ok Err true false where async await move dyn ref as"),
  },
  json: { line: [], kw: kw("true false null") },
  yaml: { line: ["#"], kw: kw("true false null yes no on off") },
  sh: {
    line: ["#"],
    kw: kw("if then fi else elif for do done case esac while until function in return export local echo"),
  },
  css: { line: [], kw: kw("") },
  html: { line: [], kw: kw("") },
  md: { line: [], kw: kw("") },
};

const EXT: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  go: "go", rs: "rust",
  json: "json", yaml: "yaml", yml: "yaml",
  sh: "sh", bash: "sh", zsh: "sh",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html", svelte: "html",
  md: "md", markdown: "md",
};

/** Best-effort language id from a file path; "" when unknown (renders as plain). */
export function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? "";
}

const WORD = /[A-Za-z_$][\w$]*/y;
const NUM = /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/y;
const PUNCT = /[{}()[\].,;:]/;
const OP = /[+\-*/%=<>!&|^~?@]/;

/** Split one line of source into coloured tokens. Unknown/plain runs get cls "". */
export function tokenizeLine(line: string, lang: string): Tok[] {
  const spec = LANGS[lang];
  if (!spec || lang === "md") return [{ cls: "", text: line }];
  const out: Tok[] = [];
  const push = (cls: string, text: string): void => { if (text) out.push({ cls, text }); };
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      push("", line.slice(i, j)); i = j; continue;
    }
    let commented = false;
    for (const p of spec.line) {
      if (line.startsWith(p, i)) { push("tok-com", line.slice(i)); i = line.length; commented = true; break; }
    }
    if (commented) continue;
    if (ch === '"' || ch === "'" || (ch === "`" && spec.tmpl)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      push("tok-str", line.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(ch)) {
      NUM.lastIndex = i;
      const nm = NUM.exec(line);
      if (nm) { push("tok-num", nm[0]); i += nm[0].length; continue; }
    }
    WORD.lastIndex = i;
    const wm = WORD.exec(line);
    if (wm) {
      const w = wm[0];
      let k = i + w.length;
      while (line[k] === " ") k++;
      if (spec.kw.has(w)) push("tok-kw", w);
      else if (line[k] === "(") push("tok-fn", w);
      else push("", w);
      i += w.length; continue;
    }
    if (PUNCT.test(ch)) { push("tok-punct", ch); i++; continue; }
    if (OP.test(ch)) {
      let j = i;
      while (j < line.length && OP.test(line[j]!)) j++;
      push("tok-op", line.slice(i, j)); i = j; continue;
    }
    push("", ch); i++;
  }
  return out;
}
