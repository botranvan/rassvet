/**
 * Create / edit dialogs for listeners, pools, members, health monitors and L7 policies/rules.
 * Every change makes Octavia put the load balancer in PENDING_UPDATE for a moment; requests
 * made meanwhile get 409, so several changes in a row go through `retry409`.
 */
import { useMemo, useState } from "react";
import {
  ActionDialog,
  Checkbox,
  Field,
  Input,
  MultiPicker,
  type PickOption,
  Picker,
  Switch,
  Tabs,
  os,
  serverIps,
  tr,
  useInAdmin,
  usePorts,
  useServers,
  useSubnets,
} from "@rassvet/sdk";
import {
  ALGORITHMS,
  COMPARE_TYPES,
  type CompareType,
  type HealthMonitor,
  L7_ACTIONS,
  type L7Action,
  type L7Policy,
  type L7Rule,
  type L7RuleType,
  LB,
  LISTENER_PROTOCOLS,
  type Listener,
  type ListenerProtocol,
  type LoadBalancer,
  MONITOR_TYPES,
  type Member,
  type MonitorType,
  POOL_FOR_LISTENER,
  POOL_PROTOCOLS,
  type Persistence,
  type Pool,
  type PoolProtocol,
  RULE_TYPES,
  type Algorithm,
  lbName,
  num,
  splitList,
  useBarbicanContainers,
  useBarbicanSecrets,
} from "./api";

