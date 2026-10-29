//! Compile-time extension registry. To add an extension:
//! 1. create `extensions/<name>` implementing `rassvet_ext_api::Extension`,
//! 2. add it to the workspace + a `ext-<name>` feature in crates/server/Cargo.toml,
//! 3. register it below.

use std::sync::Arc;

use rassvet_ext_api::Extension;

#[allow(clippy::vec_init_then_push)]
pub fn registered() -> Vec<Arc<dyn Extension>> {
    #[allow(unused_mut)]
    let mut v: Vec<Arc<dyn Extension>> = Vec::new();
    #[cfg(feature = "ext-octavia")]
    v.push(Arc::new(rassvet_ext_octavia::Octavia));
    #[cfg(feature = "ext-magnum")]
    v.push(Arc::new(rassvet_ext_magnum::Magnum));
    v
}
