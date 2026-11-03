/* Rassvet docs viewer: renders docs/project and docs/admin from the master branch on GitHub. */
(() => {
  "use strict";

  const REPO = "botranvan/rassvet";
  const BRANCH = "master";
  const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/docs/`;
  const BLOB = `https://github.com/${REPO}/blob/${BRANCH}/docs/`;
  const TREE = `https://github.com/${REPO}/tree/${BRANCH}/docs`;
  const SECTIONS = [
    { id: "project", title: "Project guides", blurb: "For everyone who works inside a project." },
    { id: "admin", title: "Admin guides", blurb: "For users with the admin role who run the cloud." },
  ];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const md = (src) => DOMPurify.sanitize(marked.parse(src, { gfm: true }), { ADD_ATTR: ["target"] });
  const mdInline = (src) => DOMPurify.sanitize(marked.parseInline(src, { gfm: true }));
  const ICON = {
    edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    gh: '<svg viewBox="0 0 24 24"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.3 6.4-1.5 6.4-7A5.4 5.4 0 0 0 20 4.8 5 5 0 0 0 19.9 1S18.7.7 16 2.5a13.4 13.4 0 0 0-7 0C6.3.7 5.1 1 5.1 1A5 5 0 0 0 5 4.8a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.3 6.6 6.4 7A3.4 3.4 0 0 0 9 18.1V22"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  const side = $("#docs-side");
  const nav = $("#docs-nav");
  const filter = $("#docs-filter");
  const content = $("#docs-content");
  const crumbs = $("#docs-crumbs");
  const actions = $("#docs-actions");
  const pager = $("#docs-pager");
  const toc = $("#docs-toc");
  const toggle = $("#docs-toggle");

  /* ------------------------------------------------------------ fetching */
  const cache = new Map();
  const fetchText = (path) => {
    if (!cache.has(path)) {
      cache.set(path, fetch(RAW + path).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText || "error"} for docs/${path}`);
        return r.text();
      }).catch((e) => { cache.delete(path); throw e; }));
    }
    return cache.get(path);
  };

  /* The guide list comes from the tables in docs/README.md. */
  const parseIndex = (src) => {
    const guides = [];
    const intro = [];
    let sec = null;
    let seenH2 = false;
    for (const line of src.split("\n")) {
      const h2 = line.match(/^##\s+(.*)/);
      if (h2) { seenH2 = true; sec = /project/i.test(h2[1]) ? "project" : /admin/i.test(h2[1]) ? "admin" : null; continue; }
      if (!seenH2 && !/^#\s/.test(line)) { intro.push(line); continue; }
      const m = sec && line.match(/^\|\s*(\d+)\s*\|\s*\[([^\]]+)\]\((project|admin)\/([^)#\s]+)\.md\)\s*\|\s*(.*?)\s*\|\s*$/);
      if (m) guides.push({ n: +m[1], title: m[2], section: m[3], slug: m[4], learn: m[5] });
    }
    // Drop the bullet list that only links to the folders.
    const introMd = intro.join("\n").replace(/^- \*\*(Project|Admin) guides\*\*.*$/gim, "").trim();
    return { guides, introMd };
  };

  let index = null; // { guides, introMd }
  const key = (g) => `${g.section}/${g.slug}`;
  const routeOf = (g, anchor) => `#/${key(g)}${anchor ? "#" + anchor : ""}`;
  const findGuide = (section, slug) => index && index.guides.find((g) => g.section === section && g.slug === slug);

  /* ---------------------------------------------------------- sidebar */
  const renderNav = () => {
    nav.innerHTML = SECTIONS.map((s) => {
      const items = index.guides.filter((g) => g.section === s.id);
      return `<div class="docs__group" data-group="${s.id}">
        <button class="docs__group-h" aria-expanded="true">${s.id === "admin" ? ICON.shield : ICON.user}<span>${s.title}</span><em>${items.length}</em>${ICON.chev}</button>
        <ul>${items.map((g) => `<li><a href="${routeOf(g)}" data-key="${key(g)}" data-text="${esc((g.title + " " + g.learn).toLowerCase())}"><span class="n">${String(g.n).padStart(2, "0")}</span><span>${esc(g.title)}</span></a></li>`).join("")}</ul>
      </div>`;
    }).join("") + '<p class="docs__none" hidden>No guides match.</p>';
    $$(".docs__group-h", nav).forEach((b) => b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      b.parentElement.classList.toggle("is-collapsed", !open);
      b.parentElement.dataset.user = "1"; // the reader chose; stop auto-folding it
    }));
    // Warm the cache when a link is about to be clicked.
    nav.addEventListener("pointerover", (e) => { const a = e.target.closest("a[data-key]"); if (a) fetchText(a.dataset.key + ".md").catch(() => {}); });
  };
  const markActive = (k) => {
    $$("a[data-key]", nav).forEach((a) => a.classList.toggle("is-active", a.dataset.key === k));
    $(".docs__home-link").classList.toggle("is-active", !k);
    // Keep the sidebar short: show the open guide's group, fold the other one.
    $$(".docs__group", nav).forEach((grp) => {
      if (grp.dataset.user || filter.value) return;
      const fold = !!k && !grp.querySelector(`a[data-key="${k}"]`);
      grp.classList.toggle("is-collapsed", fold);
      grp.querySelector(".docs__group-h").setAttribute("aria-expanded", String(!fold));
    });
    const active = $("a.is-active", nav);
    if (active) {
      active.closest(".docs__group").classList.remove("is-collapsed");
      active.closest(".docs__group").querySelector(".docs__group-h").setAttribute("aria-expanded", "true");
      const r = active.getBoundingClientRect(), sr = side.getBoundingClientRect();
      if (r.top < sr.top || r.bottom > sr.bottom) active.scrollIntoView({ block: "center" });
    }
  };
  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    $$(".docs__group", nav).forEach((grp) => {
      let n = 0;
      $$("a[data-key]", grp).forEach((a) => { const ok = !q || a.dataset.text.includes(q); a.parentElement.hidden = !ok; n += ok; });
      grp.hidden = !n;
      if (q && n) grp.classList.remove("is-collapsed");
      shown += n;
    });
    $(".docs__none", nav).hidden = shown > 0;
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = $$("a[data-key]", nav).find((a) => !a.parentElement.hidden); if (first) location.hash = first.getAttribute("href"); }
    if (e.key === "Escape") { filter.value = ""; filter.dispatchEvent(new Event("input")); }
  });

  // Mobile drawer
  const setDrawer = (open) => {
    side.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("docs-drawer-open", open);
  };
  toggle.addEventListener("click", () => setDrawer(!side.classList.contains("is-open")));
  side.addEventListener("click", (e) => { if (e.target.closest("a")) setDrawer(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side.classList.contains("is-open")) setDrawer(false); });

  /* -------------------------------------------------- content helpers */
  const slugify = (t) => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
  const setCrumbs = (items) => {
    crumbs.innerHTML = items.map(([label, href]) => `<li>${href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`}</li>`).join("");
  };
  const loading = () => {
    content.innerHTML = '<div class="docs__skel docs__skel--page"><i></i><i></i><i></i><i></i><i></i></div>';
    toc.innerHTML = "";
    pager.innerHTML = "";
  };
  const showError = (err, retry) => {
    content.innerHTML = `<div class="docs__error">
      <h2>Couldn't load this page</h2>
      <p>The docs are read live from the <code>${BRANCH}</code> branch on GitHub, and that request failed.</p>
      <pre><code>${esc(err.message || err)}</code></pre>
      <div class="docs__error-actions"><button class="btn btn--primary btn--sm" id="docs-retry">Try again</button>
      <a class="btn btn--ghost btn--sm" href="${TREE}" target="_blank" rel="noopener">${ICON.gh} Open on GitHub</a></div>
    </div>`;
    $("#docs-retry").addEventListener("click", retry);
  };
  const openLightbox = (src, alt) => {
    const lb = $("#lightbox");
    if (!lb) return;
    const img = $("img", lb);
    img.src = src; img.alt = alt || "";
    lb.hidden = false;
    document.body.style.overflow = "hidden";
  };

  /* Turn rendered markdown into site-friendly HTML: links, images, tables, code. */
  const enhance = (root, g) => {
    const base = BLOB + g.section + "/";
    const used = new Set();
    $$("h1, h2, h3, h4", root).forEach((h) => {
      let id = slugify(h.textContent) || "section";
      let n = 1;
      while (used.has(id)) id = `${slugify(h.textContent)}-${n++}`;
      used.add(id);
      h.id = id;
      if (h.tagName !== "H1") h.insertAdjacentHTML("beforeend", ` <a class="h-anchor" href="${routeOf(g, id)}" aria-label="Link to this section">#</a>`);
    });

    $$("a[href]", root).forEach((a) => {
      if (a.classList.contains("h-anchor")) return;
      const raw = a.getAttribute("href");
      if (raw.startsWith("#")) { a.setAttribute("href", routeOf(g, raw.slice(1))); return; }
      if (/^(https?:)?\/\//i.test(raw) || /^mailto:/i.test(raw)) { a.target = "_blank"; a.rel = "noopener"; return; }
      const u = new URL(raw, base);
      const m = u.pathname.match(/\/docs\/(project|admin)\/([^/]+)\.md$/);
      if (m) { a.setAttribute("href", `#/${m[1]}/${m[2]}${u.hash}`); return; }
      if (/\/docs\/(README\.md)?$/.test(u.pathname)) { a.setAttribute("href", "#/"); return; }
      a.href = u.href; a.target = "_blank"; a.rel = "noopener";
    });

    $$("img[src]", root).forEach((img) => {
      const raw = img.getAttribute("src");
      if (!/^(https?:)?\/\//i.test(raw) && !raw.startsWith("data:")) img.src = new URL(raw, RAW + g.section + "/").href;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
      img.addEventListener("click", () => openLightbox(img.src, img.alt));
      // A paragraph holding only an image becomes a figure with a caption.
      const p = img.parentElement;
      if (p.tagName === "P" && p.childNodes.length === 1) {
        const fig = document.createElement("figure");
        fig.className = "docs__fig";
        p.replaceWith(fig);
        fig.appendChild(img);
        if (img.alt) fig.insertAdjacentHTML("beforeend", `<figcaption>${esc(img.alt)}</figcaption>`);
      }
    });

    $$("table", root).forEach((t) => {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });

    $$("pre", root).forEach((pre) => {
      const code = $("code", pre);
      const lang = (code && (code.className.match(/language-(\S+)/) || [])[1]) || "";
      const head = document.createElement("div");
      head.className = "docs__code-bar";
      head.innerHTML = `<span>${esc(lang || "text")}</span><button class="copy" type="button">Copy</button>`;
      const box = document.createElement("div");
      box.className = "docs__code";
      pre.replaceWith(box);
      box.append(head, pre);
      $("button", head).addEventListener("click", async (e) => {
        const b = e.currentTarget;
        await window.rassvet?.copyText(pre.innerText.trim());
        b.classList.add("is-done"); b.textContent = "Copied ✓";
        setTimeout(() => { b.classList.remove("is-done"); b.textContent = "Copy"; }, 1500);
      });
    });
  };

  /* --------------------------------------------------- table of contents */
  let tocObserver;
  const buildToc = (g) => {
    tocObserver?.disconnect();
    const hs = $$("h2, h3", content);
    if (hs.length < 2) { toc.innerHTML = ""; return; }
    toc.innerHTML = `<div class="docs__toc-h">On this page</div><ul>${hs.map((h) =>
      `<li class="lvl-${h.tagName[1]}"><a href="${routeOf(g, h.id)}" data-id="${h.id}">${esc(h.textContent.replace(/\s*#$/, "").trim())}</a></li>`).join("")}</ul>
      <a class="docs__toc-top" href="#/${key(g)}">↑ Back to top</a>`;
    const links = new Map($$("a[data-id]", toc).map((a) => [a.dataset.id, a]));
    const visible = new Set();
    tocObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)));
      const first = hs.find((h) => visible.has(h.id));
      if (first) links.forEach((a, id) => a.classList.toggle("is-active", id === first.id));
    }, { rootMargin: "-80px 0px -65% 0px" });
    hs.forEach((h) => tocObserver.observe(h));
  };

  const scrollToAnchor = (anchor, smooth) => {
    const el = anchor && document.getElementById(anchor);
    if (el) {
      const y = el.getBoundingClientRect().top + scrollY - 88;
      scrollTo({ top: y, behavior: smooth && !reduced ? "smooth" : "auto" });
    } else {
      scrollTo({ top: 0, behavior: "auto" });
    }
  };

  /* ------------------------------------------------------------- views */
  let currentKey = null;
  let renderToken = 0;

  const showHome = () => {
    currentKey = "";
    markActive("");
    document.title = "Docs · Rassvet";
    setCrumbs([["Docs"]]);
    actions.innerHTML = `<a class="docs__act" href="${TREE}" target="_blank" rel="noopener">${ICON.gh}<span>View on GitHub</span></a>`;
    toc.innerHTML = "";
    pager.innerHTML = "";
    content.innerHTML = `<div class="docs__home">
      <span class="eyebrow">User guide</span>
      <h1>Rassvet <span class="grad">user guide</span></h1>
      <div class="docs__intro">${md(index.introMd)}</div>
      ${SECTIONS.map((s) => {
        const items = index.guides.filter((g) => g.section === s.id);
        return `<section class="docs__sec">
          <header><div class="docs__sec-i">${s.id === "admin" ? ICON.shield : ICON.user}</div><div><h2>${s.title}</h2><p>${s.blurb}</p></div></header>
          <div class="docs__cards">${items.map((g) => `<a class="docs__card spot" href="${routeOf(g)}">
            <span class="n">${String(g.n).padStart(2, "0")}</span>
            <b>${esc(g.title)}</b>
            <small>You will learn to ${mdInline(g.learn)}</small>
            <i>${ICON.arrow}</i></a>`).join("")}</div>
        </section>`;
      }).join("")}
    </div>`;
    $$(".docs__card", content).forEach((c) => c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--x", `${e.clientX - r.left}px`);
      c.style.setProperty("--y", `${e.clientY - r.top}px`);
    }));
    scrollTo({ top: 0, behavior: "auto" });
  };

  const showGuide = async (g, anchor) => {
    const k = key(g);
    if (currentKey === k) { scrollToAnchor(anchor, true); return; }
    const token = ++renderToken;
    currentKey = k;
    markActive(k);
    const sec = SECTIONS.find((s) => s.id === g.section);
    setCrumbs([["Docs", "#/"], [sec.title, "#/"], [g.title]]);
    actions.innerHTML = `<a class="docs__act" href="${BLOB}${k}.md" target="_blank" rel="noopener">${ICON.edit}<span>Edit on GitHub</span></a>`;
    loading();
    let src;
    try {
      src = await fetchText(k + ".md");
    } catch (err) {
      if (token !== renderToken) return;
      currentKey = null;
      showError(err, () => showGuide(g, anchor));
      return;
    }
    if (token !== renderToken) return;

    content.innerHTML = `<div class="prose">${md(src)}</div>`;
    enhance(content, g);
    const h1 = $("h1", content);
    const words = content.textContent.trim().split(/\s+/).length;
    if (h1) {
      h1.insertAdjacentHTML("afterend", `<div class="docs__meta"><span class="docs__tag docs__tag--${g.section}">${g.section === "admin" ? ICON.shield : ICON.user}${sec.title.replace(" guides", "")}</span><span>${ICON.clock}${Math.max(1, Math.round(words / 200))} min read</span></div>`);
    }
    document.title = `${g.title} · Docs · Rassvet`;

    const list = index.guides;
    const i = list.indexOf(g);
    const prev = list[i - 1], next = list[i + 1];
    pager.innerHTML =
      (prev ? `<a class="pager__link" href="${routeOf(prev)}"><small>← Previous</small><b>${esc(prev.title)}</b></a>` : `<a class="pager__link" href="#/"><small>← Back to</small><b>Overview</b></a>`) +
      (next ? `<a class="pager__link pager__link--next" href="${routeOf(next)}"><small>Next →</small><b>${esc(next.title)}</b></a>` : `<a class="pager__link pager__link--next" href="#/"><small>Back to →</small><b>Overview</b></a>`);

    buildToc(g);
    requestAnimationFrame(() => scrollToAnchor(anchor, false));
    if (next) fetchText(key(next) + ".md").catch(() => {});
  };

  const route = () => {
    if (!index) return;
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    const [path, anchor] = h.split("#");
    const [section, slug] = (path || "").split("/");
    const g = findGuide(section, slug);
    if (g) showGuide(g, anchor);
    else if (section && slug) {
      currentKey = null;
      markActive(null);
      setCrumbs([["Docs", "#/"], ["Not found"]]);
      content.innerHTML = `<div class="docs__error"><h2>Guide not found</h2><p>There is no guide at <code>${esc(path)}</code>.</p><a class="btn btn--primary btn--sm" href="#/">Back to the overview</a></div>`;
      toc.innerHTML = ""; pager.innerHTML = "";
    } else showHome();
  };

  // Clicking a heading anchor or ToC entry of the open guide only scrolls.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = a.getAttribute("href");
    const [path, anchor] = target.replace(/^#\/?/, "").split("#");
    if (currentKey && path === currentKey && anchor) {
      e.preventDefault();
      history.replaceState(null, "", target);
      scrollToAnchor(anchor, true);
    }
  });
  addEventListener("hashchange", route);

  /* -------------------------------------------------------------- start */
  const start = async () => {
    try {
      if (!window.marked || !window.DOMPurify) throw new Error("The Markdown renderer did not load.");
      index = parseIndex(await fetchText("README.md"));
      if (!index.guides.length) throw new Error("No guides were found in docs/README.md.");
    } catch (err) {
      nav.innerHTML = "";
      showError(err, () => { cache.clear(); start(); });
      return;
    }
    renderNav();
    window.rassvet?.addCommands(index.guides.map((g) => ({
      g: g.section === "admin" ? "Admin guides" : "Project guides",
      i: "book", l: g.title, k: `${g.learn} docs guide`,
      run: () => { location.hash = routeOf(g); },
    })));
    route();
  };
  start();
})();
