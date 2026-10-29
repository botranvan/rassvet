# Kế hoạch tích hợp Magnum (Kubernetes clusters)

Extension `magnum` cho Rassvet: quản lý cluster template, cluster, node group, chứng chỉ / kubeconfig,
quota và service của OpenStack Magnum (catalog service type `container-infra`, API v1, microversion
`OpenStack-API-Version: container-infra 1.x`).

Trạng thái: `[ ]` chưa làm · `[~]` đang làm · `[x]` xong

## Bối cảnh kiến trúc

- Extension = crate `extensions/<id>/` implement `rassvet_ext_api::Extension` + UI `extensions/<id>/ui/index.tsx`.
- Backend là gateway có allowlist ở `/api/ext/<id>/os/{*path}`, UI gọi qua SDK với service `ext:<id>`.
- Đăng ký: workspace `Cargo.toml`, feature `ext-<id>` trong `crates/server/Cargo.toml`,
  `crates/server/src/extensions.rs`, filter log trong `crates/server/src/logging.rs`.
- Mẫu tham chiếu: `extensions/octavia`.

## PR 1 — Hạ tầng dùng chung (Giai đoạn 0) ✅

- [x] Module `rassvet_ext_api::gateway`: `Rule`, `find_rule`, `valid_id`, `valid_name`, `encode`,
      `call`, `call_all` (theo `<key>_links` hoặc `next`) dùng chung cho các extension.
- [x] Negotiate + cache microversion cho extension (`gateway::microversion(ctx, service_type, target)`),
      dựa trên `os_client::microversion::discover` / `Microversion::negotiate`.
- [x] Octavia chuyển sang dùng module chung (không đổi hành vi, test cũ vẫn pass).
- [x] SDK (`@rassvet/sdk`): export hook images, flavors, key pairs cho extension.

## PR 2 — Backend `extensions/magnum` ✅

- [x] Crate `rassvet-ext-magnum`, manifest `id = "magnum"`, `service_types = ["container-infra"]`, nav
      (Project: Kubernetes clusters, Cluster templates; Admin: All clusters, Magnum settings).
- [x] Đăng ký feature `ext-magnum` (mặc định bật), workspace, registry, log filter.
- [x] Allowlist API v1:
  - `clustertemplates`, `clustertemplates/{id}` — GET/POST/PATCH/DELETE
  - `clusters`, `clusters/{id}` — GET/POST/PATCH/DELETE
  - `clusters/{id}/actions/resize`, `clusters/{id}/actions/upgrade` — POST
  - `clusters/{id}/nodegroups`, `clusters/{id}/nodegroups/{id}` — GET/POST/PATCH/DELETE
  - `certificates/{id}` — GET (CA), PATCH (rotate CA); `certificates` — POST (ký CSR)
  - `stats` — GET; `quotas` (admin) GET/POST, `quotas/{id}/{name}` GET (của mình) / PATCH, DELETE (admin)
  - `mservices` — GET (admin)
- [x] Kiểm tra body JSON-Patch (mảng `{op, path, value}`, chỉ `add|replace|remove`).
- [x] `POST certificates` không mở qua gateway; chỉ route kubeconfig được ký CSR.
- [x] Endpoint `POST /api/ext/magnum/clusters/{id}/kubeconfig` (`auth: cert | keystone`): sinh khóa + CSR (`rcgen`),
      ký qua `POST /certificates`, lấy CA, ghép kubeconfig; khóa không lưu trên server.
- [x] Unit test: allowlist, base URL, JSON-Patch, kubeconfig; integration test (wiremock):
      microversion, phân trang `next`, ký CSR, kubeconfig keystone.

## PR 3 — UI cluster template & cluster cơ bản ✅

- [x] `ui/api.ts`: type `ClusterTemplate`, `Cluster`, `NodeGroup`, hằng, hook, nhãn trạng thái.
- [x] Trang Cluster templates: danh sách, tạo / sửa (JSON-Patch) / clone (image, keypair, external network,
      fixed network, flavors, network/volume driver, master LB, floating IP, public/hidden, labels), xóa.
- [x] Trang Clusters: danh sách (status, health, auto-refresh khi `*_IN_PROGRESS`), tạo, xóa.
- [x] Trang chi tiết cluster: overview, labels, status reason, tải kubeconfig.

