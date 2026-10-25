# Bundled Glance metadata definitions

These files are copied unmodified from the OpenStack Glance repository,
`etc/metadefs/` (https://github.com/openstack/glance/tree/master/etc/metadefs),
commit `76306ffdb15a76456bc6106a659250e1ae69f4e1` (2026-10-11),
licensed under the Apache License 2.0 by the OpenStack contributors.

Only the namespaces associated with the `OS::Glance::Image` resource type are kept, plus
`glance-common-image-props.json` (`OS::Glance::CommonImageProperties`: architecture,
os_distro, kernel_id, ...), which describes image properties without a resource type.

Rassvet reads the metadata definitions catalog from the cloud's Glance first
(`GET /v2/metadefs/namespaces?resource_types=OS::Glance::Image`). These files are
used only when the cloud has no definitions loaded (operators load them with
`glance-manage db_load_metadefs`) or the catalog API is unavailable.

To refresh: copy the newer JSON files from the Glance repository over these,
keeping only those with an `OS::Glance::Image` resource type association
and `glance-common-image-props.json`.
