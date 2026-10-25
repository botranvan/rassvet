import { useMemo, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Button, Checkbox, ErrorNotice, Icon, StatusDot } from "@/components/ui";
import { useDomains, useProjects, useRoles, useSetProjectRoles, useUsers } from "@/lib/identity";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";

export function useDomainName() {
  const domains = useDomains();
  return useMemo(() => {
    const m = new Map(domains.data?.map((d) => [d.id, d.name]));
    return (id: string | null | undefined) => (id ? (m.get(id) ?? id) : "");
  }, [domains.data]);
}

export function Enabled({ enabled }: { enabled: boolean }) {
  return <StatusDot status={enabled ? "ok" : "off"} label={enabled ? tr("Enabled") : tr("Disabled")} />;
}

/** Searchable single-choice list (users or projects can number in the thousands). */
function SearchPick({
  items,
  value,
  onChange,
  placeholder,
}: {
  items: { id: string; label: string; sub?: string }[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const shown = items
    .filter((i) => `${i.label} ${i.sub ?? ""} ${i.id}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 200);
  return (
    <div className="rounded-md border border-line">
      <div className="relative border-b border-line">
        <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="h-9 w-full rounded-t-md bg-transparent pr-3 pl-9 text-sm focus:outline-none"
        />
      </div>
      <ul role="listbox" className="max-h-52 overflow-y-auto p-1">
        {shown.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              role="option"
              aria-selected={value === i.id}
              onClick={() => onChange(i.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-surface",
                value === i.id && "bg-cable-soft text-cable",
              )}
            >
              <span className="truncate font-medium">{i.label}</span>
              {i.sub && <span className="truncate text-xs text-muted">{i.sub}</span>}
              {value === i.id && <Icon name="check" className="ml-auto size-3.5" />}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2.5 py-3 text-sm text-muted">{trx("Nothing matches “{q}”.", { q })}</li>}
      </ul>
    </div>
  );
}

/**
 * Grant roles to a user on a project. Either side can be fixed (project detail page fixes
 * the project, user detail page fixes the user); the other is picked in the dialog.
 * With `current`, the dialog edits an existing membership and revokes unticked roles.
 */
export function AssignRolesDialog({
  open,
  onClose,
  projectId,
  userId,
  current,
  title,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  userId?: string;
  current?: string[];
  title: string;
}) {
  const roles = useRoles();
  const users = useUsers();
  const projects = useProjects();
  const domainName = useDomainName();
  const set = useSetProjectRoles();
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);

  const editing = !!current;
  const chosen = selected ?? current ?? (roles.data?.find((r) => r.name === "member") ? [roles.data.find((r) => r.name === "member")!.id] : []);
  const target = { projectId: projectId ?? picked, userId: userId ?? picked };
  const grant = chosen.filter((r) => !(current ?? []).includes(r));
  const revoke = (current ?? []).filter((r) => !chosen.includes(r));

  function close() {
    set.reset();
    setPicked(null);
    setSelected(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      onSubmit={() => {
        if (!target.projectId || !target.userId) return;
        set.mutate(
          { projectId: target.projectId, userId: target.userId, grant, revoke },
          {
            onSuccess: () => {
              toast(editing ? tr("Roles updated") : tr("Roles assigned"));
              close();
            },
          },
        );
      }}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={set.isPending}
            disabled={!target.projectId || !target.userId || (grant.length === 0 && revoke.length === 0)}
          >
            {editing ? tr("Save roles") : tr("Assign roles")}
          </Button>
        </>
      }
    >
      {!userId && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{tr("User")}</p>
          <ErrorNotice error={users.error} />
          <SearchPick
            placeholder={tr("Find a user by name or ID")}
            value={picked}
            onChange={setPicked}
            items={(users.data ?? []).map((u) => ({ id: u.id, label: u.name, sub: domainName(u.domain_id) }))}
          />
        </div>
      )}
      {!projectId && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{tr("Project")}</p>
          <ErrorNotice error={projects.error} />
          <SearchPick
            placeholder={tr("Find a project by name or ID")}
            value={picked}
            onChange={setPicked}
            items={(projects.data ?? [])
              .filter((p) => !p.is_domain)
              .map((p) => ({ id: p.id, label: p.name, sub: domainName(p.domain_id) }))}
          />
        </div>
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{tr("Roles")}</legend>
        <ErrorNotice error={roles.error} />
        <div className="grid gap-2 sm:grid-cols-2 [&_label]:break-all">
          {roles.data?.map((r) => (
            <Checkbox
              key={r.id}
              checked={chosen.includes(r.id)}
              onChange={(on) => setSelected(on ? [...chosen, r.id] : chosen.filter((x) => x !== r.id))}
            >
              {r.name}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      {editing && chosen.length === 0 && (
        <p className="text-sm text-muted">{tr("With no roles left, the user is removed from the project.")}</p>
      )}
      <ErrorNotice error={set.error} />
    </Dialog>
  );
}
