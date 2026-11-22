/**
 * Extra routes of a router (Neutron `extraroute`): static routes to destinations behind a next
 * hop on one of the router's subnets, e.g. a VPN appliance or another router. With the
 * `extraroute-atomic` extension routes are added and removed one by one (no lost update when
 * two people edit at once); without it the router's whole `routes` list is replaced.
 */
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Button, Icon, Input, Mono } from "@/components/ui";
import { type Cidr, cidrContains, cidrText, parseCidr } from "@/lib/ipmath";
import { useNeutronExtensions } from "@/lib/neutron";
import { type Port, type Router, type RouterRoute, type Subnet, os, useInvalidate, usePorts, useSubnets } from "@/lib/os";
import { tr, trx } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useNetName } from "./networkActions";

/** A router's own interface ports (HA routers have replicated ones). */
export const isRouterInterface = (p: Port) =>
  p.device_owner.startsWith("network:router_interface") || p.device_owner === "network:ha_router_replicated_interface";

const routeKey = (r: RouterRoute) => `${r.destination}|${r.nexthop}`;

/** A next hop as a one-address prefix, to test which subnet it is in. */
const hostOf = (ip: string): Cidr | null => parseCidr(`${ip.trim()}/${ip.includes(":") ? 128 : 32}`);

/** The router's subnets (its interfaces and its external gateway), for "which subnet reaches this next hop". */
export interface RouterSubnet {
  subnet: Subnet;
  cidr: Cidr;
  /** Network name, or "external gateway". */
  via: string;
}

export function routerSubnets(router: Router, interfaces: Port[], subnetOf: (id: string) => Subnet | undefined, netName: (id: string) => string): RouterSubnet[] {
  const ids = [
    ...interfaces.flatMap((p) => p.fixed_ips.map((f) => ({ id: f.subnet_id, via: netName(p.network_id) }))),
    ...(router.external_gateway_info?.external_fixed_ips ?? []).map((f) => ({ id: f.subnet_id, via: tr("external gateway") })),
  ];
  return ids.flatMap(({ id, via }) => {
    const subnet = subnetOf(id);
    const cidr = subnet && parseCidr(subnet.cidr);
    return subnet && cidr ? [{ subnet, cidr, via }] : [];
  });
}

const reachOf = (nexthop: string, subnets: RouterSubnet[]) => {
  const h = hostOf(nexthop);
  return h ? subnets.find((s) => cidrContains(s.cidr, h)) : undefined;
};

/** Add `add` and drop `remove`, atomically when the cloud can. */
async function changeRoutes(router: Router, atomic: boolean, add: RouterRoute[], remove: RouterRoute[]) {
  if (atomic) {
    if (remove.length) await os.put("network", `routers/${router.id}/remove_extraroutes`, { router: { routes: remove } });
    if (add.length) await os.put("network", `routers/${router.id}/add_extraroutes`, { router: { routes: add } });
    return;
  }
  const gone = new Set(remove.map(routeKey));
  const routes = [...(router.routes ?? []).filter((r) => !gone.has(routeKey(r))), ...add];
  await os.put("network", `routers/${router.id}`, { router: { routes } });
}

