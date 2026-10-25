/**
 * EC2 credentials: S3-style access key + secret pairs (Keystone OS-EC2) for the object
 * storage S3 API (Swift s3api or Ceph RGW), with ready-made config for aws, s3cmd, rclone
 * and boto3.
 */
import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { CodeBlock, CopyButton } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Link } from "@/components/Link";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Tabs } from "@/components/ui";
import { type Ec2Credential, s3Endpoint, useCatalog, useCreateEc2Cred, useDeleteEc2Cred, useEc2Creds } from "@/lib/identity";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

type Tool = "aws" | "s3cmd" | "rclone" | "boto3";

const mask = (s: string) => `${s.slice(0, 4)}${"•".repeat(Math.max(4, Math.min(24, s.length - 4)))}`;

function Secret({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Mono className="min-w-0 truncate">{shown ? value : mask(value)}</Mono>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="shrink-0 rounded p-1 text-muted hover:bg-ink/5 hover:text-ink"
        aria-label={shown ? tr("Hide secret") : tr("Show secret")}
        title={shown ? tr("Hide secret") : tr("Show secret")}
      >
        <Icon name={shown ? "eye-off" : "eye"} className="size-4" />
      </button>
    </span>
  );
}

/** Profile / remote name from the project name: letters, digits, - and _. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "openstack";

function snippet(tool: Tool, c: Ec2Credential, endpoint: string, region: string, name: string) {
  const ep = endpoint || "https://s3.example.com";
  let host = ep;
  let https = true;
  try {
    const u = new URL(ep);
    host = u.host;
    https = u.protocol === "https:";
  } catch {
    /* typed by hand: use as is */
  }
  switch (tool) {
    case "aws":
      return {
        filename: "aws-config.txt",
        code: `# ~/.aws/credentials
[${name}]
aws_access_key_id = ${c.access}
aws_secret_access_key = ${c.secret}

# ~/.aws/config  (AWS CLI 2.13+ reads endpoint_url here)
[profile ${name}]
region = ${region}
endpoint_url = ${ep}
s3 =
    addressing_style = path

# then:
#   aws --profile ${name} s3 ls
#   aws --profile ${name} s3 cp ./file.txt s3://my-container/
`,
      };
    case "s3cmd":
      return {
        filename: ".s3cfg",
        code: `[default]
access_key = ${c.access}
secret_key = ${c.secret}
host_base = ${host}
host_bucket = ${host}
use_https = ${https ? "True" : "False"}
bucket_location = ${region}
signature_v2 = False

# save as ~/.s3cfg, then: s3cmd ls
`,
      };
    case "rclone":
      return {
        filename: "rclone.conf",
        code: `# ~/.config/rclone/rclone.conf
[${name}]
type = s3
provider = Other
access_key_id = ${c.access}
secret_access_key = ${c.secret}
endpoint = ${ep}
region = ${region}
force_path_style = true

# then: rclone lsd ${name}:
`,
      };
    case "boto3":
      return {
        filename: "s3_example.py",
        code: `import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="${ep}",
    aws_access_key_id="${c.access}",
    aws_secret_access_key="${c.secret}",
    region_name="${region}",
    config=Config(s3={"addressing_style": "path"}),
)
for bucket in s3.list_buckets()["Buckets"]:
    print(bucket["Name"])
`,
      };
  }
}

