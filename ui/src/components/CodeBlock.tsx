import { useState } from "react";
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

/** Monospace file preview with copy and download actions. */
export function CodeBlock({ code, filename }: { code: string; filename?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-rack-line bg-rack">
      <div className="flex items-center gap-2 border-b border-rack-line px-3 py-2">
        <span className="font-mono text-xs text-rack-dim">{filename}</span>
        <div className="ml-auto flex gap-2 [&_button]:h-8 [&_button]:border-rack-line [&_button]:bg-rack-2 [&_button]:text-rack-ink [&_button:hover]:bg-rack-line">
          <CopyButton text={code} />
          {filename && (
            <Button type="button" onClick={() => downloadText(filename, code)}>
              <Icon name="download" />
              {tr("Download")}
            </Button>
          )}
        </div>
      </div>
      <pre className="max-h-96 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-rack-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}
