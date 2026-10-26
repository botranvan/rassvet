/**
 * Small syntax highlighter for Terraform / OpenTofu (HCL), Monokai colours. No dependency:
 * one regular-expression pass over the text, so it stays fast on large exports and the
 * copied / downloaded text is untouched (only the rendering is coloured).
 */
import type { ReactNode } from "react";

/** Monokai palette. */
export const MONOKAI = {
  bg: "#272822",
  bar: "#1e1f1c",
  line: "#3e3d32",
  fg: "#f8f8f2",
  dim: "#90908a",
  comment: "#75715e",
  string: "#e6db74",
  number: "#ae81ff",
  keyword: "#f92672",
  attr: "#a6e22e",
  type: "#66d9ef",
  param: "#fd971f",
};

const c = MONOKAI;
const STYLE = {
  comment: { color: c.comment, fontStyle: "italic" },
  string: { color: c.string },
  number: { color: c.number },
  keyword: { color: c.keyword },
  operator: { color: c.keyword },
  attr: { color: c.attr },
  block: { color: c.type, fontStyle: "italic" },
  func: { color: c.type },
  ref: { color: c.param },
  label: { color: c.attr },
  interp: { color: c.keyword },
} as const;
type Kind = keyof typeof STYLE;

/** Top-level Terraform blocks. */
const KEYWORDS = new Set(["resource", "data", "variable", "output", "locals", "module", "provider", "terraform", "import", "moved", "removed", "check"]);
/** Roots of references: var.x, data.a.b, local.x, each.key… */
const REF_ROOTS = new Set(["var", "local", "data", "module", "each", "count", "path", "self", "terraform"]);
const LITERALS = new Set(["true", "false", "null"]);
const CONTROL = new Set(["for", "in", "if", "for_each", "dynamic", "content"]);

const TOKEN =
  /(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(<<-?([A-Za-z_]+)\n[\s\S]*?\n[ \t]*\3(?=\n|$))|("(?:[^"\\\n]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)|(==|!=|<=|>=|&&|\|\||=>|[=!<>?:%*/+-])/g;

/** Highlight HCL into React nodes (spans with inline Monokai colours). */
export function highlightHcl(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const push = (text: string, kind?: Kind) => {
    if (!text) return;
    out.push(kind ? <span key={k++} style={STYLE[kind]}>{text}</span> : text);
  };
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index!;
    push(code.slice(last, i));
    last = i + m[0].length;
    const [tok, comment, heredoc, , str, num, ident, op] = m;
    if (comment) push(tok, "comment");
    else if (heredoc) push(tok, "string");
    else if (str) pushString(str, push);
    else if (num) push(tok, "number");
    else if (op) push(tok, "operator");
    else if (ident) {
      const before = code.slice(code.lastIndexOf("\n", i - 1) + 1, i);
      const after = code.slice(last, last + 64);
      const lineStart = /^\s*$/.test(before);
      const prevChar = before.trimEnd().slice(-1);
      if (prevChar === ".") push(tok); // attribute access: var.name, openstack_x.y.id
      else if (LITERALS.has(tok)) push(tok, "number");
      else if (lineStart && KEYWORDS.has(tok) && /^\s*["{]/.test(after)) push(tok, "keyword");
      else if (lineStart && /^\s*=(?!=)/.test(after)) push(tok, "attr");
      else if (lineStart && /^\s*("[^"\n]*"\s*)*\{/.test(after)) push(tok, "block");
      else if (/^\s*\(/.test(after)) push(tok, "func");
      else if (REF_ROOTS.has(tok) && after.startsWith(".")) push(tok, "ref");
      else if (CONTROL.has(tok)) push(tok, "keyword");
      else if (/^openstack_\w+$/.test(tok)) push(tok, "label");
      else push(tok);
    }
  }
  push(code.slice(last));
  return out;
}

/** A string literal, with `${…}` / `%{…}` interpolations shown like code. */
function pushString(s: string, push: (text: string, kind?: Kind) => void) {
  const re = /[$%]\{[^}]*\}/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    push(s.slice(last, m.index), "string");
    push(m[0].slice(0, 2), "interp");
    push(m[0].slice(2, -1), "ref");
    push("}", "interp");
    last = m.index! + m[0].length;
  }
  push(s.slice(last), "string");
}
