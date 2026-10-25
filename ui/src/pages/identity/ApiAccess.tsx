import { useMemo, useState } from "react";
import { Picker } from "@/components/Picker";
import { Link } from "@/components/Link";
import { CodeBlock } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Card, ErrorNotice, PageHeader, Tabs } from "@/components/ui";
import { type CatalogService, cloudsYaml, openrc, useCatalog, useCliInfo } from "@/lib/identity";
import { useSession } from "@/lib/session";
import { tr, trx } from "@/lib/i18n";

interface Row {
  key: string;
  type: string;
  name: string;
  iface: string;
  region: string;
  url: string;
}

function flatten(catalog: CatalogService[] | undefined): Row[] {
  return (catalog ?? []).flatMap((s) =>
    s.endpoints.map((e, i) => ({
      key: `${s.type}:${e.interface}:${e.region_id ?? e.region}:${i}`,
      type: s.type,
      name: s.name ?? "",
      iface: e.interface,
      region: e.region_id ?? e.region ?? "",
      url: e.url,
    })),
  );
}

const columns: Column<Row>[] = [
  {
    key: "service", width: "12rem",
    header: tr("Service"),
    cell: (r) => (
      <span>
        <span className="font-medium">{r.type}</span>
        {r.name && <span className="ml-2 text-muted">{r.name}</span>}
      </span>
    ),
    value: (r) => `${r.type} ${r.name}`,
  },
  { key: "region", width: "8rem", hideBelow: "md", header: tr("Region"), cell: (r) => r.region, value: (r) => r.region },
  { key: "url", header: "URL", cell: (r) => <span className="select-all">{r.url}</span>, value: (r) => r.url, mono: true },
];

export default function ApiAccess() {
  const session = useSession().data;
  const catalog = useCatalog();
  const cli = useCliInfo();
  const [file, setFile] = useState<"clouds" | "openrc">("clouds");
  const [region, setRegion] = useState<string>(session?.region ?? "");

  // Users only get the public endpoints; internal and admin ones are for the cloud's own
  // services (admins see every interface under Admin → Services & endpoints).
  const all = useMemo(() => flatten(catalog.data).filter((r) => r.iface === "public"), [catalog.data]);
  const regions = useMemo(() => [...new Set(all.map((r) => r.region))].filter(Boolean).sort(), [all]);
  const rows = all.filter((r) => !region || r.region === region);

  const c = cli.data;
  const code = c ? (file === "clouds" ? cloudsYaml(c) : openrc(c)) : "";
  const filename = file === "clouds" ? "clouds.yaml" : `${c?.project_name ?? "project"}-openrc.sh`;

  return (
    <>
      <PageHeader
        title={tr("API access")}
        description={tr("Public endpoints of the services you can reach, and ready-made credential files for the openstack command line.")}
      />

      <div className="space-y-6">
        <Card title={tr("Command-line credentials")}>
          <Tabs
            value={file}
            onChange={setFile}
            tabs={[
              { id: "clouds", label: "clouds.yaml" },
              { id: "openrc", label: tr("OpenRC script") },
            ]}
            className="mb-4"
          />
          <ErrorNotice error={cli.error} />
          {c && <CodeBlock code={code} filename={filename} />}
          <p className="mt-3 max-w-[75ch] text-sm text-muted">
            {trx("{v} For scripts and CI, use an", { v: file === "clouds"
              ? tr("Save as ~/.config/openstack/clouds.yaml. Your password is not included; add it to the file or to secure.yaml.")
              : tr("Run it with source; it asks for your password and never stores it.") })}
            <Link to="/identity/application-credentials" className="font-medium text-cable hover:underline">
              {tr("application credential")}
            </Link>{" "}{tr("instead of your password.")}
          </p>
          <p className="mt-2 max-w-[75ch] text-sm text-muted">
            {tr("S3 tools (aws, s3cmd, rclone) use an access key instead:")}{" "}
            <Link to="/identity/ec2-credentials" className="font-medium text-cable hover:underline">
              {tr("EC2 credentials")}
            </Link>
            .
          </p>
        </Card>

        <div>
          <h2 className="mb-3 text-base font-semibold">{tr("Service endpoints")}</h2>
          <ErrorNotice error={catalog.error} className="mb-3" />
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.key}
            loading={catalog.isPending}
            tableId="api-endpoints"
            onRefresh={() => catalog.refetch()}
            refreshing={catalog.isFetching}
            filterPlaceholder={tr("Filter by service or URL")}
            empty={tr("No endpoints match these filters.")}
            toolbar={
              <Picker
                aria-label={tr("Region")}
                size="sm"
                className="h-9 w-44"
                value={region}
                onChange={setRegion}
                options={[{ value: "", label: tr("All regions") }, ...regions.map((r) => ({ value: r, label: r }))]}
              />
            }
          />
        </div>
      </div>
    </>
  );
}
