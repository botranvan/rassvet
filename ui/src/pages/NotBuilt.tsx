import { useLocation } from "react-router";
import { Icon, PageHeader } from "@/components/ui";
import { useNav } from "@/lib/session";
import { tr } from "@/lib/i18n";

/** Placeholder for nav entries whose page arrives in a later patch. */
export default function NotBuilt() {
  const { pathname } = useLocation();
  const item = useNav(true).data?.items.find((i) => pathname.startsWith(i.path));
  return (
    <>
      <PageHeader title={item?.label ?? tr("Not found")} />
      <div className="grid place-items-center rounded-lg border border-dashed border-line bg-panel px-6 py-20 text-center">
        <Icon name={item?.icon ?? "circle-dashed"} className="size-8 text-muted" />
        <p className="mt-4 font-medium">
          {item ? tr("{label} isn't built yet.", { label: item.label }) : tr("This page doesn't exist.")}
        </p>
        <p className="mt-1 text-sm text-muted">
          {item ? tr("It's on the roadmap and will arrive in an upcoming patch.") : tr("Check the address or pick a page from the sidebar.")}
        </p>
      </div>
    </>
  );
}
