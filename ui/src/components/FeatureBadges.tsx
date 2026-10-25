import { guestFeatures } from "@/lib/flavorPresets";
import { Badge } from "./ui";

/** Small badges for a flavor's security / accelerator features (vTPM, SEV/TDX, vGPU). */
export function FeatureBadges({ specs }: { specs?: Record<string, string> }) {
  const g = guestFeatures(specs);
  if (!g.tpm && !g.confidential && !g.vgpu) return null;
  return (
    <span className="ml-2 inline-flex gap-1 align-middle">
      {g.tpm && <Badge tone="accent">vTPM {g.tpm.version}</Badge>}
      {g.confidential && <Badge tone="accent">{g.confidential.label}</Badge>}
      {g.vgpu && <Badge>{g.vgpu}</Badge>}
    </span>
  );
}
