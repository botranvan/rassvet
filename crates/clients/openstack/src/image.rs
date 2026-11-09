//! Glance (image service) v2 client.

use std::collections::BTreeMap;

use reqwest::{Method, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    Error, Result,
    identity::seg,
    rest::{Rest, TRANSFER_TIMEOUT},
};

/// Attributes Glance manages itself; they can't be set or removed by users.
pub const READ_ONLY: &[&str] = &[
    "id",
    "status",
    "size",
    "virtual_size",
    "checksum",
    "os_hash_algo",
    "os_hash_value",
    "owner",
    "created_at",
    "updated_at",
    "file",
    "schema",
    "self",
    "direct_url",
    "locations",
    "stores",
    "member_status",
];

/// Core attributes with their own schema type; edited through [`ImageUpdate::core`].
pub const CORE: &[&str] = &[
    "name",
    "visibility",
    "protected",
    "min_disk",
    "min_ram",
    "os_hidden",
    "tags",
    "disk_format",
    "container_format",
];

/// Turn any image endpoint form (`https://glance:9292`, `.../v2`, `.../v2/`) into `.../v2`.
pub fn v2_url(endpoint: &str) -> String {
    let e = endpoint.trim_end_matches('/');
    let e = e.strip_suffix("/v2").unwrap_or(e);
    format!("{e}/v2")
}

/// Requested change to an image, turned into a JSON-Patch by [`build_patch`].
#[derive(Debug, Default, Deserialize)]
pub struct ImageUpdate {
    /// Core attributes (see [`CORE`]) with their JSON values.
    #[serde(default)]
    pub core: Map<String, Value>,
    /// Custom properties to add or change (Glance stores them as strings).
    #[serde(default)]
    pub set: BTreeMap<String, String>,
    /// Custom properties to remove.
    #[serde(default)]
    pub unset: Vec<String>,
}

/// Build the `application/openstack-images-v2.1-json-patch` document that moves
/// `current` to the requested state. Unchanged values produce no operation.
pub fn build_patch(current: &Value, upd: &ImageUpdate) -> Result<Vec<Value>> {
    let mut ops = Vec::new();
    for (k, v) in &upd.core {
        if !CORE.contains(&k.as_str()) {
            return Err(Error::InvalidInput(format!(
                "'{k}' is not an editable image attribute"
            )));
        }
        if current.get(k) != Some(v) {
            ops.push(json!({"op": "replace", "path": format!("/{k}"), "value": v}));
        }
    }
    for (k, v) in &upd.set {
        check_property(k)?;
        match current.get(k) {
            Some(Value::String(old)) if old == v => {}
            Some(_) => ops.push(json!({"op": "replace", "path": format!("/{k}"), "value": v})),
            None => ops.push(json!({"op": "add", "path": format!("/{k}"), "value": v})),
        }
    }
    for k in &upd.unset {
        check_property(k)?;
        if current.get(k).is_some() && !upd.set.contains_key(k) {
            ops.push(json!({"op": "remove", "path": format!("/{k}")}));
        }
    }
    Ok(ops)
}

