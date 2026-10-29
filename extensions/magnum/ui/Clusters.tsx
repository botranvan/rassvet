/** Kubernetes clusters (Cluster API driver): list (project and admin view), create dialog and the per-cluster actions. */
import { useState } from "react";
import {
  ActionDialog,
  Button,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Input,
  KeyValueEditor,
  type KvRow,
  Link,
  type MenuEntry,
  PageHeader,
  Picker,
  StatusDot,
  Tabs,
  age,
  downloadText,
  fmtDate,
  fromRows,
  kvError,
  os,
  tr,
  useFlavors,
  useBootImages,
  useInAdmin,
  useInvalidate,
  useKeypairs,
  useNavigate,
  useNewParam,
  useProjects,
  useSession,
} from "@rassvet/sdk";
import { ResizeDialog } from "./NodeGroups";
import {
  BASE,
  CAPI_DRIVER,
  type Cluster,
  type ClusterTemplate,
  LABEL_SUGGESTIONS,
  MG,
  busy,
  clusterStatus,
  fetchKubeconfig,
  flavorTooSmall,
  healthStatus,
  imageProblem,
  labelOn,
  labelsOf,
  mgName,
  needsVersion,
  rotateCredentials,
  statusText,
  upgradeProblem,
  useClusters,
  useMagnumInfo,
  useOwnQuota,
  useTemplateVersion,
  useTemplates,
} from "./api";

