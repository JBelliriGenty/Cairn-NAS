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
const PALETTE = [["#16181d", "Noir"], ["#e5484d", "Rouge"], ["#f76b15", "Orange"], ["#f5c518", "Jaune"],
  ["#30a46c", "Vert"], ["#0090ff", "Bleu"], ["#8e4ec6", "Violet"], ["#e93d82", "Rose"], ["#8b8d98", "Gris"]];
const VIEWS = { overview: "Vue d'ensemble", systeme: "Système", reseau: "Réseau", disques: "Disques",
  stockage: "Stockage", partages: "Partages", comptes: "Comptes", services: "Services" };

let CFG = { nics: [], hosts: {}, services: [] };
let UI = { labels: {}, tags: {}, assign: {} };
const hist = { cpu: [], net: {}, disk: {} };
let prev = null, F = null, S = null, animUntil = 0;
const openGroups = new Set();

/* ---------- helpers ---------- */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (n, d = 1) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
const last = arr => (arr && arr.length ? arr[arr.length - 1] : 0);

function bytes(n) {
  const u = ["o", "Ko", "Mo", "Go", "To", "Po"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return nf(n, i ? 1 : 0) + " " + u[i];
}
function bits(bps) {
  const u = ["b/s", "Kb/s", "Mb/s", "Gb/s"];
  let i = 0;
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
  return nf(bps, i ? 1 : 0) + " " + u[i];
}
function duration(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + " j " : "") + h + " h " + String(m).padStart(2, "0");
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

async function get(path) {
  const r = await fetch(path, { cache: "no-store", redirect: "manual" });
  // Session expired: back to the sign-in form (built-in 401, or the proxy's redirect to its portal).
  if ((r.status === 401 && S) || r.type === "opaqueredirect") location.reload();
  if (!r.ok) throw Object.assign(new Error(r.status + " " + (await r.text())), { status: r.status });
  return r.text();
}
async function post(path, payload) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "manual" });
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
    '<button class="icon" data-edit-item="' + esc(key) + '" data-sys="' + esc(sys) + '" title="Renommer, étiqueter" aria-label="Renommer ' + esc(sys) + '">✎</button></div>';
}
// Items sharing a tag are kept together (tag order, then original order).
function byTag(keys, keyOf) {
  const order = Object.keys(UI.tags);
  const rank = k => { const i = order.indexOf(UI.assign[keyOf(k)]); return i < 0 ? order.length : i; };
  return keys.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

function tagRadios(cur) {
  const tags = Object.entries(UI.tags);
  return '<label class="swatch"><input type="radio" name="tag" value=""' + (cur ? "" : " checked") + '><span class="tagdot none"></span>Aucune</label>' +
    tags.map(([id, t]) => '<label class="swatch"><input type="radio" name="tag" value="' + esc(id) + '"' + (cur === id ? " checked" : "") +
      '><span class="tagdot" data-color="' + esc(t.color) + '"></span>' + esc(t.name) + "</label>").join("") +
    (tags.length ? "" : '<p class="sub">Pas encore d\'étiquette : bouton « Étiquettes… » de la barre latérale.</p>');
}

async function editItem(key, sys) {
  const fd = await ask("Apparence de " + sys,
    '<label>Nom affiché<input name="label" maxlength="64" placeholder="' + esc(sys) + '" value="' + esc(UI.labels[key] || "") + '"></label>' +
    '<fieldset class="swatches"><legend>Étiquette</legend>' + tagRadios(UI.assign[key]) + "</fieldset>" +
    '<p class="sub">Vide = nom système. Le nom système reste affiché en petit à côté.</p>');
  if (!fd) return;
  const label = fd.get("label").trim(), tag = fd.get("tag");
  if (label) UI.labels[key] = label; else delete UI.labels[key];
  if (tag) UI.assign[key] = tag; else delete UI.assign[key];
  saveUI();
}

async function manageTags() {
  const tags = Object.entries(UI.tags);
  const fd = await ask("Étiquettes",
    (tags.length ? '<fieldset class="swatches"><legend>Existantes (cocher pour supprimer)</legend>' + tags.map(([id, t]) =>
      '<label class="swatch"><input type="checkbox" name="del" value="' + esc(id) + '"><span class="tagdot" data-color="' + esc(t.color) + '"></span>' +
      esc(t.name) + "</label>").join("") + "</fieldset>" : "") +
    '<label>Nouvelle étiquette<input name="name" maxlength="32" placeholder="ex. Nœud Proxmox"></label>' +
    '<fieldset class="swatches palette"><legend>Couleur</legend>' + PALETTE.map(([c, n], i) =>
      '<label class="swatch" title="' + n + '"><input type="radio" name="color" value="' + c + '"' + (i ? "" : " checked") +
      '><span class="tagdot" data-color="' + c + '"></span></label>').join("") + "</fieldset>", "Enregistrer");
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
    toast("Enregistré");
    banner("");
  } catch (e) { banner("Enregistrement impossible : " + e.message); }
  render(true);
}

/* ---------- dialog ---------- */

// Native <dialog>; resolves with the FormData, or null if cancelled.
function ask(title, bodyHtml, okLabel = "Valider", danger = false) {
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

/* ---------- views ---------- */

function show(view) {
  if (!VIEWS[view]) view = "overview";
  document.querySelectorAll(".view").forEach(s => {
    const on = s.dataset.view === view;
    s.hidden = !on;
    s.classList.toggle("enter", on);
  });
  document.querySelectorAll("#nav button").forEach(b => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  $("view-title").textContent = VIEWS[view];
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
  }).catch(e => banner("Lecture impossible : " + e.message, "read"));
}

/* ---------- slow loop ---------- */

function slowTick() {
  const f = FEAT();
  const manage = f.nfs || f.smb || f.users || f.pools ? get("/api/manage") : Promise.resolve("");
  return Promise.all([get("/api/slow"), manage]).then(([out, man]) => {
    if (man) M = JSON.parse(man);
    const [hk, pool, status, ds, snaps, ss, svc, ipj, speeds, models, exports, byid, health] = sections(out);
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
      health: Object.fromEntries((health || "").trim().split("\n").filter(Boolean).map(l => { const h = JSON.parse(l); return [h.dev, h]; })),
    };
    readOk();
    render(true);
  }).catch(e => banner("Lecture ZFS/services impossible : " + e.message, "read"));
}

/* ---------- rendering ---------- */

function render(force = false) {
  if (!F || !S) return;
  if (!force && Date.now() < animUntil) return; // let the entrance animation finish
  const f = document.activeElement, sig = e => e.tagName + JSON.stringify(e.dataset) + e.textContent;
  const was = f && f !== document.body && f.closest("main") ? sig(f) : null;
  renderChrome(); renderOverview(); renderSystem(); renderNet(); renderDisks(); renderStorage(); renderNfs(); renderShares(); renderAccounts(); renderServices(); renderAlerts(); renderJournal();
  paint();
  if (was && !f.isConnected) [...document.querySelectorAll("main button, main summary")].find(e => sig(e) === was)?.focus({ preventScroll: true });
}

function healthOf(h) {
  if (!h) return { lvl: "unk", txt: "inconnue" };
  if (h.passed === false || h.critical > 0 || h.media_errors > 0 || (h.spare != null && h.spare_thr != null && h.spare <= h.spare_thr))
    return { lvl: "bad", txt: "critique" };
  if (h.used >= 80 || h.temp >= 70 || (h.spare != null && h.spare < 20) || h.realloc > 0) return { lvl: "warn", txt: "à surveiller" };
  return { lvl: "ok", txt: "bonne" };
}
const worst = lvls => (lvls.includes("bad") ? "bad" : lvls.includes("warn") ? "warn" : lvls.includes("unk") ? "unk" : "ok");

