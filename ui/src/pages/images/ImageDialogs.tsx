import { useRef, useState } from "react";
import { Picker } from "@/components/Picker";
import { useNavigate } from "@/components/Link";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { useUploads } from "@/components/UploadTray";
import { MetadataEditor, useMetadataErrors } from "@/components/MetadataEditor";
import { Button, Checkbox, ErrorNotice, Field, Icon, Input, Switch, Tabs } from "@/components/ui";
import { fmtBytes } from "@/lib/format";
import {
  CONTAINER_FORMATS,
  DISK_FORMATS,
  type Image,
  type Visibility,
  customProperties,
  guessDiskFormat,
  useCreateImage,
  useImageInfo,
  useImportUrl,
  useUpdateImage,
} from "@/lib/image";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";

const VISIBILITY: { id: Visibility; label: string; hint: string; admin?: boolean }[] = [
  { id: "private", label: tr("Private"), hint: tr("Only this project.") },
  { id: "shared", label: tr("Shared"), hint: tr("This project plus projects you add as members.") },
  { id: "community", label: tr("Community"), hint: tr("Any project can use it; it isn't listed by default.") },
  { id: "public", label: tr("Public"), hint: tr("Listed for every project in the cloud."), admin: true },
];

function VisibilityPicker({ value, onChange }: { value: Visibility; onChange: (v: Visibility) => void }) {
  const admin = useSession().data?.is_admin;
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{tr("Visibility")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {VISIBILITY.filter((v) => !v.admin || admin).map((v) => (
          <label
            key={v.id}
            className={cn(
              "flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 text-sm",
              value === v.id ? "border-cable bg-cable-soft/60" : "border-line hover:bg-surface",
            )}
          >
            <input
              type="radio"
              name="visibility"
              checked={value === v.id}
              onChange={() => onChange(v.id)}
              className="mt-0.5 accent-cable"
            />
            <span className="min-w-0">
              <span className="block font-medium">{v.label}</span>
              <span className="block text-xs text-muted">{v.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StorePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const info = useImageInfo();
  const stores = info.data?.stores ?? [];
  if (stores.length < 2) return null;
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{tr("Stores")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {stores.map((s) => (
          <Checkbox
            key={s.id}
            checked={value.length ? value.includes(s.id) : !!s.default}
            onChange={(on) => {
              const base = value.length ? value : stores.filter((x) => x.default).map((x) => x.id);
              onChange(on ? [...base, s.id] : base.filter((x) => x !== s.id));
            }}
          >
            <span className="truncate" title={s.description}>
              {s.id}
              {s.default && <span className="ml-1 text-muted">{tr("(default)")}</span>}
            </span>
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
}

/** File drop zone / picker. */
function FileField({ file, onFile }: { file: File | null; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex items-center gap-3 rounded-lg border border-dashed px-4 py-4 text-sm",
        over ? "border-cable bg-cable-soft/60" : "border-line",
      )}
    >
      <Icon name="disc-3" className="size-6 text-muted" />
      <div className="min-w-0 flex-1">
        {file ? (
          <>
            <p className="truncate font-medium" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-muted">{fmtBytes(file.size)}</p>
          </>
        ) : (
          <p className="text-muted">{tr("Drop an image file here, or choose one.")}</p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <Button type="button" className="h-8" onClick={() => input.current?.click()}>
        {file ? tr("Change file") : tr("Choose file")}
      </Button>
    </div>
  );
}

type Source = "file" | "url";

function SourceFields({
  source,
  setSource,
  file,
  setFile,
  url,
  setUrl,
  onFileChosen,
}: {
  source: Source;
  setSource: (s: Source) => void;
  file: File | null;
  setFile: (f: File) => void;
  url: string;
  setUrl: (u: string) => void;
  onFileChosen?: (f: File) => void;
}) {
  const info = useImageInfo();
  const webDownload = info.data?.import_methods.includes("web-download");
  return (
    <div className="space-y-3">
      {webDownload && (
        <Tabs
          value={source}
          onChange={setSource}
          tabs={[
            { id: "file", label: tr("Upload a file") },
            { id: "url", label: tr("Import from URL") },
          ]}
        />
      )}
      {source === "file" ? (
        <FileField
          file={file}
          onFile={(f) => {
            setFile(f);
            onFileChosen?.(f);
          }}
        />
      ) : (
        <Field label={tr("Image URL")} hint={tr("Glance downloads the file itself, so the URL must be reachable from the cloud.")}>
          {(id) => (
            <Input
              id={id}
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
              className="font-mono text-[13px]"
            />
          )}
        </Field>
      )}
    </div>
  );
}

/** Create an image record and start its upload (background tray) or URL import. */
export function CreateImageDialog({
  open,
  onClose,
  detailBase,
}: {
  open: boolean;
  onClose: () => void;
  /** Route prefix for the detail page, e.g. "/compute/images". */
  detailBase: string;
}) {
  const create = useCreateImage();
  const importUrl = useImportUrl();
  const uploads = useUploads();
  const toast = useToast();
  const navigate = useNavigate();

  const [source, setSource] = useState<Source>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [diskFormat, setDiskFormat] = useState("qcow2");
  const [containerFormat, setContainerFormat] = useState("bare");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [minDisk, setMinDisk] = useState("");
  const [minRam, setMinRam] = useState("");
  const [isProtected, setProtected] = useState(false);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"details" | "metadata">("details");
  const metaErrors = useMetadataErrors(meta);
  const [stores, setStores] = useState<string[]>([]);

  function reset() {
    create.reset();
    importUrl.reset();
    setSource("file");
    setFile(null);
    setUrl("");
    setName("");
    setDiskFormat("qcow2");
    setVisibility("private");
    setMinDisk("");
    setMinRam("");
    setProtected(false);
    setMeta({});
    setTab("details");
    setStores([]);
  }
  const close = () => {
    reset();
    onClose();
  };

  const ready =
    name.trim() && (source === "file" ? !!file : /^https?:\/\//.test(url)) && Object.keys(metaErrors).length === 0;
  const busy = create.isPending || importUrl.isPending;

  function submit() {
    if (!ready) return;
    const properties = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.trim()]));
    create.mutate(
      {
        name: name.trim(),
        disk_format: diskFormat,
        container_format: containerFormat,
        visibility,
        min_disk: Number(minDisk) || 0,
        min_ram: Number(minRam) || 0,
        protected: isProtected,
        tags: [],
        properties,
      },
      {
        onSuccess: (img) => {
          const href = `${detailBase}/${img.id}`;
          if (source === "file" && file) {
            uploads.start({ imageId: img.id, name: img.name ?? img.id, href, file, stores });
            toast(tr("Uploading {name}. You can keep working while it runs.", { name: img.name }));
            close();
            navigate(href);
          } else {
            importUrl.mutate(
              { id: img.id, uri: url, stores },
              {
                onSuccess: () => {
                  toast(tr("Glance is importing {name} from the URL", { name: img.name }));
                  close();
                  navigate(href);
                },
              },
            );
          }
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      size="xl"
      title={tr("Create image")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            {source === "file" ? tr("Create and upload") : tr("Create and import")}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "details", label: tr("Image details") },
          { id: "metadata", label: tr("Metadata{v}", { v: Object.keys(meta).length ? ` (${Object.keys(meta).length})` : "" }) },
        ]}
      />
      {tab === "metadata" ? (
        <MetadataEditor value={meta} onChange={setMeta} />
      ) : (
        <>
      <SourceFields
        source={source}
        setSource={setSource}
        file={file}
        setFile={setFile}
        url={url}
        setUrl={setUrl}
        onFileChosen={(f) => {
          if (!name) setName(f.name.replace(/\.(img|qcow2|raw|iso|vmdk|vhdx?|vdi|ploop)(\.\w+)?$/i, ""));
          const g = guessDiskFormat(f.name);
          if (g) setDiskFormat(g);
        }}
      />
      <Field label={tr("Name")}>
        {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} placeholder="ubuntu-24.04" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={tr("Disk format")}
          hint={file?.name.toLowerCase().endsWith(".img") ? tr("Most .img cloud images are qcow2; check with qemu-img info if unsure.") : undefined}
        >
          {(id) => (
            <Picker id={id} value={diskFormat} onChange={setDiskFormat} options={DISK_FORMATS.map((f) => ({ value: f, label: f }))} />
          )}
        </Field>
        <Field label={tr("Container format")}>
          {(id) => (
            <Picker id={id} value={containerFormat} onChange={setContainerFormat} options={CONTAINER_FORMATS.map((f) => ({ value: f, label: f }))} />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Minimum disk (GB)")} hint={tr("Servers need a root disk at least this large.")}>
          {(id) => <Input id={id} type="number" min={0} value={minDisk} onChange={(e) => setMinDisk(e.target.value)} placeholder="0" />}
        </Field>
        <Field label={tr("Minimum RAM (MB)")}>
          {(id) => <Input id={id} type="number" min={0} value={minRam} onChange={(e) => setMinRam(e.target.value)} placeholder="0" />}
        </Field>
      </div>
      <VisibilityPicker value={visibility} onChange={setVisibility} />
      <StorePicker value={stores} onChange={setStores} />
      <Switch checked={isProtected} onChange={setProtected} label={tr("Protected")} hint={tr("Protected images can't be deleted until this is turned off.")} />
        </>
      )}
      {Object.keys(metaErrors).length > 0 && (
        <p className="text-sm text-led-red">
          {trx("Fix the highlighted metadata values before creating the image ({keys}).", { keys: Object.keys(metaErrors).join(", ") })}
        </p>
      )}
      <ErrorNotice error={create.error ?? importUrl.error} />
    </Dialog>
  );
}

/** Add data to an image that is still queued (e.g. after a failed or cancelled upload). */
export function UploadDataDialog({ image, open, onClose, href }: { image: Image; open: boolean; onClose: () => void; href: string }) {
  const importUrl = useImportUrl();
  const uploads = useUploads();
  const toast = useToast();
  const [source, setSource] = useState<Source>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [stores, setStores] = useState<string[]>([]);
  const close = () => {
    importUrl.reset();
    setFile(null);
    setUrl("");
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Add data to {v}", { v: image.name ?? image.id })}
      description={tr("The image exists but has no data yet.")}
      onSubmit={() => {
        if (source === "file" && file) {
          uploads.start({ imageId: image.id, name: image.name ?? image.id, href, file, stores });
          close();
        } else if (url) {
          importUrl.mutate({ id: image.id, uri: url, stores }, { onSuccess: () => (toast(tr("Import started")), close()) });
        }
      }}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={importUrl.isPending} disabled={source === "file" ? !file : !url}>
            {source === "file" ? tr("Upload") : tr("Import")}
          </Button>
        </>
      }
    >
      <SourceFields source={source} setSource={setSource} file={file} setFile={setFile} url={url} setUrl={setUrl} />
      <StorePicker value={stores} onChange={setStores} />
      <ErrorNotice error={importUrl.error} />
    </Dialog>
  );
}

/** Edit an image's details and metadata (custom properties). */
export function EditImageDialog({
  image,
  onClose,
  initialTab = "details",
}: {
  image: Image;
  onClose: () => void;
  initialTab?: "details" | "metadata";
}) {
  const update = useUpdateImage();
  const toast = useToast();
  const original = Object.fromEntries(customProperties(image));
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(image.name ?? "");
  const [visibility, setVisibility] = useState<Visibility>(image.visibility);
  const [minDisk, setMinDisk] = useState(String(image.min_disk ?? 0));
  const [minRam, setMinRam] = useState(String(image.min_ram ?? 0));
  const [isProtected, setProtected] = useState(image.protected);
  const [hidden, setHidden] = useState(!!image.os_hidden);
  const [tags, setTags] = useState(image.tags.join(", "));
  const [meta, setMeta] = useState<Record<string, string>>(original);
  const metaErrors = useMetadataErrors(meta);
  const invalid = Object.keys(metaErrors);

  function submit() {
    if (invalid.length) {
      setTab("metadata");
      return;
    }
    const set = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.trim()]));
    const unset = Object.keys(original).filter((k) => !(k in meta));
    update.mutate(
      {
        id: image.id,
        core: {
          name: name.trim(),
          visibility,
          min_disk: Number(minDisk) || 0,
          min_ram: Number(minRam) || 0,
          protected: isProtected,
          os_hidden: hidden,
          tags: [...new Set(tags.split(",").map((t) => t.trim()).filter(Boolean))],
        },
        set,
        unset,
      },
      {
        onSuccess: (img) => {
          toast(tr("Image {name} updated", { name: img.name }));
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={tr("Edit {v}", { v: image.name ?? tr("image") })}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={update.isPending} disabled={!name.trim() || invalid.length > 0}>
            {tr("Update image")}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "details", label: tr("Image details") },
          { id: "metadata", label: tr("Metadata ({length})", { length: Object.keys(meta).length }) },
        ]}
      />
      {tab === "metadata" ? (
        <MetadataEditor value={meta} onChange={setMeta} />
      ) : (
        <>
          <Field label={tr("Name")}>
            {(id) => <Input id={id} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Minimum disk (GB)")}>
              {(id) => <Input id={id} type="number" min={0} value={minDisk} onChange={(e) => setMinDisk(e.target.value)} />}
            </Field>
            <Field label={tr("Minimum RAM (MB)")}>
              {(id) => <Input id={id} type="number" min={0} value={minRam} onChange={(e) => setMinRam(e.target.value)} />}
            </Field>
          </div>
          <Field label={tr("Tags")} hint={tr("Separate with commas.")}>
            {(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} placeholder={tr("golden, lts")} />}
          </Field>
          <VisibilityPicker value={visibility} onChange={setVisibility} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch checked={isProtected} onChange={setProtected} label={tr("Protected")} hint={tr("Prevents deletion.")} />
            <Switch checked={hidden} onChange={setHidden} label={tr("Hidden")} hint={tr("Left out of image lists; still usable by ID.")} />
          </div>
        </>
      )}
      {invalid.length > 0 && (
        <p className="text-sm text-led-red">{trx("Fix the highlighted metadata values first ({invalid}).", { invalid: invalid.join(", ") })}</p>
      )}
      <ErrorNotice error={update.error} />
    </Dialog>
  );
}
