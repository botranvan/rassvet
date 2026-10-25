/**
 * Browse one object storage container like a file system: pseudo-folders ("/" in names),
 * uploads with progress (files, whole folders, drag and drop), downloads, temporary and
 * public links, copy / move / rename, object properties (content type, metadata, expiry)
 * and deletes (folders recursively).
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { CopyButton, copyText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, toRows } from "@/components/KeyValueEditor";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch } from "@/components/ui";
import { fmtBytes, fmtDate } from "@/lib/format";
import { lang, tr, trx } from "@/lib/i18n";
import { type Entry, isPublic, objPath, objectUrl, swift, uploadObject, useContainerMeta, useObjectPages, useSwiftContainers, useSwiftInfo } from "@/lib/swift";
import { cn } from "@/lib/utils";
import { ContainerSettingsDialog, DeleteContainerDialog, useRefreshSwift } from "./Containers";

type Obj = Extract<Entry, { name: string }>;
const keyOf = (e: Entry) => ("subdir" in e ? e.subdir : e.name);
const isDir = (e: Entry): e is { subdir: string } => "subdir" in e;
/** Last path segment ("a/b/c.txt" → "c.txt", "a/b/" → "b"). */
const base = (p: string) => p.replace(/\/$/, "").split("/").pop() ?? p;

function download(container: string, name: string) {
  const a = Object.assign(document.createElement("a"), { href: objectUrl(container, name), download: base(name) });
  document.body.append(a);
  a.click();
  a.remove();
}

interface Upload {
  id: number;
  name: string;
  loaded: number;
  total: number;
  state: "queued" | "uploading" | "done" | "error";
  error?: string;
  abort?: () => void;
}

/** Up to three uploads at a time; the list stays until dismissed. */
function useUploads(container: string, onDone: () => void) {
  const [items, setItems] = useState<Upload[]>([]);
  const queue = useRef<{ id: number; name: string; file: File }[]>([]);
  const running = useRef(0);
  const seq = useRef(0);
  const patch = (id: number, p: Partial<Upload>) => setItems((l) => l.map((u) => (u.id === id ? { ...u, ...p } : u)));
  const pump = () => {
    while (running.current < 3 && queue.current.length) {
      const job = queue.current.shift()!;
      running.current++;
      const up = uploadObject(container, job.name, job.file, (loaded, total) => patch(job.id, { loaded, total }));
      patch(job.id, { state: "uploading", abort: up.abort });
      up.done
        .then(() => patch(job.id, { state: "done", loaded: job.file.size }))
        .catch((e: Error) => patch(job.id, { state: "error", error: e.message }))
        .finally(() => {
          running.current--;
          if (!running.current && !queue.current.length) onDone();
          pump();
        });
    }
  };
  const add = (files: { name: string; file: File }[]) => {
    const jobs = files.map((f) => ({ id: ++seq.current, ...f }));
    setItems((l) => [...l, ...jobs.map((j) => ({ id: j.id, name: j.name, loaded: 0, total: j.file.size, state: "queued" as const }))]);
    queue.current.push(...jobs);
    pump();
  };
  const busy = items.some((u) => u.state === "queued" || u.state === "uploading");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return { items, add, busy, clear: () => setItems((l) => l.filter((u) => u.state === "queued" || u.state === "uploading")) };
}

