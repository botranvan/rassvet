import { tr } from "@/lib/i18n";
import type { Platform } from "@/lib/session";
import type { PlatformSignInProps } from "../types";
import { UserPasswordForm } from "../UserPasswordForm";

/**
 * vCenter (vCenter Single Sign-On user, e.g. administrator@vsphere.local) or a standalone
 * ESXi host (local user, e.g. root). Server side: `crates/clients/vsphere`.
 */
export default function VsphereSignInForm(props: PlatformSignInProps & { platform: Extract<Platform, "vcenter" | "esxi"> }) {
  const esxi = props.platform === "esxi";
  return (
    <UserPasswordForm
      {...props}
      icon={esxi ? "server" : "server-cog"}
      userPlaceholder={esxi ? "root" : "administrator@vsphere.local"}
      userHint={
        esxi
          ? tr("A local account of the ESXi host.")
          : tr("A vCenter Single Sign-On account, with its domain: user@vsphere.local or DOMAIN\\user.")
      }
    />
  );
}
