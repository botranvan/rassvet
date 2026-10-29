# Kubernetes clusters

## Use case

You need a Kubernetes cluster for your team's applications and don't want to install and patch it by hand.
OpenStack Magnum builds the cluster for you from a **cluster template**: servers for the control plane and the
workers, networking, a load balancer for the API and storage for persistent volumes. The menu entries
**Container → Kubernetes clusters** and **Container → Cluster templates** appear when your cloud has Magnum.

Rassvet supports Magnum's **Cluster API driver** (`magnum-capi-helm`, driver `k8s_capi_helm_v1`). Templates
for the old Heat driver are marked **Not Cluster API** and can't be chosen for new clusters.

## Before you start

- A **cluster template**. Your cloud admins usually publish ready-made public templates (look in
  **Container → Cluster templates**); otherwise create your own (below).
- A **key pair** if you want SSH access to the nodes (see [Key pairs](04-key-pairs.md)).
- Enough quota for the servers, volumes, floating IPs and load balancers a cluster uses, and Magnum's own
  cluster quota (shown on the clusters page). Every cluster has at least one Octavia load balancer for its API.

## Create a cluster template (optional)

1. Go to **Container → Cluster templates** and click **Create template**.
2. **1. Basics** — **Name**, the node **Image** and an optional **Key pair**. Only Cluster API images can be
   chosen: they have the properties `os_distro` (`ubuntu` or `flatcar`) and `kube_version` (e.g. `v1.30.4`).
   The image decides the cluster's **Kubernetes version**, shown next to it.
3. **2. Network** — the **External network**, an optional **Fixed network** and **Fixed subnet** (empty:
   Magnum makes a network and router per cluster), the **CNI** (calico or cilium), the **Load balancer
   provider** (amphora or ovn), a **DNS nameserver** and **Public address for the API** (a floating IP on the
   API load balancer; off: the API is only reachable from the cluster's network).
4. **3. Nodes** — **Master flavor** and **Worker flavor**. Flavors under 2 GB RAM or 2 vCPUs are greyed out:
   the driver refuses them. Root disk, etcd disk and persistent volumes are set with labels
   (`boot_volume_size`, `etcd_blockdevice_size`, `csi_cinder_*`).
5. **4. Labels** — tune the driver, for example `auto_scaling_enabled=true`, `keystone_auth_enabled=true`,
   `monitoring_enabled=true` or `api_master_lb_allowed_cidrs`. Suggestions with explanations are offered as
   you type.
6. Click **Create template**. Use **Clone template** on an existing one to start from its settings.

## Create a cluster

1. Go to **Container → Kubernetes clusters** and click **Create cluster**.
2. **1. Details** — a **Name** (starts with a letter), the **Cluster template** and the **Key pair** (defaults to
   the template's).
3. **2. Size** — **Masters** (1 for tests, 3 for a highly available control plane), **Workers**, optional
   **Master flavor** / **Worker flavor** overrides and the **Creation timeout**. The API always gets a load
   balancer.
4. **3. Labels** — labels added here are merged with the template's; the same key overrides the template's
   value.
5. Click **Create cluster**. The page opens on the new cluster; the status goes from *Create in progress* to
   *Create complete*, usually in 10 to 20 minutes.

## Connect with kubectl

1. Open the cluster and choose **Download kubeconfig** (in the actions menu, or **Kubernetes API →
   kubeconfig → Download**).
2. Rassvet makes a new key and has the cluster CA sign a client certificate for you. The certificate gives
   **full cluster-admin rights** (group `system:masters`), so keep the file safe; Rassvet keeps no copy.
   The Cluster API driver can't rotate the cluster CA, so a leaked file **can't be revoked**: only deleting
   the cluster stops it working.
3. Use it:

   ```sh
   export KUBECONFIG=$PWD/prod-k8s.kubeconfig
   kubectl get nodes
   ```

Clusters with the label `keystone_auth_enabled=true` also offer **Sign in with → OpenStack token**: the file
then holds no secret and kubectl sends `$OS_TOKEN` (`export OS_TOKEN=$(openstack token issue -f value -c id)`);
what you may do in Kubernetes comes from your Keystone roles. Prefer this for people; keep certificates for
automation you trust.

## Manage a cluster

Open the cluster to see:

- **Overview** — status and health (with the reasons Magnum reports), Kubernetes version, API address and
  whether it is public, masters and workers with their addresses, and **OpenStack resources**: the cluster's
  network and API load balancer, linked to their own pages.
- **Node groups** — the default master and worker groups plus any you add, with the number of servers each
  has. Click **▸** in front of a group to list its servers: name (linked to the instance page), status, IP
  addresses, flavor, availability zone and age. **Add node group** creates a group
  of workers with its own size and flavor (e.g. GPU nodes); it uses the template's image and the cluster's labels.
  **Change node count** resizes a worker group; Cluster API chooses the machines to remove and drains them
  first. **Autoscaler bounds** sets the minimum and maximum the cluster autoscaler keeps the group within
  (label `auto_scaling_enabled=true`); the minimum can't be above the current node count, and a minimum of 0
  needs version 0.26 or later of the cluster's Helm chart.
- **Labels** — the effective labels and where each comes from (template, added or overridden).

Actions on a cluster:

- **Resize workers** — change the number of workers in the default worker group.
- **Upgrade** — move the cluster to another template whose image has a newer `kube_version`. Cluster API
  replaces the nodes one by one. Rassvet refuses downgrades and skipping a minor version (1.29 → 1.31): go
  through each version.
- **Renew cloud credentials** — Magnum gives the cluster a new application credential made with your account
  and deletes the old one. Use it when the person who created the cluster leaves the project or the
  credential was exposed; the cluster then depends on your account. Needs Magnum API 1.12 or later: on older
  clouds the action is greyed out.
- **Delete cluster** — deletes the nodes and everything Magnum created for the cluster. Workloads and their
  data are lost.

## Good practice

- Use 3 masters for anything that matters.
- Keep the Kubernetes version in the template's image and upgrade one minor version at a time by switching
  templates.
- Prefer OpenStack token sign-in (`keystone_auth_enabled=true`); a certificate kubeconfig can't be revoked.
- Failed clusters still hold servers, volumes and load balancers: [Cleanup](13-cleanup.md) lists them.
