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
  stockage: "Storage", sauvegarde: "Backup", partages: "Shares", comptes: "Accounts", services: "Services" };

let CFG = { nics: [], hosts: {}, services: [] };
let UI = { labels: {}, tags: {}, assign: {} };
const hist = { cpu: [], net: {}, disk: {} };
let prev = null, F = null, S = null, animUntil = 0, VIEW = null;
const openGroups = new Set();

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
  const r = await fetch(path, { cache: "no-store", redirect: "manual", headers: { "Accept-Language": LANG } });
  // Session expired: back to the sign-in form (built-in 401, or the proxy's redirect to its portal).
  if ((r.status === 401 && S) || r.type === "opaqueredirect") location.reload();
  if (!r.ok) throw Object.assign(new Error(r.status + " " + (await r.text())), { status: r.status });
  return r.text();
}
async function post(path, payload) {
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
    const [cpus, mem, netdev, diskstats, arc, temps, misc] = sections(out);
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
  const manage = f.nfs || f.smb || f.users || f.pools || f.disks || f.replication ? get("/api/manage") : Promise.resolve("");
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
  renderChrome(); renderOverview(); renderSystem(); renderNet(); renderDisks(); renderStorage(); renderBackup(); renderNfs(); renderShares(); renderAccounts(); renderServices(); renderAlerts(); renderJournal();
  paint();
  if (was && !f.isConnected) [...document.querySelectorAll("main button, main summary")].find(e => sig(e) === was)?.focus({ preventScroll: true });
}

function healthOf(h) {
  if (!h) return { lvl: "unk", txt: t("unknown") };
  if (h.passed === false || h.critical > 0 || h.media_errors > 0 || (h.spare != null && h.spare_thr != null && h.spare <= h.spare_thr))
    return { lvl: "bad", txt: t("critical") };
  if (h.used >= 80 || h.temp >= 70 || (h.spare != null && h.spare < 20) || h.realloc > 0) return { lvl: "warn", txt: t("needs attention") };
  return { lvl: "ok", txt: t("good") };
}
const worst = lvls => (lvls.includes("bad") ? "bad" : lvls.includes("warn") ? "warn" : lvls.includes("unk") ? "unk" : "ok");

