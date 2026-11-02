/* Rassvet project site — interactions. No dependencies. */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const isDark = () => root.dataset.theme !== "light";

  /* ------------------------------------------------------------ toast */
  const toastEl = $("#toast");
  let toastTimer;
  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 1800);
  };

  /* ------------------------------------------------------------ theme */
  const setTheme = (t) => {
    root.dataset.theme = t;
    store.set("rassvet-theme", t);
    $('meta[name="theme-color"]').content = t === "light" ? "#f6f8fb" : "#070d1a";
    window.dispatchEvent(new Event("themechange"));
  };
  const toggleTheme = () => {
    const next = isDark() ? "light" : "dark";
    if (document.startViewTransition && !reduced) document.startViewTransition(() => setTheme(next));
    else setTheme(next);
    toast(next === "light" ? "☀️  Light theme" : "🌙  Dark theme");
  };
  $("#theme-toggle").addEventListener("click", toggleTheme);

  /* ------------------------------------------------ nav, progress, spy */
  const nav = $(".nav");
  const progress = $(".progress");
  const links = $$(".nav__links a");
  const sections = links.map((a) => $(a.getAttribute("href"))).filter(Boolean);
  let ticking = false;
  const onScroll = () => {
    const y = scrollY;
    nav.classList.toggle("is-scrolled", y > 8);
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    let current = null;
    for (const s of sections) if (s.getBoundingClientRect().top < innerHeight * 0.4) current = s.id;
    links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === `#${current}`));
    ticking = false;
  };
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  const burger = $(".burger");
  const navLinks = $(".nav__links");
  burger.addEventListener("click", () => {
    const open = burger.getAttribute("aria-expanded") !== "true";
    burger.setAttribute("aria-expanded", String(open));
    navLinks.classList.toggle("is-open", open);
  });
  links.forEach((a) => a.addEventListener("click", () => {
    burger.setAttribute("aria-expanded", "false");
    navLinks.classList.remove("is-open");
  }));

  /* ------------------------------------------------- reveal + counters */
  const counters = new WeakSet();
  const countUp = (el) => {
    if (counters.has(el)) return;
    counters.add(el);
    const target = +el.dataset.count;
    const suffix = el.dataset.suffix || "";
    const t0 = performance.now();
    const dur = 1400;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))) + (p === 1 ? suffix : "");
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  // Stagger siblings that reveal together.
  $$(".bento, .principles, .ux-grid, .gallery, .steps, .hero__copy, .monitor-grid").forEach((g) =>
    $$(":scope > .reveal", g).forEach((el, i) => el.style.setProperty("--d", `${Math.min(i, 8) * 0.07}s`)));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("is-in");
      $$("[data-count]", e.target).forEach(countUp);
      io.unobserve(e.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  $$(".reveal").forEach((el) => io.observe(el));

  /* ------------------------------------------------------ sky canvas */
  const sky = $("#sky");
  const sctx = sky.getContext("2d");
  let stars = [];
  let dpr = 1;
  const sizeSky = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    sky.width = innerWidth * dpr;
    sky.height = innerHeight * dpr;
    const n = Math.round((innerWidth * innerHeight) / 9000);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * sky.width, y: Math.random() * sky.height,
      r: (Math.random() * 1.2 + 0.2) * dpr, p: Math.random() * Math.PI * 2,
      s: Math.random() * 0.15 + 0.03, tw: Math.random() * 0.02 + 0.005,
    }));
  };
  const drawSky = () => {
    sctx.clearRect(0, 0, sky.width, sky.height);
    const dark = isDark();
    const par = scrollY * 0.15 * dpr;
    for (const st of stars) {
      st.p += st.tw;
      if (!reduced) st.y -= st.s * dpr;
      if (st.y < -10) { st.y = sky.height + 10; st.x = Math.random() * sky.width; }
      const a = (Math.sin(st.p) * 0.5 + 0.5) * (dark ? 0.8 : 0.35);
      sctx.beginPath();
      sctx.fillStyle = dark ? `rgba(220,230,255,${a})` : `rgba(45,90,160,${a * 0.6})`;
      sctx.arc(st.x, (st.y - par + sky.height * 4) % sky.height, st.r, 0, Math.PI * 2);
      sctx.fill();
    }
    if (!reduced) requestAnimationFrame(drawSky);
  };
  sizeSky();
  drawSky();
  addEventListener("resize", sizeSky);

  /* ------------------------------------- tilt, magnetic, spotlight */
  if (fine && !reduced) {
    const tilt = $("[data-tilt]");
    const win = $(".window", tilt);
    tilt.addEventListener("pointermove", (e) => {
      const r = tilt.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      win.style.setProperty("--ry", `${x * 10 - 4}deg`);
      win.style.setProperty("--rx", `${-y * 8 + 2}deg`);
    });
    tilt.addEventListener("pointerleave", () => { win.style.removeProperty("--ry"); win.style.removeProperty("--rx"); });

    $$(".magnetic").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty("--mx", `${(e.clientX - r.left - r.width / 2) * 0.18}px`);
        b.style.setProperty("--my", `${(e.clientY - r.top - r.height / 2) * 0.28}px`);
      });
      b.addEventListener("pointerleave", () => { b.style.setProperty("--mx", "0px"); b.style.setProperty("--my", "0px"); });
    });
  }
  $$(".spot").forEach((c) => c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty("--x", `${e.clientX - r.left}px`);
    c.style.setProperty("--y", `${e.clientY - r.top}px`);
  }));

  /* ------------------------------------------------- hero window tabs */
  const tabs = $$(".window__tabs button");
  const shots = $$(".window__body .shot");
  let shotIdx = 0;
  let shotTimer;
  const showShot = (i) => {
    shotIdx = (i + tabs.length) % tabs.length;
    const key = tabs[shotIdx].dataset.shot;
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.shot === key));
    shots.forEach((s) => s.classList.toggle("is-active", s.dataset.shot === key));
  };
  const autoShots = () => { clearInterval(shotTimer); if (!reduced) shotTimer = setInterval(() => showShot(shotIdx + 1), 4500); };
  tabs.forEach((t, i) => t.addEventListener("click", () => { showShot(i); autoShots(); }));
  autoShots();

  /* ------------------------------------------ bento palette list pulse */
  const tl = $$(".typing-list li");
  let tli = 0;
  if (tl.length && !reduced) setInterval(() => { tl.forEach((l, i) => l.classList.toggle("is-hot", i === tli)); tli = (tli + 1) % tl.length; }, 1300);

  /* ----------------------------------------------------- icon set */
  const I = {
    server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
    disk: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
    image: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    net: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    hash: '<svg viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="m8 3-6 6 6 6M16 9l6 6-6 6"/></svg>',
    gh: '<svg viewBox="0 0 24 24"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.3 6.4-1.5 6.4-7A5.4 5.4 0 0 0 20 4.8 5 5 0 0 0 19.9 1S18.7.7 16 2.5a13.4 13.4 0 0 0-7 0C6.3.7 5.1 1 5.1 1A5 5 0 0 0 5 4.8a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.3 6.6 6.4 7A3.4 3.4 0 0 0 9 18.1V22"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/></svg>',
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hl = (label, q) => {
    if (!q) return esc(label);
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? esc(label) : esc(label.slice(0, i)) + "<mark>" + esc(label.slice(i, i + q.length)) + "</mark>" + esc(label.slice(i + q.length));
  };

  /* ----------------------------------------------- palette demo (auto) */
  const scenarios = [
    { q: "web", groups: [
      ["Switch project", [["folder", "production-web", "p-prod"]]],
      ["Resources", [["server", "web-02", "Instance"], ["server", "web-01", "Instance"], ["image", "snapshot-web-08", "Image"], ["image", "prod-web-golden-2026-10", "Image"], ["shield", "web", "Security group"]]],
    ] },
    { q: "vol:db", hlq: "db", groups: [
      ["Volumes", [["disk", "db-primary-data", "Volume · 200 GiB"], ["disk", "db-replica-data", "Volume · 200 GiB"], ["disk", "db-wal", "Volume · 50 GiB"]]],
    ] },
    { q: "10.0.0.15", groups: [
      ["Resources", [["server", "worker-01  ·  10.0.0.15", "Instance"], ["net", "port 3f2a…  ·  10.0.0.15", "Port"]]],
    ] },
    { q: "create", groups: [
      ["Actions", [["plus", "Create network", "Network"], ["plus", "Create volume", "Volume"], ["plus", "Create Kubernetes cluster", "ext:magnum"], ["plus", "Create DNS zone", "ext:designate"], ["plus", "Create load balancer", "ext:octavia"]]],
    ] },
    { q: "mon", groups: [
      ["Pages", [["chart", "Instance monitors", "Monitoring"], ["chart", "Physical server monitors", "Admin › Monitoring"]]],
    ] },
  ];
  const demoTyped = $("#demo-typed");
  const demoList = $("#demo-results");
  const renderDemo = (sc, q) => {
    const typed = q.length >= sc.q.length;
    if (!typed) { demoList.innerHTML = ""; return; }
    let n = 0;
    demoList.innerHTML = sc.groups.map(([g, rows]) =>
      `<li class="grp">${g}</li>` + rows.map(([ic, label, kind]) =>
        `<li class="row${n++ === 0 ? " is-sel" : ""}" style="animation-delay:${n * 0.04}s">${I[ic]}<span>${hl(label, sc.hlq || sc.q)}</span><small>${kind}</small></li>`).join("")).join("");
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let demoRunning = false;
  const runDemo = async () => {
    if (demoRunning) return;
    demoRunning = true;
    for (let k = 0; ; k = (k + 1) % scenarios.length) {
      const sc = scenarios[k];
      for (let i = 1; i <= sc.q.length; i++) { demoTyped.textContent = sc.q.slice(0, i); renderDemo(sc, sc.q.slice(0, i)); await sleep(reduced ? 0 : 90 + Math.random() * 70); }
      // walk the selection down a little
      const rows = $$(".row", demoList);
      for (let i = 1; i < Math.min(rows.length, 3); i++) { await sleep(650); rows.forEach((r, j) => r.classList.toggle("is-sel", j === i)); }
      await sleep(1600);
      for (let i = sc.q.length; i >= 0; i--) { demoTyped.textContent = sc.q.slice(0, i); await sleep(30); }
      demoList.innerHTML = "";
      await sleep(350);
    }
  };
  new IntersectionObserver((e, o) => { if (e[0].isIntersecting) { runDemo(); o.disconnect(); } }, { threshold: 0.3 }).observe($(".demo"));

  /* ---------------------------------------------- real command palette */
  const cmdk = $("#cmdk");
  const cInput = $("#cmdk-input");
  const cList = $("#cmdk-list");
  const go = (id) => () => $(id).scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  const commands = [
    { g: "Sections", i: "layers", l: "Features", k: "why overview bento", run: go("#features") },
    { g: "Sections", i: "hash", l: "Command palette", k: "cmdk search keyboard ctrl k", run: go("#palette") },
    { g: "Sections", i: "chart", l: "Monitors", k: "prometheus dashboards yaml charts cpu memory", run: go("#monitors") },
    { g: "Sections", i: "code", l: "Extensions", k: "develop crate sdk plugin octavia magnum designate", run: go("#extensions") },
    { g: "Sections", i: "net", l: "Architecture", k: "tokens keystone axum server", run: go("#architecture") },
    { g: "Sections", i: "image", l: "Design & UI/UX", k: "colors palette leds fonts theme", run: go("#design") },
    { g: "Sections", i: "arrow", l: "Get started", k: "build install cargo pnpm quick start", run: go("#start") },
    { g: "Actions", i: "sun", l: "Toggle dark / light theme", k: "dark theme light mode", run: toggleTheme },
    { g: "Actions", i: "code", l: "Copy build commands", k: "copy cargo build", run: () => copyText("cd ui && pnpm install && pnpm build && cd ..\ncargo build --release\n./target/release/rassvet --config rassvet.toml") },
    { g: "Links", i: "gh", l: "Open the repository on GitHub", k: "github source code repo", run: () => open("https://github.com/botranvan/rassvet", "_blank", "noopener") },
    { g: "Links", i: "book", l: "Read the user guide", k: "docs documentation guide", run: () => open("https://github.com/botranvan/rassvet/tree/master/docs", "_blank", "noopener") },
  ];
  let cSel = 0;
  let cItems = [];
  const renderCmdk = () => {
    const raw = cInput.value.trim();
    const q = raw.toLowerCase();
    cItems = commands.filter((c) => !q || (c.l + " " + c.k + " " + c.g).toLowerCase().includes(q));
    if (!cItems.length) { cList.innerHTML = `<li class="empty">No results for “${esc(raw)}”</li>`; return; }
    cSel = Math.min(cSel, cItems.length - 1);
    let last = "";
    cList.innerHTML = cItems.map((c, idx) => {
      const head = c.g !== last ? `<li class="grp">${c.g}</li>` : "";
      last = c.g;
      return head + `<li class="row${idx === cSel ? " is-sel" : ""}" role="option" data-i="${idx}" style="animation-delay:${idx * 0.02}s">${I[c.i]}<span>${hl(c.l, raw)}</span><small>${c.g === "Links" ? "↗" : "↵"}</small></li>`;
    }).join("");
  };
  const setSel = (i) => {
    cSel = (i + cItems.length) % cItems.length;
    $$(".row", cList).forEach((r) => r.classList.toggle("is-sel", +r.dataset.i === cSel));
    $(".row.is-sel", cList)?.scrollIntoView({ block: "nearest" });
  };
  let lastFocus = null;
  const openCmdk = () => {
    if (!cmdk.hidden) return;
    lastFocus = document.activeElement;
    cmdk.hidden = false;
    cmdk.classList.remove("is-closing");
    cInput.value = "";
    cSel = 0;
    renderCmdk();
    requestAnimationFrame(() => cInput.focus());
    document.body.style.overflow = "hidden";
  };
  const closeCmdk = () => {
    if (cmdk.hidden) return;
    cmdk.classList.add("is-closing");
    setTimeout(() => { cmdk.hidden = true; cmdk.classList.remove("is-closing"); }, reduced ? 0 : 150);
    document.body.style.overflow = "";
    lastFocus?.focus?.({ preventScroll: true });
  };
  const runSel = () => { const c = cItems[cSel]; if (!c) return; closeCmdk(); setTimeout(c.run, 60); };
  $$("[data-open-palette]").forEach((b) => b.addEventListener("click", openCmdk));
  cmdk.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeCmdk();
    const row = e.target.closest(".row");
    if (row) { cSel = +row.dataset.i; runSel(); }
  });
  cList.addEventListener("pointermove", (e) => { const row = e.target.closest(".row"); if (row && +row.dataset.i !== cSel) setSel(+row.dataset.i); });
  cInput.addEventListener("input", () => { cSel = 0; renderCmdk(); });
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); cmdk.hidden ? openCmdk() : closeCmdk(); return; }
    if (e.key === "/" && cmdk.hidden && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); openCmdk(); return; }
    if (!$("#lightbox").hidden && e.key === "Escape") return closeLightbox();
    if (cmdk.hidden) return;
    if (e.key === "Escape") closeCmdk();
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel(cSel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(cSel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); runSel(); }
  });
  // Show ⌘ on Mac, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $$("kbd").forEach((k) => { if (k.textContent === "⌘K") k.textContent = "Ctrl K"; });

  /* --------------------------------------------------------- charts */
  // Smooth pseudo-random series, like a CPU trace.
  const series = (n, base, amp, seed) => {
    const out = [];
    let v = base;
    for (let i = 0; i < n; i++) {
      v += Math.sin(i * 0.21 + seed) * amp * 0.25 + Math.cos(i * 0.07 + seed * 2) * amp * 0.15 + (Math.random() - 0.5) * amp * 0.25;
      v = Math.max(2, Math.min(98, v * 0.92 + base * 0.08));
      out.push(v);
    }
    return out;
  };
  const sizeCanvas = (cv) => {
    const r = cv.getBoundingClientRect();
    const d = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.max(1, r.width * d);
    cv.height = Math.max(1, r.height * d);
    return d;
  };
  const curve = (ctx, pts) => {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i][0] + pts[i + 1][0]) / 2;
      const yc = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
    }
    const l = pts[pts.length - 1];
    ctx.lineTo(l[0], l[1]);
  };

  // Live chart in the monitors section
  const live = $("#live-chart");
  const colors = ["#2d8cff", "#ff9f1c", "#22b5b0"];
  const names = ["total", "user", "system"];
  const N = 90;
  const data = [series(N, 45, 30, 1)];
  data.push(data[0].map((v) => v * 0.68 + Math.random() * 2));
  data.push(data[0].map((v, i) => Math.max(1, v - data[1][i] + Math.random() * 1.5)));
  const visible = [true, true, true];
  let liveOn = false;
  let liveProgress = 0;
  const drawLive = () => {
    const d = sizeCanvas(live);
    const ctx = live.getContext("2d");
    const W = live.width, H = live.height;
    const padL = 42 * d, padB = 22 * d, padT = 8 * d, padR = 8 * d;
    const gw = W - padL - padR, gh = H - padT - padB;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${11 * d}px JetBrains Mono, monospace`;
    ctx.fillStyle = css("--muted");
    ctx.strokeStyle = isDark() ? "rgba(148,170,205,0.12)" : "rgba(24,32,43,0.08)";
    ctx.lineWidth = d;
    for (let i = 0; i <= 4; i++) {
      const y = padT + gh - (gh * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(`${i * 25}%`, 4 * d, y + 4 * d);
    }
    ["09:00 PM", "12:00 AM", "03:00 AM"].forEach((t, i) => ctx.fillText(t, padL + gw * (0.12 + i * 0.36), H - 4 * d));
    const upto = Math.max(2, Math.floor(N * liveProgress));
    data.forEach((s, si) => {
      if (!visible[si]) return;
      const pts = s.slice(0, upto).map((v, i) => [padL + (gw * i) / (N - 1), padT + gh - (gh * v) / 100]);
      ctx.beginPath(); curve(ctx, pts);
      ctx.strokeStyle = colors[si]; ctx.lineWidth = 2.2 * d; ctx.lineJoin = "round"; ctx.stroke();
      if (si === 0) {
        ctx.lineTo(pts[pts.length - 1][0], padT + gh); ctx.lineTo(pts[0][0], padT + gh); ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + gh);
        g.addColorStop(0, "rgba(45,140,255,0.28)"); g.addColorStop(1, "rgba(45,140,255,0)");
        ctx.fillStyle = g; ctx.fill();
      }
      const last = pts[pts.length - 1];
      ctx.beginPath(); ctx.arc(last[0], last[1], 3.5 * d, 0, Math.PI * 2); ctx.fillStyle = colors[si]; ctx.fill();
    });
  };
  const legendBody = $("#legend-body");
  const renderLegend = () => {
    legendBody.innerHTML = data.map((s, i) => {
      const avg = s.reduce((a, b) => a + b, 0) / s.length;
      return `<tr style="opacity:${visible[i] ? 1 : 0.4}"><td><span class="sw" style="background:${colors[i]}"></span>${names[i]}</td><td>${s[s.length - 1].toFixed(1)}%</td><td>${avg.toFixed(1)}%</td><td>${Math.max(...s).toFixed(1)}%</td></tr>`;
    }).join("");
  };
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.series;
    if (visible.filter(Boolean).length === 1 && visible[i]) return;
    visible[i] = !visible[i];
    b.classList.toggle("is-on", visible[i]);
    renderLegend(); drawLive();
  }));
  const tickLive = () => {
    data[0].shift();
    const prev = data[0][data[0].length - 1];
    const nv = Math.max(4, Math.min(95, prev + (Math.random() - 0.5) * 14 + (45 - prev) * 0.08));
    data[0].push(nv);
    data[1].shift(); data[1].push(nv * 0.68 + Math.random() * 2);
    data[2].shift(); data[2].push(Math.max(1, nv - data[1][data[1].length - 1] + Math.random() * 1.5));
    renderLegend(); drawLive();
  };
  renderLegend();
  new IntersectionObserver((e) => {
    liveOn = e[0].isIntersecting;
    if (liveOn && liveProgress < 1) {
      const t0 = performance.now();
      const anim = (t) => { liveProgress = reduced ? 1 : Math.min(1, (t - t0) / 1600); drawLive(); if (liveProgress < 1) requestAnimationFrame(anim); };
      requestAnimationFrame(anim);
    }
  }, { threshold: 0.2 }).observe(live);
  setInterval(() => { if (liveOn && liveProgress >= 1 && !document.hidden) tickLive(); }, 1200);

  // Gauge
  const gaugeFill = $("#gauge-fill");
  const gaugeVal = $("#gauge-value");
  const LEN = 251.3;
  let gaugeCur = 0;
  const setGauge = (v) => {
    gaugeFill.style.strokeDashoffset = String(LEN * (1 - v / 100));
    const from = gaugeCur, t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 1400); gaugeVal.textContent = (from + (v - from) * (1 - Math.pow(1 - p, 3))).toFixed(1); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    gaugeCur = v;
  };
  let gaugeTimer;
  new IntersectionObserver((e) => {
    clearInterval(gaugeTimer);
    if (!e[0].isIntersecting) return;
    setGauge(63);
    gaugeTimer = setInterval(() => setGauge(Math.round((55 + Math.random() * 20) * 10) / 10), 3200);
  }, { threshold: 0.3 }).observe(gaugeFill.closest(".panel"));

  // Mini chart in the bento card
  const mini = $("[data-mini-chart]");
  const miniData = [series(60, 40, 30, 3), series(60, 25, 20, 7)];
  let miniOff = 0;
  let miniVisible = false;
  const drawMini = () => {
    const d = sizeCanvas(mini);
    const ctx = mini.getContext("2d");
    const W = mini.width, H = mini.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = isDark() ? "rgba(148,170,205,0.1)" : "rgba(24,32,43,0.07)";
    ctx.lineWidth = d;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke(); }
    miniData.forEach((s, si) => {
      const pts = s.map((v, i) => [((i - miniOff) * W) / (s.length - 2), H - (H * v) / 100 * 0.85 - H * 0.05]);
      ctx.beginPath(); curve(ctx, pts);
      ctx.strokeStyle = si ? "#ff9f1c" : "#2d8cff"; ctx.lineWidth = 2 * d; ctx.stroke();
      if (!si) {
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(45,140,255,0.25)"); g.addColorStop(1, "rgba(45,140,255,0)");
        ctx.fillStyle = g; ctx.fill();
      }
    });
  };
  const loopMini = () => {
    if (!miniVisible) return;
    miniOff += 0.02;
    if (miniOff >= 1) {
      miniOff = 0;
      miniData.forEach((s, i) => { s.shift(); const p = s[s.length - 1]; s.push(Math.max(5, Math.min(90, p + (Math.random() - 0.5) * 16 + ((i ? 25 : 40) - p) * 0.1))); });
    }
    drawMini();
    requestAnimationFrame(loopMini);
  };
  new IntersectionObserver((e) => { miniVisible = e[0].isIntersecting; if (miniVisible) reduced ? drawMini() : loopMini(); }).observe(mini);

  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { drawLive(); drawMini(); }, 120); });
  addEventListener("themechange", () => { drawLive(); drawMini(); });

  /* ---------------------------------------------------- extension code */
  const k = (s) => `<span class="k">${s}</span>`;
  const s = (x) => `<span class="s">${x}</span>`;
  const c = (x) => `<span class="c">${x}</span>`;
  const f = (x) => `<span class="f">${x}</span>`;
  const t = (x) => `<span class="t">${x}</span>`;
  const files = {
    cargo: ["Cargo.toml", `[${t("package")}]
name    = ${s('"rassvet-ext-my-service"')}
version.workspace = ${s("true")}
edition = ${s('"2024"')}

[${t("dependencies")}]
rassvet-ext-api = { path = ${s('"../../crates/ext-api"')} }

${c("# crates/server/Cargo.toml")}
${c('# [features] ext-my-service = ["dep:rassvet-ext-my-service"]')}`],
    lib: ["src/lib.rs", `${k("use")} rassvet_ext_api::{
    ApiError, ${t("Extension")}, ${t("Manifest")}, ${t("NavItem")}, ${t("NavSection")}, ${t("RequestContext")},
    axum::{${t("Router")}, routing::get, ${t("Json")}},
};

${k("pub struct")} ${t("MyService")};

${k("impl")} ${t("Extension")} ${k("for")} ${t("MyService")} {
    ${k("fn")} ${f("manifest")}(&self) -> ${t("Manifest")} {
        ${t("Manifest")} {
            id: ${s('"my-service"')},
            name: ${s('"My Service"')},
            version: env!(${s('"CARGO_PKG_VERSION"')}),
            description: ${s('"Manage my service"')},
            ${c("// shown only where the catalog has every type")}
            service_types: &[${s('"my-service"')}],
        }
    }

    ${k("fn")} ${f("nav")}(&self) -> ${t("Vec")}&lt;${t("NavItem")}&gt; {
        vec![${t("NavItem")} {
            id: ${s('"things"')}.into(), group: ${s('"Compute"')}.into(),
            label: ${s('"Things"')}.into(), path: ${s('"/ext/my-service/things"')}.into(),
            icon: ${s('"box"')}.into(), section: ${t("NavSection")}::Project, role: ${t("None")},
        }]
    }

    ${c("// mounted at /api/ext/my-service")}
    ${k("fn")} ${f("router")}(&self) -> ${t("Router")} {
        ${t("Router")}::new().route(${s('"/things"')}, get(${f("list")}))
    }
}

${k("async fn")} ${f("list")}(ctx: ${t("RequestContext")}) -> ${t("Result")}&lt;${t("Json")}&lt;serde_json::Value&gt;, ${t("ApiError")}&gt; {
    ${k("let")} ep = ctx.${f("endpoint")}(${s('"my-service"')})?;
    ${c("// … call OpenStack with the session's token")}
}`],
    index: ["ui/index.tsx", `${k("import")} { ${k("type")} ${t("ExtensionUi")} } ${k("from")} ${s('"@rassvet/sdk"')};
${k("import")} ${t("Things")} ${k("from")} ${s('"./Things"')};
${k("import")} { palette } ${k("from")} ${s('"./palette"')};
${k("import")} { terraform } ${k("from")} ${s('"./terraform"')};
${k("import")} { cleanup } ${k("from")} ${s('"./cleanup"')};

${c("// routes are mounted at /ext/my-service/…")}
${k("const")} ui: ${t("ExtensionUi")} = {
  routes: [{ path: ${s('"things"')}, element: &lt;${t("Things")} /&gt; }],
  palette,     ${c("// ⌘K: keywords, actions, resources")}
  terraform,   ${c("// Operations › Export to Terraform")}
  cleanup,     ${c("// Operations › Cleanup")}
};

${k("export default")} ui;`],
    palette: ["ui/palette.ts", `${k("import")} { ${k("type")} ${t("PaletteContribution")}, os, tr } ${k("from")} ${s('"@rassvet/sdk"')};

${k("export const")} palette: ${t("PaletteContribution")} = {
  keywords: ${s('"thing widget my-service"')},
  actions: [
    { id: ${s('"new-thing"')}, label: ${f("tr")}(${s('"Create thing"')}), icon: ${s('"plus"')},
      path: ${s('"things?new=1"')} },
  ],
  resources: [{
    kind: ${f("tr")}(${s('"Thing"')}),
    aliases: [${s('"thing"')}, ${s('"th"')}],          ${c("// th:web")}
    icon: ${s('"box"')},
    get:  (id, c) =&gt; os.${f("get")}(${s('"ext:my-service"')}, ${s("`things/${id}`")}, ${t("undefined")}, { signal: c.signal }),
    list: () =&gt; os.${f("list")}(${s('"ext:my-service"')}, ${s('"things"')}, ${s('"things"')}),
    id:   (r) =&gt; r.id,
    path: (r, c) =&gt; ${s("`${c.base}/things/${r.id}`")},
  }],
};`],
    terraform: ["ui/terraform.ts", `${k("import")} { ${k("type")} ${t("TerraformContribution")} } ${k("from")} ${s('"@rassvet/sdk"')};

${k("export const")} terraform: ${t("TerraformContribution")} = {
  ${c("// a hook that loads resources and returns a TfSource")}
  ${f("useSource")}: ({ projectId }) =&gt; ({
    sections: [{ kind: ${s('"my-service.thing"')}, rows: things }],
    dependencies: (r) =&gt; [{ kind: ${s('"network"')}, id: r.network_id }],
    names: (r) =&gt; r.name,
    generate: (r, tf) =&gt; tf.${f("block")}(${s('"resource"')}, ${s('"my_thing"')}, r.name, {
      ...tf.${f("attrs")}({ name: tf.${f("str")}(r.name) }),
      network_id: tf.${f("network")}(r.network_id),
    }),
  }),
};`],
    cleanup: ["ui/cleanup.tsx", `${k("import")} { ${k("type")} ${t("CleanupContribution")} } ${k("from")} ${s('"@rassvet/sdk"')};

${k("export const")} cleanup: ${t("CleanupContribution")} = {
  ${c("// returns Finders: a card and the table it opens")}
  ${f("useFindings")}: (ctx) =&gt; [{
    id: ${s('"idle-things"')},
    title: ${s('"Things nobody used"')},
    rows: things.${f("filter")}((r) =&gt; ctx.${f("idle")}(r.updated_at)),
    table: ctx.${f("table")}([
      { key: ${s('"name"')}, label: ${s('"Name"')} },
      ctx.${f("projectCol")}(),
      ctx.${f("ageCol")}(${s('"updated_at"')}),
    ]),
  }],
};`],
  };
  const extCode = $("#ext-code code");
  const extName = $("#ext-file-name");
  const showFile = (key) => {
    const [name, src] = files[key];
    extName.textContent = name;
    extCode.innerHTML = src;
    // restart the fade animation
    extCode.style.animation = "none"; void extCode.offsetWidth; extCode.style.animation = "";
    $$(".tree .file").forEach((el) => el.classList.toggle("is-active", el.dataset.file === key));
  };
  $$(".tree .file").forEach((el) => {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", () => showFile(el.dataset.file));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showFile(el.dataset.file); } });
  });
  showFile("lib");

  /* ------------------------------------------------------- terminal */
  $$(".term__tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".term__tabs button").forEach((x) => x.classList.toggle("is-active", x === b));
    $$(".term pre").forEach((p) => p.classList.toggle("is-active", p.dataset.term === b.dataset.term));
  }));

  /* ----------------------------------------------------------- copy */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); return true; }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove();
      toast(ok ? "Copied to clipboard" : "Copy failed");
      return ok;
    }
  }
  const textOf = (el) => el.innerText.split("\n").map((l) => l.replace(/^\$\s/, "")).filter((l) => !/^# then open/.test(l)).join("\n").trim();
  $$("[data-copy], [data-copy-active]").forEach((b) => b.addEventListener("click", async () => {
    const src = b.hasAttribute("data-copy-active") ? $(".term pre.is-active") : $(b.dataset.copy);
    if (await copyText(textOf(src))) {
      b.classList.add("is-done"); b.textContent = "Copied ✓";
      setTimeout(() => { b.classList.remove("is-done"); b.textContent = "Copy"; }, 1600);
    }
  }));

  /* ------------------------------------------------------- lightbox */
  const lb = $("#lightbox");
  const lbImg = $("img", lb);
  function closeLightbox() { lb.hidden = true; document.body.style.overflow = ""; }
  $$("[data-lightbox]").forEach((fig) => {
    fig.tabIndex = 0;
    const openIt = () => { lbImg.src = fig.dataset.lightbox; lbImg.alt = $("img", fig).alt; lb.hidden = false; document.body.style.overflow = "hidden"; };
    fig.addEventListener("click", openIt);
    fig.addEventListener("keydown", (e) => { if (e.key === "Enter") openIt(); });
  });
  lb.addEventListener("click", closeLightbox);
})();