/// Custom property names: not read-only, not core, and safe inside a JSON-Pointer.
pub fn check_property(k: &str) -> Result<()> {
    if k.is_empty() || k.len() > 255 || k.contains(['/', '~']) || k.chars().any(char::is_whitespace)
    {
        return Err(Error::InvalidInput(format!("invalid property name '{k}'")));
    }
    if READ_ONLY.contains(&k) || CORE.contains(&k) {
        return Err(Error::InvalidInput(format!(
            "'{k}' can't be set as a custom property"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Glance(pub Rest);

impl Glance {
    pub fn new(http: reqwest::Client, endpoint: &str, token: &str) -> Self {
        Self(Rest::new(http, v2_url(endpoint), token, "image"))
    }

    /// List images following Glance's `next` links, up to `cap` images.
    /// Returns the images and whether the list was cut at `cap`.
    pub async fn list_all(&self, query: &[(&str, &str)], cap: usize) -> Result<(Vec<Value>, bool)> {
        let mut out = Vec::new();
        let root = self.0.base().trim_end_matches("/v2").to_owned();
        let mut page = self
            .0
            .get("/images", &[query, &[("limit", "200")]].concat())
            .await?;
        loop {
            if let Some(list) = page.get_mut("images").and_then(Value::as_array_mut) {
                out.append(list);
            }
            if out.len() >= cap {
                out.truncate(cap);
                return Ok((out, true));
            }
            match page.get("next").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => {
                    let url = crate::join_next(&root, next).ok_or_else(|| {
                        crate::Error::InvalidResponse(format!("unexpected next link {next:?}"))
                    })?;
                    page = self.0.get(&url, &[]).await?;
                }
                _ => return Ok((out, false)),
            }
        }
    }

    pub async fn get(&self, id: &str) -> Result<Value> {
        self.0.get(&format!("/images/{}", seg(id)?), &[]).await
    }

    pub async fn create(&self, body: &Value) -> Result<Value> {
        self.0.post("/images", body).await
    }

    pub async fn patch(&self, id: &str, ops: &[Value]) -> Result<Value> {
        let rb = self
            .0
            .request(Method::PATCH, &format!("/images/{}", seg(id)?))
            .header(
                "Content-Type",
                "application/openstack-images-v2.1-json-patch",
            )
            .body(serde_json::to_vec(ops).unwrap_or_default());
        self.0.json(rb).await
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.0.delete(&format!("/images/{}", seg(id)?)).await
    }

    /// `deactivate` or `reactivate`.
    pub async fn action(&self, id: &str, action: &str) -> Result<()> {
        let path = format!("/images/{}/actions/{action}", seg(id)?);
        self.0
            .json(self.0.request(Method::POST, &path))
            .await
            .map(|_| ())
    }

    /// Upload image data. With `glance_direct` the data is staged and then imported
    /// (interoperable import, runs conversion plugins); otherwise it is uploaded
    /// directly with `PUT /file`.
    pub async fn upload(
        &self,
        id: &str,
        body: reqwest::Body,
        glance_direct: bool,
        stores: &[String],
    ) -> Result<()> {
        let id = seg(id)?;
        if glance_direct {
            let rb = self
                .0
                .request(Method::PUT, &format!("/images/{id}/stage"))
                .header("Content-Type", "application/octet-stream")
                .timeout(TRANSFER_TIMEOUT)
                .body(body);
            self.0.send(rb).await?;
            self.import(id, json!({"name": "glance-direct"}), stores)
                .await
        } else {
            let mut rb = self
                .0
                .request(Method::PUT, &format!("/images/{id}/file"))
                .header("Content-Type", "application/octet-stream")
                .timeout(TRANSFER_TIMEOUT)
                .body(body);
            if let Some(store) = stores.first() {
                rb = rb.header("X-Image-Meta-Store", store);
            }
            self.0.send(rb).await.map(|_| ())
        }
    }

    /// Start an import (`glance-direct`, `web-download`, ...). Runs asynchronously in Glance.
    pub async fn import(&self, id: &str, method: Value, stores: &[String]) -> Result<()> {
        let mut body = json!({ "method": method });
        if !stores.is_empty() {
            body["stores"] = json!(stores);
        }
        self.0
            .post(&format!("/images/{}/import", seg(id)?), &body)
            .await
            .map(|_| ())
    }

    /// Streaming download of the image data.
    pub async fn download(&self, id: &str) -> Result<Response> {
        let rb = self
            .0
            .request(Method::GET, &format!("/images/{}/file", seg(id)?))
            .timeout(TRANSFER_TIMEOUT);
        self.0.send(rb).await
    }

    /// Enabled import methods and (multi-store) backends. Missing info APIs → empty.
    pub async fn info(&self) -> Result<(Vec<String>, Vec<Value>)> {
        let methods = match self.0.get("/info/import", &[]).await {
            Ok(v) => v["import-methods"]["value"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            Err(e) if is_absent(&e) => Vec::new(),
            Err(e) => return Err(e),
        };
        let stores = match self.0.get("/info/stores", &[]).await {
            Ok(v) => v["stores"].as_array().cloned().unwrap_or_default(),
            Err(e) if is_absent(&e) => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok((methods, stores))
    }

    /// Names of the metadata definition namespaces associated with `resource_type`.
    pub async fn metadef_namespaces(&self, resource_type: &str) -> Result<Vec<String>> {
        let root = self.0.base().trim_end_matches("/v2").to_owned();
        let mut names = Vec::new();
        let mut page = self
            .0
            .get(
                "/metadefs/namespaces",
                &[("resource_types", resource_type), ("limit", "100")],
            )
            .await?;
        loop {
            for ns in page["namespaces"].as_array().into_iter().flatten() {
                if let Some(n) = ns["namespace"].as_str() {
                    names.push(n.to_owned());
                }
            }
            match page["next"].as_str() {
                Some(next) if !next.is_empty() && names.len() < 1000 => {
                    let Some(url) = crate::join_next(&root, next) else {
                        return Ok(names);
                    };
                    page = self.0.get(&url, &[]).await?;
                }
                _ => return Ok(names),
            }
        }
    }

    /// One namespace with its properties and objects, names prefixed for `resource_type`.
    pub async fn metadef_namespace(&self, ns: &str, resource_type: &str) -> Result<Value> {
        let doc = self
            .0
            .get(
                &format!("/metadefs/namespaces/{}", check_namespace(ns)?),
                &[("resource_type", resource_type)],
            )
            .await?;
        // Glance already applied the prefix because of `resource_type`.
        Ok(normalize_namespace(&doc, resource_type, false))
    }

    pub fn members_path(id: &str) -> Result<String> {
        Ok(format!("/images/{}/members", seg(id)?))
    }
}

/// Resource type of Glance images in the metadata definitions catalog.
pub const IMAGE_RESOURCE_TYPE: &str = "OS::Glance::Image";

/// Namespace names look like `OS::Compute::Libvirt`; reject anything else before using
/// one in a URL path.
pub fn check_namespace(ns: &str) -> Result<&str> {
    let ok = !ns.is_empty()
        && ns.len() <= 80
        && ns
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'));
    if ok {
        Ok(ns)
    } else {
        Err(Error::InvalidInput(format!("invalid namespace '{ns}'")))
    }
}

/// Reduce a metadefs namespace document to what the dashboard needs:
/// `{namespace, display_name, description, properties, objects:[{name, description, properties}]}`.
/// With `apply_prefix`, the `resource_type` association's prefix is added to every
/// property name, as Glance does for `GET /v2/metadefs/namespaces/{ns}?resource_type=`.
pub fn normalize_namespace(ns: &Value, resource_type: &str, apply_prefix: bool) -> Value {
    let assoc = ns["resource_type_associations"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == resource_type);
    let prefix = if apply_prefix {
        assoc.and_then(|r| r["prefix"].as_str()).unwrap_or("")
    } else {
        ""
    };
    // Where the properties go for this resource type (e.g. Nova servers: "metadata"
    // or "scheduler_hints"); absent for images.
    let target = assoc
        .and_then(|r| r["properties_target"].as_str())
        .map(str::to_owned);
    let props = |v: &Value| -> Value {
        let mut out = Map::new();
        if let Some(m) = v.as_object() {
            for (k, p) in m {
                out.insert(format!("{prefix}{k}"), p.clone());
            }
        }
        Value::Object(out)
    };
    let objects: Vec<Value> = ns["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| {
            json!({
                "name": o["name"],
                "description": o["description"],
                "properties": props(&o["properties"]),
            })
        })
        .collect();
    json!({
        "namespace": ns["namespace"],
        "display_name": ns["display_name"],
        "description": ns["description"],
        "properties": props(&ns["properties"]),
        "objects": objects,
        "properties_target": target,
    })
}

/// Info APIs answer 404/410 when the feature (e.g. multi-store) isn't configured.
fn is_absent(e: &Error) -> bool {
    matches!(e.status().map(|s| s.as_u16()), Some(400 | 404 | 410))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn patch_ops() {
        let current = json!({"id": "x", "name": "old", "min_disk": 0, "os_distro": "ubuntu", "hw_qemu_guest_agent": "yes", "tags": []});
        let mut upd = ImageUpdate::default();
        upd.core.insert("name".into(), json!("new"));
        upd.core.insert("min_disk".into(), json!(0));
        upd.set.insert("os_distro".into(), "debian".into());
        upd.set.insert("os_version".into(), "13".into());
        upd.set.insert("hw_qemu_guest_agent".into(), "yes".into());
        upd.unset = vec!["missing".into()];
        let ops = build_patch(&current, &upd).unwrap();
        assert_eq!(
            ops,
            vec![
                json!({"op": "replace", "path": "/name", "value": "new"}),
                json!({"op": "replace", "path": "/os_distro", "value": "debian"}),
                json!({"op": "add", "path": "/os_version", "value": "13"}),
            ]
        );
        let mut bad = ImageUpdate::default();
        bad.set.insert("status".into(), "active".into());
        assert!(build_patch(&current, &bad).is_err());
        let mut bad = ImageUpdate::default();
        bad.unset.push("a/b".into());
        assert!(build_patch(&current, &bad).is_err());
        let mut bad = ImageUpdate::default();
        bad.core.insert("owner".into(), json!("p"));
        assert!(build_patch(&current, &bad).is_err());
    }

    #[test]
    fn metadef_prefix() {
        let ns = json!({
            "namespace": "OS::Compute::Libvirt",
            "display_name": "libvirt Driver Options",
            "resource_type_associations": [
                {"name": "OS::Glance::Image", "prefix": "hw_"},
                {"name": "OS::Nova::Flavor", "prefix": "hw:"}
            ],
            "properties": {"boot_menu": {"title": "Boot Menu", "type": "string", "enum": ["true", "false"]}},
            "objects": [{"name": "o", "properties": {"x": {"type": "integer"}}}]
        });
        let n = normalize_namespace(&ns, IMAGE_RESOURCE_TYPE, true);
        assert_eq!(n["properties"]["hw_boot_menu"]["title"], "Boot Menu");
        assert!(n["objects"][0]["properties"]["hw_x"].is_object());
        let raw = normalize_namespace(&ns, IMAGE_RESOURCE_TYPE, false);
        assert!(raw["properties"]["boot_menu"].is_object());
        assert!(check_namespace("OS::Compute::Libvirt").is_ok());
        assert!(check_namespace("../x").is_err());
    }

    #[test]
    fn urls() {
        assert_eq!(v2_url("https://g:9292"), "https://g:9292/v2");
        assert_eq!(v2_url("https://x/image/v2/"), "https://x/image/v2");
    }

    #[tokio::test]
    async fn follows_next_links() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/image/v2/images"))
            .and(query_param("marker", "b"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"images": [{"id": "c"}]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/image/v2/images"))
            .and(query_param("visibility", "public"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "images": [{"id": "a"}, {"id": "b"}],
                "next": "/v2/images?marker=b&limit=200&visibility=public"
            })))
            .mount(&server)
            .await;
        let g = Glance::new(
            reqwest::Client::new(),
            &format!("{}/image", server.uri()),
            "t",
        );
        let (all, cut) = g.list_all(&[("visibility", "public")], 10).await.unwrap();
        assert_eq!(all.len(), 3);
        assert!(!cut);
        let (two, cut) = g.list_all(&[("visibility", "public")], 2).await.unwrap();
        assert_eq!(two.len(), 2);
        assert!(cut);
    }
}