function renderChrome() {
  const down = S.services.filter(([, st]) => st !== "active");
  $("pills").innerHTML = Object.values(S.pools).map(p =>
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
    '<div class="meter ' + lvlTemp(c) + '"><span>' + esc(n) + '</span><div class="bar"><i data-w="' + c + '"></i></div><b>' + nf(c, 0) + " °C</b></div>").join("") + "</div>";
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

function renderDisks() {
  const groups = [];
  for (const root of Object.values(S.statusOf).flatMap(poolTree)) {
    for (const v of root.children) {
      groups.push({ key: root.name + "/" + v.name, title: poolName(root.name) + (v.children.length ? " · " + v.name : " · " + t("single disk")),
        state: v.state, pool: S.pools[root.name], scan: scanText(S.statusOf[root.name] || ""),
        members: leaves(v).map(l => ({ dev: devOf(l.name), id: l.name, state: l.state, err: l.err, pool: root.name })) });
    }
  }
  const inPool = new Set(groups.flatMap(g => g.members.map(m => m.dev)));
  const other = Object.keys(S.model).filter(d => !inPool.has(d)).sort();
  if (other.length) groups.push({ key: "other", title: t("Not in a pool"), state: "", members: other.map(d => ({ dev: d, id: d, state: "", err: [0, 0, 0] })) });

  $("groups").innerHTML = groups.map(g => {
    const devs = g.members.map(m => m.dev);
    const r = sumSeries(devs.map(d => (hist.disk[d] || {}).r || [])), w = sumSeries(devs.map(d => (hist.disk[d] || {}).w || []));
    const temps = devs.map(d => S.health[d]?.temp ?? F.nvmeT[d]).filter(x => x != null);
    const hs = devs.map(d => healthOf(S.health[d]));
    const errs = g.members.reduce((acc, m) => acc + m.err.reduce((a, b) => a + (b || 0), 0), 0);
    const lvl = worst([...hs.map(h => h.lvl), g.state && g.state !== "ONLINE" ? "bad" : "ok", errs ? "warn" : "ok"]);
    const cap = devs.reduce((acc, d) => acc + (S.health[d]?.capacity || 0), 0);
    return '<article class="card group ' + lvl + '"><div class="row"><span class="dot ' + (lvl === "ok" ? "ok" : lvl === "bad" ? "bad" : "warn") + '"></span>' +
      "<b>" + esc(g.title) + '</b><span class="tag">' + tp(devs.length, "{n} disk · {size} raw", "{n} disks · {size} raw", { size: bytes(cap) }) + "</span>" +
      (g.state ? '<span class="pill ' + (g.state === "ONLINE" ? "ok" : "bad") + '">' + esc(g.state) + "</span>" : "") + "</div>" +
      '<div class="stats">' +
      stat(t("Read"), bytes(last(r)) + "/s", "rx") + stat(t("Write"), bytes(last(w)) + "/s", "tx") +
      stat(t("Max temperature"), temps.length ? nf(Math.max(...temps), 0) + " °C" : "—", lvlTemp(Math.max(0, ...temps))) +
      stat(t("Health"), t("{ok} / {total} good", { ok: hs.filter(h => h.lvl === "ok").length, total: hs.length }), lvl) +
      stat(t("ZFS errors"), String(errs), errs ? "warn" : "") +
      (g.pool ? stat(t("Pool used"), nf(g.pool.capacity, 0) + " %", "") : "") + "</div>" +
      (g.scan && g.scan.resilver ? scanProgress(g.scan) : "") +
      spark([r, w], 1e5, true) +
      '<details data-group="' + esc(g.key) + '"' + (openGroups.has(g.key) ? " open" : "") + "><summary>" + t("Disk by disk") + "</summary>" +
      '<div class="grid disks">' + g.members.map(diskCard).join("") + "</div></details></article>";
  }).join("");
}
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
  if (!FEAT().disks || !m.pool) return "";
  const b = (act, label) => '<button data-act="' + act + '" data-pool="' + esc(m.pool) + '" data-dev="' + esc(m.id) + '">' + label + "</button>";
  return '<div class="disk-acts"><span class="pill ' + (m.state === "ONLINE" ? "ok" : m.state === "OFFLINE" ? "warn" : "bad") + '">' + esc(m.state) + "</span>" +
    (m.state === "OFFLINE" ? b("disk-online", t("Bring online")) : ["ONLINE", "DEGRADED", "FAULTED"].includes(m.state) ? b("disk-offline", t("Take offline")) : "") +
    b("disk-replace", t("Replace")) + "</div>";
}

/* storage */

const poolName = n => UI.labels["pool:" + n] || n;

function scanText(status) {
  const scan = (status.match(/^\s*scan: ([\s\S]*?)\nconfig:/m) || [, t("no scrub yet")])[1].replace(/\n\s+/g, " ").trim();
  const pct = scan.match(/([\d.]+)% done/), eta = scan.match(/done, (\S+) to go/);
  return { text: scan, running: /in progress/.test(scan), resilver: /^resilver in progress/.test(scan), pct: pct ? Number(pct[1]) : null, eta: eta ? eta[1] : "" };
}
// Progress of a running scrub or resilver (zpool status: "12.3% done, 01:02:03 to go"); the slow loop refreshes it.
function scanProgress(scan) {
  if (!scan.running || scan.pct == null) return "";
  const what = scan.resilver ? t("Resilver") : t("Scrub");
  return '<div class="bar thin scan"><i data-w="' + scan.pct + '"></i></div><p class="sub">' +
    (scan.eta ? t("{what}: {pct} % done, {eta} left", { what, pct: nf(scan.pct, 1), eta: esc(scan.eta) }) : t("{what}: {pct} % done", { what, pct: nf(scan.pct, 1) })) + "</p>";
}