/** Run `fn`, waiting out "immutable" (409) while the load balancer is busy with the previous change. */
export async function retry409<T>(fn: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status !== 409 || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const TLS_VERSIONS = ["SSLv3", "TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
const ALPN = ["h2", "http/1.1", "http/1.0"];
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const HEADERS_HTTP = ["X-Forwarded-For", "X-Forwarded-Port", "X-Forwarded-Proto"];
const HEADERS_TLS = [
  "X-SSL-Client-Verify",
  "X-SSL-Client-Has-Cert",
  "X-SSL-Client-DN",
  "X-SSL-Client-CN",
  "X-SSL-Issuer",
  "X-SSL-Client-SHA1",
  "X-SSL-Client-Not-Before",
  "X-SSL-Client-Not-After",
];

const opt = (v: string) => ({ value: v, label: v });
const nstr = (n?: number | null) => (n == null ? "" : String(n));

function NumberField({ label, value, onChange, hint, placeholder, min, max }: { label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string; min?: number; max?: number }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function TextField({ label, value, onChange, hint, placeholder, mono, autoFocus }: { label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string; mono?: boolean; autoFocus?: boolean }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} autoFocus={autoFocus} value={value} placeholder={placeholder} className={mono ? "font-mono text-[13px]" : undefined} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

// =========================================================================== certificates

const lastSegment = (ref: string) => ref.replace(/\/+$/, "").split("/").pop() ?? ref;

/** Certificate containers and secrets from Barbican as picker options (by full URL); refs not listed are kept. */
function useCertOptions(keep: string[]): { options: PickOption[]; loading: boolean; failed: boolean } {
  const containers = useBarbicanContainers();
  const secrets = useBarbicanSecrets();
  const options = useMemo(() => {
    const opts: PickOption[] = [
      ...(containers.data ?? [])
        .filter((c) => c.type === "certificate")
        .map((c) => ({
          value: c.container_ref,
          label: c.name || lastSegment(c.container_ref),
          description: lastSegment(c.container_ref),
          meta: c.status !== "ACTIVE" ? c.status : undefined,
          icon: "package",
          group: tr("Certificate containers"),
          keywords: c.container_ref,
        })),
      ...(secrets.data ?? []).map((x) => ({
        value: x.secret_ref,
        label: x.name || lastSegment(x.secret_ref),
        description: lastSegment(x.secret_ref),
        meta: x.secret_type,
        icon: "lock-keyhole",
        group: tr("Secrets (PKCS12)"),
        keywords: x.secret_ref,
      })),
    ];
    const known = new Set(opts.map((o) => o.value));
    const extra = keep.filter((r) => r && !known.has(r)).map((r) => ({ value: r, label: lastSegment(r), description: r, group: tr("Other references") }));
    return [...extra, ...opts];
  }, [containers.data, secrets.data, keep]);
  return { options, loading: containers.isPending || secrets.isPending, failed: !!containers.error && !!secrets.error };
}

/** Choose a TLS certificate (Barbican certificate container or PKCS12 secret); falls back to typing the URL. */
export function CertificatePicker({ id, value, onChange, clearable }: { id?: string; value: string; onChange: (v: string) => void; clearable?: boolean }) {
  const keep = useMemo(() => [value], [value]);
  const { options, loading, failed } = useCertOptions(keep);
  const [manual, setManual] = useState(false);
  if (manual || failed)
    return (
      <div className="grid gap-1">
        <Input id={id} className="font-mono text-[13px]" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://barbican:9311/v1/secrets/…" />
        {failed ? (
          <p className="text-xs text-muted">{tr("Couldn't list Barbican secrets; enter the reference by hand.")}</p>
        ) : (
          <button type="button" className="justify-self-start text-xs text-cable hover:underline" onClick={() => setManual(false)}>
            {tr("Choose from Barbican")}
          </button>
        )}
      </div>
    );
  return (
    <Picker
      id={id}
      value={value}
      onChange={onChange}
      clearable={clearable}
      searchable
      loading={loading}
      placeholder={tr("Choose a certificate")}
      emptyText={tr("No certificate containers or secrets in Barbican")}
      options={options}
      footer={(close) => (
        <button
          type="button"
          className="w-full rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface hover:text-ink"
          onClick={() => {
            close();
            setManual(true);
          }}
        >
          {tr("Enter a reference by hand…")}
        </button>
      )}
    />
  );
}

/** Several certificates (SNI) from Barbican. */
function CertificateMultiPicker({ id, values, onChange }: { id?: string; values: string[]; onChange: (v: string[]) => void }) {
  const { options, loading } = useCertOptions(values);
  return <MultiPicker id={id} values={values} onChange={onChange} searchable loading={loading} placeholder={tr("None")} options={options} />;
}

// =========================================================================== listener

export function ListenerDialog({ lb, listener, pools, onClose, onDone }: { lb: LoadBalancer; listener?: Listener; pools: Pool[]; onClose: () => void; onDone?: (l: Listener) => void }) {
  const edit = !!listener;
  const [tab, setTab] = useState<"basics" | "tls" | "advanced">("basics");
  const [name, setName] = useState(listener?.name ?? "");
  const [description, setDescription] = useState(listener?.description ?? "");
  const [protocol, setProtocol] = useState<ListenerProtocol>(listener?.protocol ?? "HTTP");
  const [port, setPort] = useState(nstr(listener?.protocol_port ?? 80));
  const [pool, setPool] = useState(listener?.default_pool_id ?? "");
  const [limit, setLimit] = useState(listener && listener.connection_limit >= 0 ? String(listener.connection_limit) : "");
  const [cidrs, setCidrs] = useState((listener?.allowed_cidrs ?? []).join(", "));
  const [headers, setHeaders] = useState<string[]>(Object.entries(listener?.insert_headers ?? {}).filter(([, v]) => v === "true" || v === "True").map(([k]) => k));
  const [tlsRef, setTlsRef] = useState(listener?.default_tls_container_ref ?? "");
  const [sni, setSni] = useState<string[]>(listener?.sni_container_refs ?? []);
  const [clientAuth, setClientAuth] = useState(listener?.client_authentication ?? "NONE");
  const [caRef, setCaRef] = useState(listener?.client_ca_tls_container_ref ?? "");
  const [crlRef, setCrlRef] = useState(listener?.client_crl_container_ref ?? "");
  const [versions, setVersions] = useState<string[]>(listener?.tls_versions ?? []);
  const [ciphers, setCiphers] = useState(listener?.tls_ciphers ?? "");
  const [alpn, setAlpn] = useState<string[]>(listener?.alpn_protocols ?? []);
  const [hsts, setHsts] = useState(nstr(listener?.hsts_max_age));
  const [hstsSub, setHstsSub] = useState(!!listener?.hsts_include_subdomains);
  const [hstsPreload, setHstsPreload] = useState(!!listener?.hsts_preload);
  const [tClient, setTClient] = useState(nstr(listener?.timeout_client_data));
  const [tConnect, setTConnect] = useState(nstr(listener?.timeout_member_connect));
  const [tData, setTData] = useState(nstr(listener?.timeout_member_data));
  const [tInspect, setTInspect] = useState(nstr(listener?.timeout_tcp_inspect));
  const [up, setUp] = useState(listener?.admin_state_up ?? true);

  const http = protocol === "HTTP" || protocol === "TERMINATED_HTTPS";
  const terminated = protocol === "TERMINATED_HTTPS";
  const usable = pools.filter((p) => POOL_FOR_LISTENER[protocol].includes(p.protocol));
  const headerChoices = [...HEADERS_HTTP, ...(terminated ? HEADERS_TLS : [])];

  const body = () => {
    const insert_headers = http ? Object.fromEntries(headerChoices.map((h) => [h, headers.includes(h) ? "true" : "false"]).filter(([, v]) => v === "true" || edit)) : undefined;
    const b: Record<string, unknown> = {
      name: name.trim(),
      description,
      admin_state_up: up,
      connection_limit: limit.trim() === "" ? -1 : Number(limit),
      default_pool_id: protocol === "PROMETHEUS" ? undefined : pool || null,
      allowed_cidrs: splitList(cidrs) ?? (edit ? null : undefined),
      timeout_client_data: num(tClient),
      timeout_member_connect: num(tConnect),
      timeout_member_data: num(tData),
      timeout_tcp_inspect: num(tInspect),
    };
    if (http) b.insert_headers = insert_headers;
    if (terminated) {
      Object.assign(b, {
        default_tls_container_ref: tlsRef.trim() || null,
        sni_container_refs: sni,
        client_authentication: clientAuth,
        client_ca_tls_container_ref: caRef.trim() || null,
        client_crl_container_ref: crlRef.trim() || null,
        tls_versions: versions.length ? versions : null,
        tls_ciphers: ciphers.trim() || null,
        alpn_protocols: alpn.length ? alpn : null,
        hsts_max_age: num(hsts) ?? null,
        hsts_include_subdomains: hstsSub,
        hsts_preload: hstsPreload,
      });
    }
    if (!edit) {
      Object.assign(b, { loadbalancer_id: lb.id, protocol, protocol_port: Number(port) });
      for (const k of Object.keys(b)) if (b[k] === null || b[k] === "") delete b[k];
    }
    return b;
  };
  const ok = !!port && Number(port) > 0 && Number(port) < 65536 && (!terminated || !!tlsRef.trim());
  return (
    <ActionDialog<{ listener: Listener }>
      onClose={onClose}
      size="lg"
      title={edit ? tr("Edit listener {name}", { name: lbName(listener) }) : tr("Add listener to {name}", { name: lbName(lb) })}
      description={tr("A listener accepts connections on one protocol and port of the VIP and hands them to its default pool (or to an L7 policy's pool).")}
      submitLabel={edit ? tr("Save") : tr("Add listener")}
      canSubmit={ok}
      done={edit ? tr("Listener updated") : tr("Listener added")}
      refresh={[LB]}
      onDone={(r) => onDone?.(r.listener)}
      run={() => (edit ? os.put(LB, `lbaas/listeners/${listener.id}`, { listener: body() }) : retry409(() => os.post(LB, "lbaas/listeners", { listener: body() })))}
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "basics", label: tr("Basics") },
          ...(terminated ? [{ id: "tls" as const, label: tr("TLS") }] : []),
          { id: "advanced", label: tr("Advanced") },
        ]}
      />
      {tab === "basics" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label={tr("Name")} value={name} onChange={setName} autoFocus placeholder="http" />
            <TextField label={tr("Description")} value={description} onChange={setDescription} />
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field label={tr("Protocol")} hint={edit ? tr("Can't be changed after creation.") : undefined}>
              {(id) => (
                <Picker
                  id={id}
                  value={protocol}
                  disabled={edit}
                  onChange={(v) => {
                    setProtocol(v as ListenerProtocol);
                    setPool("");
                    if (!edit) setPort(v === "HTTP" ? "80" : v === "TERMINATED_HTTPS" || v === "HTTPS" ? "443" : v === "PROMETHEUS" ? "9100" : port);
                  }}
                  options={LISTENER_PROTOCOLS}
                />
              )}
            </Field>
            <Field label={tr("Port")}>{(id) => <Input id={id} type="number" min={1} max={65535} disabled={edit} value={port} onChange={(e) => setPort(e.target.value)} />}</Field>
          </div>
          {protocol !== "PROMETHEUS" && (
            <Field label={tr("Default pool")} hint={tr("Where connections go when no L7 policy matches. Pools need a compatible protocol ({protocols}).", { protocols: POOL_FOR_LISTENER[protocol].join(", ") })}>
              {(id) => (
                <Picker
                  id={id}
                  value={pool}
                  onChange={setPool}
                  options={[
                    { value: "", label: tr("None (add one later)") },
                    ...pools.map((p) => ({
                      value: p.id,
                      label: lbName(p),
                      description: `${p.protocol} · ${p.lb_algorithm}`,
                      icon: "layers",
                      disabled: usable.includes(p) ? false : tr("Protocol {protocol} doesn't fit", { protocol: p.protocol }),
                    })),
                  ]}
                />
              )}
            </Field>
          )}
          {http && (
            <Field label={tr("Insert headers")} hint={tr("Headers the load balancer adds to requests sent to members.")}>
              {() => (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {headerChoices.map((h) => (
                    <Checkbox key={h} checked={headers.includes(h)} onChange={(v) => setHeaders(v ? [...headers, h] : headers.filter((x) => x !== h))}>
                      <span className="font-mono text-[12.5px]">{h}</span>
                    </Checkbox>
                  ))}
                </div>
              )}
            </Field>
          )}
          <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A listener that is down stops accepting connections.")} />
        </>
      )}
      {tab === "tls" && terminated && (
        <>
          <Field
            label={tr("Certificate (Barbican container or secret)")}
            hint={tr("PKCS12 secret or certificate container with the server certificate and key. Octavia's service user needs read access to it.")}
          >
            {(id) => <CertificatePicker id={id} value={tlsRef} onChange={setTlsRef} />}
          </Field>
          <Field label={tr("SNI certificates")} hint={tr("More certificates, chosen by the server name the client asks for.")}>
            {(id) => <CertificateMultiPicker id={id} values={sni} onChange={setSni} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("TLS versions")} hint={tr("Empty = Octavia's default.")}>
              {(id) => <MultiPicker id={id} values={versions} onChange={setVersions} options={TLS_VERSIONS.map(opt)} placeholder={tr("Default")} />}
            </Field>
            <Field label={tr("ALPN protocols")}>{(id) => <MultiPicker id={id} values={alpn} onChange={setAlpn} options={ALPN.map(opt)} placeholder={tr("Default")} />}</Field>
          </div>
          <TextField label={tr("Ciphers")} value={ciphers} onChange={setCiphers} mono placeholder="ECDHE-ECDSA-AES256-GCM-SHA384:…" hint={tr("OpenSSL cipher string; empty = Octavia's default.")} />
          <Field label={tr("Client authentication")}>
            {(id) => (
              <Picker
                id={id}
                value={clientAuth}
                onChange={(v) => setClientAuth(v as typeof clientAuth)}
                options={[
                  { value: "NONE", label: tr("None") },
                  { value: "OPTIONAL", label: tr("Optional"), description: tr("Verify a client certificate when one is sent") },
                  { value: "MANDATORY", label: tr("Mandatory"), description: tr("Refuse clients without a valid certificate") },
                ]}
              />
            )}
          </Field>
          {clientAuth !== "NONE" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label={tr("Client CA (secret)")} value={caRef} onChange={setCaRef} mono />
              <TextField label={tr("Revocation list (secret)")} value={crlRef} onChange={setCrlRef} mono />
            </div>
          )}
          <div className="grid items-end gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <NumberField label={tr("HSTS max age (s)")} value={hsts} onChange={setHsts} placeholder={tr("off")} min={0} />
            <div className="flex flex-wrap gap-4 pb-2.5">
              <Checkbox checked={hstsSub} onChange={setHstsSub}>
                {tr("Include subdomains")}
              </Checkbox>
              <Checkbox checked={hstsPreload} onChange={setHstsPreload}>
                {tr("Preload")}
              </Checkbox>
            </div>
          </div>
        </>
      )}
      {tab === "advanced" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label={tr("Connection limit")} value={limit} onChange={setLimit} placeholder={tr("Unlimited")} min={-1} />
            <Field label={tr("Allowed CIDRs")} hint={tr("Only these source networks may connect; empty = everyone.")}>
              {(id) => <Input id={id} className="font-mono text-[13px]" value={cidrs} placeholder="0.0.0.0/0, 2001:db8::/32" onChange={(e) => setCidrs(e.target.value)} />}
            </Field>
          </div>
          <p className="text-sm font-medium">{tr("Timeouts (milliseconds)")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label={tr("Client data")} value={tClient} onChange={setTClient} placeholder="50000" min={0} />
            <NumberField label={tr("Member connect")} value={tConnect} onChange={setTConnect} placeholder="5000" min={0} />
            <NumberField label={tr("Member data")} value={tData} onChange={setTData} placeholder="50000" min={0} />
            <NumberField label={tr("TCP inspect")} value={tInspect} onChange={setTInspect} placeholder="0" min={0} hint={tr("Time to wait for content inspection (L7 rules).")} />
          </div>
        </>
      )}
    </ActionDialog>
  );
}

