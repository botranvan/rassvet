/**
 * Admin: Barbican per-project quotas (`/v1/project-quotas`). A project without its own
 * quotas uses the cloud defaults (barbican.conf [quotas]); -1 means unlimited.
 */
import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, ErrorNotice, Field, Input, PageHeader } from "@/components/ui";
import { type BarbicanQuotas, useBarbicanQuotas } from "@/lib/barbican";
import { useProjects } from "@/lib/identity";
import { os, useInvalidate, useOsList } from "@/lib/os";
import { tr } from "@/lib/i18n";

const KEYS: { key: keyof BarbicanQuotas; label: string }[] = [
  { key: "secrets", label: tr("Secrets") },
  { key: "containers", label: tr("Containers") },
  { key: "orders", label: tr("Orders") },
  { key: "consumers", label: tr("Consumers") },
  { key: "cas", label: tr("CAs") },
];

interface Row {
  id: string;
  name: string;
  own?: BarbicanQuotas;
}

const show = (n: number | null | undefined) => (n == null ? null : n < 0 ? tr("unlimited") : n.toLocaleString());

export default function KeyManagerQuotas() {
  const projects = useProjects();
  const pq = useOsList<{ project_id: string; project_quotas: BarbicanQuotas }>("key-manager", "project-quotas", "project_quotas");
  const defaults = useBarbicanQuotas();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<Row | null>(null);
  const [resetting, setResetting] = useState<Row | null>(null);
  const rows = useMemo<Row[] | undefined>(() => {
    if (!projects.data) return undefined;
    const own = new Map(pq.data?.map((x) => [x.project_id, x.project_quotas]));
    return projects.data.map((p) => ({ id: p.id, name: p.name, own: own.get(p.id) }));
  }, [projects.data, pq.data]);

  const cell = (k: keyof BarbicanQuotas) => (r: Row) => {
    const v = r.own?.[k];
    return v != null ? <span className="font-medium">{show(v)}</span> : <span className="text-muted">{show(defaults.data?.[k]) ?? tr("default")}</span>;
  };
  const columns: Column<Row>[] = [
    {
      key: "project",
      header: tr("Project"),
      cell: (r) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{r.name}</span>
          {r.own && <Badge tone="accent">{tr("custom")}</Badge>}
        </span>
      ),
      value: (r) => r.name,
    },
    ...KEYS.map((k) => ({ key: k.key, header: k.label, width: "8rem", cell: cell(k.key), value: (r: Row) => r.own?.[k.key] ?? defaults.data?.[k.key] ?? 0 })),
  ];
  return (
    <>
      <PageHeader
        title={tr("Key manager quotas")}
        description={tr("How many secrets, containers, orders and consumers each project may create in Barbican. Grey values are the cloud defaults; -1 is unlimited.")}
      />
      <ErrorNotice error={pq.error ?? projects.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={projects.isPending || pq.isPending}
        tableId="admin-barbican-quotas"
        noun={tr("projects")}
        rowLabel={(r) => r.name}
        filterPlaceholder={tr("Filter by project")}
        onRefresh={() => invalidate("key-manager")}
        refreshing={pq.isFetching}
        rowActions={(r) => [
          { label: tr("Edit quotas"), icon: "edit", onSelect: () => setEditing(r) },
          r.own && { label: tr("Reset to defaults"), icon: "rotate-ccw", onSelect: () => setResetting(r) },
        ]}
      />
      {editing && <QuotaDialog row={editing} defaults={defaults.data} onClose={() => setEditing(null)} />}
      {resetting && (
        <ActionDialog
          onClose={() => setResetting(null)}
          title={tr("Reset {name} to the defaults?", { name: resetting.name })}
          submitLabel={tr("Reset")}
          done={tr("Quotas reset")}
          refresh={["key-manager"]}
          run={() => os.del("key-manager", `project-quotas/${resetting.id}`)}
        >
          <p className="text-sm">{tr("The project's own quotas are removed; the cloud defaults apply again.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function QuotaDialog({ row, defaults, onClose }: { row: Row; defaults?: BarbicanQuotas; onClose: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(KEYS.map((k) => [k.key, row.own?.[k.key] != null ? String(row.own[k.key]) : ""])));
  const bad = KEYS.some((k) => vals[k.key].trim() !== "" && (!Number.isInteger(Number(vals[k.key])) || Number(vals[k.key]) < -1));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Quotas of {name}", { name: row.name })}
      description={tr("Empty fields keep the cloud default; -1 is unlimited.")}
      submitLabel={tr("Save")}
      canSubmit={!bad}
      done={tr("Quotas saved")}
      refresh={["key-manager"]}
      run={() =>
        os.put("key-manager", `project-quotas/${row.id}`, {
          project_quotas: Object.fromEntries(KEYS.filter((k) => vals[k.key].trim() !== "").map((k) => [k.key, Number(vals[k.key])])),
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {KEYS.map((k) => (
          <Field key={k.key} label={k.label}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={-1}
                value={vals[k.key]}
                onChange={(e) => setVals((v) => ({ ...v, [k.key]: e.target.value }))}
                placeholder={defaults?.[k.key] != null ? tr("Default: {v}", { v: show(defaults[k.key]) ?? "" }) : tr("Default")}
              />
            )}
          </Field>
        ))}
      </div>
      {bad && <p className="text-xs text-led-red">{tr("Use whole numbers, -1 for unlimited.")}</p>}
    </ActionDialog>
  );
}
