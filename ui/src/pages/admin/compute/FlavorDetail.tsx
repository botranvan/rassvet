/** Admin: one flavor — description, extra specs (metadata) and project access for private flavors. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, fromRows, kvError, sameKv, saveKv, toRows } from "@/components/KeyValueEditor";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Mono, PageHeader, Tabs, Textarea } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { type Flavor, gib, os, useInvalidate, useOsGet } from "@/lib/os";
import { useTab } from "@/lib/useTab";
import { SpecPresets } from "./SpecPresets";
import { tr } from "@/lib/i18n";

/** Common Nova flavor extra specs (libvirt driver, scheduler, quotas). */
export const FLAVOR_SPEC_KEYS = [
  { key: "hw:cpu_policy", hint: tr("Pin vCPUs to host cores"), values: ["dedicated", "shared", "mixed"] },
  { key: "hw:cpu_thread_policy", hint: tr("SMT siblings with pinned CPUs"), values: ["prefer", "isolate", "require"] },
  { key: "hw:mem_page_size", hint: tr("Huge pages for guest RAM"), values: ["large", "small", "any", "2MB", "1GB"] },
  { key: "hw:numa_nodes", hint: tr("Guest NUMA nodes") },
  { key: "hw:emulator_threads_policy", hint: tr("Where QEMU emulator threads run"), values: ["share", "isolate"] },
  { key: "hw:cpu_sockets", hint: tr("Guest CPU topology: sockets") },
  { key: "hw:cpu_cores", hint: tr("Guest CPU topology: cores per socket") },
  { key: "hw:cpu_threads", hint: tr("Guest CPU topology: threads per core") },
  { key: "hw:vif_multiqueue_enabled", hint: tr("Multi-queue virtio-net"), values: ["true", "false"] },
  { key: "hw:watchdog_action", hint: tr("Action when the guest watchdog fires"), values: ["reset", "poweroff", "pause", "none"] },
  { key: "hw:boot_menu", hint: tr("Show the BIOS boot menu"), values: ["true", "false"] },
  { key: "os:secure_boot", hint: tr("UEFI Secure Boot"), values: ["required", "disabled", "optional"] },
  { key: "hw_rng:allowed", hint: tr("Allow a virtio RNG device"), values: ["true", "false"] },
  { key: "quota:disk_total_iops_sec", hint: tr("Disk IOPS limit (local disks)") },
  { key: "quota:disk_total_bytes_sec", hint: tr("Disk throughput limit, bytes/s") },
  { key: "quota:vif_outbound_average", hint: tr("Network egress average, KB/s") },
  { key: "quota:vif_inbound_average", hint: tr("Network ingress average, KB/s") },
  { key: "resources:VGPU", hint: tr("Number of vGPUs from Placement") },
  { key: "accel:device_profile", hint: tr("Cyborg device profile (vGPU / mdev, FPGA…)") },
  { key: "hw:mem_encryption", hint: tr("Encrypted guest memory (AMD SEV / Intel TDX)"), values: ["True", "False"] },
  { key: "hw:mem_encryption_model", hint: tr("Memory encryption technology"), values: ["amd-sev", "amd-sev-es", "amd-sev-snp", "intel-tdx"] },
  { key: "hw:tpm_version", hint: tr("Emulated TPM (vTPM)"), values: ["2.0", "1.2"] },
  { key: "hw:tpm_model", hint: tr("vTPM device model"), values: ["tpm-crb", "tpm-tis"] },
  { key: "hw:tpm_secret_security", hint: tr("Who holds the vTPM secret (host = live-migratable)"), values: ["user", "host"] },
  { key: "resources:PCPU", hint: tr("Dedicated host CPUs (instead of hw:cpu_policy)") },
  { key: "trait:HW_CPU_X86_AVX512F", hint: tr("Require a host trait"), values: ["required", "forbidden"] },
  { key: "aggregate_instance_extra_specs:ssd", hint: tr("Only hosts in aggregates with ssd=…"), values: ["true"] },
  { key: "pci_passthrough:alias", hint: tr("PCI devices, e.g. gpu:1") },
  { key: "hw:pmem", hint: tr("Persistent memory namespaces") },
];

const TABS = ["overview", "specs", "access"] as const;