function renderChrome() {
  const down = S.services.filter(([, st]) => st !== "active");
  $("pills").innerHTML = Object.values(S.pools).map(p =>
    '<span class="pill ' + (p.health === "ONLINE" ? "ok" : "bad") + '">' + esc(poolName(p.name)) + " " + esc(p.health) + "</span>").join("") +
    '<span class="pill ' + (down.length ? "warn" : "ok") + '">' + (down.length ? down.length + (down.length > 1 ? " services arrêtés" : " service arrêté") : "services OK") + "</span>";
  $("meta").textContent = [S.host, "noyau " + S.kernel, "allumé depuis " + duration(F.up), "rafraîchi " + new Date().toLocaleTimeString("fr-FR")].join(" · ");
  $("legend").innerHTML = Object.values(UI.tags).map(t => '<span class="legend-item"><span class="tagdot" data-color="' + esc(t.color) + '"></span>' + esc(t.name) + "</span>").join("");
}

/* overview */

const GAUGES = [["cpu", "Processeur"], ["mem", "Mémoire"], ["pool", "Stockage"], ["temp", "Temp. CPU"]];
const CIRC = 2 * Math.PI * 42;

function buildGauges() {
  $("gauges").innerHTML = GAUGES.map(([id, label]) =>
    '<article class="card gauge" id="g-' + id + '"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="42"/>' +
    '<circle class="val" cx="50" cy="50" r="42"/></svg><div class="g-text"><strong></strong><span class="label">' + label +
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
  setGauge("cpu", cpu, nf(cpu, 0) + " %", "charge " + F.load.map(x => nf(x, 2)).join(" · "), cpu > 85 ? "warn" : "");
  setGauge("mem", used / mp.total * 100, nf(used / 2 ** 30) + " Go", "sur " + bytes(mp.total), "");
  setGauge("pool", p.capacity, nf(p.capacity, 0) + " %", bytes(p.allocated) + " / " + bytes(p.size), p.capacity >= 80 ? "warn" : "");
  setGauge("temp", F.cpuT, nf(F.cpuT, 0) + " °C", "seuil 80 °C", lvlTemp(F.cpuT) === "ok" ? "" : lvlTemp(F.cpuT));

  const disks = Object.keys(S.model).sort();
  const hs = disks.map(d => healthOf(S.health[d]));
  const good = hs.filter(h => h.lvl === "ok").length;
  const nics = CFG.nics.map(([n]) => n);
  const rx = sumSeries(nics.map(n => (hist.net[n] || {}).rx || [])), tx = sumSeries(nics.map(n => (hist.net[n] || {}).tx || []));
  const down = S.services.filter(([, st]) => st !== "active");
  const clients = new Set(S.exports.flatMap(l => l.trim().split(/\s+/).slice(1).map(c => c.replace(/\(.*$/, ""))));
  const conn = [...clients].filter(ip => S.connected.has(ip)).length;

  // The screen's question first: is the NAS fine? Name what is not, else sum up what is.
  const issues = [
    ...pools.filter(x => x.health !== "ONLINE").map(x => "pool " + poolName(x.name) + " " + x.health),
    ...pools.filter(x => x.capacity >= 80).map(x => "pool " + poolName(x.name) + " plein à " + nf(x.capacity, 0) + " %"),
    ...disks.filter((d, i) => hs[i].lvl === "bad" || hs[i].lvl === "warn").map(d => "disque " + (UI.labels["disk:" + d] || d) + " " + healthOf(S.health[d]).txt),
    ...down.map(([n]) => "service " + n + " arrêté"),
  ];
  const vl = worst([...pools.map(x => (x.health === "ONLINE" ? (x.capacity >= 80 ? "warn" : "ok") : "bad")), ...hs.map(h => h.lvl), down.length ? "warn" : "ok"]);
  const n = (k, one, many) => k + " " + (k > 1 ? many : one);
  $("verdict").className = "verdict " + vl;
  $("verdict").innerHTML = '<span class="dot ' + vl + '"></span>' + esc(issues.length ? issues.join(" · ") :
    "Tout va bien : " + n(pools.length, "pool en ligne", "pools en ligne") + ", " + good + " / " + n(disks.length, "disque sain", "disques sains") + ", " +
    n(S.services.length, "service actif", "services actifs"));

  $("tiles").innerHTML = [
    tile("disques", "Santé des disques", good + " / " + disks.length + " en bonne santé", worst(hs.map(h => h.lvl)),
      '<div class="minidisks">' + disks.map((d, i) => '<span class="minidisk ' + hs[i].lvl + '" title="' + esc(d) + " : " + hs[i].txt + '">' +
        esc(UI.labels["disk:" + d] || d) + "<small>" + nf(S.health[d]?.temp ?? F.nvmeT[d] ?? 0, 0) + " °C</small></span>").join("") + "</div>"),
    tile("stockage", pools.length > 1 ? pools.length + " pools ZFS" : "Pool ZFS", bytes(pools.reduce((a, x) => a + x.free, 0)) + " libres",
      pools.every(x => x.health === "ONLINE") ? "ok" : "bad", pools.map(x => '<div class="meter ' + (x.capacity >= 80 ? "warn" : "ok") + '"><span>' +
        esc(poolName(x.name)) + " · " + esc(x.health) + '</span><div class="bar"><i data-w="' + x.capacity + '"></i></div><b>' + nf(x.capacity, 0) + " %</b></div>").join("")),
    tile("reseau", "Réseau (toutes interfaces)", "↓ " + bits(last(rx)) + " · ↑ " + bits(last(tx)), "", spark([rx, tx], 8000, true)),
    tile("services", "Services", (S.services.length - down.length) + " / " + S.services.length + " actifs", down.length ? "warn" : "ok",
      '<div class="svcdots">' + S.services.map(([n, st]) => '<span class="dot ' + (st === "active" ? "ok" : "bad") + '" title="' + esc(n) + " : " + esc(st) + '"></span>').join("") + "</div>" +
      (down.length ? '<p class="sub">Arrêtés : ' + down.map(([n]) => esc(n)).join(", ") + "</p>" : "")),
  ].join("");
  // Secondary facts: one line of links instead of half-empty tiles.
  $("facts").innerHTML = [
    ["partages", "NFS : " + S.exports.length + " exports · " + conn + " / " + clients.size + " clients connectés", conn ? " ok" : ""],
    ["systeme", "Allumé depuis " + duration(F.up), ""],
    ["systeme", "ARC : " + nf(F.a.hits + F.a.misses ? 100 * F.a.hits / (F.a.hits + F.a.misses) : 0, 1) + " % de succès", ""],
  ].map(([v, t, c]) => '<button class="chip' + c + '" data-goto="' + v + '">' + esc(t) + "</button>").join("");
}
function tile(view, title, value, lvl, extra) {
  return '<button class="card tile ' + (lvl || "") + '" data-goto="' + view + '"><span class="label">' + esc(title) + "</span><strong>" +
    esc(value) + "</strong>" + extra + "</button>";
}

/* system */

function buildSystem() {
  $("cpu-card").innerHTML = '<div class="row"><span class="label">Processeur</span><strong class="big" id="cpu-val"></strong></div>' +
    '<div id="cpu-chart" class="chart"></div><div class="label">Par thread</div><div class="threads" id="threads"></div>';
  $("mem-card").innerHTML = '<div class="row"><span class="label">Mémoire</span><strong class="big" id="mem-val"></strong></div>' +
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
  $("mem-val").textContent = nf((mp.total - mp.free - mp.cache) / 2 ** 30) + " / " + nf(mp.total / 2 ** 30) + " Go";
  const seg = $("mem-stack").children;
  [mp.apps, mp.arc, mp.cache].forEach((v, i) => { seg[i].style.width = (v / mp.total * 100).toFixed(2) + "%"; });
  $("mem-legend").innerHTML = [["s-apps", "Applications", mp.apps], ["s-arc", "Cache ZFS (ARC)", mp.arc], ["s-cache", "Cache système", mp.cache], ["s-free", "Libre", mp.free]]
    .map(([c, n, v]) => '<dt><i class="' + c + '"></i>' + n + "</dt><dd>" + bytes(v) + "</dd>").join("");

  const threads = F.cores.length || 1;
  $("load-card").innerHTML = '<span class="label">Charge (sur ' + threads + " threads)</span>" +
    ["1 min", "5 min", "15 min"].map((n, i) => '<div class="meter"><span>' + n + '</span><div class="bar"><i data-w="' + (F.load[i] / threads * 100) +
      '"></i></div><b>' + nf(F.load[i], 2) + "</b></div>").join("") +
    '<dl class="legend-dl"><dt>Allumé depuis</dt><dd>' + duration(F.up) + "</dd><dt>Noyau</dt><dd>" + esc(S.kernel) + "</dd>" +
    "<dt>ARC (succès)</dt><dd>" + nf(F.a.hits + F.a.misses ? 100 * F.a.hits / (F.a.hits + F.a.misses) : 0, 1) + " %</dd></dl>";

  const rows = [];
  const core = F.temps.filter(x => x.name === "coretemp" || x.name === "k10temp");
  if (core.length) rows.push(["CPU (paquet)", F.cpuT], ["CPU (cœur le plus chaud)", Math.max(...core.map(x => x.c))]);
  F.temps.filter(x => x.name === "spd5118").forEach((x, i) => rows.push(["RAM" + (i ? " " + (i + 1) : ""), x.c]));
  F.temps.filter(x => /^(en|eth)/.test(x.name)).forEach(x => rows.push([(UI.labels["nic:" + x.name] || x.name) + " · " + x.label, x.c]));
  Object.keys(F.nvmeT).sort().forEach(d => rows.push([(UI.labels["disk:" + d] || d), F.nvmeT[d]]));
  $("temp-card").innerHTML = '<span class="label">Températures</span><div class="temps">' + rows.map(([n, c]) =>
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
      '<div class="row">' + nameBlock("nic:" + n, n, n) + '<span class="tag">' + (speed > 0 ? (speed >= 1000 ? speed / 1000 + " Gb" : speed + " Mb") : "pas de lien") + "</span></div>" +
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
      groups.push({ key: root.name + "/" + v.name, title: poolName(root.name) + (v.children.length ? " · " + v.name : " · disque seul"),
        state: v.state, pool: S.pools[root.name], members: leaves(v).map(l => ({ dev: devOf(l.name), id: l.name, state: l.state, err: l.err })) });
    }
  }
  const inPool = new Set(groups.flatMap(g => g.members.map(m => m.dev)));
  const other = Object.keys(S.model).filter(d => !inPool.has(d)).sort();
  if (other.length) groups.push({ key: "other", title: "Hors pool", state: "", members: other.map(d => ({ dev: d, id: d, state: "", err: [0, 0, 0] })) });

  $("groups").innerHTML = groups.map(g => {
    const devs = g.members.map(m => m.dev);
    const r = sumSeries(devs.map(d => (hist.disk[d] || {}).r || [])), w = sumSeries(devs.map(d => (hist.disk[d] || {}).w || []));
    const temps = devs.map(d => S.health[d]?.temp ?? F.nvmeT[d]).filter(x => x != null);
    const hs = devs.map(d => healthOf(S.health[d]));
    const errs = g.members.reduce((acc, m) => acc + m.err.reduce((a, b) => a + (b || 0), 0), 0);
    const lvl = worst([...hs.map(h => h.lvl), g.state && g.state !== "ONLINE" ? "bad" : "ok", errs ? "warn" : "ok"]);
    const cap = devs.reduce((acc, d) => acc + (S.health[d]?.capacity || 0), 0);
    return '<article class="card group ' + lvl + '"><div class="row"><span class="dot ' + (lvl === "ok" ? "ok" : lvl === "bad" ? "bad" : "warn") + '"></span>' +
      "<b>" + esc(g.title) + '</b><span class="tag">' + devs.length + " disque" + (devs.length > 1 ? "s" : "") + " · " + bytes(cap) + " bruts</span>" +
      (g.state ? '<span class="pill ' + (g.state === "ONLINE" ? "ok" : "bad") + '">' + esc(g.state) + "</span>" : "") + "</div>" +
      '<div class="stats">' +
      stat("Lecture", bytes(last(r)) + "/s", "rx") + stat("Écriture", bytes(last(w)) + "/s", "tx") +
      stat("Température max", temps.length ? nf(Math.max(...temps), 0) + " °C" : "—", lvlTemp(Math.max(0, ...temps))) +
      stat("Santé", hs.filter(h => h.lvl === "ok").length + " / " + hs.length + " bonne", lvl) +
      stat("Erreurs ZFS", String(errs), errs ? "warn" : "") +
      (g.pool ? stat("Pool occupé", nf(g.pool.capacity, 0) + " %", "") : "") + "</div>" +
      spark([r, w], 1e5, true) +
      '<details data-group="' + esc(g.key) + '"' + (openGroups.has(g.key) ? " open" : "") + "><summary>Détail disque par disque</summary>" +
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
    ["Santé", hl.txt, hl.lvl], ["Température", tc != null ? nf(tc, 0) + " °C" : "—", lvlTemp(tc || 0)],
    ["Usure", h?.used != null ? h.used + " %" : "—", h?.used >= 80 ? "warn" : ""], ["Réserve", h?.spare != null ? h.spare + " %" : "—", ""],
    ["Heures", h?.hours != null ? String(h.hours) : "—", ""], ["Écrit", h?.written != null ? bytes(h.written * 512000) : "—", ""],
    ["Arrêts brutaux", h?.unsafe != null ? String(h.unsafe) : "—", ""], ["Erreurs média", h?.media_errors != null ? String(h.media_errors) : "—", h?.media_errors ? "bad" : ""],
    ["Erreurs ZFS L/É/S", m.err.join(" / "), m.err.some(x => x) ? "warn" : ""],
  ];
  return '<article class="card disk' + (tagOf(key) ? " tagged" : "") + '"' + tagAttr(key) + '><div class="row">' + nameBlock(key, d, d) +
    '<span class="pill ' + hl.lvl + '">' + esc(hl.txt) + "</span></div>" +
    '<div class="sub">' + esc(S.model[d] || h?.model || "") + (h?.serial ? " · " + esc(h.serial) : "") + "</div>" +
    '<div class="rates"><span class="rx">lecture ' + bytes(last(hi.r)) + '/s</span><span class="tx">écriture ' + bytes(last(hi.w)) + "/s</span></div>" +
    spark([hi.r, hi.w], 1e5) + '<dl class="kv">' + kv.map(([k, v, c]) => "<dt>" + k + '</dt><dd class="' + c + '">' + esc(v) + "</dd>").join("") + "</dl></article>";
}

/* storage */

const poolName = n => UI.labels["pool:" + n] || n;

function scanText(status) {
  const scan = (status.match(/^\s*scan: ([\s\S]*?)\nconfig:/m) || [, "aucun scrub encore"])[1].replace(/\n\s+/g, " ").trim();
  return { text: scan, running: /in progress/.test(scan) };
}

function renderStorage() {
  $("storage-actions").innerHTML = FEAT().pools
    ? '<button class="primary" data-act="ds-new">Nouveau dataset</button><button data-act="pool-new">Nouveau pool</button>' : "";
  $("pools").innerHTML = Object.values(S.pools).map(p => {
    const st = S.statusOf[p.name] || "", scan = scanText(st);
    const errors = (st.match(/^errors: (.*)$/m) || [, "?"])[1];
    const vdevs = poolTree(st).flatMap(t => t.children).map(v => v.children.length ? v.name.replace(/-\d+$/, "") + " × " + leaves(v).length : "disque seul");
    const key = "pool:" + p.name;
    return '<article class="card' + (tagOf(key) ? " tagged" : "") + '"' + tagAttr(key) + '><div class="row"><span class="dot ' + (p.health === "ONLINE" ? "ok" : "bad") + '"></span>' +
    nameBlock(key, p.name, p.name) + '<span class="tag">' + esc(vdevs.join(" + ")) + "</span></div>" +
    '<div class="bar big"><i data-w="' + p.capacity + '"></i></div>' +
    '<div class="stats">' + stat("Occupé", bytes(p.allocated), "") + stat("Libre", bytes(p.free), "") + stat("Taille brute", bytes(p.size), "") +
    stat("Fragmentation", p.fragmentation + " %", "") + (errors.startsWith("No known") ? stat("Erreurs", "Aucune", "ok") : stat("Erreurs", errors, "bad")) + "</div>" +
    '<p class="sub">Dernier scrub : ' + esc(scan.text) + "</p>" +
    '<button data-act="scrub" data-pool="' + esc(p.name) + '" data-running="' + scan.running + '" class="' + (scan.running ? "danger" : "primary") + '">' +
    (scan.running ? "Arrêter le scrub" : "Lancer un scrub") + "</button></article>";
  }).join("");

  const rows = byTag(S.datasets, r => "ds:" + r[0]);
  $("datasets").innerHTML = "<thead><tr><th>Dataset</th><th>Utilisé</th><th>Disponible</th><th>Compression</th><th>Gain</th><th>Bloc</th><th>Quota</th>" + (FEAT().autosnap ? "<th>Snapshots auto</th>" : "") + "<th></th></tr></thead><tbody>" +
    rows.map(([name, used, avail, , ratio, comp, rs, quota, , auto]) =>
      "<tr><td>" + nameBlock("ds:" + name, name, name) + "</td><td>" + bytes(Number(used)) + "</td><td>" + bytes(Number(avail)) + "</td><td>" + esc(comp) +
      "</td><td>× " + nf(Number(ratio), 2) + "</td><td>" + bytes(Number(rs)) + "</td><td>" + (quota === "0" ? "—" : bytes(Number(quota))) +
      (FEAT().autosnap ? "</td><td>" + (auto === "true" ? "oui" : "non") : "") +
      '</td><td class="actions"><button data-act="ds-edit" data-ds="' + esc(name) + '" data-comp="' + esc(comp) + '" data-quota="' + (quota === "0" ? "none" : esc(quota)) +
      '" data-auto="' + (auto === "true" ? "true" : "false") +
      '">Modifier</button><button data-act="ds-snap" data-ds="' + esc(name) + '">Snapshot</button></td></tr>').join("") + "</tbody>";

  // Rotating snapshots (zfs-auto-snapshot) are summed up per label, not listed.
  const auto = {}, manual = [];
  for (const s of S.snapshots) {
    const m = s[0].match(/@zfs-auto-snap_([a-z]+)-/);
    if (!m) { manual.push(s); continue; }
    const label = s[0].split(/[/@]/)[0] + " · " + m[1];
    const a = auto[label] = auto[label] || { n: 0, used: 0, last: 0 };
    a.n++; a.used += Number(s[1]); a.last = Math.max(a.last, Number(s[2]));
  }
  const when = t => new Date(t * 1000).toLocaleString("fr-FR");
  // Manual snapshots sharing a name (one recursive snapshot, a migration) make one row.
  const named = {};
  for (const s of manual.reverse()) (named[s[0].split("@")[1]] = named[s[0].split("@")[1]] || []).push(s);
  $("snaps").innerHTML = !S.snapshots.length
    ? '<tbody><tr><td class="sub">Aucun snapshot. Bouton « Snapshot » sur un dataset pour en créer un.</td></tr></tbody>'
    : "<thead><tr><th>Snapshot</th><th>Taille propre</th><th>Créé le</th><th></th></tr></thead><tbody>" +
      Object.entries(named).map(([snap, list]) => list.length === 1
        ? "<tr><td>" + esc(list[0][0]) + "</td><td>" + bytes(Number(list[0][1])) + "</td><td>" + when(Number(list[0][2])) +
          '</td><td class="actions"><button class="danger" data-act="snap-del" data-snap="' + esc(list[0][0]) + '">Supprimer</button></td></tr>'
        : '<tr><td title="' + esc(list.map(s => s[0]).join(", ")) + '">@' + esc(snap) + ' <small class="sys">' + list.length + " datasets</small></td><td>" +
          bytes(list.reduce((a, s) => a + Number(s[1]), 0)) + "</td><td>" + when(Math.max(...list.map(s => Number(s[2])))) +
          '</td><td class="actions"><button class="danger" data-act="snap-del-many" data-snap="' + esc(snap) + '">Supprimer les ' + list.length + "</button></td></tr>").join("") +
      Object.entries(auto).map(([label, a]) => '<tr class="auto"><td>zfs-auto-snap · ' + esc(label) + " — " + a.n + (a.n > 1 ? " snapshots" : " snapshot") + "</td><td>" + bytes(a.used) +
        "</td><td>dernier " + when(a.last) + '</td><td class="sub">rotation automatique</td></tr>').join("") + "</tbody>";
}

/* NFS and services */

function renderNfs() {
  $("nfs").innerHTML = '<div class="card-head"><b>Exports du serveur</b><span class="sub">/etc/exports, gérés hors du panneau</span></div>' + S.exports.map(l => {
    const [path, ...clients] = l.trim().split(/\s+/);
    const ips = byTag(clients.map(c => c.replace(/\(.*$/, "")), ip => "host:" + ip);
    return '<div class="export"><b>' + esc(path) + '</b><div class="chips">' + ips.map(ip =>
      '<button class="chip' + (S.connected.has(ip) ? " ok" : "") + '" data-edit-item="host:' + esc(ip) + '" data-sys="' + esc(ip) + '" title="' + esc(ip) + ' — cliquer pour renommer ou étiqueter">' +
      dot("host:" + ip) + esc(UI.labels["host:" + ip] || CFG.hosts[ip] || ip) + "</button>").join("") + "</div></div>";
  }).join("") + '<p class="sub">Vert = client connecté en ce moment (NFSv4, port 2049). Cliquer un client pour le renommer ou l\'étiqueter.</p>';
}

function renderServices() {
  $("services").innerHTML = byTag(S.services, ([n]) => "svc:" + n).map(([name, state]) => {
    const ok = state === "active";
    return '<div class="svc"><span class="dot ' + (ok ? "ok" : "bad") + '"></span>' + nameBlock("svc:" + name, name, name) +
      '<span class="sub">' + esc(state) + '</span><button data-act="svc" data-svc="' + esc(name) + '">' + (ok ? "Redémarrer" : "Démarrer") + "</button></div>";
  }).join("");
}

function renderJournal() {
  const el = $("journal");
  el.hidden = !M;
  if (!M) return;
  const u = M.updates, n = u.packages.length;
  $("updates").hidden = false;
  $("updates").innerHTML = '<div class="card-head"><b>Mises à jour du système</b></div><div class="svc"><span class="dot ' + (n || u.reboot ? "warn" : "ok") + '"></span><span>' +
    (n ? n + " paquet" + (n > 1 ? "s" : "") + " à mettre à jour" : "Système à jour") + (u.reboot ? " · redémarrage nécessaire" : "") + "</span></div>" +
    (n ? '<p class="sub">' + u.packages.map(esc).join(", ") + "</p>" : "");
  el.innerHTML = '<div class="card-head"><b>Journal des actions</b></div>' +
    (M.journal.length ? '<div class="table-wrap"><table><tbody>' + M.journal.map(l => {
      const [when, ...rest] = l.split(" ");
      return "<tr><td><small class=\"sys\">" + esc(new Date(when).toLocaleString("fr-FR")) + "</small></td><td>" + esc(rest.join(" ")) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : '<p class="sub">Aucune action récente.</p>');
}

function renderAlerts() {
  const el = $("alerts"), a = M && M.alerts;
  el.hidden = !M;
  if (!M) return;
  el.innerHTML = '<div class="card-head"><b>Alertes</b>' + (a ? '<button data-act="alert-test">Envoyer un test</button>' : "") + "</div>" +
    (!a ? '<p class="sub">Non configurées : renseigner <code>alerts.url</code> dans la configuration du panneau.</p>'
      : '<p class="sub">Envoyées à ' + esc(a.target) + " : pool dégradé ou en erreur, pool rempli à " + a.capacity_pct + " %, disque en échec SMART ou avec erreurs, service en échec. " +
        "Un message à l'apparition, un autre au retour à la normale.</p>" +
        (a.problems.length ? a.problems.map(p => '<div class="svc"><span class="dot bad"></span><span>' + esc(p) + "</span></div>").join("")
          : '<div class="svc"><span class="dot ok"></span><span>Aucun problème en cours</span></div>'));
}

/* ---------- shares, accounts and pools created from the page (/api/manage) ---------- */

let M = null; // {state, users, groups, mountpoints, admin_exports, free_disks}
const FEAT = () => CFG.features || {};
const ACCESS = { ro: "lecture", rw: "lecture + écriture" };
const SQUASHES = [["root_squash", "root → anonyme"], ["no_root_squash", "root conservé"], ["all_squash", "tous anonymes"]];
const LAYOUT_LABELS = [["mirror", "Miroir (RAID 1)"], ["raidz1", "RAIDZ1 · 1 disque de parité"], ["raidz2", "RAIDZ2 · 2 disques de parité"],
  ["raidz3", "RAIDZ3 · 3 disques de parité"], ["stripe", "Agrégat sans redondance"]];
const hostName = h => UI.labels["host:" + h] || CFG.hosts[h] || h;

// One action at a time: a double click would otherwise send it twice.
let busy = false;
async function once(run) {
  if (busy) return toast("Action en cours…");
  busy = true;
  try { await run(); } finally { busy = false; }
}
const mg = (payload, okMsg) => once(async () => {
  try {
    await post("/api/manage", payload);
    banner("");
    toast(okMsg);
    await slowTick();
  } catch (e) { banner("Refusé : " + e.message); }
});

function renderShares() {
  const f = FEAT(), el = $("shares");
  el.hidden = !f.nfs && !f.smb;
  if (el.hidden || !M) return;
  const rows = ["nfs", "smb"].flatMap(kind => Object.entries(M.state[kind] || {}).map(([name, s]) => [kind, name, s]));
  const host = (S.host || "").toLowerCase();
  el.innerHTML = '<div class="card-head"><b>Partages du panneau</b>' +
    (f.nfs ? '<button class="primary" data-act="share-new" data-kind="nfs">Nouveau partage NFS</button>' : "") +
    (f.smb ? '<button class="primary" data-act="share-new" data-kind="smb">Nouveau partage SMB</button>' : "") +
    (f.smb && f.users ? '<button data-act="tm-new">Nouvelle destination Time Machine</button>' : "") + "</div>" +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Nom</th><th>Type</th><th>Dossier</th><th>Accès</th><th></th></tr></thead><tbody>' +
      rows.map(([kind, name, s]) => "<tr><td><b>" + esc(name) + "</b></td><td>" + kind.toUpperCase() + ((kind === "nfs" ? s.open_fw : (s.fw || []).length) ? '<br><small class="sys">pare-feu ouvert</small>' : "") +
        (s.encrypt === "required" ? '<br><small class="sys">chiffrement obligatoire</small>' : "") +
        (s.recycle ? '<br><small class="sys">corbeille</small>' : "") + (s.versions ? '<br><small class="sys">versions précédentes</small>' : "") +
        (s.timemachine ? '<br><small class="sys">Time Machine' + (s.tm_max ? " · " + esc(s.tm_max) : "") + "</small>" : "") + "</td><td>" + esc(s.path) + '</td><td><div class="chips">' +
        (kind === "nfs"
          ? s.clients.map(c => '<span class="chip' + (S.connected.has(c.host) ? " ok" : "") + '">' + dot("host:" + c.host) + esc(hostName(c.host)) + " · " + (c.rw ? "écriture" : "lecture") + "</span>")
          : Object.entries(s.access).map(([k, m]) => '<span class="chip">' + (k[0] === "g" ? "groupe " : "") + esc(k.slice(2)) + " · " + (m === "rw" ? "écriture" : "lecture") + "</span>")).join("") +
        '</div></td><td class="actions"><button data-act="share-edit" data-kind="' + kind + '" data-name="' + esc(name) + '">Modifier</button>' +
        '<button class="danger" data-act="share-del" data-kind="' + kind + '" data-name="' + esc(name) + '">Supprimer</button></td></tr>').join("") +
      "</tbody></table></div>"
      : '<p class="sub">Aucun partage créé depuis le panneau.</p>') +
    (f.smb && M.sessions.length ? '<p class="sub"><b>Connexions SMB en cours</b></p>' + M.sessions.map(x => '<div class="svc"><span class="dot ' + (x.encryption ? "ok" : "") + '"></span><b>' +
      esc(x.user) + '</b><span class="sub">' + esc(hostName(x.machine)) + " · " + esc((x.shares || []).join(", ") || "aucun partage ouvert") + " · " + esc(x.dialect) +
      (x.encryption ? " · chiffré " + esc(x.encryption) : " · non chiffré") + " · depuis " + new Date(x.since).toLocaleString("fr-FR") + "</span></div>").join("") : "") +
    (f.smb && M.bonjour && M.bonjour !== "absent" ? '<div class="svc"><span class="dot ' + (M.bonjour === "active" ? "ok" : "") + '"></span><b>Annonce Bonjour</b>' +
      '<span class="sub">' + (M.bonjour === "active" ? "active : les Mac voient le serveur et ses destinations Time Machine sans saisir d'adresse"
        : "arrêtée : se connecter par adresse (smb://…)") + '</span><button data-act="bonjour" data-on="' + (M.bonjour === "active" ? "" : "1") + '">' +
      (M.bonjour === "active" ? "Arrêter" : "Activer") + "</button></div>" : "") +
    '<p class="sub">' + (f.smb ? "SMB : \\\\" + esc(host) + "\\nom (Windows) ou smb://" + esc(host) + "/nom (macOS), avec un compte de la rubrique Comptes. " : "") +
    (f.nfs ? "NFS : accès par adresse IP du client, sans compte." : "") + "</p>";
}

async function shareForm(kind, name) {
  const cur = name ? M.state[kind][name] : null;
  // An NFS path can be exported once: not by /etc/exports, not by another panel share.
  const taken = new Set(M.admin_exports.concat(Object.entries(M.state.nfs || {}).filter(([n]) => n !== name).map(([, s]) => s.path)));
  const paths = M.mountpoints.filter(p => kind === "smb" || !taken.has(p));
  let body = "<label>Nom" + (name ? '<input name="name" value="' + esc(name) + '" readonly>'
    : '<input name="name" required maxlength="32" pattern="[A-Za-z0-9_\\-]+" placeholder="ex. Photos">') + "</label>" +
    '<label>Dossier (dataset ZFS)<select name="path" required>' + paths.map(p => "<option" + (cur && cur.path === p ? " selected" : "") + ">" + esc(p) + "</option>").join("") + "</select></label>";
  if (kind === "nfs") {
    const rows = (cur ? cur.clients : []).concat(Array(Math.max(2, 5 - (cur ? cur.clients.length : 0))).fill({ host: "", rw: false, squash: "root_squash" }));
    body += '<fieldset class="rows"><legend>Clients · adresse IP, réseau (192.168.1.0/24) ou nom ; lignes vides ignorées</legend>' + rows.map((c, i) =>
      '<div class="client"><input name="host' + i + '" list="hosts-dl" value="' + esc(c.host) + '" aria-label="Client ' + (i + 1) + '">' +
      '<select name="rw' + i + '" aria-label="Droits"><option value="">lecture</option><option value="1"' + (c.rw ? " selected" : "") + ">lecture + écriture</option></select>" +
      '<select name="sq' + i + '" aria-label="Utilisateur root">' + SQUASHES.map(([v, l]) => '<option value="' + v + '"' + (c.squash === v ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></div>").join("") + "</fieldset>" +
      (FEAT().firewall ? '<label class="check"><input type="checkbox" name="fw"' + (cur && cur.open_fw ? " checked" : "") +
        '> Ouvrir le pare-feu (NFS, port 2049) pour ces clients</label><p class="sub">Fermé par défaut : à cocher si le client n\'a pas déjà accès. ' +
        "Adresses IP ou réseaux seulement. Supprimer le partage referme l'accès.</p>" : "") +
      '<datalist id="hosts-dl">' + Object.entries(CFG.hosts || {}).map(([ip, n]) => '<option value="' + esc(ip) + '">' + esc(n) + "</option>").join("") + "</datalist>";
    const fd = await ask(name ? "Partage NFS " + name : "Nouveau partage NFS", body, "Enregistrer");
    if (!fd) return;
    const clients = rows.map((_, i) => ({ host: fd.get("host" + i).trim(), rw: fd.get("rw" + i) === "1", squash: fd.get("sq" + i) })).filter(c => c.host);
    return mg({ op: "share_save", kind, name: fd.get("name"), path: fd.get("path"), clients, open_fw: fd.get("fw") === "on" }, "Partage NFS " + fd.get("name") + " enregistré");
  }
  // Without a Samba password an account cannot log in: shown, not selectable.
  const who = M.users.map(u => ["u:" + u.name, u.name, !u.samba]).concat(M.groups.filter(g => g.owned).map(g => ["g:" + g.name, "groupe " + g.name, false]));
  body += '<fieldset class="rows"><legend>Accès</legend>' + (who.length ? who.map(([k, l, off]) =>
    '<div class="client"><span>' + esc(l) + (off ? ' <small class="sys">pas de mot de passe Samba</small>' : "") + '</span><select name="' + esc(k) + '"' +
    (off ? " disabled" : "") + ' aria-label="Accès de ' + esc(l) + '"><option value="">aucun</option>' +
    Object.entries(ACCESS).map(([v, t]) => '<option value="' + v + '"' + (cur && cur.access[k] === v ? " selected" : "") + ">" + t + "</option>").join("") + "</select></div>").join("")
    : '<p class="sub">Aucun compte : créez-en un dans la rubrique Comptes.</p>') + "</fieldset>" +
    (FEAT().firewall ? '<label>Ouvrir le pare-feu (SMB, port 445) pour<input name="fw" value="' + esc((cur && cur.fw || []).join(", ")) +
      '" placeholder="vide = fermé ; ex. 192.168.1.20, 192.168.1.0/24"></label>' : "") +
    '<label>Chiffrement<select name="encrypt"><option value="desired">si le client sait chiffrer (macOS, Windows 10 et +)</option>' +
    '<option value="required"' + (cur && cur.encrypt === "required" ? " selected" : "") + ">obligatoire : refuse les clients qui ne chiffrent pas</option></select></label>" +
    '<label class="check"><input type="checkbox" name="versions"' + (cur ? (cur.versions ? " checked" : "") : " checked") +
    "> Versions précédentes (Windows) à partir des snapshots automatiques du dataset</label>" +
    '<label class="check"><input type="checkbox" name="recycle"' + (cur ? (cur.recycle ? " checked" : "") : " checked") +
    "> Corbeille : les fichiers supprimés vont dans .recycle et sont effacés après " + (CFG.recycle_days || 30) + " jours</label>" +
    '<label class="check"><input type="checkbox" name="tm"' + (cur && cur.timemachine ? " checked" : "") + "> Destination Time Machine (sauvegardes de Mac)</label>" +
    '<label>Taille maximale Time Machine<input name="tm_max" pattern="[0-9]+(\\.[0-9]+)?[KMGT]?" value="' + esc(cur && cur.tm_max || "") +
    '" placeholder="vide = sans limite ; ex. 1T"></label>' +
    '<label>Propriétaire des fichiers<select name="owner"><option value="">propriétaire actuel du dossier</option>' +
    M.users.filter(u => u.samba).map(u => "<option" + (cur && cur.owner === u.name ? " selected" : "") + ">" + esc(u.name) + "</option>").join("") + "</select></label>" +
    '<p class="sub">Samba écrit les nouveaux fichiers sous ce compte. Choisir un compte en fait le propriétaire du dossier partagé lui-même, pas de son contenu. ' +
    "Obligatoire si le dossier appartient à root (jamais d'écriture en root). Seuls les comptes choisis dans Accès se connectent.</p>";
  const fd = await ask(name ? "Partage SMB " + name : "Nouveau partage SMB", body, "Enregistrer");
  if (!fd) return;
  const access = Object.fromEntries(who.map(([k]) => [k, fd.get(k)]).filter(([, v]) => v));
  const fw = (fd.get("fw") || "").split(/[\s,;]+/).filter(Boolean);
  return mg({ op: "share_save", kind, name: fd.get("name"), path: fd.get("path"), access, fw, owner: fd.get("owner"), encrypt: fd.get("encrypt"), timemachine: fd.get("tm") === "on", tm_max: fd.get("tm_max").trim(), versions: fd.get("versions") === "on", recycle: fd.get("recycle") === "on" }, "Partage SMB " + fd.get("name") + " enregistré");
}

// One form: dataset (reused, or created if pools are on) + account + encrypted Time Machine share.
async function tmForm() {
  const pools = FEAT().pools;
  const fd = await ask("Nouvelle destination Time Machine",
    '<label>Nom du Mac (compte et partage)<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="ex. macbook-pro" autocomplete="off"></label>' +
    '<label>Dataset<input name="ds" required list="tm-ds" placeholder="ex. tank/timemachine/macbook-pro"></label>' +
    '<datalist id="tm-ds">' + S.datasets.map(r => '<option value="' + esc(r[0]) + '">').join("") + "</datalist>" +
    '<p class="sub">' + (pools ? "Existant : réutilisé. Nouveau : créé avec ce quota, blocs de 1M, sans snapshots automatiques."
      : "Dataset existant uniquement (créé par l'administrateur, idéalement avec quota).") + "</p>" +
    '<label>Taille réservée<input name="size" required pattern="[0-9]+(\\.[0-9]+)?[KMGT]" value="2T"></label>' +
    (FEAT().firewall ? '<label>Ouvrir le pare-feu SMB pour (IP du Mac, ou le réseau s\'il est en DHCP)<input name="ip" placeholder="vide = fermé ; ex. 192.168.1.107 ou 192.168.1.0/24"></label>' : "") +
    PASSWORDS + '<p class="sub">Chiffrement obligatoire. Sur le Mac : Réglages > Time Machine > Ajouter une destination, compte = nom du Mac.</p>', "Créer");
  if (fd && samePasswords(fd)) mg({ op: "timemachine_create", name: fd.get("name"), dataset: fd.get("ds").trim(), size: fd.get("size"), ip: (fd.get("ip") || "").trim(), password: fd.get("p1") },
    "Destination Time Machine " + fd.get("name") + " créée");
}

async function deleteShare(kind, name) {
  const fd = await ask("Supprimer le partage ?", "<p>Le partage <b>" + esc(name) + "</b> ne sera plus accessible. Les fichiers restent dans le dataset.</p>", "Supprimer", true);
  if (fd) mg({ op: "share_delete", kind, name }, "Partage " + name + " supprimé");
}

function renderAccounts() {
  const el = $("accounts");
  if (!FEAT().users) { el.innerHTML = '<article class="card"><p class="sub">Gestion des comptes désactivée sur ce serveur.</p></article>'; return; }
  if (!M) return;
  const owned = M.groups.filter(g => g.owned);
  const btn = (act, name, label, cls) => '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-act="' + act + '" data-name="' + esc(name) + '">' + label + "</button>";
  el.innerHTML = '<article class="card"><div class="card-head"><b>Utilisateurs</b><button class="primary" data-act="user-new">Nouvel utilisateur</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Identifiant</th><th>Groupes</th><th>Origine</th><th></th></tr></thead><tbody>' +
    M.users.map(u => "<tr><td><b>" + esc(u.name) + '</b> <small class="sys">uid ' + u.uid + "</small></td><td>" + (u.groups.map(esc).join(", ") || "—") +
      "</td><td>" + (u.owned ? "panneau" : '<span class="sub">système, lecture seule</span>') + '</td><td class="actions">' +
      (u.owned ? btn("user-groups", u.name, "Groupes") + btn("user-pass", u.name, "Mot de passe") + btn("user-del", u.name, "Supprimer", "danger") : "") + "</td></tr>").join("") +
    '</tbody></table></div><p class="sub">Comptes Linux sans connexion au serveur (ni shell ni SSH), avec un mot de passe Samba pour les partages SMB.</p></article>' +
    '<article class="card"><div class="card-head"><b>Groupes</b><button class="primary" data-act="group-new">Nouveau groupe</button></div>' +
    (owned.length ? owned.map(g => '<div class="svc"><b>' + esc(g.name) + '</b><span class="sub">' + (g.members.map(esc).join(", ") || "aucun membre") + "</span>" +
      btn("group-del", g.name, "Supprimer", "danger") + "</div>").join("")
      : '<p class="sub">Aucun groupe. Un groupe donne le même accès à plusieurs comptes (ex. famille).</p>') + "</article>";
}

function groupBoxes(checked) {
  const owned = M.groups.filter(g => g.owned);
  return '<fieldset class="swatches"><legend>Groupes</legend>' + (owned.length ? owned.map(g => '<label class="swatch"><input type="checkbox" name="g" value="' + esc(g.name) + '"' +
    (checked.includes(g.name) ? " checked" : "") + ">" + esc(g.name) + "</label>").join("") : '<span class="sub">Aucun groupe créé.</span>') + "</fieldset>";
}
const PASSWORDS = '<label>Mot de passe (8 caractères au moins)<input type="password" name="p1" minlength="8" maxlength="128" required autocomplete="new-password"></label>' +
  '<label>Confirmation<input type="password" name="p2" minlength="8" maxlength="128" required autocomplete="new-password"></label>';
function samePasswords(fd) {
  if (fd.get("p1") === fd.get("p2")) return true;
  banner("Les deux mots de passe sont différents.");
  return false;
}

async function userForm() {
  const fd = await ask("Nouvel utilisateur", '<label>Identifiant<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="ex. alice" autocomplete="off"></label>' +
    PASSWORDS + groupBoxes([]), "Créer");
  if (fd && samePasswords(fd)) mg({ op: "user_create", name: fd.get("name"), password: fd.get("p1"), groups: fd.getAll("g") }, "Compte " + fd.get("name") + " créé");
}
async function passwordForm(name) {
  const fd = await ask("Mot de passe de " + name, PASSWORDS, "Changer");
  if (fd && samePasswords(fd)) mg({ op: "user_password", name, password: fd.get("p1") }, "Mot de passe de " + name + " changé");
}
async function userGroupsForm(name) {
  const fd = await ask("Groupes de " + name, groupBoxes(M.users.find(u => u.name === name).groups), "Enregistrer");
  if (fd) mg({ op: "user_groups", name, groups: fd.getAll("g") }, "Groupes de " + name + " enregistrés");
}
async function deleteAccount(op, name) {
  const fd = await ask("Supprimer " + name + " ?", "<p><b>" + esc(name) + "</b> sera supprimé. Ses fichiers restent sur les partages.</p>", "Supprimer", true);
  if (fd) mg({ op, name }, name + " supprimé");
}
async function groupForm() {
  const fd = await ask("Nouveau groupe", '<label>Nom<input name="name" required maxlength="32" pattern="[a-z_][a-z0-9_\\-]*" placeholder="ex. famille"></label>', "Créer");
  if (fd) mg({ op: "group_create", name: fd.get("name") }, "Groupe " + fd.get("name") + " créé");
}

async function datasetForm() {
  const fd = await ask("Nouveau dataset", '<label>Dans<select name="parent">' + S.datasets.map(r => "<option>" + esc(r[0]) + "</option>").join("") + "</select></label>" +
    '<label>Nom<input name="leaf" required pattern="[A-Za-z0-9_.:\\-]+" placeholder="ex. photos"></label>' +
    '<label>Compression<select name="comp">' + COMPRESSION.map(c => "<option>" + c + "</option>").join("") + "</select></label>", "Créer");
  if (fd) mg({ op: "dataset_create", dataset: fd.get("parent") + "/" + fd.get("leaf"), compression: fd.get("comp") }, "Dataset " + fd.get("parent") + "/" + fd.get("leaf") + " créé");
}
async function poolForm() {
  const disks = M.free_disks;
  if (!disks.length) {
    await ask("Nouveau pool", "<p>Aucun disque libre : tous les disques ont déjà des partitions, des données ou appartiennent à un pool.</p>", "Fermer");
    return;
  }
  const fd = await ask("Nouveau pool",
    '<p class="sub">Seuls les disques vierges sont proposés. <b>Les disques choisis seront entièrement effacés.</b></p>' +
    '<label>Nom<input name="name" required pattern="[A-Za-z][A-Za-z0-9_.:\\-]*" placeholder="ex. data"></label>' +
    '<label>Disposition<select name="layout">' + LAYOUT_LABELS.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") + "</select></label>" +
    '<fieldset class="swatches"><legend>Disques</legend>' + disks.map(d => '<label class="swatch"><input type="checkbox" name="d" value="' + esc(d.id) + '">' +
      esc(d.dev) + " · " + bytes(d.size) + " · " + esc(d.model) + "</label>").join("") + "</fieldset>" +
    '<label>Confirmation : retapez le nom du pool<input name="confirm" required autocomplete="off"></label>', "Créer le pool", true);
  if (fd) mg({ op: "pool_create", name: fd.get("name"), layout: fd.get("layout"), disks: fd.getAll("d"), confirm: fd.get("confirm") }, "Pool " + fd.get("name") + " créé");
}

/* ---------- actions (validated again server-side) ---------- */

const act = (payload, okMsg) => once(async () => {
  try {
    await post("/api/action", payload);
    banner("");
    toast(okMsg);
    await slowTick();
  } catch (e) { banner("Échec : " + e.message); }
});

async function editDataset(name, comp, quota, auto) {
  const fd = await ask("Modifier " + name,
    '<label>Compression<select name="comp">' + COMPRESSION.map(c => "<option" + (c === comp ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
    '<label>Quota (ex. 500G, 1T, none)<input name="quota" required pattern="none|[0-9]+(\\.[0-9]+)?[KMGTP]?" value="' + esc(quota) + '"></label>' +
    (FEAT().autosnap ? '<label>Snapshots automatiques<select name="auto"><option value="true">oui (rotation : quart d\'heure, heure, jour, semaine, mois)</option>' +
      '<option value="false"' + (auto === "false" ? " selected" : "") + ">non</option></select></label>" : "") +
    '<p class="sub">La compression ne s\'applique qu\'aux données écrites ensuite. Les datasets enfants héritent du choix des snapshots automatiques.</p>');
  if (fd) act({ action: "dataset_set", dataset: name, compression: fd.get("comp"), quota: fd.get("quota"), autosnap: fd.get("auto") || "" }, name + " modifié");
}

async function createSnap(ds) {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  const fd = await ask("Snapshot de " + ds,
    '<label>Nom<input name="snap" required pattern="[A-Za-z0-9_.:\\-]+" value="manuel-' + stamp + '"></label>' +
    '<label class="check"><input type="checkbox" name="r"> Inclure les datasets enfants (-r)</label>', "Créer");
  if (fd) act({ action: "snapshot_create", dataset: ds, name: fd.get("snap"), recursive: !!fd.get("r") }, "Snapshot " + ds + "@" + fd.get("snap") + " créé");
}

async function destroySnap(name) {
  const fd = await ask("Supprimer le snapshot ?", "<p><b>" + esc(name) + "</b> sera supprimé définitivement.</p>", "Supprimer", true);
  if (fd) act({ action: "snapshot_destroy", snapshot: name }, name + " supprimé");
}
// Every manual snapshot called @snap: one confirmation, then one validated action each.
async function destroySnaps(snap) {
  const names = S.snapshots.map(s => s[0]).filter(n => n.split("@")[1] === snap);
  const fd = await ask("Supprimer les " + names.length + " snapshots @" + snap + " ?", '<p>Seront supprimés définitivement :</p><p class="sub">' +
    names.map(esc).join("<br>") + "</p>", "Supprimer les " + names.length, true);
  if (!fd) return;
  let done = 0;
  await once(async () => {
    try {
      for (const name of names) { await post("/api/action", { action: "snapshot_destroy", snapshot: name }); done++; }
      banner("");
      toast(done + " snapshots supprimés");
    } catch (e) { banner("Échec après " + done + " / " + names.length + " snapshots supprimés : " + e.message); }
    await slowTick();
  });
}

// One delegated listener: buttons are re-rendered every tick.
// Theme: "" = follow the system, else forced; per browser (localStorage may be unavailable).
const THEMES = { "": "auto", light: "clair", dark: "sombre" };
function setTheme(t) {
  if (!(t in THEMES)) t = "";
  if (t)document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $("theme").textContent = "Thème : " + THEMES[t];
  try { localStorage.setItem("theme", t); } catch { /* not remembered */ }
}
try { setTheme(localStorage.getItem("theme") || ""); } catch { setTheme(""); }

document.addEventListener("click", e => {
  const b = e.target.closest("button, a");
  if (!b) return;
  const d = b.dataset;
  if (d.view) return show(d.view);
  if (d.goto) return show(d.goto);
  if (d.editItem) return editItem(d.editItem, d.sys);
  switch (d.act) {
    case "tags": return manageTags();
    case "scrub": return act({ action: d.running === "true" ? "scrub_stop" : "scrub_start", pool: d.pool }, (d.running === "true" ? "Scrub arrêté sur " : "Scrub lancé sur ") + d.pool);
    case "svc": return act({ action: "service_restart", service: d.svc }, d.svc + " redémarré");
    case "ds-edit": return editDataset(d.ds, d.comp, d.quota, d.auto);
    case "ds-snap": return createSnap(d.ds);
    case "snap-del": return destroySnap(d.snap);
    case "snap-del-many": return destroySnaps(d.snap);
    case "logout": return post("/api/logout", {}).finally(() => location.reload());
    case "theme": { const k = Object.keys(THEMES); return setTheme(k[(k.indexOf(document.documentElement.dataset.theme || "") + 1) % k.length]); }
  }
  if (!M) return;
  switch (d.act) {
    case "share-new": return shareForm(d.kind);
    case "share-edit": return shareForm(d.kind, d.name);
    case "share-del": return deleteShare(d.kind, d.name);
    case "tm-new": return tmForm();
    case "alert-test": return mg({ op: "alert_test" }, "Alerte de test envoyée");
    case "user-new": return userForm();
    case "user-pass": return passwordForm(d.name);
    case "user-groups": return userGroupsForm(d.name);
    case "user-del": return deleteAccount("user_delete", d.name);
    case "group-new": return groupForm();
    case "group-del": return deleteAccount("group_delete", d.name);
    case "ds-new": return datasetForm();
    case "pool-new": return poolForm();
    case "bonjour": return mg({ op: "bonjour", on: d.on === "1" }, d.on === "1" ? "Annonce Bonjour activée" : "Annonce Bonjour arrêtée");
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
    const fd = await ask("Connexion", '<label>Identifiant<input name="user" required autocomplete="username" autocapitalize="off"></label>' +
      '<label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label>' +
      '<p class="sub">Compte du serveur membre du groupe d\'administration.</p>', "Se connecter");
    if (!fd) continue;
    try {
      await post("/api/login", { user: fd.get("user").trim(), password: fd.get("password") });
      return location.reload();
    } catch (e) { banner(e.message); }
  }
}

get("/api/config").then(t => {
  CFG = JSON.parse(t);
  $("logout").hidden = !FEAT().login;
  UI = Object.assign({ labels: {}, tags: {}, assign: {} }, CFG.ui);
  document.title = CFG.title + " · Cairn";
  $("title").textContent = CFG.title;
  $("subtitle").textContent = CFG.subtitle || "";
  $("user").textContent = CFG.user;
  buildGauges();
  buildSystem();
  document.querySelector('#nav [data-view="comptes"]').hidden = !FEAT().users;
  show(location.hash.slice(1));
  slowTick().then(fastTick);
  setInterval(fastTick, FAST_MS);
  setInterval(slowTick, SLOW_MS);
}).catch(e => e.status === 401 ? signIn() : banner("Configuration illisible : " + e.message));
