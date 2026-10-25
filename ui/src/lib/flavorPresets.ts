/**
 * Ready-made Nova extra-spec sets (confidential computing, vGPU, vTPM, Secure Boot) so admins
 * don't have to remember the keys, plus helpers to read those features back from a flavor's
 * extra specs or an image's properties (launch wizard).
 *
 * Keys from the Nova 2026.2 (Hibiscus) admin guides: SEV / SEV-ES / SEV-SNP and Intel TDX use
 * hw:mem_encryption + hw:mem_encryption_model; vTPM uses hw:tpm_version / hw:tpm_model /
 * hw:tpm_secret_security; vGPU uses resources:VGPU (Nova-managed mdevs) or
 * accel:device_profile (Cyborg-managed mdevs).
 */
import { tr } from "@/lib/i18n";

export interface SpecPreset {
  id: string;
  label: string;
  /** One line: what it gives the guest. */
  hint: string;
  group: "confidential" | "gpu" | "tpm" | "boot";
  specs: Record<string, string>;
  /** Keys this preset owns: they are removed when another preset of the same group is applied. */
  owns: string[];
  /** Image properties the guest image must carry for this to work (Nova checks at boot). */
  image?: Record<string, string>;
  /** Short notes shown after applying (limitations). */
  notes?: string[];
}

const MEM = ["hw:mem_encryption", "hw:mem_encryption_model"];
const TPM = ["hw:tpm_version", "hw:tpm_model", "hw:tpm_secret_security"];
const GPU = ["resources:VGPU", "accel:device_profile"];
const UEFI_Q35 = { hw_firmware_type: "uefi", hw_machine_type: "q35" };
const NO_LIVE = tr("No live migration or suspend: stop the instance before moving it off its host.");

export const SPEC_PRESETS: SpecPreset[] = [
  {
    id: "sev",
    label: "AMD SEV",
    hint: tr("Encrypted guest memory on AMD EPYC hosts"),
    group: "confidential",
    specs: { "hw:mem_encryption": "True", "hw:mem_encryption_model": "amd-sev" },
    owns: MEM,
    image: UEFI_Q35,
    notes: [NO_LIVE, tr("No PCI passthrough or vGPU; the boot disk must be virtio (or virtio-scsi / SATA).")],
  },
  {
    id: "sev-es",
    label: "AMD SEV-ES",
    hint: tr("SEV plus encrypted CPU register state"),
    group: "confidential",
    specs: { "hw:mem_encryption": "True", "hw:mem_encryption_model": "amd-sev-es" },
    owns: MEM,
    image: UEFI_Q35,
    notes: [NO_LIVE, tr("SEV-ES and SEV-SNP guests can't share a host.")],
  },
  {
    id: "sev-snp",
    label: "AMD SEV-SNP",
    hint: tr("SEV-ES plus memory integrity and attestation"),
    group: "confidential",
    specs: { "hw:mem_encryption": "True", "hw:mem_encryption_model": "amd-sev-snp" },
    owns: MEM,
    image: { ...UEFI_Q35, hw_firmware_stateless: "true" },
    notes: [NO_LIVE, tr("SEV-ES and SEV-SNP guests can't share a host.")],
  },
  {
    id: "tdx",
    label: "Intel TDX",
    hint: tr("Trust domain: encrypted, isolated memory and CPU state"),
    group: "confidential",
    specs: { "hw:mem_encryption": "True", "hw:mem_encryption_model": "intel-tdx" },
    owns: MEM,
    image: { ...UEFI_Q35, hw_firmware_stateless: "true", hw_video_model: "none" },
    notes: [NO_LIVE, tr("No VNC or SPICE console (use the serial console); hosts need 5th-gen Xeon or newer.")],
  },
  {
    id: "vgpu",
    label: "vGPU",
    hint: tr("One Nova-managed virtual GPU (mediated device)"),
    group: "gpu",
    specs: { "resources:VGPU": "1" },
    owns: GPU,
    notes: [tr("To pick a GPU type, add trait:CUSTOM_<TYPE>=required for the trait the operator gave those GPUs.")],
  },
  {
    id: "vgpu-cyborg",
    label: tr("vGPU (Cyborg)"),
    hint: tr("A Cyborg-managed mediated device, by device profile"),
    group: "gpu",
    specs: { "accel:device_profile": "<device-profile-name>" },
    owns: GPU,
    notes: [tr("Replace <device-profile-name> with a Cyborg device profile (openstack accelerator device profile list).")],
  },
  {
    id: "vtpm",
    label: "vTPM 2.0",
    hint: tr("Emulated TPM 2.0 (BitLocker, measured boot)"),
    group: "tpm",
    specs: { "hw:tpm_version": "2.0", "hw:tpm_model": "tpm-crb" },
    owns: TPM,
    notes: [tr("Rebuild, evacuate, shelve and rescue aren't supported for instances with a vTPM.")],
  },
  {
    id: "vtpm-host",
    label: tr("vTPM 2.0, live-migratable"),
    hint: tr("TPM secret held by the host so admins can live-migrate"),
    group: "tpm",
    specs: { "hw:tpm_version": "2.0", "hw:tpm_model": "tpm-crb", "hw:tpm_secret_security": "host" },
    owns: TPM,
    notes: [tr("Rebuild, evacuate, shelve and rescue aren't supported for instances with a vTPM.")],
  },
  {
    id: "secure-boot",
    label: tr("Secure Boot"),
    hint: tr("UEFI Secure Boot required"),
    group: "boot",
    specs: { "os:secure_boot": "required" },
    owns: ["os:secure_boot"],
    image: { hw_firmware_type: "uefi", hw_machine_type: "q35" },
  },
];