export default function Ec2Credentials() {
  const session = useSession().data;
  const creds = useEc2Creds();
  const catalog = useCatalog();
  const create = useCreateEc2Cred();
  const del = useDeleteEc2Cred();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Ec2Credential | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("aws");
  const detected = useMemo(() => s3Endpoint(catalog.data, session?.region ?? null), [catalog.data, session?.region]);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [region, setRegion] = useState("us-east-1");
  const ep = endpoint ?? detected?.url ?? "";

  const projects = useMemo(() => new Map(session?.projects.map((p) => [p.id, p.name])), [session?.projects]);
  const projectName = (id: string) => projects.get(id) ?? id;
  const current = session?.project?.id;
  const rows = useMemo(() => [...(creds.data ?? [])].sort((a, b) => Number(b.tenant_id === current) - Number(a.tenant_id === current)), [creds.data, current]);
  const chosen = rows.find((c) => c.access === picked) ?? rows.find((c) => c.tenant_id === current) ?? rows[0];
  const hasMine = rows.some((c) => c.tenant_id === current);

  const columns: Column<Ec2Credential>[] = [
    {
      key: "access",
      header: tr("Access key"),
      wrap: true,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Mono className="min-w-0 truncate">{c.access}</Mono>
          <CopyButton text={c.access} label="" className="h-7 shrink-0 px-2" />
        </span>
      ),
      value: (c) => c.access,
    },
    {
      key: "secret",
      header: tr("Secret key"),
      wrap: true,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Secret value={c.secret} />
          <CopyButton text={c.secret} label="" className="h-7 shrink-0 px-2" />
        </span>
      ),
      value: () => "",
      csv: () => "",
    },
    {
      key: "project",
      header: tr("Project"),
      width: "12rem",
      wrap: true,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{projectName(c.tenant_id)}</span>
          {c.tenant_id === current && <Badge tone="accent">{tr("current")}</Badge>}
        </span>
      ),
      value: (c) => projectName(c.tenant_id),
    },
  ];

  const snip = chosen ? snippet(tool, chosen, ep, region, slug(projectName(chosen.tenant_id))) : null;

  return (
    <>
      <PageHeader
        title={tr("EC2 credentials")}
        description={tr("Access key and secret pairs for the S3 API of object storage (Swift s3api or Ceph RGW) and other EC2-style tools. Each pair works in one project and acts as you: keep the secret safe, delete pairs you no longer use.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!current}>
            <Icon name="plus" />
            {tr("Create credentials")}
          </Button>
        }
      />
      <ErrorNotice error={creds.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.access}
        loading={creds.isPending}
        tableId="ec2-credentials"
        noun={tr("credentials")}
        rowLabel={(c) => c.access}
        empty={tr("No EC2 credentials yet. Create a pair for this project to use S3 tools.")}
        onRefresh={() => creds.refetch()}
        refreshing={creds.isFetching}
        rowActions={(c) => [
          { label: tr("Show config"), icon: "file-code", onSelect: () => setPicked(c.access) },
          "-",
          { label: tr("Delete"), icon: "trash", danger: true, onSelect: () => setDeleting(c) },
        ]}
      />

      <Card title={tr("Use with S3 tools")} className="mt-6">
        <div className="mb-4 grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field
            label={tr("S3 endpoint")}
            hint={
              detected?.guessed
                ? tr("Guessed from the object storage endpoint (Ceph RGW and Swift s3api answer S3 on the same host). Ask your operator if S3 lives elsewhere.")
                : detected
                  ? tr("From the cloud's service catalog.")
                  : tr("This region has no object storage endpoint; enter the S3 endpoint your operator gave you.")
            }
          >
            {(id) => <Input id={id} value={ep} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://s3.example.com" className="font-mono text-[13px]" />}
          </Field>
          <Field label={tr("Signing region")} hint={tr("Swift s3api expects its configured location (often us-east-1); RGW accepts any.")}>
            {(id) => <Input id={id} value={region} onChange={(e) => setRegion(e.target.value.trim())} className="font-mono text-[13px]" />}
          </Field>
        </div>
        {!chosen ? (
          <p className="text-sm text-muted">{tr("Create credentials first; the configuration for your tools appears here.")}</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Tabs
                value={tool}
                onChange={setTool}
                tabs={[
                  { id: "aws", label: "AWS CLI" },
                  { id: "s3cmd", label: "s3cmd" },
                  { id: "rclone", label: "rclone" },
                  { id: "boto3", label: "Python (boto3)" },
                ]}
                className="min-w-0 flex-1"
              />
              <span className="text-xs text-muted">
                {tr("For {project}", { project: projectName(chosen.tenant_id) })} · <Mono>{chosen.access.slice(0, 8)}…</Mono>
              </span>
            </div>
            {snip && <CodeBlock code={snip.code} filename={snip.filename} />}
            <p className="mt-3 text-sm text-muted">
              {tr("Buckets are the project's object storage containers:")}{" "}
              <Link to="/object-store/containers" className="font-medium text-cable hover:underline">
                {tr("open Containers")}
              </Link>
              .
            </p>
          </>
        )}
      </Card>

      {creating && (
        <ActionDialog
          onClose={() => setCreating(false)}
          title={tr("Create EC2 credentials?")}
          submitLabel={tr("Create")}
          done={tr("Credentials created")}
          run={async () => {
            const c = await create.mutateAsync(undefined);
            setPicked(c.access);
          }}
        >
          <p className="text-sm">{tr("A new access key and secret for project {project}. Anyone holding them can read and write that project's object storage as you.", { project: session?.project?.name ?? "" })}</p>
          {hasMine && <p className="text-sm text-muted">{tr("You already have a pair for this project; a second one is fine (e.g. one per tool), delete the ones you stop using.")}</p>}
        </ActionDialog>
      )}
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete these EC2 credentials?")}
          submitLabel={tr("Delete")}
          done={tr("Credentials deleted")}
          run={() => del.mutateAsync(deleting.access)}
        >
          <p className="text-sm">
            {tr("Tools still using access key {access} stop working at once.", { access: deleting.access })}
          </p>
        </ActionDialog>
      )}
    </>
  );
}
