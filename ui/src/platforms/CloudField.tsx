import { useEffect, useState } from "react";
import { Picker } from "@/components/Picker";
import { Field } from "@/components/ui";
import type { CloudInfo } from "@/lib/session";
import { tr } from "@/lib/i18n";

/** The cloud picked in a sign-in form (first one by default), reported to `onChange`. */
export function useCloudChoice(list: CloudInfo[], onChange?: (c: CloudInfo | undefined) => void) {
  const [cloud, setCloud] = useState("");
  const selected = list.find((c) => c.id === cloud) ?? list[0];
  useEffect(() => {
    onChange?.(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.name]);
  return { selected, setCloud };
}

/** Cloud picker of a sign-in form; hidden when the platform has a single cloud. */
export function CloudField({
  list,
  selected,
  onChange,
  icon = "server",
}: {
  list: CloudInfo[];
  selected: CloudInfo | undefined;
  onChange: (id: string) => void;
  icon?: string;
}) {
  if (list.length <= 1) return null;
  return (
    <Field label={tr("Cloud")}>
      {(id) => (
        <Picker
          id={id}
          value={selected?.id ?? ""}
          onChange={onChange}
          options={list.map((c) => ({ value: c.id, label: c.name, icon }))}
        />
      )}
    </Field>
  );
}