/** Apply a preset to a key/value map: drops keys of the same group, then sets the preset's. */
export function applyPreset(current: Record<string, string>, p: SpecPreset): Record<string, string> {
  const owned = new Set(SPEC_PRESETS.filter((x) => x.group === p.group).flatMap((x) => x.owns));
  const out = Object.fromEntries(Object.entries(current).filter(([k]) => !owned.has(k)));
  return { ...out, ...p.specs };
}

/** Presets whose specs are all present with the same values. */
export const activePresets = (specs: Record<string, string>) =>
  SPEC_PRESETS.filter((p) => Object.entries(p.specs).every(([k, v]) => (specs[k] ?? "").toLowerCase() === v.toLowerCase()) && !(p.id === "vtpm" && specs["hw:tpm_secret_security"] === "host"));

/** Combinations Nova refuses or that can't work, as messages. */
export function specConflicts(s: Record<string, string>): string[] {
  const out: string[] = [];
  const enc = (s["hw:mem_encryption"] ?? "").toLowerCase() === "true" || !!s["hw:mem_encryption_model"];
  const model = s["hw:mem_encryption_model"] ?? "";
  if (s["hw:mem_encryption_model"] && (s["hw:mem_encryption"] ?? "").toLowerCase() !== "true")
    out.push(tr("hw:mem_encryption_model needs hw:mem_encryption=True."));
  if (enc && model.startsWith("amd") && (s["resources:VGPU"] || s["accel:device_profile"] || s["pci_passthrough:alias"]))
    out.push(tr("AMD SEV guests can't use vGPUs or PCI passthrough."));
  if (s["hw:tpm_model"] === "tpm-crb" && s["hw:tpm_version"] === "1.2") out.push(tr("tpm-crb needs hw:tpm_version=2.0."));
  if ((s["hw:tpm_model"] || s["hw:tpm_secret_security"]) && !s["hw:tpm_version"]) out.push(tr("A vTPM needs hw:tpm_version."));
  if (s["hw:tpm_secret_security"] && !["user", "host"].includes(s["hw:tpm_secret_security"])) out.push(tr("hw:tpm_secret_security is user or host."));
  return out;
}

/** Image properties still needed by the active presets (merged). */
export function requiredImageProps(specs: Record<string, string>) {
  return Object.assign({}, ...activePresets(specs).map((p) => p.image ?? {})) as Record<string, string>;
}

export interface GuestFeatures {
  tpm?: { version: string; model?: string; from: "flavor" | "image"; migratable: boolean };
  confidential?: { model: string; label: string; from: "flavor" | "image" };
  vgpu?: string;
}

const MODEL_LABEL: Record<string, string> = { "amd-sev": "AMD SEV", "amd-sev-es": "AMD SEV-ES", "amd-sev-snp": "AMD SEV-SNP", "intel-tdx": "Intel TDX" };

/** Security / accelerator features a flavor + image combination asks Nova for. */
export function guestFeatures(flavorSpecs: Record<string, string> = {}, imageProps: Record<string, unknown> = {}): GuestFeatures {
  const ip = (k: string) => (imageProps[k] == null ? undefined : String(imageProps[k]));
  const out: GuestFeatures = {};
  const tv = flavorSpecs["hw:tpm_version"] ?? ip("hw_tpm_version");
  if (tv)
    out.tpm = {
      version: tv,
      model: flavorSpecs["hw:tpm_model"] ?? ip("hw_tpm_model"),
      from: flavorSpecs["hw:tpm_version"] ? "flavor" : "image",
      migratable: flavorSpecs["hw:tpm_secret_security"] === "host",
    };
  const encOn = (flavorSpecs["hw:mem_encryption"] ?? ip("hw_mem_encryption") ?? "").toLowerCase() === "true";
  const model = flavorSpecs["hw:mem_encryption_model"] ?? ip("hw_mem_encryption_model") ?? (encOn ? "amd-sev" : "");
  if (encOn || model) out.confidential = { model, label: MODEL_LABEL[model] ?? model, from: flavorSpecs["hw:mem_encryption"] || flavorSpecs["hw:mem_encryption_model"] ? "flavor" : "image" };
  if (flavorSpecs["resources:VGPU"]) out.vgpu = tr("{n} vGPU", { n: flavorSpecs["resources:VGPU"] });
  else if (flavorSpecs["accel:device_profile"]) out.vgpu = tr("Cyborg {profile}", { profile: flavorSpecs["accel:device_profile"] });
  return out;
}

/** Why this flavor + image can't boot together (Nova would refuse), or null. */
export function featureProblem(flavorSpecs: Record<string, string> = {}, imageProps: Record<string, unknown> = {}): string | null {
  const ip = (k: string) => (imageProps[k] == null ? undefined : String(imageProps[k]));
  const fv = flavorSpecs["hw:tpm_version"];
  const iv = ip("hw_tpm_version");
  if (fv && iv && fv !== iv) return tr("vTPM version differs: flavor {f}, image {i}", { f: fv, i: iv });
  const fm = flavorSpecs["hw:tpm_model"];
  const im = ip("hw_tpm_model");
  if (fm && im && fm !== im) return tr("vTPM model differs: flavor {f}, image {i}", { f: fm, i: im });
  const g = guestFeatures(flavorSpecs, imageProps);
  if (g.confidential && ip("hw_firmware_type") && ip("hw_firmware_type") !== "uefi") return tr("{model} needs a UEFI image (hw_firmware_type=uefi)", { model: g.confidential.label });
  return null;
}