export default function FlavorDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const flavor = useOsGet<Flavor>("compute", `flavors/${id}`, (r: { flavor: Flavor }) => r.flavor);
  const [tab, setTab] = useTab(TABS, "overview");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const f = flavor.data;
  const isPublic = f?.["os-flavor-access:is_public"] !== false;
  return (
    <>
      <Link to="/admin/compute/flavors" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Flavors")}
      </Link>
      <PageHeader
        title={f?.name ?? tr("Flavor")}
        description={f ? f.description || tr("{vcpus} vCPU · {ram} RAM · {v}{v2}", { vcpus: f.vcpus, ram: gib(f.ram), v: f.disk ? tr("{disk} GB disk", { disk: f.disk }) : tr("boot from volume"), v2: isPublic ? "" : tr(" · private") }) : undefined}
        actions={
          f && (
            <>
              <Button onClick={() => setEditing(true)}>
                <Icon name="edit" />
                {tr("Edit description")}
              </Button>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                <Icon name="trash" />
                {tr("Delete")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={flavor.error} className="mb-4" />
      {f && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "specs", label: tr("Extra specs ({length})", { length: Object.keys(f.extra_specs ?? {}).length }) },
              { id: "access", label: tr("Project access") },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{f.name}</Detail>
                  <Detail label="ID">
                    <Mono>{f.id}</Mono>
                  </Detail>
                  <Detail label={tr("Visibility")}>{isPublic ? tr("Public") : <Badge tone="warn">{tr("private")}</Badge>}</Detail>
                  {f.description && (
                    <Detail label={tr("Description")} wrap>
                      {f.description}
                    </Detail>
                  )}
                </dl>
              </Card>
              <Card title={tr("Size")}>
                <dl>
                  <Detail label={tr("vCPUs")}>{f.vcpus}</Detail>
                  <Detail label="RAM">{gib(f.ram)}</Detail>
                  <Detail label={tr("Root disk")}>{f.disk ? `${f.disk} GB` : tr("0 (boot from volume)")}</Detail>
                  <Detail label={tr("Ephemeral")}>{f["OS-FLV-EXT-DATA:ephemeral"] ?? 0} GB</Detail>
                  <Detail label={tr("Swap")}>{f.swap ? tr("{swap} MiB", { swap: f.swap }) : tr("None")}</Detail>
                  {f.rxtx_factor != null && <Detail label={tr("RX/TX factor")}>{f.rxtx_factor}</Detail>}
                </dl>
              </Card>
            </div>
          )}
          {tab === "specs" && <ExtraSpecs f={f} />}
          {tab === "access" && <Access f={f} isPublic={isPublic} />}
        </>
      )}
      {f && editing && <DescriptionDialog f={f} onClose={() => setEditing(false)} />}
      {f && deleting && (
        <ActionDialog
          onClose={() => setDeleting(false)}
          danger
          title={tr("Delete flavor {name}?", { name: f.name })}
          submitLabel={tr("Delete flavor")}
          done={tr("Flavor {name} deleted", { name: f.name })}
          refresh={["compute"]}
          onDone={() => navigate("/admin/compute/flavors")}
          run={() => os.del("compute", `flavors/${f.id}`)}
        >
          <p className="text-sm">{tr("Running instances keep working; new instances can't use it.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function DescriptionDialog({ f, onClose }: { f: Flavor; onClose: () => void }) {
  const [description, setDescription] = useState(f.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Describe {name}", { name: f.name })}
      description={tr("Only the description can change; sizes are fixed once a flavor exists (Nova 2.55+).")}
      submitLabel={tr("Save")}
      done={tr("Flavor updated")}
      refresh={["compute"]}
      run={() => os.put("compute", `flavors/${f.id}`, { flavor: { description: description || null } })}
    >
      <Field label={tr("Description")}>{(id) => <Textarea id={id} autoFocus rows={3} maxLength={65535} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function ExtraSpecs({ f }: { f: Flavor }) {
  const before = f.extra_specs ?? {};
  const [rows, setRows] = useState(() => toRows(before));
  const toast = useToast();
  const invalidate = useInvalidate();
  const err = kvError(rows);
  const dirty = !sameKv(fromRows(rows), before);
  const save = useMutation({
    mutationFn: () =>
      saveKv(
        before,
        fromRows(rows),
        (changed) => os.post("compute", `flavors/${f.id}/os-extra_specs`, { extra_specs: changed }),
        (keys) => Promise.all(keys.map((k) => os.del("compute", `flavors/${f.id}/os-extra_specs/${k}`))),
      ),
    onSuccess: () => {
      toast(tr("Extra specs saved"));
      invalidate("compute");
    },
  });
  return (
    <Card
      title={tr("Extra specs")}
      actions={
        <>
          <Button onClick={() => setRows(toRows(before))} disabled={!dirty}>
            {tr("Reset")}
          </Button>
          <Button variant="primary" busy={save.isPending} disabled={!dirty || !!err} onClick={() => save.mutate()}>
            {tr("Save")}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-muted">
        {tr("Flavor metadata read by the scheduler and the hypervisor driver: CPU pinning, huge pages, NUMA, I/O limits, required traits and resources. New instances pick up changes; running ones keep what they started with until resized.")}
      </p>
      <div className="mb-4">
        <SpecPresets rows={rows} onChange={setRows} />
      </div>
      <KeyValueEditor rows={rows} onChange={setRows} suggestions={FLAVOR_SPEC_KEYS} addLabel={tr("Add spec")} empty={tr("No extra specs.")} />
      {err && <p className="mt-2 text-sm text-led-red">{err}</p>}
      <ErrorNotice error={save.error} className="mt-3" />
    </Card>
  );
}

function Access({ f, isPublic }: { f: Flavor; isPublic: boolean }) {
  const projects = useProjects();
  const access = useQuery({
    queryKey: ["os", "compute", "flavors", f.id, "access"],
    queryFn: () => os.get<{ flavor_access: { tenant_id: string }[] }>("compute", `flavors/${f.id}/os-flavor-access`).then((r) => r.flavor_access),
    enabled: !isPublic,
  });
  const [project, setProject] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();
  const add = useMutation({
    mutationFn: () => os.action("compute", `flavors/${f.id}`, { addTenantAccess: { tenant: project } }),
    onSuccess: () => {
      toast(tr("Access granted"));
      setProject("");
      invalidate("compute");
    },
  });
  if (isPublic)
    return (
      <Card title={tr("Project access")}>
        <p className="text-sm text-muted">{tr("This flavor is public: every project can use it. Visibility is fixed at creation, so create a private copy to limit it to chosen projects.")}</p>
      </Card>
    );
  const has = new Set(access.data?.map((a) => a.tenant_id));
  const name = (p: string) => projects.data?.find((x) => x.id === p)?.name ?? p;
  const cols: Column<{ id: string }>[] = [
    { key: "name", header: tr("Project"), cell: (r) => <span className="font-medium">{name(r.id)}</span>, value: (r) => name(r.id) },
    { key: "id", header: "ID", mono: true, hideBelow: "md", cell: (r) => r.id, value: (r) => r.id },
  ];
  return (
    <div className="space-y-4">
      <Card title={tr("Share with a project")}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <Picker
              aria-label={tr("Project")}
              value={project}
              onChange={setProject}
              searchable
              loading={projects.isPending}
              placeholder={tr("Choose a project")}
              options={(projects.data ?? []).filter((p) => !p.is_domain).map((p) => ({ value: p.id, label: p.name, icon: "folder", disabled: has.has(p.id) ? tr("Already has access") : false }))}
            />
          </div>
          <Button variant="primary" disabled={!project} busy={add.isPending} onClick={() => add.mutate()}>
            <Icon name="plus" />
            {tr("Grant")}
          </Button>
        </div>
        <ErrorNotice error={add.error} className="mt-3" />
      </Card>
      <DataTable
        rows={access.data?.map((a) => ({ id: a.tenant_id }))}
        columns={cols}
        rowKey={(r) => r.id}
        loading={access.isPending}
        noun={tr("projects")}
        empty={tr("No project can use this private flavor yet.")}
        onRefresh={() => access.refetch()}
        refreshing={access.isFetching}
        rowActions={(r) => [{ label: tr("Revoke access"), icon: "x", danger: true, onSelect: () => setRemoving(r.id) }]}
      />
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Revoke access for {name}?", { name: name(removing) })}
          submitLabel={tr("Revoke")}
          done={tr("Access revoked")}
          refresh={["compute"]}
          run={() => os.action("compute", `flavors/${f.id}`, { removeTenantAccess: { tenant: removing } })}
        >
          <p className="text-sm">{tr("Its running instances keep working; it can't launch new ones with this flavor.")}</p>
        </ActionDialog>
      )}
    </div>
  );
}
