// cairn-nas front end. The server (src/main.rs) collects the data and runs a
// closed list of validated actions; this page parses, renders, and saves the
// UI state (custom names + colour tags) through /api/ui.
// The server CSP forbids inline styles: colours and widths go through
// data-color / data-w attributes applied by paint() via the CSSOM.
"use strict";

const FAST_MS = 2000;   // CPU, RAM, network, disks, temperatures
const SLOW_MS = 15000;  // ZFS, NFS, services, addresses, SMART (cached 5 min server-side)
const HIST = 90;        // sparkline points (3 min at 2 s)
const ENTER_MS = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650; // view entrance (400 ms + 200 ms of stagger, panel.css); renders wait for it
const COMPRESSION = ["lz4", "zstd", "zstd-fast", "gzip", "off"];
// UI strings are English sources translated where they are used (t(), i18n.js), so a language switch applies at once.
const PALETTE = [["#16181d", "Black"], ["#e5484d", "Red"], ["#f76b15", "Orange"], ["#f5c518", "Yellow"],
  ["#30a46c", "Green"], ["#0090ff", "Blue"], ["#8e4ec6", "Purple"], ["#e93d82", "Pink"], ["#8b8d98", "Grey"]];
const VIEWS = { overview: "Overview", systeme: "System", reseau: "Network", disques: "Disks",
  stockage: "Storage", sauvegarde: "Backup", machines: "Machines", partages: "Shares", comptes: "Accounts", services: "Services" };

let CFG = { nics: [], hosts: {}, services: [] };
let UI = { labels: {}, tags: {}, assign: {} };
const hist = { cpu: [], net: {}, disk: {} };
let prev = null, F = null, S = null, P = null, animUntil = 0, VIEW = null;
const openGroups = new Set();
// Machine selector: "" = this machine; else a peer's name, whose page data this
// server relays (/api/peer/<name>/…), read-only.
const MACHINE = new URLSearchParams(location.search).get("m") || "";
const REMOTE_PATHS = ["/api/config", "/api/fast", "/api/slow"];

/* ---------- helpers ---------- */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (n, d = 1) => Number(n).toLocaleString(LOCALE(), { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
const last = arr => (arr && arr.length ? arr[arr.length - 1] : 0);

function bytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return nf(n, i ? 1 : 0) + " " + t(u[i]);
}
function bits(bps) {
  const u = ["b/s", "Kb/s", "Mb/s", "Gb/s"];
  let i = 0;
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
  return nf(bps, i ? 1 : 0) + " " + t(u[i]);
}
function duration(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? t("{d} d", { d }) + " " : "") + h + " h " + String(m).padStart(2, "0");
}
const lvlTemp = c => (c >= 80 ? "bad" : c >= 65 ? "warn" : "ok");

// Element-wise sum of series of possibly different lengths, right-aligned.
function sumSeries(list) {
  const n = Math.max(0, ...list.map(s => s.length));
  return Array.from({ length: n }, (_, i) => list.reduce((acc, s) => acc + (s[s.length - n + i] || 0), 0));
}

// SVG sparkline: one line per series (or a filled area), stretched over the full width
// while the history fills up (a 3-point series would otherwise be a dot at the right edge).
function spark(series, floor = 1, area = false) {
  const max = Math.max(floor, ...series.flat());
  const pts = s => s.map((v, i) => (s.length > 1 ? i * 100 / (s.length - 1) : 100).toFixed(1) + "," + (30 - v / max * 28).toFixed(1));
  return '<svg class="spark' + (area ? " area" : "") + '" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' +
    series.map((s, i) => {
      const p = pts(s);
      if (!p.length) return "";
      const line = "M" + p.join("L");
      return (area ? '<path class="fill s' + i + '" d="' + line + "L100,30L" + p[0].split(",")[0] + ',30Z"/>' : "") +
        '<path class="s' + i + '" d="' + line + '"/>';
    }).join("") + "</svg>";
}

function paint(root = document) {
  root.querySelectorAll("[data-color]").forEach(e => e.style.setProperty("--tag", e.dataset.color));
  root.querySelectorAll("[data-w]").forEach(e => { e.style.width = clamp(Number(e.dataset.w)) + "%"; });
  // Column names on the cells: on phones each table row becomes a card that labels its values.
  root.querySelectorAll("table").forEach(t => {
    const head = [...t.querySelectorAll("thead th")].map(th => th.textContent);
    if (head.length) t.querySelectorAll("tbody tr").forEach(r => [...r.cells].forEach((c, i) => { if (head[i]) c.dataset.label = head[i]; }));
  });
}

// kind "read": a polling error, cleared by the next successful read (a network blip must not stick).
function banner(msg, kind = "") {
  $("banner").hidden = !msg;
  $("banner").textContent = msg || "";
  $("banner").dataset.kind = kind;
}
const readOk = () => { if ($("banner").dataset.kind === "read") banner(""); };
const cssMs = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast t-toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.append(t);
  void t.offsetWidth; // start from the closed state so the rise runs
  t.classList.add("is-open");
  setTimeout(() => { t.classList.remove("is-open"); setTimeout(() => t.remove(), cssMs("--toast-close")); }, 3000);
}

// Accept-Language: the server answers its error messages in the page's language.
async function get(path) {
  if (MACHINE && REMOTE_PATHS.includes(path)) path = "/api/peer/" + encodeURIComponent(MACHINE) + path.slice(4);
  const r = await fetch(path, { cache: "no-store", redirect: "manual", headers: { "Accept-Language": LANG } });
  // Session expired: back to the sign-in form (built-in 401, or the proxy's redirect to its portal).
  if ((r.status === 401 && S) || r.type === "opaqueredirect") location.reload();
  if (!r.ok) throw Object.assign(new Error(r.status + " " + (await r.text())), { status: r.status });
  return r.text();
}
async function post(path, payload) {
  if (MACHINE && path !== "/api/logout") throw new Error(t("Read-only: this is another machine. Open its own page to change it."));
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": LANG }, body: JSON.stringify(payload), redirect: "manual" });
  if (r.type === "opaqueredirect") location.reload();
  const res = await r.json().catch(() => ({ error: r.status + " " + r.statusText }));
  if (!r.ok) throw new Error(res.error || r.status);
  return res;
}
// "@@" lines separate command outputs; an empty output stays an empty section.
const sections = out => out.split(/^@@\n/m);

/* ---------- names and colour tags ---------- */

