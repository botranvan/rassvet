/**
 * Tag editor: chips plus a text box. Enter, comma or Tab adds the typed tag, Backspace in an
 * empty box removes the last one, pasted "a, b c" adds several. Used for Nova server tags
 * and Keystone project tags (both forbid "/" and "," in a tag).
 */
import { type KeyboardEvent, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./ui";
import { tr } from "@/lib/i18n";

export function tagError(tag: string, maxLength: number) {
  if (/[/,]/.test(tag)) return tr("Tags can't contain “/” or “,”");
  if (tag.length > maxLength) return tr("At most {n} characters per tag", { n: maxLength });
  return null;
}

export function TagInput({
  id,
  value,
  onChange,
  maxLength = 60,
  maxTags,
  placeholder,
  suggestions = [],
}: {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  maxLength?: number;
  maxTags?: number;
  placeholder?: string;
  /** Tags used elsewhere, offered as one-click additions. */
  suggestions?: string[];
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw
      .split(/[\n,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    let next = [...value];
    for (const t of parts) {
      const e = tagError(t, maxLength);
      if (e) {
        setError(e);
        return false;
      }
      if (!next.includes(t)) next.push(t);
    }
    if (maxTags && next.length > maxTags) {
      setError(tr("At most {n} tags", { n: maxTags }));
      next = next.slice(0, maxTags);
    } else setError(null);
    onChange(next);
    return true;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || (e.key === "Tab" && text.trim())) && text.trim()) {
      e.preventDefault();
      if (add(text)) setText("");
    } else if (e.key === "Enter") {
      e.preventDefault(); // don't submit the dialog by accident
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const offered = suggestions.filter((s) => !value.includes(s)).slice(0, 12);
  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1.5 focus-within:border-cable focus-within:ring-3 focus-within:ring-cable/15",
          error && "border-led-red",
        )}
      >
        {value.map((t) => (
          <Badge key={t} tone="accent" onRemove={() => onChange(value.filter((x) => x !== t))} removeLabel={tr("Remove tag {tag}", { tag: t })}>
            {t}
          </Badge>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => text.trim() && add(text) && setText("")}
          onPaste={(e) => {
            const v = e.clipboardData.getData("text");
            if (/[\n,]/.test(v)) {
              e.preventDefault();
              add(v);
            }
          }}
          placeholder={value.length ? "" : (placeholder ?? tr("Type a tag and press Enter"))}
          className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted/70"
        />
      </div>
      {error && <p className="text-xs text-led-red">{error}</p>}
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{tr("Used elsewhere:")}</span>
          {offered.map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="rounded-md border border-dashed border-line px-1.5 py-0.5 hover:border-cable hover:text-cable">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only tag chips ("—" when none). */
export function TagList({ tags, empty = "—" }: { tags?: string[] | null; empty?: string }) {
  if (!tags?.length) return <span className="text-muted">{empty}</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t} tone="accent">
          {t}
        </Badge>
      ))}
    </span>
  );
}