export default function Clusters() {
  const admin = useInAdmin();
  const session = useSession();
  const clusters = useClusters();
  const templates = useTemplates();
  const version = useTemplateVersion();
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const actions = useClusterActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const quota = useOwnQuota(admin ? undefined : session.data?.project?.id);

  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const templateName = (id: string) => {
    const t = templates.data?.find((x) => x.uuid === id);
    return t ? mgName(t) : id.slice(0, 8);
  };

  const columns: Column<Cluster>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (c) => (
        <div className="min-w-0">
          <Link to={`${BASE}/clusters/${c.uuid}`} className="block truncate font-medium text-cable hover:underline">
            {mgName(c)}
          </Link>
          <p className="truncate text-xs text-muted">{templateName(c.cluster_template_id)}</p>
        </div>
      ),
      value: (c) => `${c.name} ${c.uuid} ${templateName(c.cluster_template_id)}`,
      csv: (c) => c.name,
    },
    ...(admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (c: Cluster) => projectName(c.project_id), value: (c: Cluster) => projectName(c.project_id) }] : []),
    {
      key: "nodes",
      header: tr("Masters / workers"),
      width: "9rem",
      className: "text-right",
      cell: (c) => (
        <span className="font-mono text-[12.5px]">
          {c.master_count} / {c.node_count}
        </span>
      ),
      value: (c) => c.master_count + c.node_count,
    },
    { key: "version", header: tr("Version"), width: "8rem", hideBelow: "lg", cell: (c) => clusterVersion(c) || "—", value: (c) => clusterVersion(c) ?? "" },
    {
      key: "status",
      header: tr("Status"),
      width: "11rem",
      cell: (c) => <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />,
      value: (c) => c.status,
    },
    {
      key: "health",
      header: tr("Health"),
      width: "8rem",
      hideBelow: "sm",
      cell: (c) => <StatusDot status={healthStatus(c.health_status)} label={statusText(c.health_status)} />,
      value: (c) => c.health_status ?? "",
    },
    { key: "api", header: tr("API address"), width: "13rem", hideBelow: "xl", mono: true, cell: (c) => c.api_address || "—", value: (c) => c.api_address ?? "" },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "2xl", cell: (c) => <span title={fmtDate(c.created_at) ?? ""}>{age(c.created_at)}</span>, value: (c) => c.created_at ?? "" },
  ];

  /** The running version (reported by the control plane), else the template image's. */
  const clusterVersion = (c: Cluster) => c.coe_version?.replace(/^v/, "") || version(templates.data?.find((t) => t.uuid === c.cluster_template_id));
  const used = clusters.data?.length ?? 0;
  const limit = quota.data?.hard_limit;
  return (
    <>
      <PageHeader
        title={admin ? tr("All Kubernetes clusters") : tr("Kubernetes clusters")}
        description={
          admin
            ? tr("Magnum clusters of every project in this region.")
            : `${tr("Kubernetes clusters built by Magnum from a cluster template: control plane, worker node groups, networking and storage.")}${limit != null && limit >= 0 ? " " + tr("{used} of {limit} clusters used.", { used, limit }) : ""}`
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create cluster")}
          </Button>
        }
      />
      <ErrorNotice error={clusters.error} className="mb-4" />
      <DataTable
        rows={clusters.data}
        columns={columns}
        rowKey={(c) => c.uuid}
        loading={clusters.isPending}
        tableId={admin ? "magnum-admin-clusters" : "magnum-clusters"}
        noun={tr("clusters")}
        rowLabel={mgName}
        onRefresh={() => clusters.refetch()}
        refreshing={clusters.isFetching}
        onBulkDone={() => invalidate(MG, "compute", "network")}
        empty={admin ? tr("No Kubernetes clusters in this region.") : tr("This project has no Kubernetes clusters yet.")}
        filterPlaceholder={tr("Filter by name, template or status")}
        rowActions={(c) => actions.items(c)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete clusters?"),
            past: tr("deleted"),
            body: tr("Each cluster is deleted with its servers, load balancers, networks and volumes that Magnum created. Workloads and their data are lost."),
            check: (c) => (c.status === "DELETE_IN_PROGRESS" ? tr("Already being deleted") : true),
            run: (c) => os.del(MG, `clusters/${c.uuid}`),
          },
        ]}
      />
      {creating && <CreateClusterDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

export type ClusterAction = "kubeconfig" | "resize" | "upgrade" | "credentials" | "delete";

export function useClusterActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: ClusterAction; c: Cluster } | null>(null);
  const close = () => setOpen(null);
  const info = useMagnumInfo();
  // PATCH credentials/{id} came with microversion 1.12 (older Magnum answers 405).
  const noCredentials = needsVersion(info.data?.microversion, "1.12", info.isSuccess);
  const items = (c: Cluster, where: "list" | "detail" = "list"): MenuEntry[] => {
    const wait = busy(c) ? tr("Busy ({status})", { status: statusText(c.status) }) : false;
    const deleting = c.status.startsWith("DELETE") && tr("Being deleted");
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${BASE}/clusters/${c.uuid}`) },
      where === "list" && "-",
      { label: tr("Download kubeconfig"), icon: "download", disabled: !c.api_address && tr("No API address yet"), onSelect: () => setOpen({ kind: "kubeconfig", c }) },
      "-",
      { label: tr("Resize workers"), icon: "scaling", disabled: wait || deleting, onSelect: () => setOpen({ kind: "resize", c }) },
      { label: tr("Upgrade"), icon: "arrow-up", disabled: wait || deleting, onSelect: () => setOpen({ kind: "upgrade", c }) },
      { label: tr("Renew cloud credentials"), icon: "key-round", disabled: noCredentials || wait || deleting, onSelect: () => setOpen({ kind: "credentials", c }) },
      "-",
      { label: tr("Delete cluster"), icon: "trash", danger: true, disabled: c.status === "DELETE_IN_PROGRESS" && tr("Already being deleted"), onSelect: () => setOpen({ kind: "delete", c }) },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "kubeconfig" && <KubeconfigDialog cluster={o.c} onClose={close} />}
      {o.kind === "resize" && <ResizeDialog cluster={o.c} onClose={close} />}
      {o.kind === "upgrade" && <UpgradeDialog cluster={o.c} onClose={close} />}
      {o.kind === "credentials" && (
        <ActionDialog
          onClose={close}
          title={tr("Renew the cloud credentials of {name}?", { name: mgName(o.c) })}
          submitLabel={tr("Renew credentials")}
          done={tr("Renewing the credentials of {name}", { name: mgName(o.c) })}
          refresh={[MG]}
          run={() => rotateCredentials(o.c.uuid)}
        >
          <p className="text-sm">
            {tr("The cluster talks to OpenStack (load balancers, volumes, autoscaling) with an application credential of the user who created it. Magnum makes a new one with your account and deletes the old one; the cluster then belongs to you. Use it when the owner leaves the project or the credential was exposed.")}
          </p>
        </ActionDialog>
      )}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: mgName(o.c) })}
          submitLabel={tr("Delete cluster")}
          done={tr("Deleting cluster {name}", { name: mgName(o.c) })}
          refresh={[MG, "compute", "network"]}
          onDone={onDeleted}
          run={() => os.del(MG, `clusters/${o.c.uuid}`)}
        >
          <p className="text-sm">
            {tr("Magnum deletes the cluster's {n} node(s) and the load balancers, networks and volumes it created. Workloads and data in the cluster are lost.", {
              n: o.c.master_count + o.c.node_count,
            })}
          </p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, openDialog: (c: Cluster, kind: ClusterAction) => setOpen({ kind, c }) };
}

export function KubeconfigDialog({ cluster, onClose }: { cluster: Cluster; onClose: () => void }) {
  const keystone = labelOn(labelsOf(cluster.labels), "keystone_auth_enabled", false);
  const [auth, setAuth] = useState<"cert" | "keystone">("cert");
  return (
    <ActionDialog<{ filename: string; kubeconfig: string }>
      onClose={onClose}
      title={tr("Kubeconfig for {name}", { name: mgName(cluster) })}
      submitLabel={tr("Download")}
      done={(r) => tr("Saved {file}", { file: r.filename })}
      onDone={(r) => downloadText(r.filename, r.kubeconfig, "application/yaml")}
      run={() => fetchKubeconfig(cluster.uuid, auth)}
    >
      {keystone && (
        <Field label={tr("Sign in with")}>
          {(id) => (
            <Picker
              id={id}
              value={auth}
              onChange={(v) => setAuth(v as "cert" | "keystone")}
              options={[
                { value: "cert", label: tr("Client certificate"), description: tr("Cluster admin (system:masters); can't be revoked") },
                { value: "keystone", label: tr("OpenStack token"), description: tr("kubectl sends $OS_TOKEN; Kubernetes roles come from Keystone") },
              ]}
            />
          )}
        </Field>
      )}
      {auth === "cert" ? (
        <>
          <p className="text-sm">
            {tr("A new key and a client certificate signed by the cluster CA are made for you. The certificate gives full cluster-admin rights (group system:masters): keep the file safe. Rassvet keeps no copy.")}
          </p>
          <p className="text-sm text-led-red">
            {tr("The Cluster API driver can't rotate the cluster CA, so a leaked file can't be revoked: only deleting the cluster stops it working.")}
            {!keystone && " " + tr("Prefer clusters with keystone_auth_enabled=true and sign in with an OpenStack token.")}
          </p>
        </>
      ) : (
        <p className="text-sm">{tr("The file holds no secret: run kubectl with OS_TOKEN set, e.g. export OS_TOKEN=$(openstack token issue -f value -c id).")}</p>
      )}
      <p className="text-sm text-muted">{tr("Use it with: export KUBECONFIG=$PWD/{file}", { file: `${cluster.name || cluster.uuid}.kubeconfig` })}</p>
    </ActionDialog>
  );
}

function UpgradeDialog({ cluster, onClose }: { cluster: Cluster; onClose: () => void }) {
  const templates = useTemplates();
  const version = useTemplateVersion();
  const current = templates.data?.find((t) => t.uuid === cluster.cluster_template_id);
  const options = (templates.data ?? []).filter((t) => capiTemplate(t) && !t.hidden && t.uuid !== cluster.cluster_template_id);
  const [target, setTarget] = useState("");
  const now = cluster.coe_version?.replace(/^v/, "") || version(current);
  const next = version(options.find((t) => t.uuid === target));
  const problem = upgradeProblem(now, next);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Upgrade {name}", { name: mgName(cluster) })}
      description={tr("Moves the cluster to another template; its image's kube_version becomes the cluster's Kubernetes version. Cluster API replaces the nodes one by one.")}
      submitLabel={tr("Upgrade")}
      canSubmit={!!target && !problem}
      done={tr("Upgrading {name}", { name: mgName(cluster) })}
      refresh={[MG, "compute"]}
      run={() => os.post(MG, `clusters/${cluster.uuid}/actions/upgrade`, { cluster_template: target, max_batch_size: 1 })}
    >
      <p className="text-sm">{tr("Now: {t} ({v}).", { t: current ? mgName(current) : cluster.cluster_template_id, v: now ? `Kubernetes ${now}` : tr("unknown version") })}</p>
      <Field label={tr("New template")}>
        {(id) => (
          <Picker
            id={id}
            value={target}
            onChange={setTarget}
            loading={templates.isPending}
            options={options.map((t) => ({
              value: t.uuid,
              label: mgName(t),
              description: [version(t) && `Kubernetes ${version(t)}`, t.network_driver].filter(Boolean).join(" · "),
              disabled: upgradeProblem(now, version(t)),
            }))}
          />
        )}
      </Field>
      {problem && <p className="text-sm text-led-red">{problem}</p>}
    </ActionDialog>
  );
}

/** Templates for the Cluster API driver (`driver` is reported by recent Magnum; older ones don't). */
const capiTemplate = (t: ClusterTemplate) => t.coe === "kubernetes" && (!t.driver || t.driver === CAPI_DRIVER);

// =========================================================================== create

const STEPS = ["details", "size", "labels"] as const;
type Step = (typeof STEPS)[number];

export function CreateClusterDialog({ template: initial, onClose }: { template?: ClusterTemplate; onClose: () => void }) {
  const navigate = useNavigate();
  const admin = useSession().data?.is_admin;
  const templates = useTemplates();
  const keypairs = useKeypairs();
  const flavors = useFlavors();
  const [step, setStep] = useState<Step>("details");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(initial?.uuid ?? "");
  const [keypair, setKeypair] = useState<string | null>(null);
  const [masters, setMasters] = useState("1");
  const [workers, setWorkers] = useState("1");
  const [flavor, setFlavor] = useState("");
  const [masterFlavor, setMasterFlavor] = useState("");
  const [timeout, setTimeout_] = useState("60");
  const [labels, setLabels] = useState<KvRow[]>([]);

  const version = useTemplateVersion();
  const images = useBootImages();
  const usable = (templates.data ?? []).filter((t) => capiTemplate(t) && (!t.hidden || admin));
  const t = usable.find((x) => x.uuid === templateId);
  const tLabels = labelsOf(t?.labels);
  const tImage = images.data?.find((i) => i.id === t?.image_id || i.name === t?.image_id);
  const kp = keypair ?? t?.keypair_id ?? "";
  // Flavors are sent by name: the driver passes the value to capi-helm-charts as `machineFlavor`,
  // which Cluster API (CAPO) looks up by name, so an id is accepted by Magnum but no server is built.
  const flavorOpts = (flavors.data ?? []).map((f) => ({ value: f.name, label: f.name, description: `${f.vcpus} vCPU · ${Math.round(f.ram / 1024)} GiB RAM · ${f.disk} GB`, disabled: flavorTooSmall(f) }));
  const flavorName = (id?: string | null) => (id ? (flavors.data?.find((f) => f.id === id || f.name === id)?.name ?? id) : tr("driver default"));

  const problems: Partial<Record<Step, string>> = {};
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name.trim())) problems.details = tr("Start the name with a letter; use letters, digits, '-', '_' and '.'");
  if (!t) problems.details = tr("Choose a cluster template");
  if (!(Number(masters) >= 1)) problems.size = tr("At least one master");
  if (tImage && imageProblem(tImage)) problems.details = tr("The template's image can't be used: {why}", { why: imageProblem(tImage) as string });
  if (!(Number(workers) >= 0)) problems.size = tr("Enter the number of workers");
  if (!(Number(timeout) >= 0)) problems.size = tr("Enter a timeout in minutes");
  const kvProblem = kvError(labels);
  if (kvProblem) problems.labels = kvProblem;

  const create = async () => {
    const extra = fromRows(labels);
    const body: Record<string, unknown> = {
      name: name.trim(),
      cluster_template_id: templateId,
      master_count: Number(masters),
      node_count: Number(workers),
      create_timeout: Number(timeout),
      ...(kp ? { keypair: kp } : {}),
      ...(flavor ? { flavor_id: flavor } : {}),
      ...(masterFlavor ? { master_flavor_id: masterFlavor } : {}),
      // The driver always puts a load balancer in front of the API; Magnum needs this for 3+ masters.
      master_lb_enabled: true,
      // Added labels are merged into the template's instead of replacing them.
      ...(Object.keys(extra).length ? { labels: extra, merge_labels: true } : {}),
    };
    return os.post<{ uuid: string }>(MG, "clusters", body);
  };

  const stepLabel: Record<Step, string> = { details: tr("Details"), size: tr("Size"), labels: tr("Labels") };
  return (
    <ActionDialog<{ uuid: string }>
      onClose={onClose}
      size="xl"
      title={tr("Create Kubernetes cluster")}
      description={tr("Magnum builds the cluster in the background; it takes from a few minutes to half an hour depending on the driver and size.")}
      submitLabel={tr("Create cluster")}
      canSubmit={Object.keys(problems).length === 0}
      done={tr("Creating cluster {name}", { name: name.trim() })}
      refresh={[MG]}
      onDone={(r) => navigate(`${BASE}/clusters/${r.uuid}`)}
      run={create}
    >
      <Tabs value={step} onChange={setStep} tabs={STEPS.map((s, i) => ({ id: s, label: `${i + 1}. ${stepLabel[s]}${problems[s] ? " •" : ""}` }))} />
      {step === "details" && (
        <>
          <Field label={tr("Name")} hint={tr("Used in the names of the cluster's servers.")}>
            {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-k8s" />}
          </Field>
          <Field label={tr("Cluster template")}>
            {(id) => (
              <Picker
                id={id}
                value={templateId}
                onChange={setTemplateId}
                loading={templates.isPending}
                options={usable.map((x) => ({
                  value: x.uuid,
                  label: mgName(x),
                  description: [version(x) && `Kubernetes ${version(x)}`, x.network_driver, x.public ? tr("public") : tr("private")].filter(Boolean).join(" · "),
                  group: x.public ? tr("Public templates") : tr("This project's templates"),
                }))}
              />
            )}
          </Field>
          {templates.data && !usable.length && <p className="text-sm text-led-amber">{tr("There is no Kubernetes cluster template yet. Create one under Cluster templates first.")}</p>}
          <Field label={tr("Key pair")} hint={tr("SSH access to the nodes. Defaults to the template's.")}>
            {(id) => (
              <Picker
                id={id}
                value={kp}
                onChange={setKeypair}
                loading={keypairs.isPending}
                options={[{ value: "", label: tr("None") }, ...(keypairs.data ?? []).map((k) => ({ value: k.name, label: k.name, description: k.fingerprint }))]}
              />
            )}
          </Field>
        </>
      )}
      {step === "size" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Masters")} hint={tr("1 for tests, 3 for a highly available control plane.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={masters}
                  onChange={setMasters}
                  options={["1", "3", "5"].map((n) => ({ value: n, label: n }))}
                />
              )}
            </Field>
            <Field label={tr("Workers")} hint={tr("Nodes of the default worker group; add more groups later.")}>
              {(id) => <Input id={id} type="number" min={0} value={workers} onChange={(e) => setWorkers(e.target.value)} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Master flavor")}>
              {(id) => (
                <Picker id={id} value={masterFlavor} onChange={setMasterFlavor} loading={flavors.isPending} options={[{ value: "", label: tr("Template: {f}", { f: flavorName(t?.master_flavor_id) }) }, ...flavorOpts]} />
              )}
            </Field>
            <Field label={tr("Worker flavor")}>
              {(id) => <Picker id={id} value={flavor} onChange={setFlavor} loading={flavors.isPending} options={[{ value: "", label: tr("Template: {f}", { f: flavorName(t?.flavor_id) }) }, ...flavorOpts]} />}
            </Field>
          </div>
          <Field label={tr("Creation timeout (minutes)")} hint={tr("0: no timeout.")}>
            {(id) => <Input id={id} type="number" min={0} value={timeout} onChange={(e) => setTimeout_(e.target.value)} />}
          </Field>
        </>
      )}
      {step === "labels" && (
        <>
          <p className="text-sm text-muted">
            {Object.keys(tLabels).length
              ? tr("The template sets {n} label(s): {list}. Labels added here are merged with them; the same key overrides the template's value.", {
                  n: Object.keys(tLabels).length,
                  list: Object.entries(tLabels)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", "),
                })
              : tr("Labels added here are merged with the template's.")}
          </p>
          <KeyValueEditor rows={labels} onChange={setLabels} suggestions={LABEL_SUGGESTIONS} addLabel={tr("Add label")} empty={tr("No extra labels.")} />
        </>
      )}
    </ActionDialog>
  );
}