// =========================================================================== pool

export function PoolDialog({
  lb,
  pool,
  listeners,
  forListener,
  onClose,
  onDone,
}: {
  lb: LoadBalancer;
  pool?: Pool;
  listeners: Listener[];
  forListener?: Listener;
  onClose: () => void;
  onDone?: (p: Pool) => void;
}) {
  const edit = !!pool;
  const [tab, setTab] = useState<"basics" | "tls">("basics");
  const [name, setName] = useState(pool?.name ?? "");
  const [description, setDescription] = useState(pool?.description ?? "");
  const [listener, setListener] = useState(forListener?.id ?? "");
  const li = listeners.find((l) => l.id === listener);
  const allowed = li ? POOL_FOR_LISTENER[li.protocol] : POOL_PROTOCOLS;
  const [protocol, setProtocol] = useState<PoolProtocol>(pool?.protocol ?? (li ? POOL_FOR_LISTENER[li.protocol][0] : "HTTP"));
  const [algorithm, setAlgorithm] = useState<Algorithm>(pool?.lb_algorithm ?? "ROUND_ROBIN");
  const [persist, setPersist] = useState<Persistence["type"] | "">(pool?.session_persistence?.type ?? "");
  const [cookie, setCookie] = useState(pool?.session_persistence?.cookie_name ?? "");
  const [tls, setTls] = useState(!!pool?.tls_enabled);
  const [tlsRef, setTlsRef] = useState(pool?.tls_container_ref ?? "");
  const [caRef, setCaRef] = useState(pool?.ca_tls_container_ref ?? "");
  const [crlRef, setCrlRef] = useState(pool?.crl_container_ref ?? "");
  const [versions, setVersions] = useState<string[]>(pool?.tls_versions ?? []);
  const [ciphers, setCiphers] = useState(pool?.tls_ciphers ?? "");
  const [alpn, setAlpn] = useState<string[]>(pool?.alpn_protocols ?? []);
  const [up, setUp] = useState(pool?.admin_state_up ?? true);
  const udp = protocol === "UDP" || protocol === "SCTP";
  const free = listeners.filter((l) => !l.default_pool_id && l.protocol !== "PROMETHEUS");

  const body = () => {
    const b: Record<string, unknown> = {
      name: name.trim(),
      description,
      admin_state_up: up,
      lb_algorithm: algorithm,
      session_persistence: persist ? { type: persist, ...(persist === "APP_COOKIE" ? { cookie_name: cookie.trim() } : {}) } : null,
    };
    if (protocol === "HTTP" || protocol === "HTTPS" || protocol === "TCP") {
      Object.assign(b, {
        tls_enabled: tls,
        tls_container_ref: tls ? tlsRef.trim() || null : null,
        ca_tls_container_ref: tls ? caRef.trim() || null : null,
        crl_container_ref: tls ? crlRef.trim() || null : null,
        ...(tls ? { tls_versions: versions.length ? versions : null, tls_ciphers: ciphers.trim() || null, alpn_protocols: alpn.length ? alpn : null } : {}),
      });
    }
    if (!edit) {
      Object.assign(b, { protocol, ...(listener ? { listener_id: listener } : { loadbalancer_id: lb.id }) });
      for (const k of Object.keys(b)) if (b[k] === null || b[k] === "") delete b[k];
    }
    return b;
  };
  return (
    <ActionDialog<{ pool: Pool }>
      onClose={onClose}
      size="lg"
      title={edit ? tr("Edit pool {name}", { name: lbName(pool) }) : tr("Add pool to {name}", { name: lbName(lb) })}
      description={tr("A pool is a group of members that share a protocol, a balancing algorithm and an optional health monitor.")}
      submitLabel={edit ? tr("Save") : tr("Add pool")}
      canSubmit={persist !== "APP_COOKIE" || !!cookie.trim()}
      done={edit ? tr("Pool updated") : tr("Pool added")}
      refresh={[LB]}
      onDone={(r) => onDone?.(r.pool)}
      run={() => (edit ? os.put(LB, `lbaas/pools/${pool.id}`, { pool: body() }) : retry409(() => os.post(LB, "lbaas/pools", { pool: body() })))}
    >
      {(protocol === "HTTP" || protocol === "HTTPS" || protocol === "TCP") && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "basics", label: tr("Basics") },
            { id: "tls", label: tr("TLS to members") },
          ]}
        />
      )}
      {tab === "basics" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label={tr("Name")} value={name} onChange={setName} autoFocus placeholder="web-pool" />
            <TextField label={tr("Description")} value={description} onChange={setDescription} />
          </div>
          {!edit && (
            <Field label={tr("Default pool of listener")} hint={tr("Optional: the listener sends its traffic here. Without one, the pool is used by L7 policies only.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={listener}
                  disabled={!!forListener}
                  onChange={(v) => {
                    setListener(v);
                    const l = listeners.find((x) => x.id === v);
                    if (l) setProtocol(POOL_FOR_LISTENER[l.protocol][0]);
                  }}
                  options={[
                    { value: "", label: tr("None") },
                    ...(forListener ? [forListener] : free).map((l) => ({ value: l.id, label: lbName(l), description: `${l.protocol}:${l.protocol_port}`, icon: "radio-tower" })),
                  ]}
                />
              )}
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Protocol")} hint={edit ? tr("Can't be changed after creation.") : undefined}>
              {(id) => <Picker id={id} value={protocol} disabled={edit} onChange={(v) => setProtocol(v as PoolProtocol)} options={allowed.map(opt)} />}
            </Field>
            <Field label={tr("Algorithm")}>
              {(id) => <Picker id={id} value={algorithm} onChange={(v) => setAlgorithm(v as Algorithm)} options={ALGORITHMS} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Session persistence")} hint={tr("Keep a client on the same member.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={persist}
                  onChange={(v) => setPersist(v as Persistence["type"] | "")}
                  options={[
                    { value: "", label: tr("None") },
                    { value: "SOURCE_IP", label: tr("Source IP") },
                    ...(udp ? [] : [
                      { value: "HTTP_COOKIE", label: tr("HTTP cookie"), description: tr("Set by the load balancer") },
                      { value: "APP_COOKIE", label: tr("Application cookie"), description: tr("A cookie your application sets") },
                    ]),
                  ]}
                />
              )}
            </Field>
            {persist === "APP_COOKIE" && <TextField label={tr("Cookie name")} value={cookie} onChange={setCookie} mono placeholder="JSESSIONID" />}
          </div>
          <Switch checked={up} onChange={setUp} label={tr("Admin state up")} />
        </>
      )}
      {tab === "tls" && (
        <>
          <Switch checked={tls} onChange={setTls} label={tr("Encrypt traffic to members")} hint={tr("Re-encrypt with TLS between the load balancer and the members.")} />
          {tls && (
            <>
              <TextField label={tr("Client certificate (secret)")} value={tlsRef} onChange={setTlsRef} mono hint={tr("Optional: certificate the load balancer presents to members.")} />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label={tr("CA to verify members (secret)")} value={caRef} onChange={setCaRef} mono />
                <TextField label={tr("Revocation list (secret)")} value={crlRef} onChange={setCrlRef} mono />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr("TLS versions")}>{(id) => <MultiPicker id={id} values={versions} onChange={setVersions} options={TLS_VERSIONS.map(opt)} placeholder={tr("Default")} />}</Field>
                <Field label={tr("ALPN protocols")}>{(id) => <MultiPicker id={id} values={alpn} onChange={setAlpn} options={ALPN.map(opt)} placeholder={tr("Default")} />}</Field>
              </div>
              <TextField label={tr("Ciphers")} value={ciphers} onChange={setCiphers} mono />
            </>
          )}
        </>
      )}
    </ActionDialog>
  );
}