## PR 4 — Node groups & thao tác nâng cao ✅

- [x] Tab Node groups: tạo, resize (chọn server cần bỏ), sửa min/max (JSON-Patch), xóa.
- [x] Resize cluster, upgrade (đổi template), rotate CA.
- [x] Liên kết chéo (card "OpenStack resources"): server Nova (theo địa chỉ node), load balancer
      Octavia của API (theo VIP / floating IP), network Neutron, id stack / Cluster API.

## PR 5 — Admin ✅

- [x] Tất cả cluster / template (mọi project, cột Project), trang Settings (`/admin/ext/magnum/settings`):
      quotas (đặt / sửa / reset), usage theo project + `stats`, Magnum services (`mservices`).
- [x] Đánh dấu template public / hidden (admin) trong dialog template.

## PR 6 — Cleanup & Terraform ✅

- [x] Cleanup: finder "Failed Kubernetes clusters" (`*_FAILED`) và "Unused cluster templates"; chỉ bật khi
      `/nav` báo extension `magnum` có mặt.
- [x] Terraform: export `openstack_containerinfra_clustertemplate_v1`, `openstack_containerinfra_cluster_v1`
      (cluster kéo theo template + keypair; image / network tra cứu theo tên; import blocks).

## PR 7 — Tài liệu ✅

- [x] `docs/project/15-kubernetes-clusters.md`, `docs/admin/09-kubernetes-service.md`, cập nhật `docs/README.md`,
      Cleanup / Terraform docs, README gốc, i18n `vi.ts` (221 chuỗi).
- [ ] Ảnh chụp màn hình cho docs (cần một cloud có Magnum).

## PR 8 — Chỉ hỗ trợ CAPI (magnum-capi-helm, driver `k8s_capi_helm_v1`) ✅

- [x] Backend: bỏ `PATCH certificates/{id}` (driver không rotate CA được), thêm `PATCH credentials/{id}`
  (1.12, làm mới application credential); `check_body` bỏ qua `credentials/`.
- [x] `api.ts`: hằng `CAPI_DRIVER`, flavor tối thiểu 2048 MB / 2 vCPU, kiểm tra image (`os_distro`
  ubuntu|flatcar, `kube_version`), kiểm tra upgrade (không hạ phiên bản, không nhảy minor), labels CAPI,
  CNI calico|cilium, `useTemplateVersion`, `rotateCredentials`.
- [x] Templates: chỉ chọn image CAPI, hiện phiên bản Kubernetes theo image, bỏ switch master LB / floating IP,
  volume driver, docker volume; thêm CNI, Octavia provider, "Public address for the API"; badge
  "Not Cluster API".
- [x] Clusters: phiên bản từ `coe_version` / image; bỏ Rotate CA, thêm "Renew cloud credentials"; upgrade
  cảnh báo theo `upgradeProblem`; tạo cluster chỉ với template CAPI, luôn `master_lb_enabled: true`; cảnh
  báo kubeconfig chứng chỉ không thu hồi được.
- [x] Node groups: bỏ chọn server cần xóa và image; kiểm tra min ≤ node_count; lọc flavor quá nhỏ.
- [x] Chi tiết cluster: phiên bản, dòng Load balancer hiện public / nội bộ; bỏ "Container volume".
- [x] Bản dịch tiếng Việt (61 chuỗi mới, xóa 42 chuỗi không còn dùng); tài liệu project/admin viết lại cho CAPI.

## Chưa kiểm chứng

- Chưa chạy với Magnum thật: backend đã test với mock (wiremock), UI đã qua `tsc` + `vite build` nhưng
  chưa được thử trên trình duyệt với một cloud thật. Cần smoke test: tạo template → cluster → kubeconfig →
  `kubectl get nodes`, resize, upgrade, renew credentials, node group, với driver `magnum-capi-helm`.

## Rủi ro / điểm cần chốt

- Chỉ hỗ trợ driver `magnum-capi-helm` (PR 8). Template Heat / `magnum-cluster-api` (Vexxhost) bị đánh dấu
  "Not Cluster API" và không chọn được khi tạo cluster. Magnum cũ không trả `driver` → coi như CAPI.
