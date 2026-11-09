import { tr } from "@/lib/i18n";
import type { PlatformSignInProps } from "../types";
import { UserPasswordForm } from "../UserPasswordForm";

/** VMware Cloud Foundation: signs in to the SDDC Manager. Server side: `crates/clients/vcf`. */
export default function VcfSignInForm(props: PlatformSignInProps) {
  return (
    <UserPasswordForm
      {...props}
      icon="layers"
      userPlaceholder="administrator@vsphere.local"
      userHint={tr("A vCenter Single Sign-On account with a role in SDDC Manager.")}
    />
  );
}