// =========================================================================== members

type Target = { key: string; label: string; address: string; subnet?: string; description: string };

/** Instance addresses (with their subnets) that can be members. */
export function useMemberTargets() {
  const admin = useInAdmin();
  const servers = useServers(admin ? { all_tenants: 1 } : undefined);
  const ports = usePorts();
  const subnets = useSubnets();
  return useMemo(() => {
    const out: Target[] = [];
    const subnetOf = (ip: string) => ports.data?.flatMap((p) => p.fixed_ips).find((f) => f.ip_address === ip)?.subnet_id;
    for (const s of servers.data ?? []) {
      for (const a of serverIps(s)) {
        if (a.floating) continue;
        const subnet = subnetOf(a.addr);
        out.push({
          key: `${s.id}|${a.addr}`,
          label: s.name || s.id,
          address: a.addr,
          subnet,
          description: `${a.net} · ${a.addr}${subnet ? ` · ${subnets.data?.find((x) => x.id === subnet)?.cidr ?? ""}` : ""}`,
        });
      }
    }
    return { targets: out, loading: servers.isPending, subnets: subnets.data ?? [] };
  }, [servers.data, servers.isPending, ports.data, subnets.data]);
}

export function AddMembersDialog({ pool, members, onClose }: { pool: Pool; members: Member[]; onClose: () => void }) {
  const T = useMemberTargets();
  const [mode, setMode] = useState<"instances" | "address">("instances");
  const [picked, setPicked] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [subnet, setSubnet] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState(pool.protocol === "HTTPS" ? "443" : pool.protocol === "HTTP" ? "80" : "");
  const [weight, setWeight] = useState("1");
  const [backup, setBackup] = useState(false);
  const [monAddr, setMonAddr] = useState("");
  const [monPort, setMonPort] = useState("");
  const taken = new Set(members.map((m) => `${m.address}:${m.protocol_port}`));

  const fresh = (): Record<string, unknown>[] => {
    const common = { protocol_port: Number(port), weight: Number(weight || 1), backup, monitor_address: monAddr.trim() || undefined, monitor_port: num(monPort) };
    if (mode === "address") return [{ ...common, address: address.trim(), subnet_id: subnet || undefined, name: name.trim() || undefined }];
    return picked
      .map((k) => T.targets.find((t) => t.key === k)!)
      .filter(Boolean)
      .map((t) => ({ ...common, address: t.address, subnet_id: t.subnet, name: t.label }));
  };
  const n = mode === "address" ? 1 : picked.length;
  const ok = !!port && Number(port) > 0 && (mode === "address" ? !!address.trim() : picked.length > 0) && fresh().every((m) => !taken.has(`${m.address}:${m.protocol_port}`));
  const run = async () => {
    const add = fresh();
    if (add.length === 1) return retry409(() => os.post(LB, `lbaas/pools/${pool.id}/members`, { member: add[0] }));
    // Several at once: one batch update (the full list, existing members unchanged).
    const keep = members.map((m) => ({
      address: m.address,
      protocol_port: m.protocol_port,
      name: m.name || undefined,
      weight: m.weight,
      backup: m.backup,
      admin_state_up: m.admin_state_up,
      subnet_id: m.subnet_id ?? undefined,
      monitor_address: m.monitor_address ?? undefined,
      monitor_port: m.monitor_port ?? undefined,
    }));
    return retry409(() => os.put(LB, `lbaas/pools/${pool.id}/members`, { members: [...keep, ...add] }));
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Add members to {name}", { name: lbName(pool) })}
      description={tr("Members are the servers that receive the traffic: instances of this cloud, or any address the load balancer can reach.")}
      submitLabel={n > 1 ? tr("Add {n} members", { n }) : tr("Add member")}
      canSubmit={ok}
      done={n > 1 ? tr("{n} members added", { n }) : tr("Member added")}
      refresh={[LB]}
      run={run}
    >
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "instances", label: tr("Instances") },
          { id: "address", label: tr("IP address") },
        ]}
      />
      {mode === "instances" ? (
        <Field label={tr("Instances")} hint={tr("One member per chosen address; members get the instance's name.")}>
          {(id) => (
            <MultiPicker
              id={id}
              values={picked}
              onChange={setPicked}
              loading={T.loading}
              searchable
              placeholder={tr("Choose instances")}
              options={T.targets.map((t) => ({ value: t.key, label: t.label, description: t.description, icon: "server", keywords: t.address }))}
            />
          )}
        </Field>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label={tr("Address")} value={address} onChange={setAddress} mono placeholder="10.0.0.15" autoFocus />
            <TextField label={tr("Name")} value={name} onChange={setName} />
          </div>
          <Field label={tr("Subnet")} hint={tr("The member's subnet, so the amphorae get an interface there. Leave empty when the address is reachable through the VIP network.")}>
            {(id) => (
              <Picker
                id={id}
                value={subnet}
                onChange={setSubnet}
                searchable
                options={[{ value: "", label: tr("Through the VIP network") }, ...T.subnets.map((s) => ({ value: s.id, label: s.name || s.id, description: s.cidr, icon: "network" }))]}
              />
            )}
          </Field>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label={tr("Port")} value={port} onChange={setPort} min={1} max={65535} placeholder="8080" />
        <NumberField label={tr("Weight")} value={weight} onChange={setWeight} min={0} max={256} hint={tr("0 = drain: no new connections.")} />
        <div className="pt-7">
          <Checkbox checked={backup} onChange={setBackup}>
            {tr("Backup member")}
          </Checkbox>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label={tr("Monitor address")} value={monAddr} onChange={setMonAddr} mono hint={tr("Health checks go here instead (optional).")} />
        <NumberField label={tr("Monitor port")} value={monPort} onChange={setMonPort} min={1} max={65535} />
      </div>
      {fresh().some((m) => taken.has(`${m.address}:${m.protocol_port}`)) && <p className="text-sm text-led-red">{tr("A member with this address and port is already in the pool.")}</p>}
    </ActionDialog>
  );
}

