/**
 * Public API for extension UIs. Extensions import from "@rassvet/sdk" only,
 * never from host internals, so the host can evolve without breaking them.
 *
 * An extension UI is `extensions/<id>/ui/index.tsx` with a default export of
 * type `ExtensionUi`. Its routes are mounted under `/ext/<id>/`.
 */
import type { ComponentType } from "react";

export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
export { ApiError, api } from "@/lib/api";
export { useSession } from "@/lib/session";
export { cn } from "@/lib/utils";
export * from "@/components/ui";
export { registerIcons } from "@/components/icons";
export { DataTable, type Column, type BulkAction } from "@/components/DataTable";
export { Dialog, ConfirmDialog } from "@/components/Dialog";
export { useToast } from "@/components/Toast";
export { CodeBlock, CopyButton } from "@/components/CodeBlock";
export { lang, tr, trx } from "@/lib/i18n";
// Gateway helpers: use the service name `ext:<id>` for the extension's own `/api/ext/<id>/os/*` gateway.
export {
  os,
  useOsList,
  useOsGet,
  useOsPaged,
  useListOrPages,
  useInvalidate,
  type Svc,
  type ServerFilter,
  age,
  // Neutron / Nova data an extension commonly needs
  type Network,
  type Subnet,
  type Port,
  type FloatingIp,
  type Server,
  useNetworks,
  useSubnets,
  usePorts,
  useFloatingIps,
  useServers,
  portLabel,
  serverIps,
} from "@/lib/os";
export { fmtDate, fmtBytes } from "@/lib/format";
export { useProjects } from "@/lib/identity";
export { useTab } from "@/lib/useTab";
export { Link, useNavigate, useInAdmin } from "@/components/Link";
export { useParams, useSearchParams } from "react-router";
export { ActionDialog } from "@/components/ActionDialog";
export { Picker, MultiPicker, type PickOption } from "@/components/Picker";
export { ComboInput, type ComboOption } from "@/components/ComboInput";
export { ActionMenu, type MenuEntry } from "@/components/Menu";
export { KeyValueEditor, type KvRow, toRows, fromRows, kvError } from "@/components/KeyValueEditor";
export { useProjectFilter, filters, text, choice, idFilter, nameRegex, matches, statusLabel } from "@/lib/filters";

export interface ExtensionRoute {
  /** Path relative to `/ext/<id>/`, e.g. "load-balancers" or "load-balancers/:id". */
  path: string;
  component: ComponentType;
  /** Only mounted in the admin view (`/admin/ext/<id>/<path>`); every route is mounted there too. */
  adminOnly?: boolean;
}

export interface ExtensionUi {
  routes: ExtensionRoute[];
}
