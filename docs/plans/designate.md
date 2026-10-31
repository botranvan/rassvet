# Kế hoạch tích hợp Designate (DNS as a Service)

Extension `designate` cho Rassvet: zone, record set, import / export zone file, chuyển zone giữa các dự án,
chia sẻ zone, DNS ngược (PTR) của floating IP, và phần admin (TLD, blacklist, quota, khóa TSIG, pool, trạng
thái service). Catalog service type `dns`, API v2, không có microversion.

Trạng thái: `[ ]` chưa làm · `[~]` đang làm · `[x]` xong

## Bối cảnh kiến trúc

- Cùng khuôn mẫu Octavia / Magnum: crate `extensions/designate/` implement `rassvet_ext_api::Extension`,
  gateway allowlist ở `/api/ext/designate/os/{*path}`, UI `extensions/designate/ui/index.tsx` (service `ext:designate`).
- Menu là một nhóm riêng "DNS" (sau "Container"): Project → DNS zones, Reverse DNS; Admin → All DNS zones, DNS service.
- Khác biệt của Designate so với các service khác:
  - Phân trang bằng `links.next` (object) + `marker`.
  - Xem mọi dự án / thao tác thay dự án khác qua header `X-Auth-All-Projects`, `X-Auth-Sudo-Project-ID`.
  - Import / export zone file dùng `text/dns`, không phải JSON.

## PR 1 — Hạ tầng dùng chung ✅

- [x] `gateway`: `call_with` / `call_all_with` / `proxy_with` nhận header bổ sung (`call`, `call_all`, `proxy`
      giữ nguyên chữ ký, Octavia / Magnum không đổi).
- [x] `has_next` hiểu `links: {next}` của Designate; `call_all` bỏ `links.next` khi đã gom hết trang.

## PR 2 — Backend `extensions/designate` ✅

- [x] Crate `rassvet-ext-designate`, feature `ext-designate` (mặc định bật), workspace, registry, log filter.
- [x] Allowlist v2: zones (CRUD, nameservers, tasks xfr / export / transfer_requests, abandon + pool_move cho
      admin), recordsets (theo zone: GET/POST/PUT/DELETE; toàn cục: GET), shares, imports, exports,
      transfer_requests / transfer_accepts, reverse/floatingips (`{region}:{id}`), tlds (đọc cho mọi người,
      ghi cho admin), tsigkeys / blacklists / pools / service_statuses (admin), quotas, limits.
- [x] Query `all_projects=1` → `X-Auth-All-Projects: true`, `sudo_project_id=<id>` → `X-Auth-Sudo-Project-ID`;
      chỉ admin, người khác nhận 403.
- [x] `POST /api/ext/designate/zones/import` (`{"zonefile"}` → `text/dns`, tối đa 1 MiB) và
      `GET /api/ext/designate/exports/{id}/zonefile` (→ `{"zonefile"}`); không mở `POST zones/tasks/imports`
      và `.../export` qua gateway.
- [x] Unit test (allowlist, URL, header params) + integration test wiremock (phân trang + header admin,
      từ chối khi không phải admin, import / export).

## PR 3 — UI dự án ✅

- [x] `ui/api.ts`: type, hook (thêm `all_projects=1` ở admin view), helper tên (FQDN, `@`), loại bản ghi
      (gợi ý, ví dụ, kiểm tra A / AAAA / CNAME / MX / SRV / NS / PTR), tự đặt ngoặc kép và cắt TXT 255 ký tự,
      tên PTR ngược (IPv4 / IPv6).
- [x] Trang DNS zones (tab Zones / Imports / Exports / Transfer requests): tạo / sửa zone primary và secondary,
      xóa (cả bulk), xfr ngay, export + tải file, import (dán hoặc chọn file), transfer (hiện ID + key), accept.
- [x] Chi tiết zone: Record sets (tạo / sửa / nhân bản / xóa; SOA và NS gốc chỉ xem), Overview (thông tin,
      name servers + nút copy bản ghi NS để khai báo ở nhà đăng ký), Shares.
- [x] Reverse DNS: ghép floating IP của Neutron với `reverse/floatingips`, đặt / bỏ PTR (cả bulk).

## PR 4 — UI admin ✅

- [x] All DNS zones (cột Project), tạo / import zone cho dự án khác (sudo), abandon.
- [x] DNS service (`/admin/ext/designate/settings`): TLDs, TSIG keys (sinh secret ngẫu nhiên), Blacklists (thử
      regex với tên zone), Quotas (chọn dự án, sửa, reset), Pools, Services.

## PR 5 — Tích hợp & tài liệu ✅ (một phần)

- [x] Overview: DNS / Designate trong danh sách service; Ctrl+K: hành động "Create DNS zone", từ khóa tìm trang.
- [x] Tài liệu `docs/project/16-dns-zones.md`, `docs/admin/10-dns-service.md`, `docs/README.md`, README gốc.
- [x] Bản dịch tiếng Việt (241 chuỗi).
- [ ] Ctrl+K tìm zone theo tên / UUID.
- [ ] Cleanup: zone ở trạng thái ERROR, export / import cũ.
- [ ] Terraform: `openstack_dns_zone_v2`, `openstack_dns_recordset_v2`.
- [ ] Liên kết chéo: gợi ý tạo bản ghi A cho floating IP / VIP load balancer; trang floating IP hiện PTR.
- [x] Ảnh chụp màn hình cho docs (9 ảnh, cloud RAX-Labs, Playwright + Chromium headless).
- [x] DNS thành nhóm menu riêng; tab Services đánh dấu host mất heartbeat > 2 phút (pod cũ vẫn báo UP).

## Chưa kiểm chứng

- Đã chạy với Designate thật (RAX-Labs, Genestack) khi chụp ảnh: danh sách zone, record set, overview,
  Reverse DNS, admin zone / TLD / services hiển thị đúng. Chưa thử hết các thao tác ghi. Cần smoke test: tạo zone → record set A / MX / TXT dài → `dig @<ns>`, import / export, transfer giữa hai dự
  án, share (2023.1+), PTR của floating IP, admin xem mọi dự án.

## Rủi ro / điểm cần chốt

- Shares cần Designate 2023.1; cloud cũ trả 404 — tab Shares chỉ hiện lỗi, chưa ẩn theo phiên bản API.
- Danh sách `reverse/floatingips` dùng id `<region>:<fip>`; với FIP chưa có PTR, region lấy từ session —
  cần xác nhận tên region của Designate trùng với region Keystone.
- Admin view luôn gửi `all_projects`; Designate policy (`all_tenants`) vẫn quyết định cuối cùng.

## Nhật ký

- 2026-10-30: tạo plan, branch `feat/designate` (từ `feat/multi-cloud`). PR 1–4 và phần lớn PR 5 xong.
  `cargo test --workspace`, `clippy -D warnings`, `cargo check --no-default-features`, `pnpm build` pass.
- 2026-10-30: thử trên RAX-Labs — 504 ở Reverse DNS do Designate không xác thực được chứng chỉ khi gọi Neutron
  qua endpoint public (cấu hình cloud: `[network_api:neutron] endpoint_type = internalURL`); POST export lỗi
  transport một lần, không tới gateway, thử lại bằng curl thì thông.
- 2026-10-31: DNS thành nhóm menu riêng, đánh dấu service mất heartbeat, ảnh chụp cho docs.
