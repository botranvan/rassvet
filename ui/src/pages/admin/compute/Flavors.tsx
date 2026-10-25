import { Link, useNavigate } from "@/components/Link";
import { FeatureBadges } from "@/components/FeatureBadges";
import { useMutation } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { type KvRow, KeyValueEditor, fromRows, kvError } from "@/components/KeyValueEditor";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, Switch, Tabs } from "@/components/ui";
import { type Flavor, gib, os, useFlavors, useInvalidate } from "@/lib/os";
import { FLAVOR_SPEC_KEYS } from "./FlavorDetail";
import { SpecPresets } from "./SpecPresets";
import { tr } from "@/lib/i18n";

export default function Flavors() {
  // is_public=None lists public and private flavors for admins.
  const flavors = useFlavors({ is_public: "None" });
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Flavor | null>(null);
  const specs = (f: Flavor) => Object.entries(f.extra_specs ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");

  const columns: Column<Flavor>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (f) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <Link to={f.id} className="truncate font-medium text-cable hover:underline">
            {f.name}
          </Link>
          {f["os-flavor-access:is_public"] === false && <Badge tone="warn">{tr("private")}</Badge>}
          <FeatureBadges specs={f.extra_specs} />
        </span>
      ),
      value: (f) => f.name,
    },
    { key: "vcpus", header: tr("vCPUs"), width: "5rem", className: "text-right", cell: (f) => f.vcpus, value: (f) => f.vcpus },
    { key: "ram", header: "RAM", width: "6.5rem", className: "text-right", cell: (f) => gib(f.ram), value: (f) => f.ram, csv: (f) => f.ram },
    { key: "disk", header: tr("Root disk"), width: "6.5rem", className: "text-right", hideBelow: "sm", cell: (f) => (f.disk ? `${f.disk} GB` : tr("0 (volume)")), value: (f) => f.disk },
    { key: "eph", header: tr("Ephemeral"), width: "6.5rem", className: "text-right", hideBelow: "lg", cell: (f) => `${f["OS-FLV-EXT-DATA:ephemeral"] ?? 0} GB`, value: (f) => f["OS-FLV-EXT-DATA:ephemeral"] ?? 0 },
    { key: "specs", header: tr("Extra specs"), hideBelow: "md", mono: true, cell: specs, value: specs },
    { key: "id", header: "ID", width: "8rem", hideBelow: "xl", mono: true, cell: (f) => f.id, value: (f) => f.id },
  ];

  return (
    <>
      <PageHeader
        title={tr("Flavors")}
        description={tr("Instance sizes. Sizes can't change once created (create a new flavor and retire the old one), but the description, extra specs (metadata) and project access of private flavors can.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create flavor")}
          </Button>
        }
      />
      <ErrorNotice error={flavors.error} className="mb-4" />
      <DataTable
        rows={flavors.data}
        columns={columns}
        rowKey={(f) => f.id}
        loading={flavors.isPending}
        tableId="admin-flavors"
        noun={tr("flavors")}
        rowLabel={(f) => f.name}
        onRefresh={() => flavors.refetch()}
        refreshing={flavors.isFetching}
        onBulkDone={() => invalidate("compute")}
        rowActions={(x) => [
          { label: tr("Manage"), icon: "settings", onSelect: () => navigate(x.id) },
          { label: tr("Extra specs"), icon: "tags", onSelect: () => navigate(`${x.id}?tab=specs`) },
          x["os-flavor-access:is_public"] === false && { label: tr("Project access"), icon: "users", onSelect: () => navigate(`${x.id}?tab=access`) },
          "-",
          { label: tr("Delete flavor"), icon: "trash", danger: true, onSelect: () => setDeleting(x) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete flavors?"),
            past: tr("deleted"),
            body: tr("Running instances keep working; their flavor details stay embedded. New instances can't use these flavors."),
            run: (f) => os.del("compute", `flavors/${f.id}`),
          },
        ]}
      />
      <CreateFlavorDialog open={creating} onClose={() => setCreating(false)} />
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete flavor {name}?", { name: deleting.name })}
          submitLabel={tr("Delete flavor")}
          done={tr("Flavor {name} deleted", { name: deleting.name })}
          refresh={["compute"]}
          run={() => os.del("compute", `flavors/${deleting.id}`)}
        >
          <p className="text-sm">{tr("Running instances keep working; new instances can't use it.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function CreateFlavorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const blank = { name: "", vcpus: 2, ram: 4096, disk: 0, ephemeral: 0, swap: 0, isPublic: true, description: "" };
  const [v, setV] = useState(blank);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  // Metadata = Nova extra specs (hw:cpu_policy, aggregate_instance_extra_specs:*, quota:*…).
  const [specs, setSpecs] = useState<KvRow[]>([]);
  const specError = kvError(specs);
  const specCount = Object.keys(fromRows(specs)).length;
  const [tab, setTab] = useState<"details" | "metadata">("details");
  // Set once the flavor exists, so a retry after a failed extra-specs call doesn't create it twice.
  const [created, setCreated] = useState<Flavor | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: async () => {
      const flavor =
        created ??
        (
          await os.post<{ flavor: Flavor }>("compute", "flavors", {
            flavor: {
          name: v.name.trim(),
          vcpus: v.vcpus,
          ram: v.ram,
          disk: v.disk,
          "OS-FLV-EXT-DATA:ephemeral": v.ephemeral,
          swap: v.swap,
          "os-flavor-access:is_public": v.isPublic,
              description: v.description || undefined,
            },
          })
        ).flavor;
      setCreated(flavor);
      const extra = fromRows(specs);
      if (Object.keys(extra).length) {
        try {
          await os.post("compute", `flavors/${flavor.id}/os-extra_specs`, { extra_specs: extra });
        } catch (e) {
          invalidate("compute");
          setTab("metadata");
          throw new Error(tr("Flavor {name} was created, but its metadata wasn't saved: {message}. Fix it and press \"Save metadata\" again.", { name: flavor.name, message: (e as Error).message }));
        }
      }
      return flavor;
    },
    onSuccess: (f) => {
      const n = Object.keys(fromRows(specs)).length;
      toast(tr("Flavor {name} created{v}", { name: f.name, v: n ? tr(" with {n} extra spec{s}", { n, s: n === 1 ? "" : "s" }) : "" }));
      invalidate("compute");
      close();
      // Private flavors are useless until projects get access: go straight to that tab.
      if (!v.isPublic) navigate(`/admin/compute/flavors/${f.id}?tab=access`);
    },
  });
  const close = () => {
    m.reset();
    setV(blank);
    setSpecs([]);
    setCreated(null);
    setTab("details");
    onClose();
  };
  const num = (k: keyof typeof v) => (e: ChangeEvent<HTMLInputElement>) => set({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<typeof v>);
  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Create flavor")}
      size="lg"
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={close}>
            {created ? tr("Close") : tr("Cancel")}
          </Button>
          {tab === "details" && !created && (
            <Button type="button" onClick={() => setTab("metadata")}>
              {tr("Next: metadata")}
              <Icon name="chevron-right" />
            </Button>
          )}
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!v.name.trim() || v.vcpus < 1 || v.ram < 1 || !!specError}>
            {created ? tr("Save metadata") : tr("Create flavor")}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "details", label: tr("Details") },
          { id: "metadata", label: tr("Metadata{v}{v2}", { v: specCount ? ` (${specCount})` : "", v2: specError ? tr(" — check") : "" }) },
        ]}
      />
      {/* Both tabs stay mounted (hidden), so switching keeps what was typed. */}
      <div hidden={tab !== "details"} className="space-y-4">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="m2.medium" />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={tr("vCPUs")}>{(id) => <Input id={id} type="number" min={1} value={v.vcpus} onChange={num("vcpus")} />}</Field>
          <Field label={tr("RAM (MiB)")}>{(id) => <Input id={id} type="number" min={1} value={v.ram} onChange={num("ram")} />}</Field>
          <Field label={tr("Root disk (GB)")} hint={tr("0 for boot-from-volume flavors.")}>
            {(id) => <Input id={id} type="number" min={0} value={v.disk} onChange={num("disk")} />}
          </Field>
          <Field label={tr("Ephemeral (GB)")}>{(id) => <Input id={id} type="number" min={0} value={v.ephemeral} onChange={num("ephemeral")} />}</Field>
          <Field label={tr("Swap (MiB)")}>{(id) => <Input id={id} type="number" min={0} value={v.swap} onChange={num("swap")} />}</Field>
        </div>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={v.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <Switch
          checked={v.isPublic}
          onChange={(isPublic) => set({ isPublic })}
          disabled={!!created}
          label={tr("Public")}
          hint={tr("Private flavors are only visible to projects given access (you'll be taken to the access tab after creating it).")}
        />
      </div>
      <div hidden={tab !== "metadata"}>
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {tr("CPU pinning, huge pages, NUMA, aggregate matching (aggregate_instance_extra_specs:…), disk and network limits (quota:…). Pick a suggested key or type your own; they can be changed later on the flavor's page.")}
          </p>
          <SpecPresets rows={specs} onChange={setSpecs} />
          <KeyValueEditor rows={specs} onChange={setSpecs} suggestions={FLAVOR_SPEC_KEYS} addLabel={tr("Add spec")} empty={tr("No extra specs.")} />
          {specError && <p className="text-sm text-led-red">{specError}</p>}
        </div>
      </div>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