export function RoutesTab({ router, subnets, onRefresh, refreshing }: { router: Router; subnets: RouterSubnet[]; onRefresh: () => void; refreshing: boolean }) {
  const ext = useNeutronExtensions();
  const atomic = !!ext.data?.has("extraroute-atomic");
  const invalidate = useInvalidate();
  const [dialog, setDialog] = useState<{ edit?: RouterRoute } | null>(null);
  const [removing, setRemoving] = useState<RouterRoute | null>(null);
  const routes = router.routes ?? [];

  const columns: Column<RouterRoute>[] = [
    { key: "destination", header: tr("Destination"), mono: true, cell: (r) => <span className="font-medium">{r.destination}</span>, value: (r) => r.destination },
    { key: "nexthop", header: tr("Next hop"), width: "12rem", mono: true, cell: (r) => r.nexthop, value: (r) => r.nexthop },
    {
      key: "via",
      header: tr("Reached through"),
      hideBelow: "md",
      cell: (r) => {
        const s = reachOf(r.nexthop, subnets);
        return s ? (
          <span>
            {s.subnet.name || s.subnet.cidr} <span className="text-muted">· {s.via}</span>
          </span>
        ) : (
          <span className="text-led-red">{tr("No connected subnet")}</span>
        );
      },
      value: (r) => reachOf(r.nexthop, subnets)?.subnet.name ?? "",
    },
  ];

  return (
    <>
      <DataTable
        rows={routes}
        columns={columns}
        rowKey={routeKey}
        tableId="router-routes"
        noun={tr("routes")}
        rowLabel={(r) => `${r.destination} → ${r.nexthop}`}
        empty={tr("No extra routes. Traffic leaves through the connected subnets and the external gateway only.")}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onBulkDone={() => invalidate("network")}
        rowActions={(r) => [
          { label: tr("Edit route"), icon: "edit", onSelect: () => setDialog({ edit: r }) },
          "-",
          { label: tr("Remove route"), icon: "trash", danger: true, onSelect: () => setRemoving(r) },
        ]}
        bulkActions={[
          {
            id: "remove",
            label: tr("Remove"),
            icon: "trash",
            danger: true,
            title: tr("Remove routes?"),
            past: tr("removed"),
            body: tr("Traffic to these destinations follows the router's other routes again."),
            run: (r) => changeRoutes(router, atomic, [], [r]),
          },
        ]}
        toolbar={
          <Button className="h-9" onClick={() => setDialog({})}>
            <Icon name="plus" />
            {tr("Add routes")}
          </Button>
        }
      />
      {dialog && <RoutesDialog router={router} subnets={subnets} atomic={atomic} edit={dialog.edit} onClose={() => setDialog(null)} />}
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Remove route to {v}?", { v: removing.destination })}
          submitLabel={tr("Remove route")}
          done={tr("Route removed")}
          refresh={["network"]}
          run={() => changeRoutes(router, atomic, [], [removing])}
        >
          <p className="text-sm">{trx("Traffic to {v} no longer goes to {v2}.", { v: <Mono>{removing.destination}</Mono>, v2: <Mono>{removing.nexthop}</Mono> })}</p>
        </ActionDialog>
      )}
    </>
  );
}

/**
 * "Add routes" from a router's Actions menu (list or detail page): the same dialog as the
 * Routes tab's, loading the router's subnets itself.
 */
export function AddRoutesDialog({ router, onClose }: { router: Router; onClose: () => void }) {
  const ports = usePorts({ device_id: router.id });
  const subnets = useSubnets();
  const netName = useNetName();
  const ext = useNeutronExtensions();
  // Opens once the subnets are known, so the next hops are checked against them.
  if (ports.isPending || subnets.isPending || ext.isPending) return null;
  const subnetOf = (id: string) => subnets.data?.find((s) => s.id === id);
  const list = routerSubnets(router, (ports.data ?? []).filter(isRouterInterface), subnetOf, netName);
  return <RoutesDialog router={router} subnets={list} atomic={!!ext.data?.has("extraroute-atomic")} onClose={onClose} />;
}

type Row = { destination: string; nexthop: string };

/** Problems of a row, keyed by field ("" when fine). */
function check(row: Row, rows: Row[], i: number, existing: RouterRoute[], subnets: RouterSubnet[]) {
  const dest = parseCidr(row.destination);
  const hop = hostOf(row.nexthop);
  const d = !row.destination.trim()
    ? tr("Enter a destination such as 10.20.0.0/16")
    : !dest
      ? tr("Not a network address (CIDR)")
      : !dest.aligned
        ? tr("Host bits are set: use {v}", { v: cidrText(dest) })
        : "";
  const n = !row.nexthop.trim()
    ? tr("Enter the next hop's IP address")
    : !hop
      ? tr("Not an IP address")
      : dest && hop.version !== dest.version
        ? tr("IPv{v} next hop for an IPv{v2} destination", { v: hop.version, v2: dest.version })
        : !reachOf(row.nexthop, subnets)
          ? tr("Not in a subnet of this router: Neutron refuses it")
          : "";
  const key = dest && hop ? `${cidrText(dest)}|${row.nexthop.trim()}` : "";
  const dup =
    key && (existing.some((r) => routeKey(r) === key) || rows.some((r, j) => j < i && parseCidr(r.destination) && `${cidrText(parseCidr(r.destination)!)}|${r.nexthop.trim()}` === key))
      ? tr("This route already exists")
      : "";
  return { d, n: n || dup };
}