export default function ObjectBrowser() {
  const { container = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const folder = params.get("path") ?? "";
  const navigate = useNavigate();
  const toast = useToast();
  const info = useSwiftInfo();
  const meta = useContainerMeta(container);
  const pages = useObjectPages(container, folder);
  const refresh = useRefreshSwift();
  const uploads = useUploads(container, () => {
    refresh();
    toast(tr("Uploads finished"));
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [settings, setSettings] = useState(false);
  const [deletingContainer, setDeletingContainer] = useState(false);
  const [open, setOpen] = useState<{ kind: "props" | "share" | "copy" | "delete"; e: Entry } | null>(null);
  const pub = isPublic(meta.data?.read_acl);
  const publicUrl = (name: string) => `${info.data?.endpoint ?? ""}/${encodeURIComponent(container)}/${objPath(name)}`;
  const go = (path: string) => setParams(path ? { path } : {});

  const onFiles = (list: FileList | null, relative = false) => {
    if (!list?.length) return;
    uploads.add(
      Array.from(list).map((f) => ({
        file: f,
        name: folder + (relative && (f as File & { webkitRelativePath?: string }).webkitRelativePath ? (f as File & { webkitRelativePath: string }).webkitRelativePath : f.name),
      })),
    );
  };

  const crumbs = folder.split("/").filter(Boolean);
  const columns: Column<Entry>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (e) =>
        isDir(e) ? (
          <button type="button" onClick={() => go(e.subdir)} className="inline-flex max-w-full items-center gap-2 font-medium text-cable hover:underline">
            <Icon name="folder" className="size-4 shrink-0 text-led-amber" />
            <span className="truncate">{base(e.subdir)}/</span>
          </button>
        ) : (
          <button type="button" onClick={() => setOpen({ kind: "props", e })} className="inline-flex max-w-full items-center gap-2 text-left hover:text-cable">
            <Icon name="file" className="size-4 shrink-0 text-muted" />
            <span className="truncate">{e.name.slice(folder.length)}</span>
          </button>
        ),
      value: keyOf,
    },
    { key: "size", header: tr("Size"), width: "7rem", cell: (e) => (isDir(e) ? "" : fmtBytes(e.bytes)), value: (e) => (isDir(e) ? -1 : e.bytes) },
    { key: "type", header: tr("Type"), width: "12rem", hideBelow: "lg", cell: (e) => (isDir(e) ? tr("Folder") : <span className="font-mono text-[12.5px]">{e.content_type}</span>), value: (e) => (isDir(e) ? "" : e.content_type) },
    { key: "modified", header: tr("Last modified"), width: "11rem", hideBelow: "md", cell: (e) => (isDir(e) ? "" : fmtDate(e.last_modified)), value: (e) => (isDir(e) ? "" : e.last_modified) },
  ];

  const items = (e: Entry): MenuEntry[] =>
    isDir(e)
      ? [
          { label: tr("Open"), icon: "folder-open", onSelect: () => go(e.subdir) },
          "-",
          { label: tr("Delete folder"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", e }) },
        ]
      : [
          { label: tr("Download"), icon: "download", onSelect: () => download(container, e.name) },
          { label: tr("Properties"), icon: "info", onSelect: () => setOpen({ kind: "props", e }) },
          { label: tr("Share a temporary link"), icon: "link", onSelect: () => setOpen({ kind: "share", e }) },
          pub && { label: tr("Copy public URL"), icon: "globe", onSelect: () => copyText(publicUrl(e.name)).then((ok) => ok && toast(tr("Public URL copied"))) },
          { label: tr("Copy or move"), icon: "copy", onSelect: () => setOpen({ kind: "copy", e }) },
          "-",
          { label: tr("Delete object"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", e }) },
        ];

  return (
    <div
      onDragOver={(ev) => {
        if (ev.dataTransfer.types.includes("Files")) {
          ev.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(ev) => ev.currentTarget === ev.target && setDragging(false)}
      onDrop={(ev) => {
        ev.preventDefault();
        setDragging(false);
        onFiles(ev.dataTransfer.files);
      }}
      className="relative"
    >
      <Link to="/object-store/containers" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Containers")}
      </Link>
      <PageHeader
        title={container}
        description={
          meta.data ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {tr("{n} objects, {size}", { n: (meta.data.objects ?? 0).toLocaleString(), size: fmtBytes(meta.data.bytes ?? 0) ?? "" })}
              {pub && <Badge tone="accent">{tr("public")}</Badge>}
              {meta.data.history_location && <Badge>{tr("versioned → {c}", { c: meta.data.history_location })}</Badge>}
              {meta.data.storage_policy && <Badge>{meta.data.storage_policy}</Badge>}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" />
              {tr("Upload files")}
            </Button>
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Upload a folder"), icon: "folder-up", onSelect: () => dirInput.current?.click() },
                { label: tr("New folder"), icon: "folder-plus", onSelect: () => setNewFolder(true) },
                "-",
                { label: tr("Container settings"), icon: "settings", onSelect: () => setSettings(true) },
                { label: tr("Delete container"), icon: "trash", danger: true, onSelect: () => setDeletingContainer(true) },
              ]}
            />
          </div>
        }
      />
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (onFiles(e.target.files), (e.target.value = ""))} />
      <input
        ref={(el) => {
          dirInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        onChange={(e) => (onFiles(e.target.files, true), (e.target.value = ""))}
      />
      <ErrorNotice error={meta.error ?? pages.query.error} className="mb-4" />

      <nav aria-label={tr("Folder")} className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => go("")} className={cn("rounded px-1.5 py-0.5 hover:bg-ink/5", !folder && "font-semibold")}>
          {container}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <Icon name="chevron-right" className="size-3.5 text-muted" />
            <button type="button" onClick={() => go(`${crumbs.slice(0, i + 1).join("/")}/`)} className={cn("rounded px-1.5 py-0.5 hover:bg-ink/5", i === crumbs.length - 1 && "font-semibold")}>
              {c}
            </button>
          </span>
        ))}
      </nav>

      {uploads.items.length > 0 && <UploadList uploads={uploads} />}

      <DataTable
        rows={pages.rows}
        remote={pages.remote}
        columns={columns}
        rowKey={keyOf}
        loading={pages.query.isPending}
        tableId="object-browser"
        noun={tr("objects")}
        rowLabel={(e) => base(keyOf(e))}
        empty={
          <span>
            {folder ? tr("This folder is empty.") : tr("This container is empty.")} {tr("Drop files here or use “Upload files”.")}
          </span>
        }
        onRefresh={refresh}
        refreshing={pages.query.isFetching}
        onBulkDone={refresh}
        rowActions={items}
        bulkActions={[
          {
            id: "download",
            label: tr("Download"),
            icon: "download",
            title: tr("Download objects?"),
            past: tr("started"),
            body: tr("Each object downloads as its own file; folders are skipped."),
            check: (e) => (isDir(e) ? tr("Folder") : true),
            run: async (e) => download(container, keyOf(e)),
          },
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete objects?"),
            past: tr("deleted"),
            body: tr("Folders are deleted with everything in them. This can't be undone."),
            run: (e) => (isDir(e) ? swift.deletePrefix(container, e.subdir) : swift.delObject(container, e.name)),
          },
        ]}
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-cable bg-cable-soft/60">
          <p className="rounded-md bg-panel px-4 py-2 text-sm font-medium shadow">{trx("Drop to upload into {folder}", { folder: <span className="font-mono">{folder || `${container}/`}</span> })}</p>
        </div>
      )}

      {newFolder && <NewFolderDialog container={container} folder={folder} onClose={() => setNewFolder(false)} onDone={(p) => go(p)} />}
      {settings && <ContainerSettingsDialog name={container} onClose={() => setSettings(false)} />}
      {deletingContainer && meta.data && (
        <DeleteContainerDialog container={{ name: container, count: meta.data.objects ?? 0 }} onClose={() => setDeletingContainer(false)} onDone={() => navigate("/object-store/containers")} />
      )}
      {open?.kind === "props" && !isDir(open.e) && <PropertiesDialog container={container} obj={open.e} publicUrl={pub ? publicUrl(open.e.name) : null} onClose={() => setOpen(null)} />}
      {open?.kind === "share" && !isDir(open.e) && <ShareDialog container={container} name={open.e.name} onClose={() => setOpen(null)} />}
      {open?.kind === "copy" && !isDir(open.e) && <CopyDialog container={container} name={open.e.name} onClose={() => setOpen(null)} />}
      {open?.kind === "delete" && (
        <ActionDialog<{ deleted_objects?: number } | undefined>
          onClose={() => setOpen(null)}
          danger
          title={isDir(open.e) ? tr("Delete folder {name}?", { name: base(open.e.subdir) }) : tr("Delete {name}?", { name: base(open.e.name) })}
          submitLabel={tr("Delete")}
          done={(r) => (r?.deleted_objects != null ? tr("{n} objects deleted", { n: r.deleted_objects.toLocaleString() }) : tr("Object deleted"))}
          onDone={refresh}
          run={() => (isDir(open.e) ? swift.deletePrefix(container, open.e.subdir) : swift.delObject(container, (open.e as Obj).name).then(() => undefined))}
        >
          <p className="text-sm">{isDir(open.e) ? tr("Every object in the folder (and its subfolders) is deleted. This can't be undone.") : tr("This can't be undone (unless the container keeps old versions).")}</p>
        </ActionDialog>
      )}
    </div>
  );
}

