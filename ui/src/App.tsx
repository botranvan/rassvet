import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useParams } from "react-router";
import { ErrorNotice } from "@/components/ui";
import { loadExtensionRoutes, useExtensionRouteElements } from "@/extensions";
import AppShell from "@/layout/AppShell";
import { useNav, useSession } from "@/lib/session";
import ChangePassword from "@/pages/account/ChangePassword";
import AdminOverview from "@/pages/admin/AdminOverview";
import Endpoints from "@/pages/admin/identity/Endpoints";
import ProjectDetail from "@/pages/admin/identity/ProjectDetail";
import Projects from "@/pages/admin/identity/Projects";
import Roles from "@/pages/admin/identity/Roles";
import UserDetail from "@/pages/admin/identity/UserDetail";
import Users from "@/pages/admin/identity/Users";
import ApiAccess from "@/pages/identity/ApiAccess";
import AppCredentials from "@/pages/identity/AppCredentials";
import ImageDetail from "@/pages/images/ImageDetail";
import ImageList from "@/pages/images/ImageList";
import Login from "@/pages/Login";
import { VolumeTypes } from "@/pages/admin/AdminStorageNetwork";
import { IpAvailabilityPage, NetworkAgents } from "@/pages/admin/network/NetworkAdmin";
import NdpProxies from "@/pages/admin/network/NdpProxies";
import { Hypervisors } from "@/pages/admin/compute/Capacity";
import Flavors from "@/pages/admin/compute/Flavors";
import FlavorDetail from "@/pages/admin/compute/FlavorDetail";
import { Aggregates, ComputeServices } from "@/pages/admin/compute/ComputeAdmin";
import { HostDetail } from "@/pages/admin/compute/Maintenance";
import Cleanup from "@/pages/operations/Cleanup";
import Terraform from "@/pages/operations/Terraform";
import Ec2Credentials from "@/pages/identity/Ec2Credentials";
import { Domains, Regions } from "@/pages/admin/identity/DomainsRegions";
import Federation from "@/pages/admin/identity/Federation";
import Quotas from "@/pages/admin/Quotas";
import Usage from "@/pages/compute/Usage";
import InstanceDetail from "@/pages/compute/InstanceDetail";
import Instances from "@/pages/compute/Instances";
import KeyPairs from "@/pages/compute/KeyPairs";
import Launch from "@/pages/compute/Launch";
import FloatingIps from "@/pages/network/FloatingIps";
import QosPolicies, { QosPolicyDetail } from "@/pages/network/QosPolicies";
import SubnetPools, { SubnetPoolDetail } from "@/pages/network/SubnetPools";
import Secrets, { SecretDetail } from "@/pages/keymanager/Secrets";
import SecretContainers, { SecretContainerDetail } from "@/pages/keymanager/Containers";
import Orders from "@/pages/keymanager/Orders";
import KeyManagerQuotas from "@/pages/admin/keymanager/Quotas";
import ObjectContainers from "@/pages/objectstore/Containers";
import ObjectBrowser from "@/pages/objectstore/Browser";
import ObjectStorageAdmin from "@/pages/admin/objectstore/ObjectStorage";
import Rbac from "@/pages/network/Rbac";
import Topology from "@/pages/network/Topology";
import Trunks, { TrunkDetail } from "@/pages/network/Trunks";
import Networks, { NetworkDetail } from "@/pages/network/Networks";
import Routers, { RouterDetail } from "@/pages/network/Routers";
import SecurityGroups, { SecurityGroupDetail } from "@/pages/network/SecurityGroups";
import Backends from "@/pages/admin/storage/Backends";
import GroupTypes from "@/pages/admin/storage/GroupTypes";
import QosSpecs from "@/pages/admin/storage/QosSpecs";
import VolumeTypeDetail from "@/pages/admin/storage/VolumeTypeDetail";
import Backups from "@/pages/storage/Backups";
import Snapshots from "@/pages/storage/Snapshots";
import Transfers from "@/pages/storage/Transfers";
import VolumeGroups, { GroupSnapshotDetail, GroupSnapshots, VolumeGroupDetail } from "@/pages/storage/VolumeGroups";
import VolumeDetail from "@/pages/storage/VolumeDetail";
import Volumes from "@/pages/storage/Volumes";
import ServerGroups from "@/pages/compute/ServerGroups";
import FlavorList from "@/pages/compute/FlavorList";
import Ports from "@/pages/network/Ports";
import Profile from "@/pages/account/Profile";
import Groups, { GroupDetail } from "@/pages/admin/identity/Groups";
import AvailabilityZones from "@/pages/admin/compute/AvailabilityZones";
import Metadefs, { MetadefDetail } from "@/pages/admin/compute/Metadefs";
import NotBuilt from "@/pages/NotBuilt";
import Overview from "@/pages/Overview";

