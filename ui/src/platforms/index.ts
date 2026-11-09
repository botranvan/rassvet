/**
 * Cloud platforms Rassvet signs in to. Each has its own folder here (its sign-in form, and
 * later its pages), next to its client crate on the server (`crates/clients/<platform>`).
 */
import type { Platform } from "@/lib/session";
import { tr } from "@/lib/i18n";

export interface PlatformInfo {
  id: Platform;
  label: string;
  /** One line under the name in the platform picker. */
  description: string;
  icon: string;
}

export const PLATFORMS: PlatformInfo[] = [
  { id: "openstack", label: "OpenStack", description: tr("Keystone account or application credential"), icon: "cloud" },
  { id: "vcenter", label: "VMware vCenter", description: tr("vCenter Server, vCenter Single Sign-On account"), icon: "server-cog" },
  { id: "esxi", label: "VMware ESXi", description: tr("A standalone ESXi host, local account"), icon: "server" },
  { id: "vcf", label: "VMware Cloud Foundation", description: tr("SDDC Manager, vCenter Single Sign-On account"), icon: "layers" },
];

export function platformInfo(id: Platform): PlatformInfo {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}