function UploadList({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const total = uploads.items.reduce((n, u) => n + u.total, 0);
  const loaded = uploads.items.reduce((n, u) => n + (u.state === "done" ? u.total : u.loaded), 0);
  const pct = total ? Math.round((loaded / total) * 100) : 100;
  const failed = uploads.items.filter((u) => u.state === "error").length;
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm">
        <span className="font-medium">{uploads.busy ? tr("Uploading {n} file(s)…", { n: uploads.items.length }) : tr("Uploads finished")}</span>
        <span className="text-xs text-muted tabular-nums">
          {fmtBytes(loaded)} / {fmtBytes(total)} · {pct}%
        </span>
        {failed > 0 && <span className="text-xs text-led-red">{tr("{n} failed", { n: failed })}</span>}
        {!uploads.busy && (
          <button type="button" onClick={uploads.clear} className="ml-auto text-xs text-muted hover:text-ink">
            {tr("Dismiss")}
          </button>
        )}
      </div>
      <ul className="max-h-48 overflow-y-auto text-sm">
        {uploads.items.map((u) => {
          const p = u.total ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : 0;
          return (
            <li key={u.id} className="flex items-center gap-3 border-b border-line px-4 py-1.5 last:border-0">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={u.name}>
                {u.name}
              </span>
              {u.state === "uploading" && (
                <>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink/8">
                    <span className="block h-full rounded-full bg-cable" style={{ width: `${p}%` }} />
                  </span>
                  <button type="button" onClick={u.abort} className="text-xs text-muted hover:text-led-red">
                    {tr("Cancel")}
                  </button>
                </>
              )}
              {u.state === "queued" && <span className="text-xs text-muted">{tr("waiting")}</span>}
              {u.state === "done" && <span className="text-xs text-led-green">{tr("Uploaded")}</span>}
              {u.state === "error" && (
                <span className="max-w-64 truncate text-xs text-led-red" title={u.error}>
                  {u.error === "cancelled" ? tr("Cancelled") : u.error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NewFolderDialog({ container, folder, onClose, onDone }: { container: string; folder: string; onClose: () => void; onDone: (path: string) => void }) {
  const refresh = useRefreshSwift();
  const [name, setName] = useState("");
  const n = name.trim().replace(/^\/+|\/+$/g, "");
  const bad = n.split("/").some((s) => s === "." || s === "..");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("New folder")}
      description={folder ? trx("Inside {folder}", { folder: <span className="font-mono">{folder}</span> }) : undefined}
      submitLabel={tr("Create folder")}
      canSubmit={!!n && !bad}
      done={tr("Folder created")}
      onDone={() => {
        refresh();
        onDone(`${folder}${n}/`);
      }}
      run={() => swift.folder(container, `${folder}${n}`)}
    >
      <Field label={tr("Name")} hint={tr("Use “/” to create nested folders.")}>
        {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("reports/2026")} />}
      </Field>
      <p className="text-xs text-muted">{tr("Swift has no real folders: this stores an empty “folder/” marker object, and objects whose names start with the folder path appear inside it.")}</p>
    </ActionDialog>
  );
}

const toLocalInput = (unix: number) => {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function PropertiesDialog({ container, obj, publicUrl, onClose }: { container: string; obj: Obj; publicUrl: string | null; onClose: () => void }) {
  const refresh = useRefreshSwift();
  const [m, setM] = useState<Awaited<ReturnType<typeof swift.meta>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ct, setCt] = useState("");
  const [rows, setRows] = useState<KvRow[]>([]);
  const [expiry, setExpiry] = useState(false);
  const [at, setAt] = useState("");
  useEffect(() => {
    swift
      .meta(container, obj.name)
      .then((x) => {
        setM(x);
        setCt(x.content_type ?? "");
        setRows(toRows(x.metadata));
        setExpiry(x.delete_at != null);
        setAt(x.delete_at ? toLocalInput(x.delete_at) : "");
      })
      .catch(setError);
  }, [container, obj.name]);
  const kvErr = kvError(rows) ?? (rows.some((r) => r.key.trim() && !/^[A-Za-z0-9_-]+$/.test(r.key.trim())) ? tr("Keys may contain letters, digits, “-” and “_” only") : null);
  const atUnix = at ? Math.floor(new Date(at).getTime() / 1000) : null;
  const atBad = expiry && (!atUnix || atUnix * 1000 <= Date.now());
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={base(obj.name)}
      description={<span className="font-mono">{obj.name}</span>}
      submitLabel={tr("Save")}
      canSubmit={!!m && !kvErr && !atBad}
      done={tr("Properties saved")}
      onDone={refresh}
      run={() => swift.setMeta(container, obj.name, { content_type: ct.trim() || undefined, metadata: fromRows(rows), delete_at: expiry ? atUnix : m?.delete_at != null ? null : undefined })}
    >
      <ErrorNotice error={error} />
      {!m && !error && <p className="text-sm text-muted">{tr("Loading…")}</p>}
      {m && (
        <>
          <dl>
            <Detail label={tr("Size")}>{fmtBytes(m.bytes ?? 0)}</Detail>
            <Detail label={tr("Last modified")}>{m.last_modified ? new Date(m.last_modified).toLocaleString(lang === "vi" ? "vi-VN" : undefined) : "—"}</Detail>
            <Detail label="ETag">
              <Mono>{m.etag ?? "—"}</Mono>
            </Detail>
            {(m.static_large_object || m.manifest) && <Detail label={tr("Large object")}>{m.static_large_object ? tr("Static large object (SLO)") : tr("Dynamic large object (DLO): {m}", { m: m.manifest ?? "" })}</Detail>}
            {publicUrl && (
              <Detail label={tr("Public URL")}>
                <span className="flex min-w-0 items-center gap-2">
                  <Mono className="truncate">{publicUrl}</Mono>
                  <CopyButton text={publicUrl} label="" className="h-7 px-2" />
                </span>
              </Detail>
            )}
          </dl>
          <div className="flex gap-2">
            <Button className="h-8" onClick={() => download(container, obj.name)}>
              <Icon name="download" />
              {tr("Download")}
            </Button>
          </div>
          <Field label={tr("Content type")}>{(id) => <Input id={id} value={ct} onChange={(e) => setCt(e.target.value)} className="font-mono text-[13px]" />}</Field>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{tr("Metadata")}</p>
            <KeyValueEditor rows={rows} onChange={setRows} keyPlaceholder={tr("key")} valuePlaceholder={tr("value")} empty={tr("No metadata.")} />
            {kvErr && <p className="text-xs text-led-red">{kvErr}</p>}
          </div>
          <Switch checked={expiry} onChange={setExpiry} label={tr("Delete automatically")} hint={tr("Swift removes the object at this time (object expiration).")} />
          {expiry && (
            <Field label={tr("Delete at")} hint={atBad ? tr("Must be in the future.") : undefined}>
              {(id) => <Input id={id} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-64" />}
            </Field>
          )}
        </>
      )}
    </ActionDialog>
  );
}

const DURATIONS = [
  { value: "3600", label: tr("1 hour") },
  { value: "86400", label: tr("1 day") },
  { value: "604800", label: tr("7 days") },
  { value: "2592000", label: tr("30 days") },
];

function ShareDialog({ container, name, onClose }: { container: string; name: string; onClose: () => void }) {
  const [seconds, setSeconds] = useState("86400");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<{ url: string; expires: number } | null>(null);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Share {name}", { name: base(name) })}
      description={tr("A temporary URL works without signing in, for anyone who has it, until it expires.")}
      submitLabel={tr("Done")}
      run={async () => undefined}
    >
      <Field label={tr("Valid for")}>{(id) => <Picker id={id} value={seconds} onChange={(v) => (setSeconds(v), setLink(null))} options={DURATIONS} />}</Field>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setLink(await swift.tempUrl(container, name, Number(seconds)));
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="link" />
        {link ? tr("Create a new link") : tr("Create link")}
      </Button>
      <ErrorNotice error={error} />
      {link && (
        <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
            <Mono className="min-w-0 flex-1 truncate">{link.url}</Mono>
            <CopyButton text={link.url} label="" className="h-7 px-2" />
          </div>
          <p className="text-xs text-muted">{tr("Expires {date}.", { date: new Date(link.expires * 1000).toLocaleString(lang === "vi" ? "vi-VN" : undefined) })}</p>
        </div>
      )}
      <p className="text-xs text-muted">{tr("Links are signed with the container's (or account's) temp URL key; Rassvet creates a container key the first time. Changing that key revokes every link.")}</p>
    </ActionDialog>
  );
}

function CopyDialog({ container, name, onClose }: { container: string; name: string; onClose: () => void }) {
  const refresh = useRefreshSwift();
  const containers = useSwiftContainers();
  const [to, setTo] = useState(container);
  const [target, setTarget] = useState(name);
  const [move, setMove] = useState(false);
  const same = to === container && target.trim() === name;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Copy or move {name}", { name: base(name) })}
      description={tr("Swift copies on the server side; nothing passes through your browser.")}
      submitLabel={move ? tr("Move") : tr("Copy")}
      canSubmit={!!target.trim() && !same}
      done={move ? tr("Object moved") : tr("Object copied")}
      onDone={refresh}
      run={() => swift.copy({ container, object: name }, { container: to, object: target.trim() }, move)}
    >
      <Field label={tr("Destination container")}>
        {(id) => <Picker id={id} value={to} onChange={setTo} searchable loading={containers.isPending} options={(containers.data ?? []).map((c) => ({ value: c.name, label: c.name, icon: "archive", meta: fmtBytes(c.bytes) }))} />}
      </Field>
      <Field label={tr("Destination name")} hint={same ? tr("Pick another container or name.") : tr("Include folders with “/”. Renaming = moving within the same container.")}>
        {(id) => <Input id={id} value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono text-[13px]" />}
      </Field>
      <Switch checked={move} onChange={setMove} label={tr("Delete the original (move)")} />
    </ActionDialog>
  );
}
