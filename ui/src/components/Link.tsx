/**
 * Router links that keep the admin view: inside /admin, a link to a project page that also
 * exists for admins (a network, router, volume… detail, or those lists) goes to the admin
 * copy instead, so following a link from an admin screen never drops into the project view
 * (where the resource of another project wouldn't be found).
 */
import { type ComponentProps, forwardRef } from "react";
import { type NavigateOptions, type To, Link as RouterLink, useLocation, useNavigate as useRouterNavigate } from "react-router";

/** Project paths with an admin twin under /admin (lists and `:id` detail pages). */
const ADMIN_TWINS = [
  /^\/compute\/instances(\/(?!launch\b)[^/?#]+)?([?#].*)?$/,
  /^\/compute\/images(\/[^/?#]+)?([?#].*)?$/,
  /^\/network\/(networks|routers|qos|subnet-pools)(\/[^/?#]+)?([?#].*)?$/,
  /^\/network\/(security-groups|trunks)\/[^/?#]+([?#].*)?$/,
  /^\/network\/(rbac|floating-ips|ports|security-groups)([?#].*)?$/,
  /^\/compute\/(server-groups|instance-snapshots)([?#].*)?$/,
  /^\/storage\/volumes(\/[^/?#]+)?([?#].*)?$/,
  /^\/storage\/backups([?#].*)?$/,
  /^\/storage\/(groups|group-snapshots)(\/[^/?#]+)?([?#].*)?$/,
  // Extension pages are mounted under /admin/ext/<id>/… too (see extensions.tsx).
  /^\/ext\/[^/?#]+\/.+/,
];

export const inAdmin = (pathname: string) => pathname.startsWith("/admin");

/** The admin twin of `to` when we're in the admin view, else `to` unchanged. */
export function adminTwin(to: string, pathname: string) {
  return inAdmin(pathname) && ADMIN_TWINS.some((re) => re.test(to)) ? `/admin${to}` : to;
}

function mapTo(to: To, pathname: string): To {
  if (typeof to === "string") return adminTwin(to, pathname);
  return to.pathname ? { ...to, pathname: adminTwin(to.pathname, pathname) } : to;
}

/** True on admin screens; detail pages use it to look across projects. */
export const useInAdmin = () => inAdmin(useLocation().pathname);

export const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof RouterLink>>(function Link({ to, ...rest }, ref) {
  const { pathname } = useLocation();
  return <RouterLink ref={ref} to={mapTo(to, pathname)} {...rest} />;
});

export function useNavigate() {
  const navigate = useRouterNavigate();
  const { pathname } = useLocation();
  return (to: To | number, opts?: NavigateOptions) => (typeof to === "number" ? navigate(to) : navigate(mapTo(to, pathname), opts));
}
