/**
 * Instance user data (cloud-init). Nova returns it base64-encoded in
 * `OS-EXT-SRV-ATTR:user_data` (microversion 2.3+, admins by default). It often holds
 * passwords or keys, so it starts hidden: a short masked preview, and "Reveal values"
 * decodes it (gzip too) into readable, wrapped, copyable text.
 */
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/CodeBlock";
import { Badge, Button, Card, Icon } from "@/components/ui";
import { tr, trx } from "@/lib/i18n";

/** base64 → text; gunzips when cloud-init's gzip form is used. */
async function decodeUserData(b64: string): Promise<string> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && "DecompressionStream" in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** What kind of user data it is, from its first line. */
function kindOf(text: string) {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  if (first.startsWith("#cloud-config")) return "cloud-config";
  if (first.startsWith("#!")) return tr("shell script");
  if (/^content-type:\s*multipart/i.test(first) || /^mime-version/i.test(first)) return tr("MIME multipart");
  if (first.startsWith("#include")) return "include";
  if (first.startsWith("## template: jinja")) return tr("jinja template");
  return null;
}

const PREVIEW = 96;

export function UserDataCard({ value, visible }: { value: string | null | undefined; visible: boolean }) {
  const [shown, setShown] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!value) return;
    decodeUserData(value)
      .then(setText)
      .catch(() => setError(tr("This user data isn't valid base64 (or can't be decompressed); showing it as stored.")));
  }, [value]);

  if (!visible) {
    return (
      <Card title={tr("User data")}>
        <p className="text-sm text-muted">{tr("Nova shows an instance's user data to admins only (policy os_compute_api:os-extended-server-attributes).")}</p>
      </Card>
    );
  }
  if (!value) {
    return (
      <Card title={tr("User data")}>
        <p className="text-sm text-muted">{tr("No user data was given at launch.")}</p>
      </Card>
    );
  }

  const kind = text ? kindOf(text) : null;
  const lines = text?.split("\n").length;
  return (
    <Card
      title={tr("User data")}
      actions={
        <div className="flex items-center gap-2">
          {shown && <CopyButton className="h-8" text={text ?? value} label={tr("Copy")} />}
          <Button className="h-8" onClick={() => setShown((x) => !x)} aria-pressed={shown}>
            <Icon name={shown ? "eye-off" : "eye"} />
            {shown ? tr("Hide values") : tr("Reveal values")}
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        {kind && <Badge tone="accent">{kind}</Badge>}
        {text != null && <span>{trx("{lines} lines", { lines })}</span>}
        <span>{trx("{toLocaleString} characters base64", { toLocaleString: value.length.toLocaleString() })}</span>
      </div>
      {shown ? (
        <>
          {error && <p className="mb-2 text-sm text-led-amber">{error}</p>}
          <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap select-text">
            {text ?? value}
          </pre>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setShown(true)}
          title={tr("Reveal values")}
          className="block w-full rounded-md border border-dashed border-line bg-surface px-3 py-2.5 text-left font-mono text-[12.5px] break-all text-muted hover:border-cable"
        >
          {value.slice(0, PREVIEW)}
          {value.length > PREVIEW && "…"}
          <span className="mt-1 block font-sans text-xs">{tr("Hidden: it can contain passwords or keys. Click to decode and show it.")}</span>
        </button>
      )}
    </Card>
  );
}
