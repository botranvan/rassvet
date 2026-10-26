import { type CSSProperties, useMemo, useState } from "react";
import { MONOKAI, highlightHcl } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import { Button, Icon } from "./ui";
import { tr } from "@/lib/i18n";

/** Save `text` as a file in the browser. */
export function downloadText(filename: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http deployments.
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = tr("Copy"), className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} className={cn(done && "text-led-green")} />
      {done ? tr("Copied") : label}
    </Button>
  );
}

/**
 * Monospace file preview with copy and download actions. `language="hcl"` colours
 * Terraform code with the Monokai theme (copy and download keep the plain text).
 */
export function CodeBlock({ code, filename, language }: { code: string; filename?: string; language?: "hcl" }) {
  const hcl = language === "hcl";
  const body = useMemo(() => (hcl ? highlightHcl(code) : code), [code, hcl]);
  // Monokai colours as CSS variables, so the Tailwind classes below can use them.
  const theme = hcl
    ? ({ "--mk-bg": MONOKAI.bg, "--mk-bar": MONOKAI.bar, "--mk-line": MONOKAI.line, "--mk-fg": MONOKAI.fg, "--mk-dim": MONOKAI.dim } as CSSProperties)
    : undefined;
  return (
    <div
      style={theme}
      className={cn("overflow-hidden rounded-lg border", hcl ? "border-[var(--mk-line)] bg-[var(--mk-bg)]" : "border-rack-line bg-rack")}
    >
      <div className={cn("flex items-center gap-2 border-b px-3 py-2", hcl ? "border-[var(--mk-line)] bg-[var(--mk-bar)]" : "border-rack-line")}>
        {hcl && (
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-[#f92672]" />
            <span className="size-2.5 rounded-full bg-[#e6db74]" />
            <span className="size-2.5 rounded-full bg-[#a6e22e]" />
          </span>
        )}
        <span className={cn("font-mono text-xs", hcl ? "text-[var(--mk-dim)]" : "text-rack-dim")}>{filename}</span>
        <div
          className={cn(
            "ml-auto flex gap-2 [&_button]:h-8",
            hcl
              ? "[&_button]:border-[var(--mk-line)] [&_button]:bg-[var(--mk-bg)] [&_button]:text-[var(--mk-fg)] [&_button:hover]:bg-[var(--mk-line)]"
              : "[&_button]:border-rack-line [&_button]:bg-rack-2 [&_button]:text-rack-ink [&_button:hover]:bg-rack-line",
          )}
        >
          <CopyButton text={code} />
          {filename && (
            <Button type="button" onClick={() => downloadText(filename, code)}>
              <Icon name="download" />
              {tr("Download")}
            </Button>
          )}
        </div>
      </div>
      <pre
        className={cn(
          "max-h-96 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed",
          hcl ? "text-[var(--mk-fg)] selection:bg-[#49483e]" : "text-rack-ink",
        )}
      >
        <code>{body}</code>
      </pre>
    </div>
  );
}