export function EditMemberDialog({ pool, member, onClose }: { pool: Pool; member: Member; onClose: () => void }) {
  const [name, setName] = useState(member.name);
  const [weight, setWeight] = useState(String(member.weight));
  const [backup, setBackup] = useState(member.backup);
  const [monAddr, setMonAddr] = useState(member.monitor_address ?? "");
  const [monPort, setMonPort] = useState(nstr(member.monitor_port));
  const [up, setUp] = useState(member.admin_state_up);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit member {name}", { name: member.name || `${member.address}:${member.protocol_port}` })}
      submitLabel={tr("Save")}
      done={tr("Member updated")}
      refresh={[LB]}
      run={() =>
        retry409(() =>
          os.put(LB, `lbaas/pools/${pool.id}/members/${member.id}`, {
            member: { name: name.trim(), weight: Number(weight || 0), backup, admin_state_up: up, monitor_address: monAddr.trim() || null, monitor_port: num(monPort) ?? null },
          }),
        )
      }
    >
      <TextField label={tr("Name")} value={name} onChange={setName} autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label={tr("Weight")} value={weight} onChange={setWeight} min={0} max={256} hint={tr("0 = drain: no new connections.")} />
        <div className="pt-7">
          <Checkbox checked={backup} onChange={setBackup}>
            {tr("Backup member")}
          </Checkbox>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label={tr("Monitor address")} value={monAddr} onChange={setMonAddr} mono />
        <NumberField label={tr("Monitor port")} value={monPort} onChange={setMonPort} min={1} max={65535} />
      </div>
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A member that is down gets no traffic.")} />
    </ActionDialog>
  );
}