const tagOf = key => UI.tags[UI.assign[key]];
const tagAttr = key => { const t = tagOf(key); return t ? ' data-color="' + esc(t.color) + '"' : ""; };
function dot(key) {
  const t = tagOf(key);
  return t ? '<span class="tagdot" data-color="' + esc(t.color) + '" title="' + esc(t.name) + '"></span>' : "";
}
// Custom name in bold, the system name small and grey next to it once renamed.
function nameBlock(key, sys, def) {
  const custom = UI.labels[key];
  return '<div class="name">' + dot(key) + "<b>" + esc(custom || def || sys) + "</b>" +
    (custom ? '<small class="sys">' + esc(sys) + "</small>" : "") +
    '<button class="icon" data-edit-item="' + esc(key) + '" data-sys="' + esc(sys) + '" title="' + t("Rename, tag") + '" aria-label="' + t("Rename {name}", { name: esc(sys) }) + '">✎</button></div>';
}
// Items sharing a tag are kept together (tag order, then original order).
function byTag(keys, keyOf) {
  const order = Object.keys(UI.tags);
  const rank = k => { const i = order.indexOf(UI.assign[keyOf(k)]); return i < 0 ? order.length : i; };
  return keys.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

function tagRadios(cur) {
  const tags = Object.entries(UI.tags);
  return '<label class="swatch"><input type="radio" name="tag" value=""' + (cur ? "" : " checked") + '><span class="tagdot none"></span>' + t("None") + "</label>" +
    tags.map(([id, t]) => '<label class="swatch"><input type="radio" name="tag" value="' + esc(id) + '"' + (cur === id ? " checked" : "") +
      '><span class="tagdot" data-color="' + esc(t.color) + '"></span>' + esc(t.name) + "</label>").join("") +
    (tags.length ? "" : '<p class="sub">' + t("No tags yet: use the “Tags…” button in the sidebar.") + "</p>");
}

async function editItem(key, sys) {
  const fd = await ask(t("Appearance of {name}", { name: sys }),
    "<label>" + t("Display name") + '<input name="label" maxlength="64" placeholder="' + esc(sys) + '" value="' + esc(UI.labels[key] || "") + '"></label>' +
    '<fieldset class="swatches"><legend>' + t("Tag") + "</legend>" + tagRadios(UI.assign[key]) + "</fieldset>" +
    '<p class="sub">' + t("Empty = system name. The system name stays shown in small print next to it.") + "</p>");
  if (!fd) return;
  const label = fd.get("label").trim(), tag = fd.get("tag");
  if (label) UI.labels[key] = label; else delete UI.labels[key];
  if (tag) UI.assign[key] = tag; else delete UI.assign[key];
  saveUI();
}

async function manageTags() {
  const tags = Object.entries(UI.tags);
  const fd = await ask(t("Tags"),
    (tags.length ? '<fieldset class="swatches"><legend>' + t("Existing (tick to delete)") + "</legend>" + tags.map(([id, t]) =>
      '<label class="swatch"><input type="checkbox" name="del" value="' + esc(id) + '"><span class="tagdot" data-color="' + esc(t.color) + '"></span>' +
      esc(t.name) + "</label>").join("") + "</fieldset>" : "") +
    "<label>" + t("New tag") + '<input name="name" maxlength="32" placeholder="' + t("e.g. Proxmox node") + '"></label>' +
    '<fieldset class="swatches palette"><legend>' + t("Colour") + "</legend>" + PALETTE.map(([c, n], i) =>
      '<label class="swatch" title="' + t(n) + '"><input type="radio" name="color" value="' + c + '"' + (i ? "" : " checked") +
      '><span class="tagdot" data-color="' + c + '"></span></label>').join("") + "</fieldset>", t("Save"));
  if (!fd) return;
  for (const id of fd.getAll("del")) {
    delete UI.tags[id];
    for (const k in UI.assign) if (UI.assign[k] === id) delete UI.assign[k];
  }
  const name = fd.get("name").trim();
  if (name) UI.tags["t" + Date.now()] = { name, color: fd.get("color") };
  saveUI();
}

async function saveUI() {
  try {
    await post("/api/ui", UI);
    toast(t("Saved"));
    banner("");
  } catch (e) { banner(t("Could not save: {err}", { err: e.message })); }
  render(true);
}

/* ---------- dialog ---------- */

// Native <dialog>; resolves with the FormData, or null if cancelled.
function ask(title, bodyHtml, okLabel = t("OK"), danger = false) {
  const d = $("dlg");
  $("dlg-title").textContent = title;
  $("dlg-body").innerHTML = bodyHtml;
  paint($("dlg-body"));
  $("dlg-ok").textContent = okLabel;
  $("dlg-ok").className = danger ? "danger" : "primary";
  d.classList.remove("is-closing");
  d.showModal();
  void d.offsetWidth; // from the pre-open scale, not from wherever the last close stopped
  d.classList.add("is-open");
  return new Promise(res => d.addEventListener("close", () =>
    res(d.returnValue === "ok" ? new FormData(d.querySelector("form")) : null), { once: true }));
}

// Closing plays the scale-down first: submit (after validation) and Escape are held, then close(value).
function closeDialog(value) {
  const d = $("dlg");
  if (!d.classList.contains("is-open")) return;
  d.classList.replace("is-open", "is-closing");
  setTimeout(() => { d.classList.remove("is-closing"); d.close(value); }, cssMs("--modal-close-dur"));
}
$("dlg").querySelector("form").addEventListener("submit", e => { e.preventDefault(); closeDialog(e.submitter ? e.submitter.value : "ok"); });
$("dlg").addEventListener("cancel", e => { e.preventDefault(); closeDialog("cancel"); });
// Cancel is not a submit button: Enter in a field submits with OK, the default button.
$("dlg-cancel").addEventListener("click", () => closeDialog("cancel"));

/* ---------- views ---------- */

function show(view) {
  if (!VIEWS[view]) view = "overview";
  document.querySelectorAll(".view").forEach(s => {
    const on = s.dataset.view === view;
    s.hidden = !on;
    s.classList.toggle("enter", on);
  });
  document.querySelectorAll("#nav button").forEach(b => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  $("view-title").textContent = t(VIEWS[view]);
  VIEW = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
  render(true);
  animUntil = Date.now() + ENTER_MS;
  clearTimeout(show.timer);
  show.timer = setTimeout(() => document.querySelectorAll(".view.enter").forEach(s => s.classList.remove("enter")), ENTER_MS);
}

/* ---------- fast loop ---------- */

function fastTick() {
  get("/api/fast").then(out => {
    const [cpus, mem, netdev, diskstats, arc, temps, misc, fanLines = ""] = sections(out);
    const now = Date.now() / 1000;
    const cpu = cpus.trim().split("\n").map(l => {
      const c = l.trim().split(/\s+/).slice(1, 9).map(Number);
      return { total: c.reduce((a, b) => a + b, 0), idle: c[3] + c[4] };
    });
    const m = Object.fromEntries(mem.trim().split("\n").map(l => { const [k, v] = l.split(/:\s+/); return [k, parseInt(v) * 1024]; }));
    const a = Object.fromEntries(arc.trim().split("\n").filter(Boolean).map(l => { const p = l.trim().split(/\s+/); return [p[0], Number(p[2])]; }));
    const net = {};
    netdev.split("\n").slice(2).forEach(l => {
      const [name, rest] = l.split(":");
      if (!rest) return;
      const f = rest.trim().split(/\s+/).map(Number);
      net[name.trim()] = { rx: f[0], tx: f[8] };
    });
    const disk = {};
    diskstats.trim().split("\n").forEach(l => {
      const f = l.trim().split(/\s+/);
      if (/^(nvme\d+n\d+|sd[a-z]+)$/.test(f[2])) disk[f[2]] = { r: Number(f[5]) * 512, w: Number(f[9]) * 512 };
    });

    let cores = F ? F.cores : [];
    if (prev) {
      const dt = now - prev.t;
      const busy = (c, p) => (c.total > p.total ? 100 * (1 - (c.idle - p.idle) / (c.total - p.total)) : 0);
      if (cpu[0].total > prev.cpu[0].total) push(hist.cpu, busy(cpu[0], prev.cpu[0]));
      cores = cpu.slice(1).map((c, i) => (prev.cpu[i + 1] ? busy(c, prev.cpu[i + 1]) : 0));
      for (const n in net) {
        if (!prev.net[n]) continue;
        const h = hist.net[n] = hist.net[n] || { rx: [], tx: [] };
        push(h.rx, Math.max(0, (net[n].rx - prev.net[n].rx) * 8 / dt));
        push(h.tx, Math.max(0, (net[n].tx - prev.net[n].tx) * 8 / dt));
      }
      for (const d in disk) {
        if (!prev.disk[d]) continue;
        const h = hist.disk[d] = hist.disk[d] || { r: [], w: [] };
        push(h.r, Math.max(0, (disk[d].r - prev.disk[d].r) / dt));
        push(h.w, Math.max(0, (disk[d].w - prev.disk[d].w) / dt));
      }
    }
    prev = { t: now, cpu, net, disk };

    const t = temps.trim().split("\n").filter(Boolean).map(l => { const [name, dev, label, v] = l.split("|"); return { name, dev, label, c: Number(v) / 1000 }; });
    const core = t.filter(x => x.name === "coretemp" || x.name === "k10temp");
    const pkg = core.find(x => /Package|Tctl/.test(x.label));
    const [load, up] = misc.trim().split("\n");
    F = {
      m, a, cores, temps: t,
      fans: fanLines.trim().split("\n").filter(Boolean).map(l => { const i = l.lastIndexOf("|"); return [l.slice(0, i), Number(l.slice(i + 1))]; }),
      cpuT: pkg ? pkg.c : Math.max(0, ...core.map(x => x.c)),
      nvmeT: Object.fromEntries(t.filter(x => x.name === "nvme" && x.label === "Composite").map(x => [x.dev + "n1", x.c])),
      load: load.split(" ").slice(0, 3).map(Number), up: Number(up.split(" ")[0]),
    };
    readOk();
    render();
  }).catch(e => banner(t("Read failed: {err}", { err: e.message }), "read"));
}

/* ---------- slow loop ---------- */

function slowTick() {
  const f = FEAT();
  // Separate: the server answers from memory, but a failure here must not hide the rest.
  if (f.peers) get("/api/peers").then(x => { P = JSON.parse(x); render(true); }).catch(() => { P = null; });
  const manage = f.nfs || f.smb || f.users || f.pools || f.vdevs || f.disks || f.replication || f.iscsi || f.schedules || f.encryption || f.offsite ? get("/api/manage") : Promise.resolve("");
  return Promise.all([get("/api/slow"), manage]).then(([out, man]) => {
    if (man) M = JSON.parse(man);
    const [hk, pool, status, ds, snaps, ss, svc, ipj, speeds, models, exports, byid, health, repl] = sections(out);
    const [host, kernel] = hk.trim().split("\n");
    const addrs = {};
    JSON.parse(ipj || "[]").forEach(i => {
      addrs[i.ifname] = { up: i.operstate === "UP", ips: i.addr_info.filter(x => x.family === "inet").map(x => x.local + "/" + x.prefixlen) };
    });
    S = {
      host, kernel, status, addrs,
      // Every imported pool, in zpool order: "name\tprop\tvalue\tsource".
      pools: pool.trim().split("\n").filter(Boolean).reduce((acc, l) => {
        const f = l.split("\t");
        (acc[f[0]] = acc[f[0]] || { name: f[0] })[f[1]] = isNaN(f[2]) ? f[2] : Number(f[2]);
        return acc;
      }, {}),
      statusOf: Object.fromEntries(status.split(/^\s*pool: /m).slice(1).map(b => [b.split("\n")[0].trim(), b])),
      // name used avail refer ratio compression recordsize quota mountpoint auto-snapshot type volsize volblocksize
      datasets: ds.trim() ? ds.trim().split("\n").map(l => l.split("\t")) : [],
      snapshots: snaps.trim() ? snaps.trim().split("\n").map(l => l.split("\t")) : [],
      connected: new Set(ss.trim().split("\n").filter(Boolean).map(l => l.trim().split(/\s+/).at(-1).replace(/:\d+$/, ""))),
      services: svc.trim().split("\n").filter(Boolean).map(l => l.split(" ")),
      speeds: Object.fromEntries(speeds.trim().split("\n").map(l => { const [n, s] = l.split(" "); return [n, Number(s)]; })),
      model: Object.fromEntries(models.trim().split("\n").filter(Boolean).map(l => l.split("|").map(s => s.trim()))),
      exports: exports.trim().split("\n").filter(l => l.trim()),
      byid: Object.fromEntries(byid.trim().split("\n").filter(Boolean).map(l => l.split("|"))),
      // Replicated datasets: "dataset\tlast snapshot (s)\tage (s)\tmax age (s)", "-" when never.
      replication: (repl || "").trim().split("\n").filter(Boolean).map(l => l.split("\t")),
      health: Object.fromEntries((health || "").trim().split("\n").filter(Boolean).map(l => { const h = JSON.parse(l); return [h.dev, h]; })),
    };
    readOk();
    render(true);
  }).catch(e => banner(t("Could not read ZFS/services: {err}", { err: e.message }), "read"));
}

/* ---------- rendering ---------- */

function render(force = false) {
  if (!F || !S) return;
  if (!force && Date.now() < animUntil) return; // let the entrance animation finish
  const f = document.activeElement, sig = e => e.tagName + JSON.stringify(e.dataset) + e.textContent;
  const was = f && f !== document.body && f.closest("main") ? sig(f) : null;
  renderChrome(); renderOverview(); renderSystem(); renderNet(); renderDisks(); renderStorage(); renderBackup(); renderMachines(); renderNfs(); renderShares(); renderAccounts(); renderServices(); renderAlerts(); renderJournal();
  paint();
  if (was && !f.isConnected) [...document.querySelectorAll("main button, main summary")].find(e => sig(e) === was)?.focus({ preventScroll: true });
}

function healthOf(h) {
  if (!h) return { lvl: "unk", txt: t("unknown") };
  if (h.passed === false || h.critical > 0 || h.media_errors > 0 || (h.spare != null && h.spare_thr != null && h.spare <= h.spare_thr) || (h.selftest && h.selftest.passed === false))
    return { lvl: "bad", txt: t("critical") };
  if (h.used >= 80 || h.temp >= 70 || (h.spare != null && h.spare < 20) || h.realloc > 0) return { lvl: "warn", txt: t("needs attention") };
  return { lvl: "ok", txt: t("good") };
}
const worst = lvls => (lvls.includes("bad") ? "bad" : lvls.includes("warn") ? "warn" : lvls.includes("unk") ? "unk" : "ok");

function renderChrome() {
  const down = S.services.filter(([, st]) => st !== "active");
  $("pills").innerHTML = (MACHINE ? '<span class="pill warn">' + t("read-only view") + "</span>" : "") + Object.values(S.pools).map(p =>
    '<span class="pill ' + (p.health === "ONLINE" ? "ok" : "bad") + '">' + esc(poolName(p.name)) + " " + esc(p.health) + "</span>").join("") +
    '<span class="pill ' + (down.length ? "warn" : "ok") + '">' + (down.length ? tp(down.length, "{n} service stopped", "{n} services stopped") : t("services OK")) + "</span>";
  $("meta").textContent = [S.host, t("kernel {v}", { v: S.kernel }), t("up for {d}", { d: duration(F.up) }), t("refreshed {time}", { time: new Date().toLocaleTimeString(LOCALE()) })].join(" · ");
  $("legend").innerHTML = Object.values(UI.tags).map(t => '<span class="legend-item"><span class="tagdot" data-color="' + esc(t.color) + '"></span>' + esc(t.name) + "</span>").join("");
}

/* overview */

const GAUGES = [["cpu", "Processor"], ["mem", "Memory"], ["pool", "Storage"], ["temp", "CPU temp."]];
const CIRC = 2 * Math.PI * 42;

function buildGauges() {
  $("gauges").innerHTML = GAUGES.map(([id, label]) =>
    '<article class="card gauge" id="g-' + id + '"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="42"/>' +
    '<circle class="val" cx="50" cy="50" r="42"/></svg><div class="g-text"><strong></strong><span class="label">' + t(label) +
    '</span><span class="sub"></span></div></article>').join("");
}
function setGauge(id, pct, value, sub, lvl) {
  const g = $("g-" + id);
  g.className = "card gauge " + (lvl || "");
  g.querySelector(".val").style.strokeDasharray = (clamp(pct) / 100 * CIRC).toFixed(1) + " " + CIRC.toFixed(1);
  g.querySelector("strong").textContent = value;
  g.querySelector(".sub").textContent = sub;
}

function memParts() {
  const m = F.m, arc = F.a.size || 0;
  const cache = (m.Cached || 0) + (m.Buffers || 0) + (m.SReclaimable || 0);
  const apps = Math.max(0, m.MemTotal - m.MemFree - cache - arc);
  return { total: m.MemTotal, apps, arc, cache, free: m.MemFree };
}

function renderOverview() {
  const cpu = last(hist.cpu), mp = memParts(), used = mp.total - mp.free - mp.cache;
  const pools = Object.values(S.pools);
  const p = { allocated: pools.reduce((a, x) => a + x.allocated, 0), size: pools.reduce((a, x) => a + x.size, 0) };
  p.capacity = p.size ? p.allocated / p.size * 100 : 0;
  setGauge("cpu", cpu, nf(cpu, 0) + " %", t("load {v}", { v: F.load.map(x => nf(x, 2)).join(" · ") }), cpu > 85 ? "warn" : "");
  setGauge("mem", used / mp.total * 100, nf(used / 2 ** 30) + " " + t("GB"), t("of {v}", { v: bytes(mp.total) }), "");
  setGauge("pool", p.capacity, nf(p.capacity, 0) + " %", bytes(p.allocated) + " / " + bytes(p.size), p.capacity >= 80 ? "warn" : "");
  setGauge("temp", F.cpuT, nf(F.cpuT, 0) + " °C", t("threshold 80 °C"), lvlTemp(F.cpuT) === "ok" ? "" : lvlTemp(F.cpuT));

  const disks = Object.keys(S.model).sort();
  const hs = disks.map(d => healthOf(S.health[d]));
  const good = hs.filter(h => h.lvl === "ok").length;
  const nics = CFG.nics.map(([n]) => n);
  const rx = sumSeries(nics.map(n => (hist.net[n] || {}).rx || [])), tx = sumSeries(nics.map(n => (hist.net[n] || {}).tx || []));
  const down = S.services.filter(([, st]) => st !== "active");
  const clients = new Set(S.exports.flatMap(l => l.trim().split(/\s+/).slice(1).map(c => c.replace(/\(.*$/, ""))));
  const conn = [...clients].filter(ip => S.connected.has(ip)).length;
  const lateRepl = S.replication.filter(([, last, age, max]) => last === "-" || Number(age) > Number(max));
  const oldest = Math.max(0, ...S.replication.filter(r => r[1] !== "-").map(r => Number(r[2])));

  // The screen's question first: is the NAS fine? Name what is not, else sum up what is.
  const issues = [
    ...pools.filter(x => x.health !== "ONLINE").map(x => t("pool {name} {state}", { name: poolName(x.name), state: x.health })),
    ...pools.filter(x => x.capacity >= 80).map(x => t("pool {name} {pct} % full", { name: poolName(x.name), pct: nf(x.capacity, 0) })),
    ...disks.filter((d, i) => hs[i].lvl === "bad" || hs[i].lvl === "warn").map(d => t("disk {name} {health}", { name: UI.labels["disk:" + d] || d, health: healthOf(S.health[d]).txt })),
    ...down.map(([n]) => t("service {name} stopped", { name: n })),
    ...lateRepl.map(([ds]) => t("replication of {name} late", { name: UI.labels["ds:" + ds] || ds })),
  ];
  const vl = worst([...pools.map(x => (x.health === "ONLINE" ? (x.capacity >= 80 ? "warn" : "ok") : "bad")), ...hs.map(h => h.lvl), down.length ? "warn" : "ok", lateRepl.length ? "bad" : "ok"]);
  $("verdict").className = "verdict " + vl;
  $("verdict").innerHTML = '<span class="dot ' + vl + '"></span>' + esc(issues.length ? issues.join(" · ") :
    t("All good: {pools}, {good} / {disks}, {services}", { pools: tp(pools.length, "{n} pool online", "{n} pools online"), good,
      disks: tp(disks.length, "{n} healthy disk", "{n} healthy disks"), services: tp(S.services.length, "{n} active service", "{n} active services") }));

  $("tiles").innerHTML = [
    tile("disques", t("Disk health"), t("{good} / {total} in good health", { good, total: disks.length }), worst(hs.map(h => h.lvl)),
      '<div class="minidisks">' + disks.map((d, i) => '<span class="minidisk ' + hs[i].lvl + '" title="' + esc(t("{name}: {value}", { name: d, value: hs[i].txt })) + '">' +
        esc(UI.labels["disk:" + d] || d) + "<small>" + nf(S.health[d]?.temp ?? F.nvmeT[d] ?? 0, 0) + " °C</small></span>").join("") + "</div>"),
    tile("stockage", pools.length > 1 ? t("{n} ZFS pools", { n: pools.length }) : t("ZFS pool"), t("{v} free", { v: bytes(pools.reduce((a, x) => a + x.free, 0)) }),
      pools.every(x => x.health === "ONLINE") ? "ok" : "bad", pools.map(x => '<div class="meter ' + (x.capacity >= 80 ? "warn" : "ok") + '"><span>' +
        esc(poolName(x.name)) + " · " + esc(x.health) + '</span><div class="bar"><i data-w="' + x.capacity + '"></i></div><b>' + nf(x.capacity, 0) + " %</b></div>").join("")),
    tile("reseau", t("Network (all interfaces)"), "↓ " + bits(last(rx)) + " · ↑ " + bits(last(tx)), "", spark([rx, tx], 8000, true)),
    tile("services", t("Services"), t("{up} / {total} active", { up: S.services.length - down.length, total: S.services.length }), down.length ? "warn" : "ok",
      '<div class="svcdots">' + S.services.map(([n, st]) => '<span class="dot ' + (st === "active" ? "ok" : "bad") + '" title="' + esc(t("{name}: {value}", { name: n, value: st })) + '"></span>').join("") + "</div>" +
      (down.length ? '<p class="sub">' + t("Stopped: {list}", { list: down.map(([n]) => esc(n)).join(", ") }) + "</p>" : "")),
    S.replication.length ? tile("sauvegarde", t("Replication"), t("{ok} / {total} up to date", { ok: S.replication.length - lateRepl.length, total: S.replication.length }),
      lateRepl.length ? "bad" : "ok", '<p class="sub">' + (lateRepl.length ? t("Late: {list}", { list: lateRepl.map(([ds]) => esc(ds)).join(", ") })
        : t("Oldest last snapshot: {age}", { age: duration(oldest) })) + "</p>") : "",
  ].join("");
  // The other Cairn instances, apart from this machine's own tiles.
  const peers = MACHINE ? [] : (P || []).filter(m => !m.self);
  $("ov-machines-h").hidden = !peers.length;
  $("ov-machines").innerHTML = peers.map(peerOverview).join("");
  // Secondary facts: one line of links instead of half-empty tiles.
  $("facts").innerHTML = [
    ["partages", t("NFS: {exports} exports · {conn} / {clients} clients connected", { exports: S.exports.length, conn, clients: clients.size }), conn ? " ok" : ""],
    ["systeme", t("Up for {d}", { d: duration(F.up) }), ""],
    ["systeme", t("ARC: {pct} % hit rate", { pct: nf(F.a.hits + F.a.misses ? 100 * F.a.hits / (F.a.hits + F.a.misses) : 0, 1) }), ""],
  ].map(([v, t, c]) => '<button class="chip' + c + '" data-goto="' + v + '">' + esc(t) + "</button>").join("");
}
function tile(view, title, value, lvl, extra) {
  return '<button class="card tile ' + (lvl || "") + '" data-goto="' + view + '"><span class="label">' + esc(title) + "</span><strong>" +
    esc(value) + "</strong>" + extra + "</button>";
}

/* system */

function buildSystem() {
  $("cpu-card").innerHTML = '<div class="row"><span class="label">' + t("Processor") + '</span><strong class="big" id="cpu-val"></strong></div>' +
    '<div id="cpu-chart" class="chart"></div><div class="label">' + t("Per thread") + '</div><div class="threads" id="threads"></div>';
  $("mem-card").innerHTML = '<div class="row"><span class="label">' + t("Memory") + '</span><strong class="big" id="mem-val"></strong></div>' +
    '<div class="stack" id="mem-stack"><i class="s-apps"></i><i class="s-arc"></i><i class="s-cache"></i></div><dl class="legend-dl" id="mem-legend"></dl>';
}

function renderSystem() {
  const cores = F.cores;
  const th = $("threads");
  if (th.children.length !== cores.length) {
    th.innerHTML = cores.map((_, i) => '<div class="thread" title="CPU ' + i + '"><i></i><span>' + i + "</span></div>").join("");
  }
  cores.forEach((v, i) => {
    const bar = th.children[i].firstChild;
    bar.style.height = clamp(v).toFixed(0) + "%";
    bar.className = v > 85 ? "hot" : "";
  });
  $("cpu-val").textContent = nf(last(hist.cpu), 0) + " %";
  $("cpu-chart").innerHTML = spark([hist.cpu], 100, true);

  const mp = memParts();
  $("mem-val").textContent = nf((mp.total - mp.free - mp.cache) / 2 ** 30) + " / " + nf(mp.total / 2 ** 30) + " " + t("GB");
  const seg = $("mem-stack").children;
  [mp.apps, mp.arc, mp.cache].forEach((v, i) => { seg[i].style.width = (v / mp.total * 100).toFixed(2) + "%"; });
  $("mem-legend").innerHTML = [["s-apps", "Applications", mp.apps], ["s-arc", "ZFS cache (ARC)", mp.arc], ["s-cache", "System cache", mp.cache], ["s-free", "Free", mp.free]]
    .map(([c, n, v]) => '<dt><i class="' + c + '"></i>' + t(n) + "</dt><dd>" + bytes(v) + "</dd>").join("");

  const threads = F.cores.length || 1;
  $("load-card").innerHTML = '<span class="label">' + t("Load (over {n} threads)", { n: threads }) + "</span>" +
    ["1 min", "5 min", "15 min"].map((n, i) => '<div class="meter"><span>' + n + '</span><div class="bar"><i data-w="' + (F.load[i] / threads * 100) +
      '"></i></div><b>' + nf(F.load[i], 2) + "</b></div>").join("") +
    '<dl class="legend-dl"><dt>' + t("Uptime") + "</dt><dd>" + duration(F.up) + "</dd><dt>" + t("Kernel") + "</dt><dd>" + esc(S.kernel) + "</dd>" +
    "<dt>" + t("ARC (hit rate)") + "</dt><dd>" + nf(F.a.hits + F.a.misses ? 100 * F.a.hits / (F.a.hits + F.a.misses) : 0, 1) + " %</dd></dl>";

  const rows = [];
  const core = F.temps.filter(x => x.name === "coretemp" || x.name === "k10temp");
  if (core.length) rows.push([t("CPU (package)"), F.cpuT], [t("CPU (hottest core)"), Math.max(...core.map(x => x.c))]);
  F.temps.filter(x => x.name === "spd5118").forEach((x, i) => rows.push(["RAM" + (i ? " " + (i + 1) : ""), x.c]));
  F.temps.filter(x => /^(en|eth)/.test(x.name)).forEach(x => rows.push([(UI.labels["nic:" + x.name] || x.name) + " · " + x.label, x.c]));
  Object.keys(F.nvmeT).sort().forEach(d => rows.push([(UI.labels["disk:" + d] || d), F.nvmeT[d]]));
  $("temp-card").innerHTML = '<span class="label">' + t("Temperatures") + '</span><div class="temps">' + rows.map(([n, c]) =>
    '<div class="meter ' + lvlTemp(c) + '"><span>' + esc(n) + '</span><div class="bar"><i data-w="' + c + '"></i></div><b>' + nf(c, 0) + " °C</b></div>").join("") + "</div>" +
    (F.fans.length ? '<span class="label fans-label">' + t("Fans") + '</span><div class="temps fans">' +
      F.fans.map(([n, rpm]) => '<div class="meter"><span>' + esc(n) + "</span><b>" + nf(rpm, 0) + " " + t("rpm") + "</b></div>").join("") + "</div>" : "");
}

/* network */

function renderNet() {
  const names = byTag(CFG.nics.map(([n]) => n), n => "nic:" + n);
  const desc = Object.fromEntries(CFG.nics);
  $("net").innerHTML = names.map(n => {
    const h = hist.net[n] || { rx: [], tx: [] };
    const rx = last(h.rx), tx = last(h.tx), speed = S.speeds[n];
    const ad = S.addrs[n] || { up: false, ips: [] };
    const pct = speed > 0 ? Math.max(rx, tx) / (speed * 1e6) * 100 : 0;
    return '<article class="card nic' + (ad.up ? "" : " down") + (tagOf("nic:" + n) ? " tagged" : "") + '"' + tagAttr("nic:" + n) + ">" +
      '<div class="row">' + nameBlock("nic:" + n, n, n) + '<span class="tag">' + (speed > 0 ? (speed >= 1000 ? speed / 1000 + " Gb" : speed + " Mb") : t("no link")) + "</span></div>" +
      '<div class="sub">' + esc(desc[n] || "") + (ad.ips.length ? " · " + esc(ad.ips.join(", ")) : "") + "</div>" +
      '<div class="rates"><span class="rx">↓ ' + bits(rx) + '</span><span class="tx">↑ ' + bits(tx) + "</span></div>" +
      (speed > 0 ? '<div class="bar thin"><i data-w="' + pct + '"></i></div>' : "") +
      spark([h.rx, h.tx], 8000) + "</article>";
  }).join("");
}

/* disks: grouped by vdev, expandable */

function poolTree(status) {
  const rows = (status.split(/\n\s*NAME\s+STATE.*\n/)[1] || "").split("\n\n")[0].split("\n").filter(Boolean);
  const roots = [], stack = [];
  for (const l of rows) {
    const f = l.trim().split(/\s+/);
    const n = { depth: l.match(/^\t?( *)/)[1].length, name: f[0], state: f[1] || "", err: f.slice(2, 5).map(Number), children: [] };
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(n);
    stack.push(n);
  }
  return roots;
}
const leaves = n => (n.children.length ? n.children.flatMap(leaves) : [n]);
function devOf(name) {
  const t = S.byid[name.replace(/-part\d+$/, "")] || name;
  const m = t.match(/^(nvme\d+n\d+)p\d+$/) || t.match(/^(sd[a-z]+)\d+$/);
  return m ? m[1] : t;
}

// Sections after the data groups in zpool status, and what each is for.
const ROLES = { logs: "Log (SLOG)", cache: "Cache (L2ARC)", spares: "Spare disk", special: "Special", dedup: "Dedup" };
const REMOVABLE = ["logs", "cache", "spares"];

function renderDisks() {
  const groups = [];
  for (const [pn, st] of Object.entries(S.statusOf)) {
    const [root, ...secs] = poolTree(st), scan = scanText(st), exp = expandText(st);
    if (!root) continue;
    for (const v of root.children) {
      groups.push({ key: pn + "/" + v.name, title: poolName(pn) + (v.children.length ? " · " + v.name : " · " + t("single disk")),
        state: v.state, pool: S.pools[pn], scan, exp: exp && exp.vdev === v.name ? exp : null,
        members: leaves(v).map(l => ({ dev: devOf(l.name), id: l.name, state: l.state, err: l.err, pool: pn })) });
    }
    // Log, cache and spare devices: one card per top-level device, removable from the page.
    for (const sec of secs) for (const v of sec.children) {
      groups.push({ key: pn + "/" + sec.name + "/" + v.name, title: poolName(pn) + " · " + t(ROLES[sec.name] || sec.name) + (v.children.length ? " · " + v.name : ""),
        state: v.state, role: sec.name, poolId: pn, vdev: v.name,
        members: leaves(v).map(l => ({ dev: devOf(l.name), id: l.name, state: l.state, err: l.err, pool: pn, role: sec.name })) });
    }
  }
  const inPool = new Set(groups.flatMap(g => g.members.map(m => m.dev)));
  const other = Object.keys(S.model).filter(d => !inPool.has(d)).sort();
  if (other.length) groups.push({ key: "other", title: t("Not in a pool"), state: "", members: other.map(d => ({ dev: d, id: d, state: "", err: [0, 0, 0] })) });

  $("groups").innerHTML = smartCard() + groups.map(g => {
    const devs = g.members.map(m => m.dev);
    const r = sumSeries(devs.map(d => (hist.disk[d] || {}).r || [])), w = sumSeries(devs.map(d => (hist.disk[d] || {}).w || []));
    const temps = devs.map(d => S.health[d]?.temp ?? F.nvmeT[d]).filter(x => x != null);
    const hs = devs.map(d => healthOf(S.health[d]));
    const errs = g.members.reduce((acc, m) => acc + m.err.reduce((a, b) => a + (b || 0), 0), 0);
    const lvl = worst([...hs.map(h => h.lvl), stateLvl(g.state), errs ? "warn" : "ok"]);
    const cap = devs.reduce((acc, d) => acc + (S.health[d]?.capacity || 0), 0);
    return '<article class="card group ' + lvl + '"><div class="row"><span class="dot ' + (lvl === "ok" ? "ok" : lvl === "bad" ? "bad" : "warn") + '"></span>' +
      "<b>" + esc(g.title) + '</b><span class="tag">' + tp(devs.length, "{n} disk · {size} raw", "{n} disks · {size} raw", { size: bytes(cap) }) + "</span>" +
      (g.state ? '<span class="pill ' + stateLvl(g.state) + '">' + esc(g.state) + "</span>" : "") + "</div>" +
      '<div class="stats">' +
      stat(t("Read"), bytes(last(r)) + "/s", "rx") + stat(t("Write"), bytes(last(w)) + "/s", "tx") +
      stat(t("Max temperature"), temps.length ? nf(Math.max(...temps), 0) + " °C" : "—", lvlTemp(Math.max(0, ...temps))) +
      stat(t("Health"), t("{ok} / {total} good", { ok: hs.filter(h => h.lvl === "ok").length, total: hs.length }), lvl) +
      stat(t("ZFS errors"), String(errs), errs ? "warn" : "") +
      (g.pool ? stat(t("Pool used"), nf(g.pool.capacity, 0) + " %", "") : "") + "</div>" +
      (g.scan && g.scan.resilver ? scanProgress(g.scan) : "") + (g.exp ? scanProgress(g.exp) : "") +
      spark([r, w], 1e5, true) +
      (g.role && REMOVABLE.includes(g.role) && (FEAT().vdevs || FEAT().pools)
        ? '<div class="disk-acts"><button class="danger" data-act="vdev-del" data-pool="' + esc(g.poolId) + '" data-dev="' + esc(g.vdev) + '" data-role="' + g.role + '">' + t("Remove from the pool") + "</button></div>" : "") +
      '<details data-group="' + esc(g.key) + '"' + (openGroups.has(g.key) ? " open" : "") + "><summary>" + t("Disk by disk") + "</summary>" +
      '<div class="grid disks">' + g.members.map(diskCard).join("") + "</div></details></article>";
  }).join("");
}
// ONLINE, and AVAIL for an idle spare, are fine; INUSE = a spare standing in for a failed disk.
const stateLvl = st => !st || st === "ONLINE" || st === "AVAIL" ? "ok" : st === "INUSE" || st === "OFFLINE" ? "warn" : "bad";
function stat(label, value, cls) {
  return '<div class="stat ' + (cls || "") + '"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>";
}
function diskCard(m) {
  const d = m.dev, h = S.health[d], hl = healthOf(h), hi = hist.disk[d] || { r: [], w: [] };
  const key = "disk:" + d;
  const tc = h?.temp ?? F.nvmeT[d];
  const kv = [
    [t("Health"), hl.txt, hl.lvl], [t("Temperature"), tc != null ? nf(tc, 0) + " °C" : "—", lvlTemp(tc || 0)],
    [t("Wear"), h?.used != null ? h.used + " %" : "—", h?.used >= 80 ? "warn" : ""], [t("Spare"), h?.spare != null ? h.spare + " %" : "—", ""],
    [t("Power-on hours"), h?.hours != null ? String(h.hours) : "—", ""], [t("Written"), h?.written != null ? bytes(h.written * 512000) : "—", ""],
    [t("Unsafe shutdowns"), h?.unsafe != null ? String(h.unsafe) : "—", ""], [t("Media errors"), h?.media_errors != null ? String(h.media_errors) : "—", h?.media_errors ? "bad" : ""],
    [t("ZFS errors R/W/C"), m.err.join(" / "), m.err.some(x => x) ? "warn" : ""],
    [t("Last self-test"), h?.selftest ? h.selftest.status + (h.selftest.hours != null ? " · " + t("{h} h", { h: h.selftest.hours }) : "") : "—", h?.selftest?.passed === false ? "bad" : ""],
  ];
  return '<article class="card disk' + (tagOf(key) ? " tagged" : "") + '"' + tagAttr(key) + '><div class="row">' + nameBlock(key, d, d) +
    '<span class="pill ' + hl.lvl + '">' + esc(hl.txt) + "</span></div>" +
    '<div class="sub">' + esc(S.model[d] || h?.model || "") + (h?.serial ? " · " + esc(h.serial) : "") + "</div>" +
    '<div class="rates"><span class="rx">' + t("read {rate}/s", { rate: bytes(last(hi.r)) }) + '</span><span class="tx">' + t("write {rate}/s", { rate: bytes(last(hi.w)) }) + "</span></div>" +
    spark([hi.r, hi.w], 1e5) + '<dl class="kv">' + kv.map(([k, v, c]) => "<dt>" + k + '</dt><dd class="' + c + '">' + esc(v) + "</dd>").join("") + "</dl>" +
    diskActions(m) + "</article>";
}
// Offline / online / replace a pool member (features.disks); the server checks redundancy again.
function diskActions(m) {
  if (!FEAT().disks || !m.pool || m.role) return "";
  const b = (act, label) => '<button data-act="' + act + '" data-pool="' + esc(m.pool) + '" data-dev="' + esc(m.id) + '">' + label + "</button>";
  return '<div class="disk-acts"><span class="pill ' + (m.state === "ONLINE" ? "ok" : m.state === "OFFLINE" ? "warn" : "bad") + '">' + esc(m.state) + "</span>" +
    (m.state === "OFFLINE" ? b("disk-online", t("Bring online")) : ["ONLINE", "DEGRADED", "FAULTED"].includes(m.state) ? b("disk-offline", t("Take offline")) : "") +
    b("disk-replace", t("Replace")) + "</div>";
}

/* storage */

const poolName = n => UI.labels["pool:" + n] || n;
const isVol = r => r[10] === "volume";
const fsRows = () => S.datasets.filter(r => !isVol(r));

function scanText(status) {
  const scan = (status.match(/^\s*scan: ([\s\S]*?)\n(?:expand|config):/m) || [, t("no scrub yet")])[1].replace(/\n\s+/g, " ").trim();
  const pct = scan.match(/([\d.]+)% done/), eta = scan.match(/done, (\S+) to go/);
  return { text: scan, running: /in progress/.test(scan), resilver: /^resilver in progress/.test(scan), pct: pct ? Number(pct[1]) : null, eta: eta ? eta[1] : "" };
}
// RAIDZ expansion (zpool attach raidzN-X): "expand: expansion of raidz1-0 in progress since …", then the same progress line as a resilver.
function expandText(status) {
  const m = status.match(/^\s*expand: ([\s\S]*?)\nconfig:/m);
  if (!m) return null;
  const x = m[1].replace(/\n\s+/g, " ").trim(), v = x.match(/expansion of (\S+) in progress/), pct = x.match(/([\d.]+)% done/), eta = x.match(/done, (\S+) to go/);
  return { text: x, running: !!v, vdev: v ? v[1] : "", label: t("RAIDZ expansion"), pct: pct ? Number(pct[1]) : null, eta: eta ? eta[1] : "" };
}
// Pool properties (ashift, autotrim, feature upgrade, trim) and, with features.vdevs / pools, its layout controls.
const canUpgrade = st => /features are not enabled/.test(st);
function poolManage(p, st, root) {
  const f = FEAT(), name = esc(p.name), trimming = /\d+% trimmed/.test(st);
  const props = [t("ashift {n} ({size} sectors)", { n: p.ashift, size: bytes(2 ** Number(p.ashift || 0)) }),
    t("automatic trim: {v}", { v: p.autotrim === "on" ? t("on") : t("off") }),
    canUpgrade(st) ? t("ZFS features to enable (zpool upgrade)") : t("all ZFS features enabled")].concat(trimming ? [t("trim in progress")] : []);
  const b = (act, label, cls, extra) => '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-act="' + act + '" data-pool="' + name + '"' + (extra || "") + ">" + label + "</button>";
  const raidz = (root ? root.children : []).some(v => /^raidz/.test(v.name));
  const btns = (f.vdevs || f.pools ? b("vdev-add", t("Add a log device (SLOG)"), "", ' data-role="log"') + b("vdev-add", t("Add a cache device (L2ARC)"), "", ' data-role="cache"') +
      b("vdev-add", t("Add a spare disk"), "", ' data-role="spare"') + b("pool-trim", t("Trim now")) +
      b("pool-autotrim", p.autotrim === "on" ? t("Turn automatic trim off") : t("Turn automatic trim on"), "", ' data-on="' + (p.autotrim === "on" ? "" : "1") + '"') : "") +
    (f.pools ? b("vdev-add", t("Add a data group"), "", ' data-role="data"') + (raidz ? b("raidz-expand", t("Expand a RAIDZ group")) : "") +
      (canUpgrade(st) ? b("pool-upgrade", t("Enable new ZFS features")) : "") + b("pool-export", t("Export")) + b("pool-del", t("Delete the pool"), "danger") : "");
  return '<p class="sub">' + props.map(esc).join(" · ") + "</p>" + (btns ? '<details data-group="manage:' + name + '"' + (openGroups.has("manage:" + p.name) ? " open" : "") + "><summary>" +
    t("Layout and maintenance") + '</summary><div class="disk-acts">' + btns + "</div></details>" : "");
}
// Progress of a running scrub or resilver (zpool status: "12.3% done, 01:02:03 to go"); the slow loop refreshes it.
function scanProgress(scan) {
  if (!scan.running || scan.pct == null) return "";
  const what = scan.label || (scan.resilver ? t("Resilver") : t("Scrub"));
  return '<div class="bar thin scan"><i data-w="' + scan.pct + '"></i></div><p class="sub">' +
    (scan.eta ? t("{what}: {pct} % done, {eta} left", { what, pct: nf(scan.pct, 1), eta: esc(scan.eta) }) : t("{what}: {pct} % done", { what, pct: nf(scan.pct, 1) })) + "</p>";
}

function renderStorage() {
  $("storage-actions").innerHTML = FEAT().pools
    ? '<button class="primary" data-act="ds-new">' + t("New dataset") + '</button><button data-act="zvol-new">' + t("New volume") + '</button><button data-act="pool-new">' + t("New pool") + "</button>" +
      '<button data-act="pool-import">' + t("Import a pool") + "</button>" + encNewBtn() : encNewBtn();
  $("pools").innerHTML = Object.values(S.pools).map(p => {
    const st = S.statusOf[p.name] || "", scan = scanText(st), exp = expandText(st);
    const errors = (st.match(/^errors: (.*)$/m) || [, "?"])[1];
    const [root, ...secs] = poolTree(st);
    const vdevs = (root ? root.children : []).map(v => v.children.length ? v.name.replace(/-\d+$/, "") + " × " + leaves(v).length : t("single disk"))
      .concat(secs.map(s => t(ROLES[s.name] || s.name) + " × " + s.children.flatMap(leaves).length));
    const key = "pool:" + p.name;
    return '<article class="card' + (tagOf(key) ? " tagged" : "") + '"' + tagAttr(key) + '><div class="row"><span class="dot ' + (p.health === "ONLINE" ? "ok" : "bad") + '"></span>' +
    nameBlock(key, p.name, p.name) + '<span class="tag">' + esc(vdevs.join(" + ")) + "</span></div>" +
    '<div class="bar big"><i data-w="' + p.capacity + '"></i></div>' +
    '<div class="stats">' + stat(t("Allocated"), bytes(p.allocated), "") + stat(t("Free"), bytes(p.free), "") + stat(t("Raw size"), bytes(p.size), "") +
    stat(t("Fragmentation"), p.fragmentation + " %", "") + (errors.startsWith("No known") ? stat(t("Errors"), t("None"), "ok") : stat(t("Errors"), errors, "bad")) + "</div>" +
    '<p class="sub">' + t("Last scrub: {v}", { v: esc(scan.text) }) + "</p>" + scanProgress(scan) + (exp ? scanProgress(exp) : "") +
    (scan.resilver ? "" : '<button data-act="scrub" data-pool="' + esc(p.name) + '" data-running="' + scan.running + '" class="' + (scan.running ? "danger" : "primary") + '">' +
    (scan.running ? t("Stop scrub") : t("Start a scrub")) + "</button>") + scrubEvery(p.name) + poolManage(p, st, root) + "</article>";
  }).join("");

  const del = name => FEAT().pools && name.includes("/") ? '<button class="danger" data-act="ds-del" data-ds="' + esc(name) + '">' + t("Delete") + "</button>" : "";
  const rows = byTag(fsRows(), r => "ds:" + r[0]);
  $("datasets").innerHTML = "<thead><tr>" + ["Dataset", "Used", "Available", "Compression", "Ratio", "Block size", "Quota"].concat(FEAT().autosnap ? ["Auto snapshots"] : [], ENC() ? ["Encryption"] : [], [""])
    .map(h => "<th>" + t(h) + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map(([name, used, avail, , ratio, comp, rs, quota, , auto]) =>
      "<tr><td>" + nameBlock("ds:" + name, name, name) + "</td><td>" + bytes(Number(used)) + "</td><td>" + bytes(Number(avail)) + "</td><td>" + esc(comp) +
      "</td><td>× " + nf(Number(ratio), 2) + "</td><td>" + bytes(Number(rs)) + "</td><td>" + (quota === "0" ? "—" : bytes(Number(quota))) +
      (FEAT().autosnap ? "</td><td>" + autoLabels(name, auto) : "") + (ENC() ? "</td><td>" + encCell(name) : "") +
      '</td><td class="actions"><button data-act="ds-edit" data-ds="' + esc(name) + '" data-comp="' + esc(comp) + '" data-quota="' + (quota === "0" ? "none" : esc(quota)) +
      '" data-auto="' + (auto === "true" ? "true" : "false") +
      '">' + t("Edit") + '</button><button data-act="ds-snap" data-ds="' + esc(name) + '">' + t("Snapshot") + "</button>" + restoreBtn(name) + del(name) + "</td></tr>").join("") + "</tbody>";

  // ZFS volumes (block devices, /dev/zvol/<name>): size, space used, compression.
  const vols = byTag(S.datasets.filter(isVol), r => "ds:" + r[0]);
  $("zvols-h").hidden = $("zvols-card").hidden = !vols.length;
  const iscsi = FEAT().iscsi && M ? M.state.iscsi || {} : null;
  $("zvols").innerHTML = "<thead><tr>" + ["Volume", "Size", "Used", "Ratio", "Block size", "Compression"].concat(iscsi ? ["iSCSI"] : [], [""]).map(h => "<th>" + t(h) + "</th>").join("") + "</tr></thead><tbody>" +
    vols.map(([name, used, , , ratio, comp, , , , , , size, vbs]) =>
      "<tr><td>" + nameBlock("ds:" + name, name, name) + "</td><td>" + bytes(Number(size)) + "</td><td>" + bytes(Number(used)) + "</td><td>× " + nf(Number(ratio), 2) +
      "</td><td>" + bytes(Number(vbs)) + "</td><td>" + esc(comp) +
      // iSCSI controls in their own column: the target name is in the tooltip and the dialog.
      (iscsi ? '</td><td class="actions">' + (iscsi[name]
        ? '<button data-act="iscsi" data-ds="' + esc(name) + '" title="' + esc(iscsi[name].iqn) + '">' + tp(iscsi[name].initiators.length, "{n} machine", "{n} machines") + "</button>" +
          '<button class="danger" data-act="iscsi-stop" data-ds="' + esc(name) + '">' + t("Stop") + "</button>"
        : '<button data-act="iscsi" data-ds="' + esc(name) + '">' + t("Export") + "</button>") : "") +
      '</td><td class="actions">' +
      (FEAT().pools ? '<button data-act="zvol-grow" data-ds="' + esc(name) + '" data-size="' + esc(size) + '">' + t("Grow") + "</button>" : "") +
      '<button data-act="ds-snap" data-ds="' + esc(name) + '">' + t("Snapshot") + "</button>" + restoreBtn(name) + del(name) + "</td></tr>").join("") + "</tbody>";

  // Rotating snapshots (zfs-auto-snapshot) are summed up per label, not listed.
  const auto = {}, manual = [];
  for (const s of S.snapshots) {
    const m = s[0].match(/@zfs-auto-snap_([a-z]+)-/);
    if (!m) { manual.push(s); continue; }
    const label = s[0].split(/[/@]/)[0] + " · " + m[1];
    const a = auto[label] = auto[label] || { n: 0, used: 0, last: 0 };
    a.n++; a.used += Number(s[1]); a.last = Math.max(a.last, Number(s[2]));
  }
  const when = t => new Date(t * 1000).toLocaleString(LOCALE());
  // Manual snapshots sharing a name (one recursive snapshot, a migration) make one row.
  const named = {};
  for (const s of manual.reverse()) (named[s[0].split("@")[1]] = named[s[0].split("@")[1]] || []).push(s);
  $("autosnap-keep").hidden = !SCH();
  if (SCH()) $("autosnap-keep").innerHTML = '<div class="card-head"><b>' + t("Automatic snapshot rotation") + "</b></div>" + (SCH().autosnap_installed
    ? '<div class="chips">' + LABELS.map(([l, n]) => '<button class="chip" data-act="autosnap-keep" data-label="' + l + '">' + t(n) + " · " +
      (SCH().autosnap.keep[l] != null ? t("keep {n}", { n: SCH().autosnap.keep[l] }) : "—") + "</button>").join("") + "</div>" +
      '<p class="sub">' + t("For the whole machine (zfs-auto-snapshot); which datasets get each rotation is chosen with Edit. A replication's backup side keeps its own copies longer.") + "</p>"
    : '<p class="sub">' + t("zfs-auto-snapshot is not installed (apt install zfs-auto-snapshot).") + "</p>");
  $("snaps").innerHTML = !S.snapshots.length
    ? '<tbody><tr><td class="sub">' + t("No snapshots. Use the “Snapshot” button on a dataset to create one.") + "</td></tr></tbody>"
    : "<thead><tr><th>" + t("Snapshot") + "</th><th>" + t("Unique size") + "</th><th>" + t("Created") + "</th><th></th></tr></thead><tbody>" +
      Object.entries(named).map(([snap, list]) => list.length === 1
        ? "<tr><td>" + esc(list[0][0]) + "</td><td>" + bytes(Number(list[0][1])) + "</td><td>" + when(Number(list[0][2])) +
          '</td><td class="actions"><button class="danger" data-act="snap-del" data-snap="' + esc(list[0][0]) + '">' + t("Delete") + "</button></td></tr>"
        : '<tr><td title="' + esc(list.map(s => s[0]).join(", ")) + '">@' + esc(snap) + ' <small class="sys">' + tp(list.length, "{n} dataset", "{n} datasets") + "</small></td><td>" +
          bytes(list.reduce((a, s) => a + Number(s[1]), 0)) + "</td><td>" + when(Math.max(...list.map(s => Number(s[2])))) +
          '</td><td class="actions"><button class="danger" data-act="snap-del-many" data-snap="' + esc(snap) + '">' + t("Delete all {n}", { n: list.length }) + "</button></td></tr>").join("") +
      Object.entries(auto).map(([label, a]) => '<tr class="auto"><td>zfs-auto-snap · ' + esc(label) + " — " + tp(a.n, "{n} snapshot", "{n} snapshots") + "</td><td>" + bytes(a.used) +
        "</td><td>" + t("last {when}", { when: when(a.last) }) + '</td><td class="sub">' + t("automatic rotation") + "</td></tr>").join("") + "</tbody>";
}

// Replication: the newest snapshot of each replicated dataset, late past its max age.
function renderBackup() {
  const on = FEAT().replication;
  document.querySelector('#nav [data-view="sauvegarde"]').hidden = !S.replication.length && !on && !FEAT().offsite;
  $("repl-setup").innerHTML = on && M ? replSetup() : "";
  $("offsite-h").hidden = !OFF();
  $("offsite").innerHTML = OFF() ? offsiteCards() : "";
  const when = t => new Date(t * 1000).toLocaleString(LOCALE());
  $("repl").innerHTML = !S.replication.length
    ? '<tbody><tr><td class="sub">' + (on ? t("Nothing replicated yet.") : t("No replication configured: list the replicated datasets under <code>replication</code> in the panel configuration.")) + "</td></tr></tbody>"
    : "<thead><tr>" + ["Dataset", "Last snapshot", "Age", "State"].map(h => "<th>" + t(h) + "</th>").join("") + "</tr></thead><tbody>" +
    S.replication.map(([ds, last, age, max]) => {
      const never = last === "-", late = never || Number(age) > Number(max);
      return "<tr><td>" + dot("ds:" + ds) + "<b>" + esc(UI.labels["ds:" + ds] || ds) + "</b></td><td>" + (never ? "—" : when(Number(last))) +
        "</td><td>" + (never ? "—" : duration(Number(age))) + '</td><td><span class="pill ' + (late ? "bad" : "ok") + '">' +
        (never ? t("never") : late ? t("late (over {h} h)", { h: Number(max) / 3600 }) : t("up to date")) + "</span></td></tr>";
    }).join("") + "</tbody>";
}

/* machines: this one and the other Cairn instances (read-only, /api/peers) */

function machineLvl(m) {
  if (!m.ok) return "bad";
  const pools = Object.values((m.summary || {}).pools || {});
  if (pools.some(p => p.health !== "ONLINE")) return "bad";
  return m.summary.problems > 0 || pools.some(p => p.capacity >= 80) ? "warn" : "ok";
}
function machineState(m) {
  if (!m.ok) return m.checked ? t("unreachable") : t("not checked yet");
  return m.summary.problems ? tp(m.summary.problems, "{n} problem", "{n} problems") : t("no problem");
}
// Another machine on Overview: its own tiles (from /api/summary?full=1), under its name.
function peerOverview(m) {
  const s = m.summary, f = s && s.full, lvl = machineLvl(m);
  const meter = (label, pct, lvl) => '<div class="meter ' + lvl + '"><span>' + esc(label) + '</span><div class="bar"><i data-w="' + pct + '"></i></div><b>' + nf(pct, 0) + " %</b></div>";
  const pools = s ? Object.entries(s.pools) : [];
  const tiles = [];
  if (f) {
    const memPct = f.mem.total ? f.mem.used / f.mem.total * 100 : 0, temp = f.cpu_temp_c ?? s.temp_max_c;
    tiles.push(tile("machines", t("System"), t("Processor") + " " + nf(f.cpu_pct, 0) + " %", f.cpu_pct > 85 ? "warn" : "",
      meter(t("Memory"), memPct, memPct > 90 ? "warn" : "ok") + '<p class="sub">' + [t("load {v}", { v: (f.load || []).map(x => nf(x, 2)).join(" · ") }),
        temp != null ? t("CPU temp.") + " " + nf(temp, 0) + " °C" : "", t("Up for {d}", { d: duration(f.uptime_s) })].filter(Boolean).join(" · ") + "</p>"));
    const hs = (f.disks || []).map(healthOf);
    tiles.push(tile("machines", t("Disk health"), t("{good} / {total} in good health", { good: hs.filter(h => h.lvl === "ok").length, total: hs.length }), worst(hs.map(h => h.lvl)),
      '<div class="minidisks">' + f.disks.map((d, i) => '<span class="minidisk ' + hs[i].lvl + '" title="' + esc(t("{name}: {value}", { name: d.dev, value: hs[i].txt })) + '">' +
        esc(d.dev) + (d.temp != null ? "<small>" + nf(d.temp, 0) + " °C</small>" : "") + "</span>").join("") + "</div>"));
  }
  if (pools.length) tiles.push(tile("machines", pools.length > 1 ? t("{n} ZFS pools", { n: pools.length }) : t("ZFS pool"),
    t("{v} free", { v: bytes(pools.reduce((a, [, p]) => a + Math.max(0, p.size - p.alloc), 0)) }), pools.every(([, p]) => p.health === "ONLINE") ? "ok" : "bad",
    pools.map(([n, p]) => meter(n + " · " + p.health, p.capacity, p.health !== "ONLINE" ? "bad" : p.capacity >= 80 ? "warn" : "ok")).join("")));
  if (f) {
    tiles.push(tile("machines", t("Network (all interfaces)"), "↓ " + bits(f.net.rx_bps) + " · ↑ " + bits(f.net.tx_bps), "", ""));
    const svc = f.services || [], down = svc.filter(([, st]) => st !== "active");
    if (svc.length) tiles.push(tile("machines", t("Services"), t("{up} / {total} active", { up: svc.length - down.length, total: svc.length }), down.length ? "warn" : "ok",
      '<div class="svcdots">' + svc.map(([n, st]) => '<span class="dot ' + (st === "active" ? "ok" : "bad") + '" title="' + esc(t("{name}: {value}", { name: n, value: st })) + '"></span>').join("") + "</div>" +
      (down.length ? '<p class="sub">' + t("Stopped: {list}", { list: down.map(([n]) => esc(n)).join(", ") }) + "</p>" : "")));
    const rep = f.replication || [], late = rep.filter(([, age, max]) => age == null || age > max);
    if (rep.length) tiles.push(tile("machines", t("Replication"), t("{ok} / {total} up to date", { ok: rep.length - late.length, total: rep.length }), late.length ? "bad" : "ok",
      '<p class="sub">' + (late.length ? t("Late: {list}", { list: late.map(([ds]) => esc(ds)).join(", ") })
        : t("Oldest last snapshot: {age}", { age: duration(Math.max(0, ...rep.map(r => r[1]))) })) + "</p>"));
  } else if (s && s.temp_max_c != null) tiles.push(tile("machines", t("Max temperature"), nf(s.temp_max_c, 0) + " °C", lvlTemp(s.temp_max_c), ""));
  const msgs = s && s.messages.length ? '<p class="verdict ' + lvl + '"><span class="dot ' + lvl + '"></span>' + esc(s.messages.join(" · ")) + "</p>" : "";
  return '<div class="peer-ov"><div class="card-head"><span class="row"><span class="dot ' + lvl + '"></span><b>' + esc(m.name) + '</b><span class="sub">' + esc(machineState(m)) + "</span></span>" +
    '<a class="btn" href="' + esc(m.link) + '" target="_blank" rel="noopener noreferrer">' + t("Open") + "</a></div>" +
    (!m.ok ? '<p class="sub">' + (m.checked ? t("Unreachable for {d}", { d: duration(m.down_s) }) + (s ? " · " + t("Last known state:") : "") : t("Not checked yet.")) + "</p>" : "") +
    msgs + '<div class="grid tiles">' + tiles.join("") + "</div></div>";
}
function renderMachines() {
  document.querySelector('#nav [data-view="machines"]').hidden = !FEAT().peers;
  const sel = $("machine");
  sel.hidden = !P;
  if (P && sel.options.length !== P.length) sel.innerHTML = P.map(m => '<option value="' + esc(m.self ? "" : m.name) + '">' + esc(m.name) + "</option>").join("");
  sel.value = MACHINE;
  if (!P) return void ($("machines").innerHTML = FEAT().peers ? '<p class="sub">' + t("Loading…") + "</p>" : "");
  $("machines").innerHTML = P.map(m => {
    const s = m.summary, lvl = machineLvl(m);
    const down = !m.ok ? '<p class="sub">' + (m.checked ? t("Unreachable since {time} ({d})", { time: new Date(Date.now() - m.down_s * 1000).toLocaleString(LOCALE()), d: duration(m.down_s) }) +
      (m.error ? '<br><small class="sys">' + esc(m.error) + "</small>" : "") : t("Not checked yet.")) + "</p>" : "";
    return '<article class="card"><div class="card-head"><span class="row"><span class="dot ' + lvl + '"></span><b>' + esc(m.name) + "</b></span>" +
      (m.self ? '<span class="pill">' + t("this machine") + "</span>" : '<a class="btn" href="' + esc(m.link) + '" target="_blank" rel="noopener noreferrer">' + t("Open") + "</a>") + "</div>" +
      down + (s ? (m.ok ? "" : '<p class="sub">' + t("Last known state:") + "</p>") +
        Object.entries(s.pools).map(([n, p]) => '<div class="meter ' + (p.health !== "ONLINE" ? "bad" : p.capacity >= 80 ? "warn" : "ok") + '"><span>' + esc(n) + " · " + esc(p.health) +
          '</span><div class="bar"><i data-w="' + p.capacity + '"></i></div><b>' + nf(p.capacity, 0) + " %</b></div>").join("") +
        '<div class="stats">' + stat(t("Problems"), String(s.problems), s.problems ? "warn" : "ok") +
        (s.temp_max_c != null ? stat(t("Max temperature"), nf(s.temp_max_c, 0) + " °C", lvlTemp(s.temp_max_c)) : "") + "</div>" +
        (s.messages.length ? '<ul class="msgs">' + s.messages.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") : "") + "</article>";
  }).join("");
}

/* off-site backup with restic (features.offsite) */

const OFF = () => FEAT().offsite && M && M.offsite;
const KINDS = { local: "Local folder or disk", sftp: "SFTP server", s3: "S3-compatible storage", b2: "Backblaze B2" };
function offsiteCards() {
  const o = OFF(), repos = Object.entries(o.repos || {}), jobs = Object.entries(o.jobs || {});
  if (!o.installed) return '<article class="card"><p class="sub">' + t("restic is not installed (apt install restic).") + "</p></article>";
  const btn = (act, attrs, label, cls) => "<button" + (cls ? ' class="' + cls + '"' : "") + ' data-act="' + act + '"' + attrs + ">" + label + "</button>";
  const when = s => new Date(s * 1000).toLocaleString(LOCALE());
  const keep = j => [["keep_daily", "{n} daily"], ["keep_weekly", "{n} weekly"], ["keep_monthly", "{n} monthly"]].filter(([k]) => j[k] > 0).map(([k, l]) => t(l, { n: j[k] })).join(", ");
  const state = ds => {
    const st = (o.status.jobs || {})[ds];
    if (!st) return '<span class="pill">' + t("never run") + "</span>";
    return '<span class="pill ' + (st.ok ? "ok" : "bad") + '">' + (st.ok ? t("succeeded") : t("failed")) + "</span> " + esc(when(st.time)) + (st.ok ? "" : '<br><small class="sys">' + esc(st.msg || "") + "</small>");
  };
  const last = (o.status.restore || {}).last;
  return '<article class="card"><div class="card-head"><b>' + t("Repositories") + "</b>" + btn("rs-repo", "", t("New repository"), repos.length ? "" : "primary") + "</div>" +
    (repos.length ? repos.map(([n, r]) => '<div class="svc"><b>' + esc(n) + '</b><span class="sub">' + t(KINDS[r.kind]) + " · " + esc(r.location) + "</span>" +
      btn("rs-repo", ' data-name="' + esc(n) + '"', t("Edit")) + btn("rs-repo-del", ' data-name="' + esc(n) + '"', t("Remove"), "danger") + "</div>").join("")
      : '<p class="sub">' + t("No repository. A repository is where restic keeps the encrypted, deduplicated copies: a disk or folder, an SFTP server, S3-compatible or B2 storage.") + "</p>") +
    (o.key ? '<p class="sub">' + t("This machine's SFTP key, to add to the server's authorized_keys:") + '</p><code class="key">' + esc(o.key) + "</code>"
      : '<p class="sub">' + t("SFTP repositories need this machine's own key.") + " " + btn("rs-key", "", t("Create this machine's key")) + "</p>") +
    '<p class="sub">' + t("Passwords and access keys stay in root-only files on this machine (/etc/cairn-nas/restic) and are never shown again. Without the repository password, the copies cannot be read: keep it somewhere else too.") + "</p></article>" +
    '<article class="card"><div class="card-head"><b>' + t("Backups") + "</b>" + (repos.length ? btn("rs-job", "", t("New backup"), jobs.length ? "" : "primary") : "") + "</div>" +
    (jobs.length ? '<div class="table-wrap"><table><thead><tr>' + ["Dataset", "Repository", "Frequency", "Kept", "Last run", ""].map(h => "<th>" + t(h) + "</th>").join("") + "</tr></thead><tbody>" +
      jobs.map(([ds, j]) => { const d = ' data-ds="' + esc(ds) + '"'; return "<tr><td><b>" + esc(ds) + "</b></td><td>" + esc(j.repo) + "</td><td>" + t(j.every === "daily" ? "every day at 04:00" : "Sundays at 04:00") +
        "</td><td>" + keep(j) + "</td><td>" + state(ds) + '</td><td class="actions">' + btn("rs-run", d + (o.running ? " disabled" : ""), t("Run now")) + btn("rs-restore", d, t("Restore…")) +
        btn("rs-job", d, t("Edit")) + btn("rs-job-del", d, t("Stop"), "danger") + "</td></tr>"; }).join("") + "</tbody></table></div>"
      : '<p class="sub">' + t("No backup. Each backup copies a fresh snapshot of a dataset (its own files, not its child datasets) to a repository, then applies the retention.") + "</p>") +
    (o.running ? '<p class="sub">' + t("A backup or a restore is running.") + "</p>" : "") +
    (last ? '<p class="sub">' + t("Last restore: {ds} into {target}, {when}: {res}", { ds: last.dataset, target: last.target, when: when(last.time), res: last.ok ? t("succeeded") : t("failed") + " (" + (last.msg || "") + ")" }) + "</p>" : "") +
    "</article>";
}
async function repoForm(name) {
  const r = name ? OFF().repos[name] : null;
  const fd = await ask(name ? t("Repository {name}", { name }) : t("New repository"),
    "<label>" + t("Name") + '<input name="name" required pattern="[A-Za-z0-9_\\-]+" value="' + esc(name || "") + '"' + (name ? " readonly" : "") + ' placeholder="' + t("e.g. offsite") + '"></label>' +
    "<label>" + t("Type") + '<select name="kind">' + Object.entries(KINDS).map(([k, l]) => '<option value="' + k + '"' + (r && r.kind === k ? " selected" : "") + ">" + t(l) + "</option>").join("") + "</select></label>" +
    "<label>" + t("Location") + '<input name="loc" required value="' + esc(r ? r.location : "") + '" placeholder="/mnt/usb/restic"></label>' +
    '<p class="sub">' + t("Local: /path · SFTP: user@host:/path · S3: https://endpoint/bucket/path · B2: bucket:path") + "</p>" +
    "<label>" + t("Repository password (8 characters or more)") + '<input name="pass" type="password" autocomplete="new-password"' + (name ? ' placeholder="' + t("unchanged") + '"' : " required minlength=\"8\"") + "></label>" +
    "<label>" + t("Access key ID (S3, B2)") + '<input name="kid" autocomplete="off"' + (name ? ' placeholder="' + t("unchanged") + '"' : "") + "></label>" +
    "<label>" + t("Secret key (S3, B2)") + '<input name="secret" type="password" autocomplete="new-password"' + (name ? ' placeholder="' + t("unchanged") + '"' : "") + "></label>" +
    "<label>" + t("Region (S3, optional)") + '<input name="region" autocomplete="off"></label>' +
    '<p class="sub">' + t("An existing restic repository at that place is used as it is (same password); otherwise it is created.") + "</p>", t("Save"));
  if (fd) mg({ op: "restic_repo_save", name: fd.get("name"), kind: fd.get("kind"), location: fd.get("loc").trim(), password: fd.get("pass"), key_id: fd.get("kid").trim(), secret: fd.get("secret"), region: fd.get("region").trim() },
    t("Repository {name} saved", { name: fd.get("name") }));
}
async function jobForm(ds) {
  const j = ds ? OFF().jobs[ds] : { every: "daily", keep_daily: 7, keep_weekly: 4, keep_monthly: 6 };
  const fss = fsRows().filter(r => (r[8] || "").startsWith("/")).map(r => r[0]);
  const num = (k, l) => "<label>" + t(l) + '<input name="' + k + '" type="number" min="0" max="1000" required value="' + (j[k] ?? 0) + '"></label>';
  const fd = await ask(ds ? t("Backup of {name}", { name: ds }) : t("New backup"),
    "<label>" + t("Dataset") + '<select name="ds"' + (ds ? " disabled" : "") + ">" + (ds ? [ds] : fss).map(n => "<option" + (n === ds ? " selected" : "") + ">" + esc(n) + "</option>").join("") + "</select></label>" +
    "<label>" + t("Repository") + '<select name="repo">' + Object.keys(OFF().repos).map(n => "<option" + (n === j.repo ? " selected" : "") + ">" + esc(n) + "</option>").join("") + "</select></label>" +
    '<fieldset class="rows"><legend>' + t("Frequency") + "</legend>" + [["daily", "every day at 04:00"], ["weekly", "Sundays at 04:00"]].map(([e, l]) =>
      '<label class="check"><input type="radio" name="every" value="' + e + '"' + (e === j.every ? " checked" : "") + "> " + t(l) + "</label>").join("") + "</fieldset>" +
    num("keep_daily", "Daily copies kept") + num("keep_weekly", "Weekly copies kept") + num("keep_monthly", "Monthly copies kept") +
    '<p class="sub">' + t("Older copies are forgotten and their data pruned after each run (restic forget --prune). Child datasets are not included: give each its own backup.") + "</p>", t("Save"));
  if (!fd) return;
  const name = ds || fd.get("ds");
  mg({ op: "restic_job_save", dataset: name, repo: fd.get("repo"), every: fd.get("every"), keep_daily: Number(fd.get("keep_daily")), keep_weekly: Number(fd.get("keep_weekly")), keep_monthly: Number(fd.get("keep_monthly")) },
    t("Backup of {name} saved", { name }));
}
async function offsiteRestore(ds) {
  let list;
  try { list = JSON.parse(await get("/api/backups?dataset=" + encodeURIComponent(ds))); } catch (e) { return banner(t("Read failed: {err}", { err: e.message })); }
  if (!list.length) return ask(t("Restore {name}", { name: ds }), "<p>" + t("No copy in the repository yet.") + "</p>", t("Close"));
  const mount = (fsRows().find(r => r[0] === ds) || [])[8] || "";
  const fd = await ask(t("Restore {name}", { name: ds }),
    "<label>" + t("Copy") + '<select name="id">' + list.map(s => '<option value="' + esc(s.id) + '">' + esc(new Date(s.time).toLocaleString(LOCALE())) + " · " + esc(s.id) + "</option>").join("") + "</select></label>" +
    "<label>" + t("File or folder (empty: everything)") + '<input name="path" placeholder="' + t("e.g. 2025/invoices") + '"></label>' +
    "<label>" + t("Into (a new folder inside a dataset)") + '<input name="target" required value="' + esc(mount + "/restored-" + new Date().toISOString().slice(0, 10)) + '"></label>' +
    '<p class="sub">' + t("Nothing is overwritten: the folder must not exist yet. The restore runs in the background; its result shows here.") + "</p>", t("Restore"));
  if (fd) mg({ op: "restic_restore", dataset: ds, snapshot: fd.get("id"), path: fd.get("path").trim(), target: fd.get("target").trim() }, t("Restore started"));
}
async function offsiteDrop(op, attrs, title, body, okMsg) {
  const fd = await ask(title, "<p>" + body + "</p>", t("Remove"), true);
  if (fd) mg({ op, ...attrs }, okMsg);
}

// Both halves of a pull replication: this machine copies others, others copy this one.
function replSetup() {
  const pulls = Object.entries(M.state.repl_pull || {}), allowed = Object.entries(M.state.repl_allow || {});
  const btn = (act, name, label, cls) => '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-act="' + act + '" data-name="' + esc(name) + '">' + label + "</button>";
  return '<article class="card"><div class="card-head"><b>' + t("Copies kept on this machine") + "</b>" +
    (pulls.length ? btn("repl-run", "", t("Run now")) : "") + '<button' + (M.repl_pubkey ? ' class="primary"' : "") + ' data-act="repl-pull-new">' + t("New replication") + "</button></div>" +
    (M.repl_pubkey
      ? '<p class="sub">' + t("This machine's key, to paste on the source machine (Backup view, “Allow a backup machine”):") + '</p><code class="key">' + esc(M.repl_pubkey) + "</code>"
      : '<p class="sub">' + t("This machine first needs its own key to connect to the source machines.") + "</p>" + btn("repl-key", "", t("Create this machine's key"), "primary")) +
    (pulls.length ? pulls.map(([target, j]) => '<div class="svc"><b>' + esc(target) + '</b><span class="sub">← ' + esc(j.host) + ":" + esc(j.source) + "</span>" +
      btn("repl-pull-del", target, t("Stop"), "danger") + "</div>").join("")
      : '<p class="sub">' + t("No replication. Every night at 03:00 this machine copies the datasets of another Cairn machine (syncoid), and keeps their automatic snapshots longer.") + "</p>") +
    "</article>" +
    '<article class="card"><div class="card-head"><b>' + t("Backup machines allowed to copy this one") + '</b><button data-act="repl-allow-new">' + t("Allow a backup machine") + "</button></div>" +
    (allowed.length ? allowed.map(([host, e]) => '<div class="svc"><b>' + esc(host) + '</b><span class="sub">' + esc((e.datasets || []).join(", ")) + "</span>" +
      btn("repl-revoke", host, t("Revoke"), "danger") + "</div>").join("")
      : '<p class="sub">' + t("None. An allowed machine can only read (zfs send) the chosen datasets, from its own address, with its own key: it can neither change nor delete anything here.") + "</p>") +
    "</article>";
}
async function replPullForm() {
  const fd = await ask(t("New replication"),
    "<label>" + t("Source machine") + '<input name="host" required placeholder="' + t("e.g. 192.168.1.10") + '" autocomplete="off"></label>' +
    "<label>" + t("Dataset to copy (with its children)") + '<input name="source" required placeholder="tank"></label>' +
    "<label>" + t("Copy into (local dataset, created by the first copy)") + '<input name="target" required placeholder="' + esc((Object.keys(S.pools)[0] || "backup") + "/tank") + '"></label>' +
    '<p class="sub">' + t("Allow this machine on the source first (its Backup view, with the key shown here). The source's automatic snapshots are what is copied: turn them on there. The first copy starts right away.") + "</p>",
    t("Create"));
  if (fd) mg({ op: "repl_pull_save", host: fd.get("host").trim(), source: fd.get("source").trim(), target: fd.get("target").trim() }, t("Replication into {name} created", { name: fd.get("target") }));
}
async function replAllowForm() {
  const pools = Object.keys(S.pools);
  const fd = await ask(t("Allow a backup machine"),
    "<label>" + t("Backup machine address") + '<input name="host" required placeholder="' + t("e.g. 192.168.1.20") + '" autocomplete="off"></label>' +
    "<label>" + t("Its public key (shown in its Backup view)") + '<textarea name="key" required rows="3" placeholder="ssh-ed25519 AAAA…"></textarea></label>' +
    '<fieldset class="rows"><legend>' + t("Datasets it may copy") + "</legend>" + pools.map(p => '<label class="check"><input type="checkbox" name="ds" value="' + esc(p) + '" checked> ' + esc(p) + "</label>").join("") + "</fieldset>",
    t("Allow"));
  if (fd) mg({ op: "repl_allow", host: fd.get("host").trim(), key: fd.get("key"), datasets: fd.getAll("ds") }, t("{name} allowed", { name: fd.get("host") }));
}
async function replConfirm(op, name, title, text, okMsg) {
  const fd = await ask(title, "<p>" + text + "</p>", t("Confirm"), true);
  if (fd) mg(op === "repl_revoke" ? { op, host: name } : { op, name }, okMsg);
}

/* NFS and services */

function renderNfs() {
  $("nfs").innerHTML = '<div class="card-head"><b>' + t("Server exports") + '</b><span class="sub">' + t("/etc/exports, managed outside the panel") + "</span></div>" + S.exports.map(l => {
    const [path, ...clients] = l.trim().split(/\s+/);
    const ips = byTag(clients.map(c => c.replace(/\(.*$/, "")), ip => "host:" + ip);
    return '<div class="export"><b>' + esc(path) + '</b><div class="chips">' + ips.map(ip =>
      '<button class="chip' + (S.connected.has(ip) ? " ok" : "") + '" data-edit-item="host:' + esc(ip) + '" data-sys="' + esc(ip) + '" title="' + esc(t("{ip} — click to rename or tag", { ip })) + '">' +
      dot("host:" + ip) + esc(UI.labels["host:" + ip] || CFG.hosts[ip] || ip) + "</button>").join("") + "</div></div>";
  }).join("") + '<p class="sub">' + t("Green = client connected right now (NFSv4, port 2049). Click a client to rename or tag it.") + "</p>";
}

function renderServices() {
  $("services").innerHTML = byTag(S.services, ([n]) => "svc:" + n).map(([name, state]) => {
    const ok = state === "active";
    return '<div class="svc"><span class="dot ' + (ok ? "ok" : "bad") + '"></span>' + nameBlock("svc:" + name, name, name) +
      '<span class="sub">' + esc(state) + '</span><button data-act="svc" data-svc="' + esc(name) + '">' + (ok ? t("Restart") : t("Start")) + "</button></div>";
  }).join("");
}

function renderJournal() {
  const el = $("journal");
  el.hidden = !M;
  if (!M) return;
  const u = M.updates, n = u.packages.length, held = u.held || [];
  $("updates").hidden = false;
  const job = M.upgrade || {};
  if (job.running) pollUpgrade();
  $("updates").innerHTML = '<div class="card-head"><b>' + t("System updates") + "</b>" + (n && !job.running ? '<button class="primary" data-act="updates-apply">' + t("Update") + "</button>" : "") +
    '</div><div class="svc"><span class="dot ' + (n || u.reboot ? "warn" : "ok") + '"></span><span>' +
    (n ? tp(n, "{n} package to update", "{n} packages to update") : t("System up to date")) + (u.reboot ? " · " + t("restart required") : "") + "</span></div>" +
    (n ? '<p class="sub">' + u.packages.map(esc).join(", ") + "</p>" : "") +
    (held.length ? '<p class="sub">' + t("Held (apt-mark hold), not updated: {list}", { list: held.map(esc).join(", ") }) + "</p>" : "") +
    '<div id="upgrade">' + upgradeHtml(job) + "</div>";
  el.innerHTML = '<div class="card-head"><b>' + t("Action log") + "</b></div>" +
    (M.journal.length ? '<div class="table-wrap"><table><tbody>' + M.journal.map(l => {
      const [when, ...rest] = l.split(" ");
      return "<tr><td><small class=\"sys\">" + esc(new Date(when).toLocaleString(LOCALE())) + "</small></td><td>" + esc(rest.join(" ")) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : '<p class="sub">' + t("No recent actions.") + "</p>");
}

// Progress of the "Update" job, polled every second while it runs (the slow loop is too slow for it).
function upgradeHtml(j) {
  if (j.running) {
    const step = j.phase === "install" ? t("Installing {pkg}", { pkg: esc(j.pkg) }) : j.phase === "download" ? t("Downloading packages") : t("Preparing");
    return '<div class="bar big"><i data-w="' + j.pct + '"></i></div><p class="sub">' + step + " · " + j.pct + " %</p>";
  }
  return j.ok === false ? '<div class="svc"><span class="dot bad"></span><span>' + t("Last update failed: {err}", { err: esc(j.error) }) + "</span></div>" : "";
}
let upgradeTimer = null;
function pollUpgrade() {
  if (upgradeTimer) return;
  upgradeTimer = setInterval(async () => {
    let j;
    try { j = JSON.parse(await get("/api/updates")); } catch { return; }
    const box = $("upgrade");
    if (j.running) { if (box) { box.innerHTML = upgradeHtml(j); paint(box); } return; }
    clearInterval(upgradeTimer);
    upgradeTimer = null;
    if (j.ok) toast(t("Updates installed"));
    await slowTick();
  }, 1000);
}

async function applyUpdates() {
  const p = M.updates.packages;
  const fd = await ask(t("Install the updates?"), "<p>" + tp(p.length, "{n} package: {list}", "{n} packages: {list}", { list: p.map(esc).join(", ") }) + "</p>" +
    '<p class="sub">' + t("apt-get upgrade, configuration files kept. The affected services restart (Samba: open connections are dropped). May take a few minutes.") + "</p>", t("Update"));
  if (fd) return mg({ op: "updates_apply" }, t("Update started"));
}

function renderAlerts() {
  const el = $("alerts"), a = M && M.alerts;
  el.hidden = !M;
  if (!M) return;
  el.innerHTML = '<div class="card-head"><b>' + t("Alerts") + "</b>" + (a ? '<button data-act="alert-test">' + t("Send a test") + "</button>" : "") + "</div>" +
    (!a ? '<p class="sub">' + t("Not configured: set <code>alerts.url</code> in the panel configuration.") + "</p>"
      : '<p class="sub">' + t("Sent to {target}: degraded or faulted pool, pool {pct} % full, disk failing SMART or with errors, failed service, late replication. One message when it starts, another when it is back to normal.",
        { target: esc(a.target), pct: a.capacity_pct }) + "</p>" +
        (a.problems.length ? a.problems.map(p => '<div class="svc"><span class="dot bad"></span><span>' + esc(p) + "</span></div>").join("")
          : '<div class="svc"><span class="dot ok"></span><span>' + t("No current problems") + "</span></div>"));
}

/* ---------- shares, accounts and pools created from the page (/api/manage) ---------- */

let M = null; // {state, users, groups, mountpoints, admin_exports, free_disks}
const FEAT = () => CFG.features || {};
const ACCESS = { ro: "read only", rw: "read + write" };
const SQUASHES = [["root_squash", "root → anonymous"], ["no_root_squash", "root kept"], ["all_squash", "all anonymous"]];
const LAYOUT_LABELS = [["mirror", "Mirror (RAID 1)"], ["raidz1", "RAIDZ1 · 1 parity disk"], ["raidz2", "RAIDZ2 · 2 parity disks"],
  ["raidz3", "RAIDZ3 · 3 parity disks"], ["stripe", "Stripe without redundancy"]];
const hostName = h => UI.labels["host:" + h] || CFG.hosts[h] || h;

// One action at a time: a double click would otherwise send it twice.
let busy = false;
async function once(run) {
  if (busy) return toast(t("Action in progress…"));
  busy = true;
  try { await run(); } finally { busy = false; }
}
const mg = (payload, okMsg) => once(async () => {
  try {
    await post("/api/manage", payload);
    banner("");
    toast(okMsg);
    await slowTick();
  } catch (e) { banner(t("Refused: {err}", { err: e.message })); }
});

function renderShares() {
  const f = FEAT(), el = $("shares");
  el.hidden = !f.nfs && !f.smb;
  if (el.hidden || !M) return;
  const rows = ["nfs", "smb"].flatMap(kind => Object.entries(M.state[kind] || {}).map(([name, s]) => [kind, name, s]));
  const host = (S.host || "").toLowerCase();
  el.innerHTML = '<div class="card-head"><b>' + t("Panel shares") + "</b>" +
    (f.nfs ? '<button class="primary" data-act="share-new" data-kind="nfs">' + t("New NFS share") + "</button>" : "") +
    (f.smb ? '<button class="primary" data-act="share-new" data-kind="smb">' + t("New SMB share") + "</button>" : "") +
    (f.smb && f.users ? '<button data-act="tm-new">' + t("New Time Machine destination") + "</button>" : "") + "</div>" +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>' + t("Name") + "</th><th>" + t("Type") + "</th><th>" + t("Folder") + "</th><th>" + t("Access") + "</th><th></th></tr></thead><tbody>" +
      rows.map(([kind, name, s]) => "<tr><td><b>" + esc(name) + "</b></td><td>" + kind.toUpperCase() + ((kind === "nfs" ? s.open_fw : (s.fw || []).length) ? '<br><small class="sys">' + t("firewall open") + "</small>" : "") +
        (s.encrypt === "required" ? '<br><small class="sys">' + t("encryption required") + "</small>" : "") +
        (s.recycle ? '<br><small class="sys">' + t("recycle bin") + "</small>" : "") + (s.versions ? '<br><small class="sys">' + t("previous versions") + "</small>" : "") +
        (s.timemachine ? '<br><small class="sys">Time Machine' + (s.tm_max ? " · " + esc(s.tm_max) : "") + "</small>" : "") + "</td><td>" + esc(s.path) + '</td><td><div class="chips">' +
        (kind === "nfs"
          ? s.clients.map(c => '<span class="chip' + (S.connected.has(c.host) ? " ok" : "") + '">' + dot("host:" + c.host) + esc(hostName(c.host)) + " · " + (c.rw ? t("write") : t("read")) + "</span>")
          : Object.entries(s.access).map(([k, m]) => '<span class="chip">' + (k[0] === "g" ? t("group {name}", { name: esc(k.slice(2)) }) : esc(k.slice(2))) + " · " + (m === "rw" ? t("write") : t("read")) + "</span>")).join("") +
        '</div></td><td class="actions"><button data-act="share-edit" data-kind="' + kind + '" data-name="' + esc(name) + '">' + t("Edit") + "</button>" +
        '<button class="danger" data-act="share-del" data-kind="' + kind + '" data-name="' + esc(name) + '">' + t("Delete") + "</button></td></tr>").join("") +
      "</tbody></table></div>"
      : '<p class="sub">' + t("No shares created from the panel.") + "</p>") +
    (f.smb && M.sessions.length ? '<p class="sub"><b>' + t("Current SMB connections") + "</b></p>" + M.sessions.map(x => '<div class="svc"><span class="dot ' + (x.encryption ? "ok" : "") + '"></span><b>' +
      esc(x.user) + '</b><span class="sub">' + esc(hostName(x.machine)) + " · " + esc((x.shares || []).join(", ") || t("no share open")) + " · " + esc(x.dialect) +
      " · " + (x.encryption ? t("encrypted {v}", { v: esc(x.encryption) }) : t("not encrypted")) + " · " + t("since {when}", { when: new Date(x.since).toLocaleString(LOCALE()) }) + "</span></div>").join("") : "") +
    (f.smb && M.bonjour && M.bonjour !== "absent" ? '<div class="svc"><span class="dot ' + (M.bonjour === "active" ? "ok" : "") + '"></span><b>' + t("Bonjour announcement") + "</b>" +
      '<span class="sub">' + (M.bonjour === "active" ? t("on: Macs see the server and its Time Machine destinations without typing an address")
        : t("off: connect by address (smb://…)")) + '</span><button data-act="bonjour" data-on="' + (M.bonjour === "active" ? "" : "1") + '">' +
      (M.bonjour === "active" ? t("Stop") : t("Turn on")) + "</button></div>" : "") +
    '<p class="sub">' + (f.smb ? t("SMB: \\\\{host}\\name (Windows) or smb://{host}/name (macOS), with an account from the Accounts section.", { host: esc(host) }) + " " : "") +
    (f.nfs ? t("NFS: access by client IP address, no account.") : "") + "</p>";
}

async function shareForm(kind, name) {
  const cur = name ? M.state[kind][name] : null;
  // An NFS path can be exported once: not by /etc/exports, not by another panel share.
  const taken = new Set(M.admin_exports.concat(Object.entries(M.state.nfs || {}).filter(([n]) => n !== name).map(([, s]) => s.path)));
  const paths = M.mountpoints.filter(p => kind === "smb" || !taken.has(p));
  let body = "<label>" + t("Name") + (name ? '<input name="name" value="' + esc(name) + '" readonly>'
    : '<input name="name" required maxlength="32" pattern="[A-Za-z0-9_\\-]+" placeholder="' + t("e.g. Photos") + '">') + "</label>" +
    "<label>" + t("Folder (ZFS dataset)") + '<select name="path" required>' + paths.map(p => "<option" + (cur && cur.path === p ? " selected" : "") + ">" + esc(p) + "</option>").join("") + "</select></label>";
  if (kind === "nfs") {
    const rows = (cur ? cur.clients : []).concat(Array(Math.max(2, 5 - (cur ? cur.clients.length : 0))).fill({ host: "", rw: false, squash: "root_squash" }));
    body += '<fieldset class="rows"><legend>' + t("Clients · IP address, network (192.168.1.0/24) or name; empty lines are ignored") + "</legend>" + rows.map((c, i) =>
      '<div class="client"><input name="host' + i + '" list="hosts-dl" value="' + esc(c.host) + '" aria-label="' + t("Client {n}", { n: i + 1 }) + '">' +
      '<select name="rw' + i + '" aria-label="' + t("Rights") + '"><option value="">' + t(ACCESS.ro) + '</option><option value="1"' + (c.rw ? " selected" : "") + ">" + t(ACCESS.rw) + "</option></select>" +
      '<select name="sq' + i + '" aria-label="' + t("root user") + '">' + SQUASHES.map(([v, l]) => '<option value="' + v + '"' + (c.squash === v ? " selected" : "") + ">" + t(l) + "</option>").join("") +
      "</select></div>").join("") + "</fieldset>" +
      (FEAT().firewall ? '<label class="check"><input type="checkbox" name="fw"' + (cur && cur.open_fw ? " checked" : "") +
        "> " + t("Open the firewall (NFS, port 2049) for these clients") + '</label><p class="sub">' +
        t("Closed by default: tick it if the client does not already have access. IP addresses or networks only. Deleting the share closes the access again.") + "</p>" : "") +
      '<datalist id="hosts-dl">' + Object.entries(CFG.hosts || {}).map(([ip, n]) => '<option value="' + esc(ip) + '">' + esc(n) + "</option>").join("") + "</datalist>";
    const fd = await ask(name ? t("NFS share {name}", { name }) : t("New NFS share"), body, t("Save"));
    if (!fd) return;
    const clients = rows.map((_, i) => ({ host: fd.get("host" + i).trim(), rw: fd.get("rw" + i) === "1", squash: fd.get("sq" + i) })).filter(c => c.host);
    return mg({ op: "share_save", kind, name: fd.get("name"), path: fd.get("path"), clients, open_fw: fd.get("fw") === "on" }, t("NFS share {name} saved", { name: fd.get("name") }));
  }
  // Without a Samba password an account cannot log in: shown, not selectable.
  const who = M.users.map(u => ["u:" + u.name, u.name, !u.samba]).concat(M.groups.filter(g => g.owned).map(g => ["g:" + g.name, t("group {name}", { name: g.name }), false]));
  body += '<fieldset class="rows"><legend>' + t("Access") + "</legend>" + (who.length ? who.map(([k, l, off]) =>
    '<div class="client"><span>' + esc(l) + (off ? ' <small class="sys">' + t("no Samba password") + "</small>" : "") + '</span><select name="' + esc(k) + '"' +
    (off ? " disabled" : "") + ' aria-label="' + t("Access for {name}", { name: esc(l) }) + '"><option value="">' + t("no access") + "</option>" +
    Object.entries(ACCESS).map(([v, a]) => '<option value="' + v + '"' + (cur && cur.access[k] === v ? " selected" : "") + ">" + t(a) + "</option>").join("") + "</select></div>").join("")
    : '<p class="sub">' + t("No accounts: create one in the Accounts section.") + "</p>") + "</fieldset>" +
    (FEAT().firewall ? "<label>" + t("Open the firewall (SMB, port 445) for") + '<input name="fw" value="' + esc((cur && cur.fw || []).join(", ")) +
      '" placeholder="' + t("empty = closed; e.g. 192.168.1.20, 192.168.1.0/24") + '"></label>' : "") +
    "<label>" + t("Encryption") + '<select name="encrypt"><option value="desired">' + t("if the client can encrypt (macOS, Windows 10 and later)") + "</option>" +
    '<option value="required"' + (cur && cur.encrypt === "required" ? " selected" : "") + ">" + t("required: refuse clients that do not encrypt") + "</option></select></label>" +
    '<label class="check"><input type="checkbox" name="versions"' + (cur ? (cur.versions ? " checked" : "") : " checked") +
    "> " + t("Previous versions (Windows) from the dataset's automatic snapshots") + "</label>" +
    '<label class="check"><input type="checkbox" name="recycle"' + (cur ? (cur.recycle ? " checked" : "") : " checked") +
    "> " + t("Recycle bin: deleted files go to .recycle and are erased after {n} days", { n: CFG.recycle_days || 30 }) + "</label>" +
    '<label class="check"><input type="checkbox" name="tm"' + (cur && cur.timemachine ? " checked" : "") + "> " + t("Time Machine destination (Mac backups)") + "</label>" +
    "<label>" + t("Time Machine maximum size") + '<input name="tm_max" pattern="[0-9]+(\\.[0-9]+)?[KMGT]?" value="' + esc(cur && cur.tm_max || "") +
    '" placeholder="' + t("empty = no limit; e.g. 1T") + '"></label>' +
    "<label>" + t("File owner") + '<select name="owner"><option value="">' + t("current owner of the folder") + "</option>" +
    M.users.filter(u => u.samba).map(u => "<option" + (cur && cur.owner === u.name ? " selected" : "") + ">" + esc(u.name) + "</option>").join("") + "</select></label>" +
    '<p class="sub">' + t("Samba writes new files as this account. Choosing an account makes it the owner of the shared folder itself, not of its contents. Required if the folder belongs to root (never any writing as root). Only the accounts chosen under Access can connect.") + "</p>";
  const fd = await ask(name ? t("SMB share {name}", { name }) : t("New SMB share"), body, t("Save"));
  if (!fd) return;
  const access = Object.fromEntries(who.map(([k]) => [k, fd.get(k)]).filter(([, v]) => v));
  const fw = (fd.get("fw") || "").split(/[\s,;]+/).filter(Boolean);
  return mg({ op: "share_save", kind, name: fd.get("name"), path: fd.get("path"), access, fw, owner: fd.get("owner"), encrypt: fd.get("encrypt"), timemachine: fd.get("tm") === "on", tm_max: fd.get("tm_max").trim(), versions: fd.get("versions") === "on", recycle: fd.get("recycle") === "on" }, t("SMB share {name} saved", { name: fd.get("name") }));
}

// One form: dataset (reused, or created if pools are on) + account + encrypted Time Machine share.
async function tmForm() {
  const pools = FEAT().pools;
  const fd = await ask(t("New Time Machine destination"),
    "<label>" + t("Mac name (account and share)") + '<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="' + t("e.g. macbook-pro") + '" autocomplete="off"></label>' +
    "<label>" + t("Dataset") + '<input name="ds" required list="tm-ds" placeholder="' + t("e.g. tank/timemachine/macbook-pro") + '"></label>' +
    '<datalist id="tm-ds">' + fsRows().map(r => '<option value="' + esc(r[0]) + '">').join("") + "</datalist>" +
    '<p class="sub">' + (pools ? t("Existing: reused. New: created with this quota, 1M blocks, no automatic snapshots.")
      : t("Existing dataset only (created by the administrator, ideally with a quota).")) + "</p>" +
    "<label>" + t("Reserved size") + '<input name="size" required pattern="[0-9]+(\\.[0-9]+)?[KMGT]" value="2T"></label>' +
    (FEAT().firewall ? "<label>" + t("Open the SMB firewall for (the Mac's IP, or the network if it uses DHCP)") + '<input name="ip" placeholder="' + t("empty = closed; e.g. 192.168.1.107 or 192.168.1.0/24") + '"></label>' : "") +
    passwords() + '<p class="sub">' + t("Encryption required. On the Mac: Settings > Time Machine > Add Destination, account = Mac name.") + "</p>", t("Create"));
  if (fd && samePasswords(fd)) mg({ op: "timemachine_create", name: fd.get("name"), dataset: fd.get("ds").trim(), size: fd.get("size"), ip: (fd.get("ip") || "").trim(), password: fd.get("p1") },
    t("Time Machine destination {name} created", { name: fd.get("name") }));
}

async function deleteShare(kind, name) {
  const fd = await ask(t("Delete the share?"), "<p>" + t("The share <b>{name}</b> will no longer be accessible. The files stay in the dataset.", { name: esc(name) }) + "</p>", t("Delete"), true);
  if (fd) mg({ op: "share_delete", kind, name }, t("Share {name} deleted", { name }));
}

function renderAccounts() {
  const el = $("accounts");
  if (!FEAT().users) { el.innerHTML = '<article class="card"><p class="sub">' + t("Account management is disabled on this server.") + "</p></article>"; return; }
  if (!M) return;
  const owned = M.groups.filter(g => g.owned);
  const btn = (act, name, label, cls) => '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-act="' + act + '" data-name="' + esc(name) + '">' + label + "</button>";
  el.innerHTML = '<article class="card"><div class="card-head"><b>' + t("Users") + '</b><button class="primary" data-act="user-new">' + t("New user") + "</button></div>" +
    '<div class="table-wrap"><table><thead><tr><th>' + t("Username") + "</th><th>" + t("Groups") + "</th><th>" + t("Source") + "</th><th></th></tr></thead><tbody>" +
    M.users.map(u => "<tr><td><b>" + esc(u.name) + '</b> <small class="sys">uid ' + u.uid + "</small></td><td>" + (u.groups.map(esc).join(", ") || "—") +
      "</td><td>" + (u.owned ? t("panel") : '<span class="sub">' + t("system, read-only") + "</span>") + '</td><td class="actions">' +
      (u.owned ? btn("user-groups", u.name, t("Groups")) + btn("user-pass", u.name, t("Password")) + btn("user-del", u.name, t("Delete"), "danger") : "") + "</td></tr>").join("") +
    '</tbody></table></div><p class="sub">' + t("Linux accounts that cannot log in to the server (no shell, no SSH), with a Samba password for SMB shares.") + "</p></article>" +
    '<article class="card"><div class="card-head"><b>' + t("Groups") + '</b><button class="primary" data-act="group-new">' + t("New group") + "</button></div>" +
    (owned.length ? owned.map(g => '<div class="svc"><b>' + esc(g.name) + '</b><span class="sub">' + (g.members.map(esc).join(", ") || t("no members")) + "</span>" +
      btn("group-del", g.name, t("Delete"), "danger") + "</div>").join("")
      : '<p class="sub">' + t("No groups. A group gives several accounts the same access (e.g. family).") + "</p>") + "</article>";
}

function groupBoxes(checked) {
  const owned = M.groups.filter(g => g.owned);
  return '<fieldset class="swatches"><legend>' + t("Groups") + "</legend>" + (owned.length ? owned.map(g => '<label class="swatch"><input type="checkbox" name="g" value="' + esc(g.name) + '"' +
    (checked.includes(g.name) ? " checked" : "") + ">" + esc(g.name) + "</label>").join("") : '<span class="sub">' + t("No groups created.") + "</span>") + "</fieldset>";
}
const passwords = () => "<label>" + t("Password (at least 8 characters)") + '<input type="password" name="p1" minlength="8" maxlength="128" required autocomplete="new-password"></label>' +
  "<label>" + t("Confirmation") + '<input type="password" name="p2" minlength="8" maxlength="128" required autocomplete="new-password"></label>';
function samePasswords(fd) {
  if (fd.get("p1") === fd.get("p2")) return true;
  banner(t("The two passwords do not match."));
  return false;
}

async function userForm() {
  const fd = await ask(t("New user"), "<label>" + t("Username") + '<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="' + t("e.g. alice") + '" autocomplete="off"></label>' +
    passwords() + groupBoxes([]), t("Create"));
  if (fd && samePasswords(fd)) mg({ op: "user_create", name: fd.get("name"), password: fd.get("p1"), groups: fd.getAll("g") }, t("Account {name} created", { name: fd.get("name") }));
}
async function passwordForm(name) {
  const fd = await ask(t("Password for {name}", { name }), passwords(), t("Change"));
  if (fd && samePasswords(fd)) mg({ op: "user_password", name, password: fd.get("p1") }, t("Password for {name} changed", { name }));
}
async function userGroupsForm(name) {
  const fd = await ask(t("Groups for {name}", { name }), groupBoxes(M.users.find(u => u.name === name).groups), t("Save"));
  if (fd) mg({ op: "user_groups", name, groups: fd.getAll("g") }, t("Groups for {name} saved", { name }));
}
async function deleteAccount(op, name) {
  const fd = await ask(t("Delete {name}?", { name }), "<p>" + t("<b>{name}</b> will be deleted. Their files stay on the shares.", { name: esc(name) }) + "</p>", t("Delete"), true);
  if (fd) mg({ op, name }, t("{name} deleted", { name }));
}
async function groupForm() {
  const fd = await ask(t("New group"), "<label>" + t("Name") + '<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="' + t("e.g. family") + '"></label>', t("Create"));
  if (fd) mg({ op: "group_create", name: fd.get("name") }, t("Group {name} created", { name: fd.get("name") }));
}

async function datasetForm() {
  const fd = await ask(t("New dataset"), "<label>" + t("In") + '<select name="parent">' + fsRows().map(r => "<option>" + esc(r[0]) + "</option>").join("") + "</select></label>" +
    "<label>" + t("Name") + '<input name="leaf" required pattern="[A-Za-z0-9_.:\\-]+" placeholder="' + t("e.g. photos") + '"></label>' +
    "<label>" + t("Compression") + '<select name="comp">' + COMPRESSION.map(c => "<option>" + c + "</option>").join("") + "</select></label>", t("Create"));
  if (fd) mg({ op: "dataset_create", dataset: fd.get("parent") + "/" + fd.get("leaf"), compression: fd.get("comp") }, t("Dataset {name} created", { name: fd.get("parent") + "/" + fd.get("leaf") }));
}
async function poolForm() {
  const disks = M.free_disks;
  if (!disks.length) {
    await ask(t("New pool"), "<p>" + t("No free disk: every disk already has partitions or data, or belongs to a pool.") + "</p>", t("Close"));
    return;
  }
  const fd = await ask(t("New pool"),
    '<p class="sub">' + t("Only blank disks are offered. <b>The chosen disks will be completely erased.</b>") + "</p>" +
    "<label>" + t("Name") + '<input name="name" required pattern="[A-Za-z][A-Za-z0-9_.:\\-]*" placeholder="' + t("e.g. data") + '"></label>' +
    "<label>" + t("Layout") + '<select name="layout">' + LAYOUT_LABELS.map(([v, l]) => '<option value="' + v + '">' + t(l) + "</option>").join("") + "</select></label>" +
    '<fieldset class="swatches"><legend>' + t("Disks") + "</legend>" + disks.map(d => '<label class="swatch"><input type="checkbox" name="d" value="' + esc(d.id) + '">' +
      esc(d.dev) + " · " + bytes(d.size) + " · " + esc(d.model) + "</label>").join("") + "</fieldset>" +
    "<label>" + t("Confirmation: retype the pool name") + '<input name="confirm" required autocomplete="off"></label>', t("Create the pool"), true);
  if (fd) mg({ op: "pool_create", name: fd.get("name"), layout: fd.get("layout"), disks: fd.getAll("d"), confirm: fd.get("confirm") }, t("Pool {name} created", { name: fd.get("name") }));
}

// ZFS volume (zvol): a block device of a fixed size, e.g. a VM disk. It can grow, never shrink.
async function zvolForm() {
  const fd = await ask(t("New volume"), '<p class="sub">' + t("A block device of a fixed size (/dev/zvol/…), e.g. a virtual machine disk. It can be grown later, never shrunk.") + "</p>" +
    "<label>" + t("In") + '<select name="parent">' + fsRows().map(r => "<option>" + esc(r[0]) + "</option>").join("") + "</select></label>" +
    "<label>" + t("Name") + '<input name="leaf" required pattern="[A-Za-z0-9_.:\\-]+" placeholder="' + t("e.g. vm-disk") + '"></label>' +
    "<label>" + t("Size (e.g. 100G, 1.5T)") + '<input name="size" required pattern="[0-9]+(\\.[0-9]+)?[KMGTPkmgtp]?"></label>' +
    '<label class="check"><input type="checkbox" name="sparse" checked> ' + t("Thin (sparse): space is taken as data is written") + "</label>" +
    "<label>" + t("Block size") + '<select name="vbs">' + ["8K", "16K", "32K", "64K", "128K"].map(b => "<option" + (b === "16K" ? " selected" : "") + ">" + b + "</option>").join("") + "</select></label>" +
    "<label>" + t("Compression") + '<select name="comp">' + COMPRESSION.map(c => "<option>" + c + "</option>").join("") + "</select></label>" +
    '<p class="sub">' + t("Not thin: the whole size is reserved in the pool now, so writes never fail for lack of space. The block size cannot be changed afterwards.") + "</p>", t("Create"));
  const name = fd && fd.get("parent") + "/" + fd.get("leaf");
  if (fd) mg({ op: "zvol_create", dataset: name, size: fd.get("size"), sparse: !!fd.get("sparse"), volblocksize: fd.get("vbs"), compression: fd.get("comp") }, t("Volume {name} created", { name }));
}
async function zvolGrow(name, size) {
  const fd = await ask(t("Grow {name}", { name }), "<p>" + t("Current size: {size}", { size: bytes(Number(size)) }) + "</p>" +
    "<label>" + t("New size (e.g. 200G, 2T)") + '<input name="size" required pattern="[0-9]+(\\.[0-9]+)?[KMGTPkmgtp]?"></label>' +
    '<p class="sub">' + t("A volume can only grow. Then extend the partition and file system inside it, from the machine that uses it.") + "</p>", t("Grow"));
  if (fd) mg({ op: "zvol_grow", dataset: name, size: fd.get("size") }, t("{name} grown", { name }));
}

// iSCSI export (features.iscsi): one target per volume, open only to the listed initiators.
async function iscsiForm(name) {
  const cur = (M.state.iscsi || {})[name];
  const ips = Object.values(S.addrs).flatMap(a => a.ips.map(ip => ip.split("/")[0])).filter(ip => !ip.startsWith("127."));
  const fd = await ask(cur ? t("iSCSI access to {name}", { name }) : t("Export {name} over iSCSI", { name }),
    (cur ? '<p class="sub">' + t("Target: {iqn}", { iqn: "<code>" + esc(cur.iqn) + "</code>" }) + "</p>" : "") +
    '<p class="sub">' + t("Portal: port 3260 on {ips}. No machine is allowed by default: list each one by its iSCSI name (on Linux and Proxmox: /etc/iscsi/initiatorname.iscsi). A volume must be used by one machine at a time, unless a cluster file system manages it.", { ips: esc(ips.join(", ") || "—") }) + "</p>" +
    "<label>" + t("Allowed machines (one iSCSI name per line)") + '<textarea name="ini" required rows="4" placeholder="iqn.1993-08.org.debian:01:…">' + esc((cur ? cur.initiators : []).join("\n")) + "</textarea></label>",
    cur ? t("Save") : t("Export"));
  if (fd) mg({ op: "iscsi_save", zvol: name, initiators: fd.get("ini").split(/\s+/).filter(Boolean) }, t("{name} exported over iSCSI", { name }));
}
async function iscsiStop(name) {
  const fd = await ask(t("Stop the iSCSI export of {name}?", { name }), "<p>" + t("Connected machines lose this disk at once. The data stays on the volume.") + "</p>", t("Stop the export"), true);
  if (fd) mg({ op: "iscsi_delete", zvol: name }, t("iSCSI export of {name} stopped", { name }));
}

// Deletion: permanent, the full name retyped; the server refuses while a share, an export or a replication uses it.
const confirmName = () => "<label>" + t("Confirmation: retype the full name") + '<input name="confirm" required autocomplete="off"></label>';
async function destroyDataset(name) {
  const kids = S.datasets.filter(r => r[0].startsWith(name + "/")).map(r => r[0]);
  const snaps = S.snapshots.filter(s => s[0].startsWith(name + "@") || s[0].startsWith(name + "/")).length;
  const vol = isVol(S.datasets.find(r => r[0] === name) || []);
  const fd = await ask(t("Delete {name}?", { name }),
    "<p>" + t(vol ? "Deletion is permanent: the volume <b>{name}</b>, its data and all its snapshots are destroyed. There is no undo."
      : "Deletion is permanent: <b>{name}</b>, its files and all its snapshots are destroyed. There is no undo.", { name: esc(name) }) + "</p>" +
    (snaps ? '<p class="sub">' + tp(snaps, "{n} snapshot is deleted with it.", "{n} snapshots are deleted with it.") + "</p>" : "") +
    (kids.length ? '<p class="sub">' + t("Child datasets:") + "<br>" + kids.map(esc).join("<br>") + "</p>" +
      '<label class="check"><input type="checkbox" name="r"> ' + t("With its children ({n}), deleted too", { n: kids.length }) + "</label>" : "") +
    '<p class="sub">' + t("Refused while a share, an export or a replication uses it, or while its files are open.") + "</p>" + confirmName(), t("Delete permanently"), true);
  if (fd) mg({ op: "dataset_destroy", dataset: name, confirm: fd.get("confirm"), recursive: !!fd.get("r") }, t("{name} deleted", { name }));
}
async function destroyPool(pool) {
  const n = S.datasets.filter(r => r[0].startsWith(pool + "/")).length;
  const fd = await ask(t("Delete the pool {pool}?", { pool }),
    "<p>" + t("Deletion is permanent: the pool <b>{pool}</b> and everything in it ({n} datasets and volumes, all snapshots) are destroyed. There is no undo.", { pool: esc(pool), n }) + "</p>" +
    '<p class="sub">' + t("Refused while a share, an export or a replication points into it. The disks are left as they are (not wiped): they become free again only once erased.") + "</p>" +
    confirmPool(pool), t("Delete permanently"), true);
  if (fd) mg({ op: "pool_destroy", pool, confirm: fd.get("confirm") }, t("Pool {name} deleted", { name: pool }));
}

// Pool layout: log / cache / spare (features.vdevs, removable later), data groups and RAIDZ expansion (features.pools, for good).
const ROLE_FORMS = {
  log: ["Add a log device (SLOG) to {pool}", "A log device (SLOG) receives the synchronous writes (NFS, virtual machines, databases) on a fast SSD before ZFS writes them to the pool; ordinary writes do not use it. Choose an SSD with power-loss protection (capacitors, found on data-center models such as the Intel S3500): the panel cannot check it, and a consumer SSD without it gives little or no gain. A few GB are used. Two or three disks are mirrored. It can be removed at any time, without losing data."],
  cache: ["Add a cache device (L2ARC) to {pool}", "A cache device (L2ARC) keeps a copy of often-read data on an SSD, beyond the memory cache (ARC). Useful only when the data read often does not fit in memory; it uses a little memory itself. No redundancy needed: losing it loses no data. It can be removed at any time."],
  spare: ["Add a spare disk to {pool}", "A spare disk waits unused; when a disk of the pool fails, ZFS puts the spare in its place and rebuilds onto it. It must be at least as large as the pool's disks. It can be removed while unused."],
  data: ["Add a data group to {pool}", "The pool grows by a new group of disks; new data is spread over all the groups. <b>This cannot be undone</b>: a pool with a RAIDZ group can never lose a group. Use the same layout and disk size as the existing groups; zpool refuses a different redundancy level."],
};
const noFreeDisk = async title => ask(title, "<p>" + t("No free disk: every disk already has partitions or data, or belongs to a pool.") + "</p>" +
  '<p class="sub">' + t("Plug in the new disk: it appears here once it is blank (no partition, no signature).") + "</p>", t("Close"));
const diskChoice = (type, name) => '<fieldset class="swatches"><legend>' + t("Disks") + "</legend>" + M.free_disks.map((d, i) => '<label class="swatch"><input type="' + type + '" name="' + name + '" value="' + esc(d.id) + '"' +
  (type === "radio" ? " required" + (i ? "" : " checked") : "") + ">" + esc(d.dev) + " · " + bytes(d.size) + " · " + esc(d.model) + "</label>").join("") + "</fieldset>";
async function vdevForm(pool, role) {
  const [title, help] = ROLE_FORMS[role];
  if (!M.free_disks.length) return noFreeDisk(t(title, { pool }));
  // The existing groups' layout is offered first: e.g. raidz1 × 3 → raidz1.
  const [root] = poolTree(S.statusOf[pool] || ""), first = root && root.children[0];
  const same = first && first.children.length ? first.name.replace(/-\d+$/, "") : "stripe";
  const fd = await ask(t(title, { pool }), '<p class="sub">' + t(help) + "</p>" +
    (role === "data" ? "<label>" + t("Layout") + '<select name="layout">' + LAYOUT_LABELS.map(([v, l]) => '<option value="' + v + '"' + (v === same ? " selected" : "") + ">" + t(l) + "</option>").join("") + "</select></label>" +
      (first ? '<p class="sub">' + t("Existing groups: {layout} of {n} disks.", { layout: same, n: leaves(first).length }) + "</p>" : "") : "") +
    '<p class="sub">' + t("Only blank disks are offered. <b>The chosen disks will be completely erased.</b>") + "</p>" + diskChoice("checkbox", "d") + confirmPool(pool), t("Add"), true);
  if (fd) mg({ op: "vdev_add", pool, role, layout: fd.get("layout") || "", disks: fd.getAll("d"), confirm: fd.get("confirm") }, t("Added to {pool}", { pool }));
}
async function vdevRemove(pool, dev, role) {
  const fd = await ask(t("Remove {dev} from {pool}?", { dev, pool }), "<p>" + t(role === "logs" ? "Synchronous writes go back to the pool's own disks (slower). No data is lost."
    : role === "cache" ? "Reads are served by the pool's disks and the memory cache. No data is lost." : "The pool no longer has this spare disk.") + "</p>" +
    '<p class="sub">' + t("The disk keeps its ZFS label: it is offered again as a free disk only once erased (wipefs -a).") + "</p>", t("Remove"), true);
  if (fd) mg({ op: "vdev_remove", pool, device: dev }, t("{dev} removed from {pool}", { dev, pool }));
}
async function raidzExpand(pool) {
  const [root] = poolTree(S.statusOf[pool] || ""), groups = (root ? root.children : []).filter(v => /^raidz/.test(v.name));
  if (!M.free_disks.length) return noFreeDisk(t("Expand a RAIDZ group of {pool}", { pool }));
  const fd = await ask(t("Expand a RAIDZ group of {pool}", { pool }),
    '<p class="sub">' + t("One more disk in the group (OpenZFS 2.3 or later). The data is spread again in the background, the pool stays usable; progress shows here. <b>This cannot be undone.</b> Data written before keeps its old parity ratio until rewritten, so part of the new space shows only then. The disk must be at least as large as the others and <b>will be completely erased</b>.") + "</p>" +
    "<label>" + t("Group") + '<select name="vdev">' + groups.map(v => "<option>" + esc(v.name) + "</option>").join("") + "</select></label>" + diskChoice("radio", "new") + confirmPool(pool), t("Expand"), true);
  if (fd) mg({ op: "raidz_expand", pool, vdev: fd.get("vdev"), new: fd.get("new"), confirm: fd.get("confirm") }, t("Expansion started on {pool}", { pool }));
}

// Export / import / feature upgrade / trim.
async function exportPool(pool) {
  const fd = await ask(t("Export {pool}?", { pool }), "<p>" + t("The pool is cleanly detached from this server: its datasets are unmounted and it leaves the page until it is imported again, here or on another machine (move the disks).") + "</p>" +
    '<p class="sub">' + t("Refused while a share, an export or a replication uses it, or while its files are open.") + "</p>" + confirmPool(pool), t("Export"), true);
  if (fd) mg({ op: "pool_export", pool, confirm: fd.get("confirm") }, t("Pool {name} exported", { name: pool }));
}
async function importPool() {
  let list = [];
  try { list = JSON.parse(await get("/api/importable")); } catch (e) { return banner(t("Failed: {err}", { err: e.message })); }
  if (!list.length) return ask(t("Import a pool"), "<p>" + t("No pool to import: the disks of an exported pool show up here once plugged in.") + "</p>", t("Close"));
  const fd = await ask(t("Import a pool"), '<fieldset class="swatches"><legend>' + t("Pools found on the disks") + "</legend>" + list.map((p, i) =>
    '<label class="swatch"><input type="radio" name="id" required value="' + esc(p.id) + '"' + (i ? "" : " checked") + ">" + esc(p.name) + " · " + esc(p.state) + "</label>").join("") + "</fieldset>" +
    list.map(p => '<pre class="sub">' + esc(p.text) + "</pre>").join("") +
    '<p class="sub">' + t("A pool still in use by another machine (not exported there) is not imported from the panel.") + "</p>", t("Import"));
  const p = fd && list.find(x => x.id === fd.get("id"));
  if (p) mg({ op: "pool_import", id: p.id }, t("Pool {name} imported", { name: p.name }));
}
async function upgradePool(pool) {
  const fd = await ask(t("Enable the new ZFS features on {pool}?", { pool }), "<p>" + t("Every feature of this server's ZFS version is enabled on the pool. <b>This cannot be undone: older systems (an older Debian, another NAS, a rescue disk) can no longer import the pool.</b> The data stays as it is.") + "</p>" +
    confirmPool(pool), t("Enable"), true);
  if (fd) mg({ op: "pool_upgrade", pool, confirm: fd.get("confirm") }, t("ZFS features enabled on {pool}", { pool }));
}
async function trimPool(pool) {
  const fd = await ask(t("Trim {pool} now?", { pool }), "<p>" + t("TRIM tells the SSDs which blocks are free, which keeps their write speed up. It runs in the background; disks that do not support it are skipped.") + "</p>", t("Trim now"));
  if (fd) mg({ op: "pool_trim", pool }, t("Trim started on {pool}", { pool }));
}

// Disk replacement (features.disks): offline and replace need the pool name retyped.
const confirmPool = pool => "<label>" + t("Confirmation: retype the pool name") + '<input name="confirm" required autocomplete="off"></label>';
async function diskOffline(pool, dev) {
  const fd = await ask(t("Take {dev} offline?", { dev }), "<p>" + t("ZFS stops using this disk; <b>{pool}</b> keeps running on the others, with less redundancy, until the disk is brought back online or replaced.", { pool: esc(pool) }) + "</p>" +
    '<p class="sub">' + t("Refused when the disk group would be left without redundancy: replace the disk instead, the old one keeps working until the copy is done.") + "</p>" + confirmPool(pool), t("Take offline"), true);
  if (fd) mg({ op: "disk_offline", pool, device: dev, confirm: fd.get("confirm") }, t("{dev} is offline", { dev }));
}
async function diskReplace(pool, dev) {
  const disks = M.free_disks;
  if (!disks.length) {
    await ask(t("Replace {dev} in {pool}", { dev, pool }), "<p>" + t("No free disk: every disk already has partitions or data, or belongs to a pool.") + "</p>" +
      '<p class="sub">' + t("Plug in the new disk: it appears here once it is blank (no partition, no signature).") + "</p>", t("Close"));
    return;
  }
  const fd = await ask(t("Replace {dev} in {pool}", { dev, pool }),
    '<p class="sub">' + t("ZFS copies the data onto the new disk (resilver), then detaches the old one. <b>The chosen disk will be completely erased.</b> It must be at least as large as the old one.") + "</p>" +
    '<fieldset class="swatches"><legend>' + t("New disk") + "</legend>" + disks.map((d, i) => '<label class="swatch"><input type="radio" name="new" required value="' + esc(d.id) + '"' + (i ? "" : " checked") + ">" +
      esc(d.dev) + " · " + bytes(d.size) + " · " + esc(d.model) + "</label>").join("") + "</fieldset>" + confirmPool(pool), t("Replace"), true);
  if (fd) mg({ op: "disk_replace", pool, device: dev, new: fd.get("new"), confirm: fd.get("confirm") }, t("Resilver started on {pool}", { pool }));
}

/* ---------- actions (validated again server-side) ---------- */

const act = (payload, okMsg) => once(async () => {
  try {
    await post("/api/action", payload);
    banner("");
    toast(okMsg);
    await slowTick();
  } catch (e) { banner(t("Failed: {err}", { err: e.message })); }
});

async function editDataset(name, comp, quota, auto) {
  const sch = FEAT().autosnap && SCH();
  const fd = await ask(t("Edit {name}", { name }),
    "<label>" + t("Compression") + '<select name="comp">' + COMPRESSION.map(c => "<option" + (c === comp ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
    "<label>" + t("Quota (e.g. 500G, 1T, none)") + '<input name="quota" required pattern="none|[0-9]+(\\.[0-9]+)?[KMGTP]?" value="' + esc(quota) + '"></label>' +
    (sch ? '<fieldset class="rows"><legend>' + t("Automatic snapshots") + "</legend>" + LABELS.map(([l, n]) => '<label class="check"><input type="checkbox" name="lab" value="' + l + '"' +
      (labelsOn(name).includes(l) ? " checked" : "") + "> " + t(n) + (SCH().autosnap.keep[l] != null ? ' <small class="sys">' + t("keep {n}", { n: SCH().autosnap.keep[l] }) + "</small>" : "") + "</label>").join("") + "</fieldset>"
    : FEAT().autosnap ? "<label>" + t("Automatic snapshots") + '<select name="auto"><option value="true">' + t("yes (rotation: quarter-hour, hour, day, week, month)") + "</option>" +
      '<option value="false"' + (auto === "false" ? " selected" : "") + ">" + t("no") + "</option></select></label>" : "") +
    '<p class="sub">' + t("Compression only applies to data written afterwards. Child datasets inherit the automatic snapshot choice.") + "</p>");
  if (!fd) return;
  await act({ action: "dataset_set", dataset: name, compression: fd.get("comp"), quota: fd.get("quota"), autosnap: sch ? "" : fd.get("auto") || "" }, t("{name} updated", { name }));
  const want = fd.getAll("lab");
  if (sch && want.join() !== labelsOn(name).join()) mg({ op: "autosnap_labels", dataset: name, labels: want }, t("{name} updated", { name }));
}

/* native encryption (features.encryption) */

const ENC = () => FEAT().encryption && M && M.encryption;
const encNewBtn = () => ENC() ? '<button data-act="enc-new">' + t("New encrypted dataset") + "</button>" : "";
function encCell(ds) {
  const e = ENC().find(x => x.name === ds);
  if (!e) return "—";
  const st = e.keystatus === "available" ? t("unlocked") : t("locked");
  if (e.root !== ds) return '<small class="sys">' + t("{st}, key of {root}", { st, root: e.root }) + "</small>";
  const d = ' data-ds="' + esc(ds) + '"';
  return '<span class="pill ' + (e.keystatus === "available" ? "ok" : "warn") + '">' + st + "</span> " +
    (e.keystatus === "available" ? '<button data-act="enc-lock"' + d + ">" + t("Lock") + "</button>" : '<button data-act="enc-unlock"' + d + ' data-pass="' + (e.keyfile ? "" : "1") + '">' + t("Unlock") + "</button>") +
    '<br><small class="sys">' + (e.keyfile ? t("key file") : t("passphrase")) + "</small>" +
    (e.keyfile ? ' <button class="link" data-act="enc-boot"' + d + ' data-on="' + (e.boot ? "" : "1") + '">' + (e.boot ? t("unlocked at boot") : t("not unlocked at boot")) + "</button>" : "");
}
async function encForm() {
  const fd = await ask(t("New encrypted dataset"), "<label>" + t("In") + '<select name="parent">' + fsRows().map(r => "<option>" + esc(r[0]) + "</option>").join("") + "</select></label>" +
    "<label>" + t("Name") + '<input name="leaf" required pattern="[A-Za-z0-9_.:\\-]+" placeholder="' + t("e.g. papers") + '"></label>' +
    '<fieldset class="rows"><legend>' + t("Key") + "</legend>" +
    '<label class="check"><input type="radio" name="kf" value="passphrase" checked> ' + t("Passphrase: asked at each unlock, never stored") + "</label>" +
    '<label class="check"><input type="radio" name="kf" value="keyfile"> ' + t("Key file on this machine (/etc/cairn-nas/keys, root only)") + "</label></fieldset>" +
    "<label>" + t("Passphrase (8 characters or more)") + '<input name="pass" type="password" minlength="8" maxlength="512" autocomplete="new-password"></label>' +
    "<label>" + t("Passphrase again") + '<input name="pass2" type="password" autocomplete="new-password"></label>' +
    '<label class="check"><input type="checkbox" name="boot"> ' + t("Unlock at boot (key file only)") + "</label>" +
    '<p class="sub">' + t("An existing dataset cannot be encrypted in place: create an encrypted one and copy the data into it. A lost passphrase or key file means lost data; a key file protects the disks taken away, not the machine itself.") + "</p>", t("Create"));
  if (!fd) return;
  const kf = fd.get("kf"), dataset = fd.get("parent") + "/" + fd.get("leaf");
  if (kf === "passphrase" && fd.get("pass") !== fd.get("pass2")) return banner(t("The two passphrases differ"));
  mg({ op: "enc_create", dataset, keyformat: kf, passphrase: kf === "passphrase" ? fd.get("pass") : "", boot: fd.get("boot") === "on" }, t("Encrypted dataset {name} created", { name: dataset }));
}
async function encUnlock(ds, pass) {
  if (!pass) return mg({ op: "enc_unlock", dataset: ds }, t("{name} unlocked", { name: ds }));
  const fd = await ask(t("Unlock {name}", { name: ds }), "<label>" + t("Passphrase") + '<input name="pass" type="password" required minlength="8" autocomplete="current-password"></label>', t("Unlock"));
  if (fd) mg({ op: "enc_unlock", dataset: ds, passphrase: fd.get("pass") }, t("{name} unlocked", { name: ds }));
}
async function encLock(ds) {
  const fd = await ask(t("Lock {name}", { name: ds }), "<p>" + t("Its file systems and those below it are unmounted and the key is forgotten until the next unlock. Refused while a share or a replication uses them.") + "</p>", t("Lock"));
  if (fd) mg({ op: "enc_lock", dataset: ds }, t("{name} locked", { name: ds }));
}

/* schedules (features.schedules): automatic snapshot labels and rotation, scrub, SMART self-tests */

const SCH = () => FEAT().schedules && M && M.schedules;
const LABELS = [["frequent", "every 15 min"], ["hourly", "hourly"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"]];
// zfs-auto-snapshot: a label is skipped when the general switch or the label's own property is false.
const labelsOn = ds => { const p = (SCH().autosnap.props || {})[ds] || {}; return LABELS.map(l => l[0]).filter(l => p[""] !== "false" && p[l] !== "false"); };
function autoLabels(ds, auto) {
  if (!SCH()) return auto === "true" ? t("yes") : t("no");
  const on = labelsOn(ds);
  const SHORT = { frequent: "15 min", hourly: "hour", daily: "day", weekly: "week", monthly: "month" };
  return !on.length ? t("no") : on.length === LABELS.length ? t("all") : on.map(l => t(SHORT[l])).join(" · ");
}
const EVERY = { off: "never", daily: "every day", weekly: "every week", monthly: "every month" };
function scrubEvery(pool) {
  if (!SCH() || !SCH().scrub_timers) return "";
  const e = SCH().scrub[pool] || "off";
  return '<p class="sub">' + t("Scheduled scrub: {v}", { v: t(EVERY[e]) }) + ' <button data-act="scrub-every" data-pool="' + esc(pool) + '" data-every="' + e + '">' + t("Change") + "</button></p>";
}
function smartCard() {
  if (!SCH()) return "";
  const sm = SCH().smart;
  return '<article class="card"><div class="card-head"><b>' + t("SMART self-tests") + "</b>" + '<button data-act="smart-every">' + t("Change") + "</button></div>" +
    '<p class="sub">' + t("Short test: {a}. Long test: {b}. The last result of each disk is in its card (Disk by disk); a failed test raises an alert.", { a: t(EVERY[sm.short]), b: t(EVERY[sm.long]) }) + "</p></article>";
}
async function keepForm(label) {
  const n = SCH().autosnap.keep[label], name = t(LABELS.find(l => l[0] === label)[1]);
  const fd = await ask(t("Rotation: {name}", { name }), "<label>" + t("Snapshots kept per dataset") + '<input name="keep" type="number" min="1" max="1000" required value="' + (n || "") + '"></label>' +
    '<p class="sub">' + t("Older ones are deleted at the next run. A replication pulling from this machine needs its last copied snapshot to still be here: keep enough to cover its schedule.") + "</p>", t("Save"));
  if (fd) mg({ op: "autosnap_keep", label, keep: Number(fd.get("keep")) }, t("Rotation updated"));
}
async function scrubForm(pool, cur) {
  const fd = await ask(t("Scheduled scrub of {pool}", { pool }), '<fieldset class="rows"><legend>' + t("Frequency") + "</legend>" + ["off", "weekly", "monthly"].map(e =>
    '<label class="check"><input type="radio" name="every" value="' + e + '"' + (e === cur ? " checked" : "") + "> " + t(EVERY[e]) + "</label>").join("") + "</fieldset>" +
    '<p class="sub">' + t("OpenZFS timers (zfs-scrub-weekly@ / zfs-scrub-monthly@). Debian's zfsutils-linux also scrubs every pool on the second Sunday of the month (/etc/cron.d/zfsutils-linux).") + "</p>", t("Save"));
  if (fd) mg({ op: "scrub_every", pool, every: fd.get("every") }, t("Scrub schedule of {pool} saved", { pool }));
}
async function smartForm() {
  const sm = SCH().smart;
  const radios = (kind, opts) => '<fieldset class="rows"><legend>' + t(kind === "short" ? "Short test (a few minutes)" : "Long test (hours on a large disk)") + "</legend>" + opts.map(e =>
    '<label class="check"><input type="radio" name="' + kind + '" value="' + e + '"' + (e === sm[kind] ? " checked" : "") + "> " + t(EVERY[e]) + "</label>").join("") + "</fieldset>";
  const fd = await ask(t("SMART self-tests"), radios("short", ["off", "daily", "weekly"]) + radios("long", ["off", "weekly", "monthly"]) +
    '<p class="sub">' + t("Every disk at 01:30 (weekly and monthly: on Sunday). Disks keep working during the test.") + "</p>", t("Save"));
  if (!fd) return;
  for (const kind of ["short", "long"]) if (fd.get(kind) !== sm[kind]) await mg({ op: "smart_every", kind, every: fd.get(kind) }, t("Self-test schedule saved"));
}

async function createSnap(ds) {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  const fd = await ask(t("Snapshot of {name}", { name: ds }),
    "<label>" + t("Name") + '<input name="snap" required pattern="[A-Za-z0-9_.:\\-]+" value="' + t("manual") + "-" + stamp + '"></label>' +
    '<label class="check"><input type="checkbox" name="r"> ' + t("Include child datasets (-r)") + "</label>", t("Create"));
  if (fd) act({ action: "snapshot_create", dataset: ds, name: fd.get("snap"), recursive: !!fd.get("r") }, t("Snapshot {name} created", { name: ds + "@" + fd.get("snap") }));
}

async function destroySnap(name) {
  const fd = await ask(t("Delete the snapshot?"), "<p>" + t("<b>{name}</b> will be permanently deleted.", { name: esc(name) }) + "</p>", t("Delete"), true);
  if (fd) act({ action: "snapshot_destroy", snapshot: name }, t("{name} deleted", { name }));
}
// Every manual snapshot called @snap: one confirmation, then one validated action each.
async function destroySnaps(snap) {
  const names = S.snapshots.map(s => s[0]).filter(n => n.split("@")[1] === snap);
  const fd = await ask(t("Delete the {n} snapshots @{snap}?", { n: names.length, snap }), "<p>" + t("Will be permanently deleted:") + '</p><p class="sub">' +
    names.map(esc).join("<br>") + "</p>", t("Delete all {n}", { n: names.length }), true);
  if (!fd) return;
  let done = 0;
  await once(async () => {
    try {
      for (const name of names) { await post("/api/action", { action: "snapshot_destroy", snapshot: name }); done++; }
      banner("");
      toast(t("{n} snapshots deleted", { n: done }));
    } catch (e) { banner(t("Failed after {done} / {total} snapshots deleted: {err}", { done, total: names.length, err: e.message })); }
    await slowTick();
  });
}

/* snapshot restore (features.restore): browse, download, copy back, clone, roll back */

const snapsOf = ds => S.snapshots.filter(s => s[0].split("@")[0] === ds).sort((a, b) => Number(b[2]) - Number(a[2]));
const restoreBtn = ds => FEAT().restore && snapsOf(ds).length ? '<button data-act="ds-restore" data-ds="' + esc(ds) + '">' + t("Restore…") + "</button>" : "";
const whenS = s => new Date(Number(s) * 1000).toLocaleString(LOCALE());

async function restoreForm(ds) {
  const list = snapsOf(ds), vol = isVol(S.datasets.find(r => r[0] === ds) || []);
  const fd = await ask(t("Restore from a snapshot of {name}", { name: ds }),
    "<label>" + t("Snapshot") + '<select name="snap">' + list.map(s => '<option value="' + esc(s[0]) + '">' + esc(s[0].split("@")[1]) + " · " + esc(whenS(s[2])) + "</option>").join("") + "</select></label>" +
    '<fieldset class="rows"><legend>' + t("What to do") + "</legend>" +
    (vol ? "" : '<label class="check"><input type="radio" name="what" value="browse" checked> ' + t("Browse it: download or copy back files and folders") + "</label>") +
    '<label class="check"><input type="radio" name="what" value="clone"' + (vol ? " checked" : "") + "> " + t("Clone it into a new dataset (read-write copy, the original stays as it is)") + "</label>" +
    '<label class="check"><input type="radio" name="what" value="rollback"> ' + t("Roll the dataset back to it (destructive)") + "</label></fieldset>", t("Continue"));
  if (!fd) return;
  const snap = fd.get("snap");
  return { browse: browseSnap, clone: cloneForm, rollback: rollbackForm }[fd.get("what")](snap);
}

// The listing is redrawn inside the open dialog; "Restore" closes it and asks for confirmation.
let BR = null;
async function browseSnap(snap) {
  BR = { snap, pick: null };
  $("dlg-cancel").hidden = true;
  const done = ask(t("Inside {name}", { name: snap }), '<div id="br"><p class="sub">' + t("Loading…") + "</p></div>", t("Close"));
  browseTo("");
  await done;
  $("dlg-cancel").hidden = false;
  const pick = BR.pick;
  BR = null;
  if (pick) return restorePick(snap, pick);
}
async function browseTo(path) {
  const el = $("br");
  if (!el || !BR) return;
  try {
    const r = JSON.parse(await get("/api/browse?snap=" + encodeURIComponent(BR.snap) + "&path=" + encodeURIComponent(path)));
    const q = p => "snap=" + encodeURIComponent(BR.snap) + "&path=" + encodeURIComponent(p);
    const join = n => (r.path ? r.path + "/" : "") + n;
    const up = r.path.includes("/") ? r.path.replace(/\/[^/]*$/, "") : "";
    el.innerHTML = '<p class="sub crumbs">/' + esc(r.path) + (r.path ? ' <button type="button" data-act="br-open" data-path="' + esc(up) + '">' + t("Up") + "</button>" : "") + "</p>" +
      (!r.entries.length ? '<p class="sub">' + t("Empty folder.") + "</p>" :
      '<div class="table-wrap files"><table><thead><tr><th>' + t("Name") + "</th><th>" + t("Size") + "</th><th>" + t("Modified") + "</th><th></th></tr></thead><tbody>" +
      r.entries.map(e => "<tr><td>" + (e.dir ? '<button type="button" class="link" data-act="br-open" data-path="' + esc(join(e.name)) + '">' + esc(e.name) + "/</button>" : esc(e.name) + (e.link ? " →" : "")) +
        "</td><td>" + (e.dir ? "—" : bytes(e.size)) + "</td><td>" + esc(whenS(e.mtime)) + '</td><td class="actions">' +
        '<a class="btn" href="/api/download?' + q(join(e.name)) + '" download>' + t(e.dir ? "Download (.tar)" : "Download") + "</a>" +
        '<button type="button" data-act="br-pick" data-path="' + esc(join(e.name)) + '">' + t("Restore") + "</button></td></tr>").join("") + "</tbody></table></div>") +
      '<p class="sub">' + t("Downloads stop at 4 GiB: restore larger items instead.") + "</p>";
    paint(el);
  } catch (e) { el.innerHTML = '<p class="sub">' + esc(e.message) + "</p>"; }
}
async function restorePick(snap, path) {
  const leaf = path.split("/").pop(), as = leaf + ".restored-" + snap.split("@")[1];
  const fd = await ask(t("Restore {name}?", { name: leaf }),
    "<p>" + t("<b>{path}</b> is copied from the snapshot back into the dataset, next to the original, as <b>{as}</b>. Nothing is overwritten.", { path: esc(path), as: esc(as) }) + "</p>", t("Restore"));
  if (fd) mg({ op: "snap_restore", snapshot: snap, path }, t("{name} restored", { name: as }));
}
async function cloneForm(snap) {
  const ds = snap.split("@")[0];
  const fd = await ask(t("Clone {name}", { name: snap }),
    "<label>" + t("New dataset") + '<input name="ds" required value="' + esc(ds + "-" + snap.split("@")[1].replace(/[^A-Za-z0-9_.:-]/g, "-")) + '"></label>' +
    '<p class="sub">' + t("A read-write copy that shares its blocks with the snapshot (no space used at first). While the clone exists, the snapshot cannot be deleted.") + "</p>", t("Clone"));
  if (fd) mg({ op: "snap_clone", snapshot: snap, dataset: fd.get("ds").trim() }, t("{name} created", { name: fd.get("ds").trim() }));
}
async function rollbackForm(snap) {
  const ds = snap.split("@")[0], at = Number((S.snapshots.find(s => s[0] === snap) || [])[2] || 0);
  const lost = snapsOf(ds).filter(s => Number(s[2]) > at).map(s => s[0]);
  const fd = await ask(t("Roll {name} back?", { name: ds }),
    "<p>" + t("Every change made to <b>{name}</b> since {when} is lost: files written, changed or deleted after that go back to how they were. There is no undo.", { name: esc(ds), when: esc(whenS(at)) }) + "</p>" +
    (lost.length ? '<p class="sub">' + tp(lost.length, "{n} newer snapshot is destroyed too:", "{n} newer snapshots are destroyed too:") + "<br>" + lost.slice(0, 12).map(esc).join("<br>") +
      (lost.length > 12 ? "<br>" + t("and {n} more", { n: lost.length - 12 }) : "") + "</p>" : "") +
    '<p class="sub">' + t("Refused while a replication or an iSCSI export uses it, or when a newer snapshot has a clone. To get back a few files only, browse the snapshot instead.") + "</p>" + confirmName(), t("Roll back"), true);
  if (fd) mg({ op: "snap_rollback", snapshot: snap, confirm: fd.get("confirm") }, t("{name} rolled back", { name: ds }));
}

// One delegated listener: buttons are re-rendered every tick.
// Theme: "" = follow the system, else forced; per browser (localStorage may be unavailable).
const THEMES = { "": "auto", light: "light", dark: "dark" };
function setTheme(th) {
  if (!(th in THEMES)) th = "";
  if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
  $("theme").textContent = t("Theme: {name}", { name: t(THEMES[th]) });
  try { localStorage.setItem("theme", th); } catch { /* not remembered */ }
}
try { setTheme(localStorage.getItem("theme") || ""); } catch { setTheme(""); }

// Language: the viewer's choice (button, localStorage "cairn-lang"), else the server default, else the browser (pickLang).
// Text is translated when built: re-apply the static text, rebuild what is built once, re-render the rest.
function setLang(l) {
  LANG = LANGS[l] ? l : "en";
  applyStatic();
  $("lang").textContent = t("Language: {name}", { name: LANGS[LANG].name });
  setTheme(document.documentElement.dataset.theme || ""); // relabel
  buildGauges();
  buildSystem();
  if (VIEW) $("view-title").textContent = t(VIEWS[VIEW]);
  render(true);
}

document.addEventListener("click", e => {
  const b = e.target.closest("button, a");
  if (!b) return;
  const d = b.dataset;
  if (d.view) return show(d.view);
  if (d.goto) return show(d.goto);
  if (d.editItem) return editItem(d.editItem, d.sys);
  switch (d.act) {
    case "tags": return manageTags();
    case "scrub": return act({ action: d.running === "true" ? "scrub_stop" : "scrub_start", pool: d.pool }, d.running === "true" ? t("Scrub stopped on {pool}", { pool: d.pool }) : t("Scrub started on {pool}", { pool: d.pool }));
    case "svc": return act({ action: "service_restart", service: d.svc }, t("{name} restarted", { name: d.svc }));
    case "ds-edit": return editDataset(d.ds, d.comp, d.quota, d.auto);
    case "ds-snap": return createSnap(d.ds);
    case "snap-del": return destroySnap(d.snap);
    case "snap-del-many": return destroySnaps(d.snap);
    case "ds-restore": return restoreForm(d.ds);
    case "br-open": return browseTo(d.path);
    case "br-pick": BR.pick = d.path; return closeDialog("cancel");
    case "logout": return post("/api/logout", {}).finally(() => location.reload());
    case "theme": { const k = Object.keys(THEMES); return setTheme(k[(k.indexOf(document.documentElement.dataset.theme || "") + 1) % k.length]); }
    case "lang": {
      const k = Object.keys(LANGS), l = k[(k.indexOf(LANG) + 1) % k.length];
      try { localStorage.setItem("cairn-lang", l); } catch { /* not remembered */ }
      return setLang(l);
    }
  }
  if (!M) return;
  switch (d.act) {
    case "share-new": return shareForm(d.kind);
    case "share-edit": return shareForm(d.kind, d.name);
    case "share-del": return deleteShare(d.kind, d.name);
    case "tm-new": return tmForm();
    case "alert-test": return mg({ op: "alert_test" }, t("Test alert sent"));
    case "updates-apply": return applyUpdates();
    case "user-new": return userForm();
    case "repl-key": return mg({ op: "repl_key" }, t("Key created"));
    case "repl-run": return mg({ op: "repl_run" }, t("Replication started"));
    case "repl-pull-new": return replPullForm();
    case "repl-allow-new": return replAllowForm();
    case "repl-pull-del": return replConfirm("repl_pull_delete", d.name, t("Stop the replication into {name}?", { name: d.name }),
      t("The nightly copy stops. What was already copied stays in <b>{name}</b>.", { name: esc(d.name) }), t("Replication into {name} stopped", { name: d.name }));
    case "repl-revoke": return replConfirm("repl_revoke", d.name, t("Revoke {name}?", { name: d.name }),
      t("<b>{name}</b> will no longer be able to copy this machine. Its copies stay on it.", { name: esc(d.name) }), t("{name} revoked", { name: d.name }));
    case "user-pass": return passwordForm(d.name);
    case "user-groups": return userGroupsForm(d.name);
    case "user-del": return deleteAccount("user_delete", d.name);
    case "group-new": return groupForm();
    case "group-del": return deleteAccount("group_delete", d.name);
    case "ds-new": return datasetForm();
    case "pool-new": return poolForm();
    case "zvol-new": return zvolForm();
    case "zvol-grow": return zvolGrow(d.ds, d.size);
    case "iscsi": return iscsiForm(d.ds);
    case "iscsi-stop": return iscsiStop(d.ds);
    case "ds-del": return destroyDataset(d.ds);
    case "pool-del": return destroyPool(d.pool);
    case "pool-import": return importPool();
    case "pool-export": return exportPool(d.pool);
    case "pool-upgrade": return upgradePool(d.pool);
    case "pool-trim": return trimPool(d.pool);
    case "pool-autotrim": return mg({ op: "pool_autotrim", pool: d.pool, on: d.on === "1" }, d.on === "1" ? t("Automatic trim on for {pool}", { pool: d.pool }) : t("Automatic trim off for {pool}", { pool: d.pool }));
    case "vdev-add": return vdevForm(d.pool, d.role);
    case "vdev-del": return vdevRemove(d.pool, d.dev, d.role);
    case "raidz-expand": return raidzExpand(d.pool);
    case "disk-offline": return diskOffline(d.pool, d.dev);
    case "disk-online": return mg({ op: "disk_online", pool: d.pool, device: d.dev }, t("{dev} is back online", { dev: d.dev }));
    case "disk-replace": return diskReplace(d.pool, d.dev);
    case "rs-repo": return repoForm(d.name);
    case "rs-repo-del": return offsiteDrop("restic_repo_delete", { name: d.name }, t("Remove repository {name}", { name: d.name }),
      t("This machine forgets the repository and its password; the copies already in it stay where they are."), t("Repository {name} removed", { name: d.name }));
    case "rs-key": return mg({ op: "restic_key" }, t("Key created"));
    case "rs-job": return jobForm(d.ds);
    case "rs-job-del": return offsiteDrop("restic_job_delete", { dataset: d.ds }, t("Stop the backup of {name}", { name: d.ds }),
      t("No more copies are made; those already in the repository stay there."), t("Backup of {name} stopped", { name: d.ds }));
    case "rs-run": return mg({ op: "restic_run", dataset: d.ds }, t("Backup of {name} started", { name: d.ds }));
    case "rs-restore": return offsiteRestore(d.ds);
    case "enc-new": return encForm();
    case "enc-unlock": return encUnlock(d.ds, d.pass);
    case "enc-lock": return encLock(d.ds);
    case "enc-boot": return mg({ op: "enc_boot", dataset: d.ds, on: d.on === "1" }, d.on === "1" ? t("{name} unlocked at boot", { name: d.ds }) : t("{name} no longer unlocked at boot", { name: d.ds }));
    case "autosnap-keep": return keepForm(d.label);
    case "scrub-every": return scrubForm(d.pool, d.every);
    case "smart-every": return smartForm();
    case "bonjour": return mg({ op: "bonjour", on: d.on === "1" }, d.on === "1" ? t("Bonjour announcement on") : t("Bonjour announcement off"));
  }
});
// <details> keep their open state across re-renders ("toggle" does not bubble: capture).
document.addEventListener("toggle", e => {
  const g = e.target.dataset && e.target.dataset.group;
  if (g) e.target.open ? openGroups.add(g) : openGroups.delete(g);
}, true);
$("machine").addEventListener("change", e => {
  const m = e.target.value;
  location.href = location.pathname + (m ? "?m=" + encodeURIComponent(m) : "") + location.hash;
});
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
// A re-render between pointerdown and click would swallow the click: hold renders briefly.
document.addEventListener("pointerdown", () => { animUntil = Math.max(animUntil, Date.now() + 500); });

/* ---------- start ---------- */

// Built-in sign-in mode: /api/config answers 401 until signed in.
async function signIn() {
  for (;;) {
    const fd = await ask(t("Sign-in"), "<label>" + t("Username") + '<input name="user" required autocomplete="username" autocapitalize="off"></label>' +
      "<label>" + t("Password") + '<input type="password" name="password" required autocomplete="current-password"></label>' +
      '<p class="sub">' + t("A server account that belongs to the administration group.") + "</p>", t("Sign in"));
    if (!fd) continue;
    try {
      await post("/api/login", { user: fd.get("user").trim(), password: fd.get("password") });
      return location.reload();
    } catch (e) { banner(e.message); }
  }
}

$("meta").textContent = t("Loading…");
setLang(LANG); // static text first: the sign-in form may come before /api/config
get("/api/config").then(txt => {
  CFG = JSON.parse(txt);
  // Another machine: its data only, nothing to change from here (the selector stays this server's).
  if (MACHINE) { CFG.features = { peers: true }; document.body.classList.add("remote"); }
  $("logout").hidden = !FEAT().login;
  UI = Object.assign({ labels: {}, tags: {}, assign: {} }, CFG.ui);
  document.title = CFG.title + " · Cairn";
  $("title").textContent = CFG.title;
  $("subtitle").textContent = CFG.subtitle || "";
  $("user").textContent = CFG.user;
  setLang(pickLang(CFG.lang)); // the viewer's choice, else the server default; builds the gauges and system cards
  document.querySelector('#nav [data-view="comptes"]').hidden = !FEAT().users;
  show(location.hash.slice(1));
  slowTick().then(fastTick);
  setInterval(fastTick, FAST_MS);
  setInterval(slowTick, SLOW_MS);
}).catch(e => e.status === 401 ? signIn() : banner(t("Unreadable configuration: {err}", { err: e.message })));