export default function App() {
  const session = useSession();

  if (session.isPending) return <Splash />;
  if (session.error)
    return (
      <div className="mx-auto max-w-md p-10">
        <ErrorNotice error={session.error} />
      </div>
    );
  if (!session.data) return <Login />;
  return <Authed session={session.data} />;
}

function Authed({ session }: { session: NonNullable<ReturnType<typeof useSession>["data"]> }) {
  const nav = useNav(true);
  const extIds = nav.data?.extensions.map((e) => e.id) ?? [];
  const exts = useQuery({
    queryKey: ["extension-routes", extIds],
    queryFn: () => loadExtensionRoutes(extIds),
    enabled: nav.isSuccess,
    staleTime: Infinity,
  });
  const extRoutes = useExtensionRouteElements(exts.data ?? [], session.is_admin);

  return (
    <Routes>
      <Route element={<AppShell session={session} />}>
        <Route index element={<Overview session={session} />} />
        <Route path="compute/instances" element={<Instances />} />
        <Route path="compute/instances/launch" element={<Launch />} />
        <Route path="compute/instances/:id" element={<InstanceDetail />} />
        <Route path="compute/keypairs" element={<KeyPairs />} />
        <Route path="compute/flavors" element={<FlavorList />} />
        <Route path="compute/instance-snapshots" element={<ImageList snapshots />} />
        <Route path="compute/server-groups" element={<ServerGroups />} />
        <Route path="compute/usage" element={<Usage />} />
        <Route path="operations/cleanup" element={<Cleanup />} />
        <Route path="operations/terraform" element={<Terraform />} />
        <Route path="identity/ec2-credentials" element={<Ec2Credentials />} />
        <Route path="storage/volumes" element={<Volumes />} />
        <Route path="storage/volumes/:id" element={<VolumeDetail />} />
        <Route path="storage/snapshots" element={<Snapshots />} />
        <Route path="storage/backups" element={<Backups />} />
        <Route path="storage/groups" element={<VolumeGroups />} />
        <Route path="storage/groups/:id" element={<VolumeGroupDetail />} />
        <Route path="storage/group-snapshots" element={<GroupSnapshots />} />
        <Route path="storage/group-snapshots/:id" element={<GroupSnapshotDetail />} />
        <Route path="storage/transfers" element={<Transfers />} />
        <Route path="network/networks" element={<Networks />} />
        <Route path="network/networks/:id" element={<NetworkDetail />} />
        <Route path="network/routers" element={<Routers />} />
        <Route path="network/routers/:id" element={<RouterDetail />} />
        <Route path="network/security-groups" element={<SecurityGroups />} />
        <Route path="network/security-groups/:id" element={<SecurityGroupDetail />} />
        <Route path="network/floating-ips" element={<FloatingIps />} />
        <Route path="network/ports" element={<Ports />} />
        <Route path="network/subnet-pools" element={<SubnetPools />} />
        <Route path="network/subnet-pools/:id" element={<SubnetPoolDetail />} />
        <Route path="key-manager/secrets" element={<Secrets />} />
        <Route path="key-manager/secrets/:id" element={<SecretDetail />} />
        <Route path="key-manager/containers" element={<SecretContainers />} />
        <Route path="key-manager/containers/:id" element={<SecretContainerDetail />} />
        <Route path="key-manager/orders" element={<Orders />} />
        <Route path="object-store/containers" element={<ObjectContainers />} />
        <Route path="object-store/containers/:container" element={<ObjectBrowser />} />
        <Route path="network/topology" element={<Topology />} />
        <Route path="network/trunks" element={<Trunks />} />
        <Route path="network/trunks/:id" element={<TrunkDetail />} />
        <Route path="network/qos" element={<QosPolicies />} />
        <Route path="network/qos/:id" element={<QosPolicyDetail />} />
        <Route path="network/rbac" element={<Rbac />} />
        <Route path="compute/images" element={<ImageList />} />
        <Route path="compute/images/:id" element={<ImageDetail />} />
        <Route path="identity/application-credentials" element={<AppCredentials />} />
        <Route path="identity/api-access" element={<ApiAccess />} />
        <Route path="account/password" element={<ChangePassword />} />
        <Route path="account/profile" element={<Profile />} />
        {session.is_admin ? (
          <Route path="admin">
            <Route index element={<AdminOverview />} />
            <Route path="identity/projects" element={<Projects />} />
            <Route path="identity/projects/:id" element={<ProjectDetail />} />
            <Route path="identity/users" element={<Users />} />
            <Route path="identity/users/:id" element={<UserDetail />} />
            <Route path="identity/roles" element={<Roles />} />
            <Route path="identity/groups" element={<Groups />} />
            <Route path="identity/groups/:id" element={<GroupDetail />} />
            <Route path="identity/endpoints" element={<Endpoints />} />
            <Route path="identity/domains" element={<Domains />} />
            <Route path="identity/regions" element={<Regions />} />
            <Route path="identity/federation" element={<Federation />} />
            <Route path="quotas" element={<Quotas />} />
            <Route path="compute/images" element={<ImageList admin />} />
            <Route path="compute/instance-snapshots" element={<ImageList admin snapshots />} />
            <Route path="compute/metadata-definitions" element={<Metadefs />} />
            <Route path="compute/metadata-definitions/:ns" element={<MetadefDetail />} />
            <Route path="compute/instances" element={<Instances admin />} />
            <Route path="compute/instances/:id" element={<InstanceDetail admin />} />
            <Route path="compute/flavors" element={<Flavors />} />
            <Route path="compute/flavors/:id" element={<FlavorDetail />} />
            <Route path="compute/services" element={<ComputeServices />} />
            {/* Host maintenance lives in Hypervisors now; old links still work. */}
            <Route path="compute/maintenance" element={<Navigate to="/admin/compute/hypervisors" replace />} />
            <Route path="compute/maintenance/:host" element={<MovedHost />} />
            <Route path="operations/cleanup" element={<Cleanup admin />} />
            <Route path="compute/aggregates" element={<Aggregates />} />
            <Route path="compute/availability-zones" element={<AvailabilityZones />} />
            <Route path="compute/server-groups" element={<ServerGroups admin />} />
            <Route path="compute/usage" element={<Usage admin />} />
            <Route path="compute/hypervisors" element={<Hypervisors />} />
            <Route path="compute/hypervisors/:host" element={<HostDetail />} />
            <Route path="storage/volumes" element={<Volumes admin />} />
            <Route path="storage/volumes/:id" element={<VolumeDetail />} />
            <Route path="storage/backups" element={<Backups admin />} />
            <Route path="storage/groups" element={<VolumeGroups admin />} />
            <Route path="storage/groups/:id" element={<VolumeGroupDetail />} />
            <Route path="storage/group-snapshots" element={<GroupSnapshots admin />} />
            <Route path="storage/group-snapshots/:id" element={<GroupSnapshotDetail />} />
            <Route path="storage/volume-types" element={<VolumeTypes />} />
            <Route path="storage/volume-types/:id" element={<VolumeTypeDetail />} />
            <Route path="storage/qos" element={<QosSpecs />} />
            <Route path="storage/group-types" element={<GroupTypes />} />
            <Route path="storage/backends" element={<Backends />} />
            <Route path="network/agents" element={<NetworkAgents />} />
            <Route path="network/networks" element={<Networks admin />} />
            <Route path="network/networks/:id" element={<NetworkDetail />} />
            <Route path="network/routers" element={<Routers admin />} />
            <Route path="network/routers/:id" element={<RouterDetail />} />
            <Route path="network/security-groups" element={<SecurityGroups admin />} />
            <Route path="network/security-groups/:id" element={<SecurityGroupDetail />} />
            <Route path="network/ports" element={<Ports admin />} />
            <Route path="network/subnet-pools" element={<SubnetPools admin />} />
            <Route path="network/subnet-pools/:id" element={<SubnetPoolDetail admin />} />
            <Route path="key-manager/quotas" element={<KeyManagerQuotas />} />
            <Route path="object-store" element={<ObjectStorageAdmin />} />
            <Route path="network/trunks/:id" element={<TrunkDetail />} />
            <Route path="network/ip-availability" element={<IpAvailabilityPage />} />
            <Route path="network/floating-ips" element={<FloatingIps admin />} />
            <Route path="network/ndp-proxies" element={<NdpProxies />} />
            <Route path="network/qos" element={<QosPolicies admin />} />
            <Route path="network/qos/:id" element={<QosPolicyDetail admin />} />
            <Route path="network/rbac" element={<Rbac admin />} />
            <Route path="compute/images/:id" element={<ImageDetail admin />} />
            <Route path="*" element={<NotBuilt />} />
          </Route>
        ) : (
          <Route path="admin/*" element={<Navigate to="/" replace />} />
        )}
        {extRoutes}
        <Route path="*" element={<NotBuilt />} />
      </Route>
    </Routes>
  );
}

/** /admin/compute/maintenance/<host>?… → /admin/compute/hypervisors/<host>?… */
function MovedHost() {
  const { host = "" } = useParams();
  return <Navigate to={`/admin/compute/hypervisors/${encodeURIComponent(host)}${window.location.search}`} replace />;
}

function Splash() {
  return (
    <div className="grid h-full place-items-center bg-rack">
      <img src="/favicon.svg" alt="" className="size-10 animate-pulse" />
    </div>
  );
}