// =========================================================================== health monitor

export function HealthMonitorDialog({ pool, monitor, onClose }: { pool: Pool; monitor?: HealthMonitor; onClose: () => void }) {
  const edit = !!monitor;
  const udp = pool.protocol === "UDP";
  const sctp = pool.protocol === "SCTP";
  const types = MONITOR_TYPES.filter((t) => (udp ? ["UDP-CONNECT", "HTTP", "TCP", "PING", "SCTP"].includes(t) : sctp ? ["SCTP", "HTTP", "TCP", "PING", "UDP-CONNECT"].includes(t) : t !== "UDP-CONNECT" && t !== "SCTP"));
  const [type, setType] = useState<MonitorType>(monitor?.type ?? (udp ? "UDP-CONNECT" : sctp ? "SCTP" : pool.protocol === "HTTPS" ? "HTTPS" : pool.protocol === "HTTP" ? "HTTP" : "TCP"));
  const [name, setName] = useState(monitor?.name ?? "");
  const [delay, setDelay] = useState(nstr(monitor?.delay ?? 5));
  const [timeout, setTimeout_] = useState(nstr(monitor?.timeout ?? 3));
  const [retries, setRetries] = useState(nstr(monitor?.max_retries ?? 3));
  const [retriesDown, setRetriesDown] = useState(nstr(monitor?.max_retries_down ?? 3));
  const [method, setMethod] = useState(monitor?.http_method ?? "GET");
  const [path, setPath] = useState(monitor?.url_path ?? "/");
  const [codes, setCodes] = useState(monitor?.expected_codes ?? "200");
  const [version, setVersion] = useState(nstr(monitor?.http_version ?? 1.0));
  const [domain, setDomain] = useState(monitor?.domain_name ?? "");
  const [up, setUp] = useState(monitor?.admin_state_up ?? true);
  const http = type === "HTTP" || type === "HTTPS";
  const ok = Number(delay) > 0 && Number(timeout) > 0 && Number(timeout) <= Number(delay) && Number(retries) >= 1 && Number(retries) <= 10;
  const body = () => {
    const b: Record<string, unknown> = {
      name: name.trim(),
      delay: Number(delay),
      timeout: Number(timeout),
      max_retries: Number(retries),
      max_retries_down: Number(retriesDown || 3),
      admin_state_up: up,
      ...(http ? { http_method: method, url_path: path || "/", expected_codes: codes || "200", http_version: Number(version), ...(version === "1.1" && domain.trim() ? { domain_name: domain.trim() } : {}) } : {}),
    };
    if (!edit) Object.assign(b, { pool_id: pool.id, type });
    return b;
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={edit ? tr("Edit health monitor") : tr("Add health monitor to {name}", { name: lbName(pool) })}
      description={tr("Members failing the check are taken out of rotation until they pass again.")}
      submitLabel={edit ? tr("Save") : tr("Add monitor")}
      canSubmit={ok}
      done={edit ? tr("Health monitor updated") : tr("Health monitor added")}
      refresh={[LB]}
      run={() => retry409(() => (edit ? os.put(LB, `lbaas/healthmonitors/${monitor.id}`, { healthmonitor: body() }) : os.post(LB, "lbaas/healthmonitors", { healthmonitor: body() })))}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Type")} hint={edit ? tr("Can't be changed after creation.") : undefined}>
          {(id) => <Picker id={id} value={type} disabled={edit} onChange={(v) => setType(v as MonitorType)} options={types.map(opt)} />}
        </Field>
        <TextField label={tr("Name")} value={name} onChange={setName} />
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <NumberField label={tr("Interval (s)")} value={delay} onChange={setDelay} min={1} />
        <NumberField label={tr("Timeout (s)")} value={timeout} onChange={setTimeout_} min={1} />
        <NumberField label={tr("Retries up")} value={retries} onChange={setRetries} min={1} max={10} />
        <NumberField label={tr("Retries down")} value={retriesDown} onChange={setRetriesDown} min={1} max={10} />
      </div>
      <p className="text-xs text-muted">{tr("A member is marked down after “retries down” failed checks and back up after “retries up” passed ones. The timeout can't be longer than the interval.")}</p>
      {http && (
        <>
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_9rem]">
            <Field label={tr("Method")}>{(id) => <Picker id={id} value={method} onChange={setMethod} options={["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "CONNECT", "TRACE"].map(opt)} />}</Field>
            <TextField label={tr("URL path")} value={path} onChange={setPath} mono placeholder="/healthz" />
            <TextField label={tr("Expected codes")} value={codes} onChange={setCodes} mono placeholder="200-299" />
          </div>
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field label={tr("HTTP version")}>{(id) => <Picker id={id} value={version} onChange={setVersion} options={["1.0", "1.1"].map(opt)} />}</Field>
            {version === "1.1" && <TextField label={tr("Host header")} value={domain} onChange={setDomain} mono placeholder="www.example.com" />}
          </div>
        </>
      )}
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} />
    </ActionDialog>
  );
}

// =========================================================================== L7

type RuleDraft = { type: L7RuleType; compare: CompareType; key: string; value: string; invert: boolean };
const blankRule = (): RuleDraft => ({ type: "PATH", compare: "STARTS_WITH", key: "", value: "", invert: false });
const ruleReady = (r: RuleDraft) => !!r.value.trim() && (!RULE_TYPES.find((t) => t.value === r.type)?.key || !!r.key.trim());
const ruleBody = (r: RuleDraft) => ({ type: r.type, compare_type: r.compare, value: r.value.trim(), invert: r.invert, ...(RULE_TYPES.find((t) => t.value === r.type)?.key ? { key: r.key.trim() } : {}) });

function RuleFields({ r, set }: { r: RuleDraft; set: (r: RuleDraft) => void }) {
  const t = RULE_TYPES.find((x) => x.value === r.type);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Match on")} hint={t?.description}>
          {(id) => <Picker id={id} value={r.type} onChange={(v) => set({ ...r, type: v as L7RuleType })} options={RULE_TYPES.map((x) => ({ value: x.value, label: x.label }))} />}
        </Field>
        <Field label={tr("Comparison")}>{(id) => <Picker id={id} value={r.compare} onChange={(v) => set({ ...r, compare: v as CompareType })} options={COMPARE_TYPES} />}</Field>
      </div>
      <div className={t?.key ? "grid gap-4 sm:grid-cols-2" : ""}>
        {t?.key && <TextField label={t.key} value={r.key} onChange={(v) => set({ ...r, key: v })} mono />}
        <TextField label={tr("Value")} value={r.value} onChange={(v) => set({ ...r, value: v })} mono placeholder={r.type === "PATH" ? "/api" : r.type === "HOST_NAME" ? "www.example.com" : ""} />
      </div>
      <Checkbox checked={r.invert} onChange={(v) => set({ ...r, invert: v })}>
        {tr("Invert (match when the comparison is false)")}
      </Checkbox>
    </>
  );
}