function RoutesDialog({ router, subnets, atomic, edit, onClose }: { router: Router; subnets: RouterSubnet[]; atomic: boolean; edit?: RouterRoute; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(edit ? [{ ...edit }] : [{ destination: "", nexthop: "" }]);
  const existing = (router.routes ?? []).filter((r) => !edit || routeKey(r) !== routeKey(edit));
  const problems = rows.map((r, i) => check(r, rows, i, existing, subnets));
  const ok = rows.length > 0 && problems.every((p) => !p.d && !p.n);
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // Only built on submit, when every row is valid.
  const routes = () => rows.map((r) => ({ destination: cidrText(parseCidr(r.destination)!), nexthop: r.nexthop.trim() }));

  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={edit ? tr("Edit route to {v}", { v: edit.destination }) : tr("Add routes to {name}", { name: router.name || tr("the router") })}
      description={tr("Send traffic for a destination network to a next hop on one of the router's subnets, such as a VPN appliance or another router.")}
      submitLabel={edit ? tr("Save") : tr("Add {n} route{s}", { n: rows.length, s: rows.length === 1 ? "" : "s" })}
      canSubmit={ok}
      done={edit ? tr("Route updated") : tr("Routes added")}
      refresh={["network"]}
      run={() => changeRoutes(router, atomic, routes(), edit ? [edit] : [])}
    >
      <div className="space-y-2">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-3 text-xs font-medium text-muted">
          <span>{tr("Destination (CIDR)")}</span>
          <span>{tr("Next hop")}</span>
          <span />
        </div>
        {rows.map((r, i) => {
          const p = problems[i];
          const via = reachOf(r.nexthop, subnets);
          // Problems show once something is typed (the button stays off until every row is fine).
          const show = (field: "d" | "n", value: string) => value.trim() !== "" && p[field];
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] items-start gap-3">
              <div>
                <Input
                  aria-label={tr("Destination (CIDR)")}
                  autoFocus={i === rows.length - 1}
                  value={r.destination}
                  onChange={(e) => patch(i, { destination: e.target.value })}
                  placeholder="10.20.0.0/16"
                  className={cn("font-mono text-[13px]", show("d", r.destination) && "border-led-red")}
                  spellCheck={false}
                />
                {show("d", r.destination) && <p className="mt-1 text-xs text-led-red">{p.d}</p>}
              </div>
              <div>
                <Input
                  aria-label={tr("Next hop")}
                  value={r.nexthop}
                  onChange={(e) => patch(i, { nexthop: e.target.value })}
                  placeholder={subnets[0] ? cidrText(subnets[0].cidr).replace(/\.0\/\d+$/, ".254") : "192.168.1.254"}
                  className={cn("font-mono text-[13px]", show("n", r.nexthop) && "border-led-red")}
                  spellCheck={false}
                />
                {show("n", r.nexthop) ? (
                  <p className="mt-1 text-xs text-led-red">{p.n}</p>
                ) : via ? (
                  <p className="mt-1 truncate text-xs text-muted">{tr("Through {subnet} · {via}", { subnet: via.subnet.name || via.subnet.cidr, via: via.via })}</p>
                ) : null}
              </div>
              {!edit && (
                <Button type="button" variant="ghost" className="h-10 px-2.5" aria-label={tr("Remove this row")} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Icon name="x" />
                </Button>
              )}
            </div>
          );
        })}
        {!edit && (
          <Button type="button" onClick={() => setRows([...rows, { destination: "", nexthop: rows.at(-1)?.nexthop ?? "" }])}>
            <Icon name="plus" />
            {tr("Add another route")}
          </Button>
        )}
      </div>
      {subnets.length > 0 && (
        <div className="rounded-md bg-surface px-3 py-2 text-xs text-muted">
          <p className="mb-1 font-medium text-ink">{tr("The next hop must be in one of these subnets")}</p>
          <ul className="space-y-0.5">
            {subnets.map((s) => (
              <li key={s.subnet.id}>
                <Mono>{s.subnet.cidr}</Mono> · {s.subnet.name || tr("unnamed")} · {s.via}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ActionDialog>
  );
}