- Kubeconfig chứng chỉ không thu hồi được (CAPI không rotate CA) — khuyến nghị `keystone_auth_enabled`.
- Microversion tối đa của cloud đích (node groups / resize cần ≥ 1.7–1.10).
- Chứng chỉ trong kubeconfig có `O=system:masters` (cluster-admin) — ghi rõ trong UI.

## Nhật ký

- 2026-10-29: tạo plan, branch `feat/magnum`.
- 2026-10-29: PR 1 xong — `crates/ext-api/src/gateway.rs` (Service, Rule, proxy, call_all hỗ trợ `next`
  kiểu Magnum, cache microversion), Octavia dùng module chung, SDK export `useFlavors`, `useKeypairs`,
  `useBootImages`. `cargo test`, `clippy`, `tsc -b` pass.
- 2026-10-29: PR 2 xong — `extensions/magnum` (gateway, kubeconfig với `rcgen`, ECDSA P-256),
  feature `ext-magnum` bật mặc định. 11 test pass, clippy sạch.
- 2026-10-29: PR 3 xong — `extensions/magnum/ui` (api.ts, Templates, Clusters, ClusterDetail, index), SDK
  export `downloadText`. `pnpm build` (tsc + vite) pass.
- 2026-10-29: PR 4 xong — `NodeGroups.tsx`, dialog Resize / Upgrade / Rotate CA. `tsc` pass.
- 2026-10-29: PR 5 xong — `Settings.tsx` (Quotas, Usage, Services). `tsc` pass.
- 2026-10-29: PR 6 xong — `Cleanup.tsx`, `Terraform.tsx`, `lib/terraform.ts`; đã chạy thử bộ sinh HCL với dữ liệu mẫu.
- 2026-10-29: PR 7 xong — tài liệu và bản dịch tiếng Việt. `cargo test` / `clippy` / `--no-default-features`,
  `pnpm build` đều pass.
- 2026-10-29: PR 8 xong — chỉ hỗ trợ CAPI (`magnum-capi-helm`). `cargo test` / `clippy`, `tsc` + `vite build` pass.
- 2026-10-29: sửa sau thử nghiệm trên STG — (1) ngay sau `POST clusters`, Magnum trả lỗi
  `master_count ... '0'` cho mọi GET cluster tới khi conductor tạo xong node group: UI thử lại 10 lần,
  mỗi lần 3 s (`useOsGet` / `useOsList` nhận `retry`); (2) driver CAPI không điền `node_addresses`:
  server được tìm theo tiền tố tên `<stack_id>-`; "Driver resource" đổi thành "Cluster API name".
- 2026-10-29: menu Kubernetes chuyển sang nhóm "Container"; Ctrl+K tìm cluster / template theo tên hoặc UUID
  và có hành động "Create Kubernetes cluster" / "Create cluster template" (`?new=1`, template mở qua `?edit=<uuid>`).
- 2026-10-29: server chuyển từ card "OpenStack resources" sang tab Node groups: cột "Servers" và dòng mở rộng
  (`DataTable` có prop `expand`) liệt kê server của từng nhóm (tên theo `<release>-control-plane-…` /
  `<release>-<nhóm>-…`, prefix dài nhất thắng); SDK export `serverStatus`, `serverLabel`.
- 2026-10-29: STG1 / STG2 chạy Magnum max microversion 1.11 → `PATCH credentials/{id}` trả 405. Thêm
  `GET /api/ext/magnum/info` (microversion đã thương lượng) và UI vô hiệu hoá "Renew cloud credentials" khi < 1.12.
- 2026-10-29: driver CAPI bỏ qua label của node group → bỏ ô Labels trong dialog tạo node group; danh sách server
  của nhóm hiện `fault.message` của server ERROR.
- 2026-10-29: node group `test-group2` trên STG không có server: Rassvet gửi flavor bằng UUID, driver chuyển nguyên
  thành `machineFlavor` và CAPO tìm flavor theo **tên** → không tạo được máy (Magnum vẫn nhận vì
  `_validate_allowed_flavor` chấp nhận cả id). Mọi picker flavor (template, cluster, node group) giờ gửi tên;
  template cũ lưu id vẫn hiển thị đúng và không bị patch khi không đổi; tab Node groups cảnh báo nhóm lưu id.