export function L7PolicyDialog({ listener, policy, pools, onClose }: { listener: Listener; policy?: L7Policy; pools: Pool[]; onClose: () => void }) {
  const edit = !!policy;
  const [name, setName] = useState(policy?.name ?? "");
  const [description, setDescription] = useState(policy?.description ?? "");
  const [action, setAction] = useState<L7Action>(policy?.action ?? "REDIRECT_TO_POOL");
  const [position, setPosition] = useState(nstr(policy?.position));
  const [pool, setPool] = useState(policy?.redirect_pool_id ?? "");
  const [url, setUrl] = useState(policy?.redirect_url ?? "");
  const [prefix, setPrefix] = useState(policy?.redirect_prefix ?? "");
  const [code, setCode] = useState(nstr(policy?.redirect_http_code ?? 302));
  const [up, setUp] = useState(policy?.admin_state_up ?? true);
  const [rule, setRule] = useState<RuleDraft>(blankRule());
  const [withRule, setWithRule] = useState(!edit);
  const redirect = action === "REDIRECT_TO_URL" || action === "REDIRECT_PREFIX";
  const ok = (action !== "REDIRECT_TO_POOL" || !!pool) && (action !== "REDIRECT_TO_URL" || !!url.trim()) && (action !== "REDIRECT_PREFIX" || !!prefix.trim()) && (!withRule || ruleReady(rule));
  const body = () => ({
    name: name.trim(),
    description,
    action,
    admin_state_up: up,
    position: num(position),
    redirect_pool_id: action === "REDIRECT_TO_POOL" ? pool : null,
    redirect_url: action === "REDIRECT_TO_URL" ? url.trim() : null,
    redirect_prefix: action === "REDIRECT_PREFIX" ? prefix.trim() : null,
    redirect_http_code: redirect ? Number(code) : null,
    ...(edit ? {} : { listener_id: listener.id, ...(withRule ? { rules: [ruleBody(rule)] } : {}) }),
  });
  const clean = () => {
    const b: Record<string, unknown> = body();
    if (!edit) for (const k of Object.keys(b)) if (b[k] === null || b[k] === undefined) delete b[k];
    return b;
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={edit ? tr("Edit L7 policy {name}", { name: lbName(policy) }) : tr("Add L7 policy to {name}", { name: lbName(listener) })}
      description={tr("Policies are checked in order of position; the first whose rules all match decides what happens to the request.")}
      submitLabel={edit ? tr("Save") : tr("Add policy")}
      canSubmit={ok}
      done={edit ? tr("L7 policy updated") : tr("L7 policy added")}
      refresh={[LB]}
      run={() => retry409(() => (edit ? os.put(LB, `lbaas/l7policies/${policy.id}`, { l7policy: clean() }) : os.post(LB, "lbaas/l7policies", { l7policy: clean() })))}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
        <TextField label={tr("Name")} value={name} onChange={setName} autoFocus />
        <TextField label={tr("Description")} value={description} onChange={setDescription} />
        <NumberField label={tr("Position")} value={position} onChange={setPosition} min={1} placeholder={tr("last")} />
      </div>
      <Field label={tr("Action")}>{(id) => <Picker id={id} value={action} onChange={(v) => setAction(v as L7Action)} options={L7_ACTIONS} />}</Field>
      {action === "REDIRECT_TO_POOL" && (
        <Field label={tr("Pool")}>
          {(id) => (
            <Picker
              id={id}
              value={pool}
              onChange={setPool}
              placeholder={tr("Choose a pool")}
              options={pools.map((p) => ({ value: p.id, label: lbName(p), description: `${p.protocol} · ${p.lb_algorithm}`, icon: "layers", disabled: POOL_FOR_LISTENER[listener.protocol].includes(p.protocol) ? false : tr("Protocol {protocol} doesn't fit", { protocol: p.protocol }) }))}
            />
          )}
        </Field>
      )}
      {redirect && (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          {action === "REDIRECT_TO_URL" ? (
            <TextField label={tr("URL")} value={url} onChange={setUrl} mono placeholder="https://www.example.com/maintenance" />
          ) : (
            <TextField label={tr("Prefix")} value={prefix} onChange={setPrefix} mono placeholder="https://www.example.com" />
          )}
          <Field label={tr("HTTP code")}>{(id) => <Picker id={id} value={code} onChange={setCode} options={REDIRECT_CODES.map((c) => opt(String(c)))} />}</Field>
        </div>
      )}
      {!edit && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <Checkbox checked={withRule} onChange={setWithRule}>
            <span className="font-medium">{tr("Add a first rule")}</span>
          </Checkbox>
          {withRule && <RuleFields r={rule} set={setRule} />}
          {!withRule && <p className="text-xs text-muted">{tr("A policy without rules never matches.")}</p>}
        </div>
      )}
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} />
    </ActionDialog>
  );
}

export function L7RuleDialog({ policy, rule, onClose }: { policy: L7Policy; rule?: L7Rule; onClose: () => void }) {
  const edit = !!rule;
  const [r, setR] = useState<RuleDraft>(rule ? { type: rule.type, compare: rule.compare_type, key: rule.key ?? "", value: rule.value, invert: rule.invert } : blankRule());
  const [up, setUp] = useState(rule?.admin_state_up ?? true);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={edit ? tr("Edit rule") : tr("Add rule to {name}", { name: lbName(policy) })}
      description={tr("Every rule of a policy has to match (AND).")}
      submitLabel={edit ? tr("Save") : tr("Add rule")}
      canSubmit={ruleReady(r)}
      done={edit ? tr("Rule updated") : tr("Rule added")}
      refresh={[LB]}
      run={() =>
        retry409(() =>
          edit
            ? os.put(LB, `lbaas/l7policies/${policy.id}/rules/${rule.id}`, { rule: { ...ruleBody(r), admin_state_up: up } })
            : os.post(LB, `lbaas/l7policies/${policy.id}/rules`, { rule: { ...ruleBody(r), admin_state_up: up } }),
        )
      }
    >
      <RuleFields r={r} set={setR} />
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} />
    </ActionDialog>
  );
}
