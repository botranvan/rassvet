# Kubernetes service (Magnum)

## Use case

You offer Kubernetes clusters to your projects with OpenStack Magnum and its Cluster API driver
(`magnum-capi-helm`). You want to publish the cluster templates people should use, limit how many clusters
each project may run, and check that the Magnum services are healthy. The admin view has **Container → All
Kubernetes clusters**, **Container → Cluster templates** and **Container → Kubernetes service** when the cloud has
Magnum.

## What the cloud needs

- Magnum with the `magnum-capi-helm` driver and a management cluster running Cluster API (Rassvet doesn't
  support the Heat driver).
- Octavia: every cluster's API sits behind a load balancer.
- Node images uploaded with the properties `os_distro=ubuntu` (or `flatcar`) and `kube_version=v1.x.y`, e.g.
  the images built by the azimuth-images project.
- Flavors with at least 2 GB RAM and 2 vCPUs (the defaults of `[capi_helm] minimum_flavor_ram` and
  `minimum_flavor_vcpus` in `magnum.conf`).

## Publish cluster templates

1. Switch to the admin view and go to **Container → Cluster templates**. The list shows the templates of every
   project, with a **Project** column and the Kubernetes version of each template's image. Templates of other
   drivers are marked **Not Cluster API**.
2. Create a template (see [Kubernetes clusters](../project/15-kubernetes-clusters.md)) and, under
   **1. Basics**, turn on **Public** so every project can create clusters from it.
3. When a newer Kubernetes version is out, upload its image, clone the template, pick the new image, publish
   the new template and turn on **Hidden** on the old one: existing clusters keep it, new clusters can't
   choose it, and owners move with **Upgrade** (one minor version at a time).

Magnum only lets admins change a template that clusters use, and only some attributes; prefer new templates.
Pin the Helm chart version with the label `capi_helm_chart_version` if you don't want templates to follow
the driver's default.

## Clusters of every project

**Container → All Kubernetes clusters** lists every project's clusters with their status, health and API address.
Open one to see its node groups, labels and OpenStack resources, or to resize, upgrade or delete it on the
owner's behalf.

**Renew cloud credentials** replaces the cluster's application credential with one made by your account. Use it
(Magnum API 1.12 or later) when the cluster's creator leaves: their credential stops working when their account is disabled, and the
cluster can no longer manage its load balancers, volumes or autoscaling.

## Quotas, usage and services

Go to **Container → Kubernetes service**:

- **Quotas** — the number of clusters each project may have. **Set quota** picks a project and a limit;
  **Change limit** edits one; **Reset to default** removes the project's own quota so Magnum's default
  (`[quotas] max_clusters_per_project` in `magnum.conf`) applies again.
- **Usage** — clusters and nodes in the region (Magnum's statistics) and per project, with failed clusters
  highlighted.
- **Services** — the `magnum-conductor` services: host, state (up or down), enabled or disabled and the last
  report. A service that is down stops clusters from being created, changed or deleted.

## Good practice

- Keep one public template per supported Kubernetes version and hide old ones instead of deleting them.
- Set a small default cluster quota and raise it per project on request.
- Encourage `keystone_auth_enabled=true` in public templates: certificate kubeconfigs can't be revoked with
  the Cluster API driver.
- Check [Cleanup across projects](08-cleanup-all-projects.md) for failed clusters: they keep servers,
  volumes and load balancers.