function renderStorage() {
  $("storage-actions").innerHTML = FEAT().pools
    ? '<button class="primary" data-act="ds-new">' + t("New dataset") + '</button><button data-act="pool-new">' + t("New pool") + "</button>" : "";
  $("pools").innerHTML = Object.values(S.pools).map(p => {
    const st = S.statusOf[p.name] || "", scan = scanText(st);
    const errors = (st.match(/^errors: (.*)$/m) || [, "?"])[1];
    const vdevs = poolTree(st).flatMap(t => t.children).map(v => v.children.length ? v.name.replace(/-\d+$/, "") + " × " + leaves(v).length : t("single disk"));
    const key = "pool:" + p.name;
    return '<article class="card' + (tagOf(key) ? " tagged" : "") + '"' + tagAttr(key) + '><div class="row"><span class="dot ' + (p.health === "ONLINE" ? "ok" : "bad") + '"></span>' +
    nameBlock(key, p.name, p.name) + '<span class="tag">' + esc(vdevs.join(" + ")) + "</span></div>" +
    '<div class="bar big"><i data-w="' + p.capacity + '"></i></div>' +
    '<div class="stats">' + stat(t("Allocated"), bytes(p.allocated), "") + stat(t("Free"), bytes(p.free), "") + stat(t("Raw size"), bytes(p.size), "") +
    stat(t("Fragmentation"), p.fragmentation + " %", "") + (errors.startsWith("No known") ? stat(t("Errors"), t("None"), "ok") : stat(t("Errors"), errors, "bad")) + "</div>" +
    '<p class="sub">' + t("Last scrub: {v}", { v: esc(scan.text) }) + "</p>" + scanProgress(scan) +
    (scan.resilver ? "" : '<button data-act="scrub" data-pool="' + esc(p.name) + '" data-running="' + scan.running + '" class="' + (scan.running ? "danger" : "primary") + '">' +
    (scan.running ? t("Stop scrub") : t("Start a scrub")) + "</button>") + "</article>";
  }).join("");

  const rows = byTag(S.datasets, r => "ds:" + r[0]);
  $("datasets").innerHTML = "<thead><tr>" + ["Dataset", "Used", "Available", "Compression", "Ratio", "Block size", "Quota"].concat(FEAT().autosnap ? ["Auto snapshots"] : [], [""])
    .map(h => "<th>" + t(h) + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map(([name, used, avail, , ratio, comp, rs, quota, , auto]) =>
      "<tr><td>" + nameBlock("ds:" + name, name, name) + "</td><td>" + bytes(Number(used)) + "</td><td>" + bytes(Number(avail)) + "</td><td>" + esc(comp) +
      "</td><td>× " + nf(Number(ratio), 2) + "</td><td>" + bytes(Number(rs)) + "</td><td>" + (quota === "0" ? "—" : bytes(Number(quota))) +
      (FEAT().autosnap ? "</td><td>" + (auto === "true" ? t("yes") : t("no")) : "") +
      '</td><td class="actions"><button data-act="ds-edit" data-ds="' + esc(name) + '" data-comp="' + esc(comp) + '" data-quota="' + (quota === "0" ? "none" : esc(quota)) +
      '" data-auto="' + (auto === "true" ? "true" : "false") +
      '">' + t("Edit") + '</button><button data-act="ds-snap" data-ds="' + esc(name) + '">' + t("Snapshot") + "</button></td></tr>").join("") + "</tbody>";

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
  document.querySelector('#nav [data-view="sauvegarde"]').hidden = !S.replication.length && !on;
  $("repl-setup").innerHTML = on && M ? replSetup() : "";
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
  $("updates").innerHTML = '<div class="card-head"><b>' + t("System updates") + "</b>" + (n ? '<button class="primary" data-act="updates-apply">' + t("Update") + "</button>" : "") +
    '</div><div class="svc"><span class="dot ' + (n || u.reboot ? "warn" : "ok") + '"></span><span>' +
    (n ? tp(n, "{n} package to update", "{n} packages to update") : t("System up to date")) + (u.reboot ? " · " + t("restart required") : "") + "</span></div>" +
    (n ? '<p class="sub">' + u.packages.map(esc).join(", ") + "</p>" : "") +
    (held.length ? '<p class="sub">' + t("Held (apt-mark hold), not updated: {list}", { list: held.map(esc).join(", ") }) + "</p>" : "");
  el.innerHTML = '<div class="card-head"><b>' + t("Action log") + "</b></div>" +
    (M.journal.length ? '<div class="table-wrap"><table><tbody>' + M.journal.map(l => {
      const [when, ...rest] = l.split(" ");
      return "<tr><td><small class=\"sys\">" + esc(new Date(when).toLocaleString(LOCALE())) + "</small></td><td>" + esc(rest.join(" ")) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : '<p class="sub">' + t("No recent actions.") + "</p>");
}

async function applyUpdates() {
  const p = M.updates.packages;
  const fd = await ask(t("Install the updates?"), "<p>" + tp(p.length, "{n} package: {list}", "{n} packages: {list}", { list: p.map(esc).join(", ") }) + "</p>" +
    '<p class="sub">' + t("apt-get upgrade, configuration files kept. The affected services restart (Samba: open connections are dropped). May take a few minutes.") + "</p>", t("Update"));
  if (fd) return mg({ op: "updates_apply" }, t("Updates installed"));
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
    '<datalist id="tm-ds">' + S.datasets.map(r => '<option value="' + esc(r[0]) + '">').join("") + "</datalist>" +
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
  const fd = await ask(t("New dataset"), "<label>" + t("In") + '<select name="parent">' + S.datasets.map(r => "<option>" + esc(r[0]) + "</option>").join("") + "</select></label>" +
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
  const fd = await ask(t("Edit {name}", { name }),
    "<label>" + t("Compression") + '<select name="comp">' + COMPRESSION.map(c => "<option" + (c === comp ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
    "<label>" + t("Quota (e.g. 500G, 1T, none)") + '<input name="quota" required pattern="none|[0-9]+(\\.[0-9]+)?[KMGTP]?" value="' + esc(quota) + '"></label>' +
    (FEAT().autosnap ? "<label>" + t("Automatic snapshots") + '<select name="auto"><option value="true">' + t("yes (rotation: quarter-hour, hour, day, week, month)") + "</option>" +
      '<option value="false"' + (auto === "false" ? " selected" : "") + ">" + t("no") + "</option></select></label>" : "") +
    '<p class="sub">' + t("Compression only applies to data written afterwards. Child datasets inherit the automatic snapshot choice.") + "</p>");
  if (fd) act({ action: "dataset_set", dataset: name, compression: fd.get("comp"), quota: fd.get("quota"), autosnap: fd.get("auto") || "" }, t("{name} updated", { name }));
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
    case "disk-offline": return diskOffline(d.pool, d.dev);
    case "disk-online": return mg({ op: "disk_online", pool: d.pool, device: d.dev }, t("{dev} is back online", { dev: d.dev }));
    case "disk-replace": return diskReplace(d.pool, d.dev);
    case "bonjour": return mg({ op: "bonjour", on: d.on === "1" }, d.on === "1" ? t("Bonjour announcement on") : t("Bonjour announcement off"));
  }
});
// <details> keep their open state across re-renders ("toggle" does not bubble: capture).
document.addEventListener("toggle", e => {
  const g = e.target.dataset && e.target.dataset.group;
  if (g) e.target.open ? openGroups.add(g) : openGroups.delete(g);
}, true);
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
