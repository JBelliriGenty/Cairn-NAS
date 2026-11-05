//! Cairn (cairn-nas): single-binary admin panel for a Debian + ZFS storage box.
//!
//! Runs as root, in one of two modes:
//! - behind a reverse proxy that authenticates users (e.g. Traefik + Authelia
//!   forwardAuth): a request is served only if it comes from a trusted proxy
//!   address AND carries the identity header (and a required group, if set);
//! - on its own ("login" in the config): HTTPS only, sign-in with a local
//!   system account member of the admin group (checked against /etc/shadow),
//!   session cookie, growing delay after failures.
//! Reads come from /proc and /sys directly, plus a few zpool/zfs/
//! ss/systemctl/ip calls; writes are a closed list of validated actions run
//! without a shell, each logged with the user name (stderr -> journald).
//! GET /api/summary (pools, problems, temperature as JSON) is also open to a
//! bearer token ("summary_token_file"), for dashboards such as Homepage.
//!
//! Usage: cairn-nas /etc/cairn-nas.json

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::process::Command;
use std::sync::Mutex;
use std::collections::BTreeMap;
use std::ffi::{c_char, CStr, CString};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server};

const INDEX: &str = include_str!("../www/index.html");
const JS: &str = include_str!("../www/panel.js");
const CSS: &str = include_str!("../www/panel.css");
const ICON: &str = include_str!("../www/icon.svg");
const I18N: &str = include_str!("../www/i18n.js");
const COMPRESSION: [&str; 5] = ["lz4", "zstd", "zstd-fast", "gzip", "off"];

struct Config {
    listen: String,
    trusted_proxies: Vec<String>,
    user_header: String,
    groups_header: String,
    require_groups: Vec<String>,
    services: Vec<String>,
    state_file: String, // UI labels/tags edited from the page
    features: Features, // opt-in write features beyond the basic actions
    manage_file: String, // shares and groups created from the page
    nfs_file: String,
    smb_file: String,
    // nftables table holding the sets cairn_nfs / cairn_smb ("inet nas");
    // None: the panel never opens the firewall.
    firewall_table: Option<String>,
    fw_file: String,
    alerts: Option<Alerts>,
    login: Option<Login>,
    tls: Option<(String, String)>, // PEM certificate and key files
    alerts_file: String, // problems already notified (survives restarts)
    recycle_days: u64,
    summary_token: Option<String>, // bearer token for /api/summary only
    lang: String, // alerts, /api/summary, and the page when the browser asks for no known language
    replication: Vec<Replica>,
    public: Value,      // what /api/config returns (labels, title…)
}

/// Built-in sign-in (no authenticating proxy in front).
struct Login {
    admin_group: String,
    session_s: u64, // idle time before the session expires
}

/// Notifications: POST of the message to `url` (ntfy-compatible: title, priority
/// and tags go in the query string; any other webhook just gets a text body).
struct Alerts {
    url: String,
    headers_file: Option<String>, // curl -H @file, e.g. "Authorization: Bearer …" (secret, not in the config)
    capacity_pct: u64,
    interval_s: u64,
}

/// A replicated dataset (and its children): the newest snapshot whose name
/// starts with `prefix` tells when it was last sent (source) or received (target).
struct Replica {
    dataset: String,
    prefix: String,
    max_age_s: u64,
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v[key].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

impl Config {
    fn load(path: &str) -> Config {
        let v: Value = serde_json::from_str(&fs::read_to_string(path).expect("config unreadable")).expect("config: invalid JSON");
        let s = |k: &str, d: &str| v[k].as_str().unwrap_or(d).to_string();
        let mut public = json!({});
        for k in ["title", "subtitle", "nics", "hosts", "services", "lang"] {
            public[k] = v[k].clone();
        }
        let recycle_days = v["recycle_days"].as_u64().unwrap_or(30).max(1);
        public["recycle_days"] = json!(recycle_days); // the effective value, even when unset
        let f = |k: &str| v["features"][k].as_bool().unwrap_or(false);
        let features = Features { nfs: f("nfs"), smb: f("smb"), users: f("users"), pools: f("pools") };
        let firewall_table = v["firewall_table"].as_str().map(String::from);
        let l = &v["login"];
        let login = l.is_object().then(|| Login {
            admin_group: l["admin_group"].as_str().unwrap_or("nas-admin").to_string(),
            session_s: l["session_minutes"].as_u64().unwrap_or(30).max(1) * 60,
        });
        let tls = match (v["tls"]["cert"].as_str(), v["tls"]["key"].as_str()) {
            (Some(c), Some(k)) => Some((c.to_string(), k.to_string())),
            _ => None,
        };
        // A system password must never cross the network in clear text.
        assert!(login.is_none() || tls.is_some(), "config: \"login\" requires \"tls\" (cert and key)");
        let a = &v["alerts"];
        let alerts = a["url"].as_str().map(|url| Alerts {
            url: url.to_string(),
            headers_file: a["headers_file"].as_str().map(String::from),
            capacity_pct: a["capacity_pct"].as_u64().unwrap_or(85),
            interval_s: a["interval_s"].as_u64().unwrap_or(300).max(60),
        });
        public["features"] = json!({"nfs": features.nfs, "smb": features.smb, "users": features.users, "pools": features.pools,
            "firewall": firewall_table.is_some(), "login": login.is_some(), "autosnap": std::path::Path::new("/usr/sbin/zfs-auto-snapshot").exists()});
        Config {
            listen: s("listen", "127.0.0.1:9091"),
            trusted_proxies: strings(&v, "trusted_proxies"),
            user_header: s("user_header", "Remote-User"),
            groups_header: s("groups_header", "Remote-Groups"),
            require_groups: strings(&v, "require_groups"),
            services: strings(&v, "services"),
            state_file: s("state_file", "/var/lib/cairn-nas/ui.json"),
            features,
            manage_file: s("manage_file", "/var/lib/cairn-nas/manage.json"),
            nfs_file: s("nfs_file", "/etc/exports.d/cairn-nas.exports"),
            smb_file: s("smb_file", "/etc/samba/cairn-nas.conf"),
            firewall_table,
            fw_file: s("fw_file", "/etc/nftables.d/cairn-nas.nft"),
            alerts,
            login,
            tls,
            alerts_file: s("alerts_file", "/var/lib/cairn-nas/alerts.json"),
            recycle_days,
            lang: s("lang", "en"),
            replication: v["replication"].as_array().into_iter().flatten().filter_map(|r| Some(Replica {
                dataset: r["dataset"].as_str()?.to_string(),
                prefix: r["snapshot_prefix"].as_str().unwrap_or("").to_string(),
                max_age_s: r["max_age_hours"].as_u64().unwrap_or(26).max(1) * 3600,
            })).collect(),
            // A file, so the secret stays out of the config; a short token is refused.
            summary_token: v["summary_token_file"].as_str().map(|f| {
                let t = fs::read_to_string(f).expect("summary_token_file unreadable").trim().to_string();
                assert!(t.len() >= 32, "summary_token_file: token shorter than 32 characters");
                t
            }),
            public,
        }
    }
}

/* ---------- collectors ---------- */

fn read(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn cmd(argv: &[&str]) -> String {
    // ponytail: no timeout; each request runs on its own thread, so a hung
    // zpool only blocks its own request. Add a wait-with-timeout if it bites.
    Command::new(argv[0]).args(&argv[1..]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// Sections separated by "@@" lines, each section newline-terminated (see panel.js).
fn join(sections: Vec<String>) -> String {
    sections
        .into_iter()
        .map(|mut s| {
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s
        })
        .collect::<Vec<_>>()
        .join("@@\n")
}

fn hwmon() -> String {
    let mut out = String::new();
    let Ok(dirs) = fs::read_dir("/sys/class/hwmon") else { return out };
    for d in dirs.flatten() {
        let p = d.path();
        let name = read(&format!("{}/name", p.display())).trim().to_string();
        let dev = fs::canonicalize(p.join("device")).ok().and_then(|x| x.file_name().map(|f| f.to_string_lossy().into_owned())).unwrap_or_default();
        let Ok(files) = fs::read_dir(&p) else { continue };
        for f in files.flatten() {
            let file = f.file_name().to_string_lossy().into_owned();
            if let Some(base) = file.strip_prefix("temp").and_then(|r| r.strip_suffix("_input")) {
                let label = read(&format!("{}/temp{base}_label", p.display())).trim().to_string();
                let value = read(&f.path().to_string_lossy()).trim().to_string();
                let label = if label.is_empty() { "temp".into() } else { label };
                out += &format!("{name}|{dev}|{label}|{value}\n");
            }
        }
    }
    out
}

fn fast() -> String {
    let arc: String = read("/proc/spl/kstat/zfs/arcstats")
        .lines()
        .filter(|l| ["size ", "c_max ", "hits ", "misses "].iter().any(|k| l.starts_with(k)))
        .map(|l| format!("{l}\n"))
        .collect();
    join(vec![
        read("/proc/stat").lines().filter(|l| l.starts_with("cpu")).map(|l| format!("{l}\n")).collect(),
        read("/proc/meminfo"),
        read("/proc/net/dev"),
        read("/proc/diskstats"),
        arc,
        hwmon(),
        read("/proc/loadavg") + &read("/proc/uptime"),
    ])
}

fn sys_lines(glob_dir: &str, keep: impl Fn(&str) -> bool, line: impl Fn(&str) -> String) -> String {
    let mut names: Vec<String> = fs::read_dir(glob_dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| keep(n)).collect()).unwrap_or_default();
    names.sort();
    names.iter().map(|n| line(n) + "\n").collect()
}

fn slow(cfg: &Config) -> String {
    let mut argv = vec!["systemctl", "is-active"];
    argv.extend(cfg.services.iter().map(String::as_str));
    let states = cmd(&argv);
    let services: String = cfg.services.iter().zip(states.lines()).map(|(s, st)| format!("{s} {st}\n")).collect();
    let snaps = cmd(&["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,used,creation"]);
    let now = now_s();
    let repl: String = last_sends(&snaps, &cfg.replication).iter().map(|(ds, last, max)| match last {
        Some(t) => format!("{ds}\t{t}\t{}\t{max}\n", now.saturating_sub(*t)),
        None => format!("{ds}\t-\t-\t{max}\n"),
    }).collect();
    join(vec![
        read("/proc/sys/kernel/hostname") + &read("/proc/sys/kernel/osrelease"),
        // Every imported pool: a pool added later shows up without any config change.
        cmd(&["zpool", "get", "-Hp", "health,size,allocated,free,fragmentation,capacity"]),
        cmd(&["zpool", "status"]),
        cmd(&["zfs", "list", "-Hp", "-o", "name,used,avail,refer,compressratio,compression,recordsize,quota,mountpoint,com.sun:auto-snapshot"]),
        snaps,
        cmd(&["ss", "-Htn", "state", "established", "( sport = :2049 )"]),
        services,
        cmd(&["ip", "-j", "addr"]),
        sys_lines("/sys/class/net", |n| n.starts_with('e'), |n| {
            let sp = read(&format!("/sys/class/net/{n}/speed"));
            format!("{n} {}", if sp.trim().is_empty() { "-1" } else { sp.trim() })
        }),
        disks().iter().map(|n| format!("{n}|{}\n", read(&format!("/sys/block/{n}/device/model")).trim())).collect(),
        read("/etc/exports").lines().filter(|l| !l.starts_with('#')).map(|l| format!("{l}\n")).collect(),
        by_id(),
        health(),
        repl,
    ])
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// (dataset, newest matching snapshot's creation time, max age) for each
/// replicated dataset and its children, from `zfs list -Hp -t snapshot`
/// lines whose first column is the name and last one the creation time.
/// ponytail: a child with no snapshot at all is not listed (only the root is,
/// as never sent); list the datasets too if that matters.
fn last_sends(snaps: &str, reps: &[Replica]) -> Vec<(String, Option<u64>, u64)> {
    let mut out: BTreeMap<String, (Option<u64>, u64)> = BTreeMap::new();
    for r in reps {
        out.entry(r.dataset.clone()).or_insert((None, r.max_age_s));
        for l in snaps.lines() {
            let f: Vec<&str> = l.split('\t').collect();
            let (Some((ds, snap)), Some(Ok(t))) = (f[0].split_once('@'), f.last().map(|t| t.trim().parse::<u64>())) else { continue };
            let under = ds == r.dataset || ds.strip_prefix(&r.dataset).is_some_and(|x| x.starts_with('/'));
            if under && snap.starts_with(&r.prefix) {
                let e = out.entry(ds.to_string()).or_insert((None, r.max_age_s));
                e.0 = e.0.max(Some(t));
            }
        }
    }
    out.into_iter().map(|(d, (t, m))| (d, t, m)).collect()
}

/// Replication late (newest snapshot older than its max age) or never done.
fn replication_problems(rows: &[(String, Option<u64>, u64)], now: u64, out: &mut BTreeMap<String, String>) {
    for (ds, last, max) in rows {
        match last {
            None => {
                out.insert(format!("repl:{ds}"), format!("Replication of {ds}: no snapshot yet"));
            }
            Some(t) if now.saturating_sub(*t) > *max => {
                out.insert(format!("repl:{ds}"), format!("Replication of {ds} is late: last snapshot {} h ago (threshold {} h)", (now - t) / 3600, max / 3600));
            }
            _ => {}
        }
    }
}

fn disks() -> Vec<String> {
    let mut d: Vec<String> = fs::read_dir("/sys/block")
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    d.retain(|n| (n.starts_with("nvme") && n.ends_with("n1")) || (n.starts_with("sd") && n.len() == 3));
    d.sort();
    d
}

/// "by-id name|kernel name" lines: zpool status names disks by id, the stats use kernel names.
fn by_id() -> String {
    let Ok(dir) = fs::read_dir("/dev/disk/by-id") else { return String::new() };
    let mut out: Vec<String> = dir
        .flatten()
        .filter_map(|e| {
            let target = fs::canonicalize(e.path()).ok()?;
            Some(format!("{}|{}\n", e.file_name().to_string_lossy(), target.file_name()?.to_string_lossy()))
        })
        .collect();
    out.sort();
    out.concat()
}

static HEALTH: Mutex<Option<(Instant, String)>> = Mutex::new(None);
const HEALTH_TTL_S: u64 = 300;

/// One JSON line per disk from smartctl, cached HEALTH_TTL_S (SMART data moves slowly).
fn health() -> String {
    let mut cache = HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((t, s)) = cache.as_ref() {
        if t.elapsed().as_secs() < HEALTH_TTL_S {
            return s.clone();
        }
    }
    let mut out = String::new();
    for d in disks() {
        let raw = cmd(&["smartctl", "-j", "-a", &format!("/dev/{d}")]);
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { continue };
        let h = &v["nvme_smart_health_information_log"];
        let realloc = v["ata_smart_attributes"]["table"]
            .as_array()
            .and_then(|t| t.iter().find(|a| a["id"] == 5))
            .map(|a| a["raw"]["value"].clone())
            .unwrap_or(Value::Null);
        let line = json!({
            "dev": d, "model": v["model_name"], "serial": v["serial_number"], "capacity": v["user_capacity"]["bytes"],
            "passed": v["smart_status"]["passed"], "temp": v["temperature"]["current"], "hours": v["power_on_time"]["hours"],
            "used": h["percentage_used"], "spare": h["available_spare"], "spare_thr": h["available_spare_threshold"],
            "media_errors": h["media_errors"], "critical": h["critical_warning"], "written": h["data_units_written"],
            "unsafe": h["unsafe_shutdowns"], "realloc": realloc,
        });
        out += &format!("{line}\n");
    }
    *cache = Some((Instant::now(), out.clone()));
    out
}

/* ---------- summary (dashboards) ---------- */

/// From `zpool list -H -p -o name,health,capacity,size,alloc`, problems and hwmon() lines.
fn summary_json(list: &str, problems: &BTreeMap<String, String>, hwmon: &str) -> Value {
    let mut pools = json!({});
    for l in list.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        let [name, health, cap, size, alloc] = f[..] else { continue };
        let n = |x: &str| x.parse::<u64>().unwrap_or(0);
        pools[name] = json!({"health": health, "capacity": n(cap), "size": n(size), "alloc": n(alloc)});
    }
    let temp = hwmon.lines().filter_map(|l| l.rsplit('|').next()?.parse::<i64>().ok()).max().map(|m| m / 1000);
    json!({"pools": pools, "problems": problems.len(), "messages": problems.values().collect::<Vec<_>>(), "temp_max_c": temp})
}

fn summary(cfg: &Config) -> Value {
    let cap = cfg.alerts.as_ref().map_or(85, |a| a.capacity_pct);
    let p = problems(cfg, cap).into_iter().map(|(k, m)| (k, tr(&cfg.lang, &m))).collect();
    summary_json(&cmd(&["zpool", "list", "-H", "-p", "-o", "name,health,capacity,size,alloc"]), &p, &hwmon())
}

/* ---------- translations ---------- */

/// Messages are written in English; FR maps each one (`{}` = any text, kept
/// and itself translated) to French. Specific templates before generic ones.
const FR: &[(&str, &str)] = &[
    ("Service {} failed", "Service {} en échec"),
    ("Pool {} is {} full (threshold {}%)", "Pool {} rempli à {} (seuil {} %)"),
    ("Pool {}: {}", "Pool {} : {}"),
    ("Pool {}: {}", "Pool {} : {}"),
    ("Disk {}: SMART self-test failed", "Disque {} : test SMART en échec"),
    ("Disk {}: {} = {}", "Disque {} : {} = {}"),
    ("Replication of {} is late: last snapshot {} h ago (threshold {} h)", "Réplication de {} en retard : dernier snapshot il y a {} h (seuil {} h)"),
    ("Replication of {}: no snapshot yet", "Réplication de {} : aucun snapshot pour l'instant"),
    ("NVMe critical warning", "avertissement critique NVMe"),
    ("media errors", "erreurs de lecture"),
    ("reallocated sectors", "secteurs réalloués"),
    ("resolved", "rétabli"),
    ("alert", "alerte"),
    ("Test message sent from the panel.", "Message de test envoyé depuis le panneau."),
    ("Samba is not installed: no password to set", "Samba n'est pas installé : pas de mot de passe à définir"),
    ("feature disabled on this server", "fonction désactivée sur ce serveur"),
    ("unknown share", "partage inconnu"),
    ("share name refused (letters, digits, - and _)", "nom de partage refusé (lettres, chiffres, - et _)"),
    ("path refused: ZFS dataset mount points only", "chemin refusé : point de montage d'un dataset ZFS uniquement"),
    ("this path is already exported by /etc/exports (managed outside the panel)", "ce chemin est déjà exporté par /etc/exports (géré hors du panneau)"),
    ("this path is already exported by another share", "ce chemin est déjà exporté par un autre partage"),
    ("client refused: {}", "client refusé : {}"),
    ("firewall opening not configured on this server", "ouverture du pare-feu non configurée sur ce serveur"),
    ("the firewall only accepts IP addresses or networks, not names", "le pare-feu n'accepte que des adresses IP ou des réseaux, pas des noms"),
    ("access refused: {} (account without a Samba password?)", "accès refusé : {} (compte sans mot de passe Samba ?)"),
    ("firewall: IP addresses or networks only (32 at most)", "pare-feu : adresses IP ou réseaux seulement (32 au plus)"),
    ("the folder belongs to root: choose who owns the files", "le dossier appartient à root : choisissez le propriétaire des fichiers"),
    ("owner refused: accounts with a Samba password only", "propriétaire refusé : compte avec mot de passe Samba uniquement"),
    ("user name refused or already taken (lowercase, digits, - and _)", "identifiant refusé ou déjà pris (minuscules, chiffres, - et _)"),
    ("password: 8 to 128 characters", "mot de passe : 8 à 128 caractères"),
    ("group refused", "groupe refusé"),
    ("account not managed by the panel", "compte non géré par le panneau"),
    ("group name refused or already taken", "nom de groupe refusé ou déjà pris"),
    ("unreadable state", "état illisible"),
    ("alerts not configured on this server", "alertes non configurées sur ce serveur"),
    ("group not managed by the panel", "groupe non géré par le panneau"),
    ("name refused or already taken (lowercase, digits, - and _)", "nom refusé ou déjà pris (minuscules, chiffres, - et _)"),
    ("address of the Mac: IP or network", "adresse du Mac : IP ou réseau"),
    ("dedicated dataset only, never the root of a pool", "dataset dédié uniquement, jamais la racine d'un pool"),
    ("dataset does not exist, and dataset creation is disabled on this server", "dataset inexistant, et la création de datasets est désactivée sur ce serveur"),
    ("dataset refused (existing parent + simple name)", "dataset refusé (parent existant + nom simple)"),
    ("this dataset is already shared over SMB", "ce dataset est déjà partagé en SMB"),
    ("pool name refused or already taken", "nom de pool refusé ou déjà pris"),
    ("unknown layout", "disposition inconnue"),
    ("unknown operation", "opération inconnue"),
    ("unknown pool", "pool inconnu"),
    ("value refused", "valeur refusée"),
    ("name refused", "nom refusé"),
    ("snapshot refused", "snapshot refusé"),
    ("unknown snapshot", "snapshot inconnu"),
    ("service not allowed", "service non autorisé"),
    ("unknown action", "action inconnue"),
    ("at least one client (32 at most)", "au moins un client (32 au plus)"),
    ("at least one user or group", "au moins un utilisateur ou un groupe"),
    ("encryption: desired or required", "chiffrement : desired ou required"),
    ("Time Machine size: e.g. 500G, 1T, or empty", "taille Time Machine : ex. 500G, 1T, ou vide"),
    ("remove it from the shares first: {}", "retirez-le d'abord des partages : {}"),
    ("size: e.g. 500G, 1T", "taille : ex. 500G, 1T"),
    ("confirmation: type the pool name again", "confirmation : retapez le nom du pool"),
    ("{}: at least {} free disk(s), each used once", "{} : au moins {} disque(s) libre(s), chacun une seule fois"),
    ("invalid request", "requête invalide"),
    ("too many attempts: try again in {} s", "trop d'essais : réessayez dans {} s"),
    ("wrong user name or password", "identifiant ou mot de passe incorrect"),
    ("access denied", "accès refusé"),
    ("invalid labels", "étiquettes invalides"),
    ("demo mode: nothing is changed", "mode démo : rien n'est modifié"),
    ("not found", "introuvable"),
];

/// The message in `lang` ("fr"; anything else = English as written).
fn tr(lang: &str, msg: &str) -> String {
    if lang != "fr" {
        return msg.to_string();
    }
    FR.iter().find_map(|(en, fr)| fill(en, msg).map(|caps| {
        let mut out = String::new();
        for (i, part) in fr.split("{}").enumerate() {
            if i > 0 {
                out += &caps.get(i - 1).map_or(String::new(), |c| tr(lang, c));
            }
            out += part;
        }
        out
    })).unwrap_or_else(|| msg.to_string())
}

/// The texts matching the `{}` of `template` in `msg`, or None when it does not match.
fn fill<'a>(template: &str, msg: &'a str) -> Option<Vec<&'a str>> {
    let parts: Vec<&str> = template.split("{}").collect();
    let mut rest = msg.strip_prefix(parts[0])?;
    let mut caps = vec![];
    for (i, part) in parts.iter().enumerate().skip(1) {
        let at = if i == parts.len() - 1 {
            rest.strip_suffix(part).map(|r| r.len())?
        } else {
            rest.find(part).filter(|_| !part.is_empty())?
        };
        caps.push(&rest[..at]);
        rest = &rest[at + part.len()..];
    }
    rest.is_empty().then_some(caps)
}

/// The page's language (Accept-Language sent by panel.js), else the server's.
fn lang_of<'a>(cfg: &'a Config, r: &Request) -> &'a str {
    let h = header(r, "Accept-Language");
    if h.starts_with("fr") { "fr" } else if h.starts_with("en") { "en" } else { &cfg.lang }
}

/* ---------- alerts ---------- */

/// Current problems, key -> message. A key carries the count it reports, so a
/// growing error counter is a new key, notified again.
fn problems(cfg: &Config, capacity_pct: u64) -> BTreeMap<String, String> {
    let mut out = pool_problems(&cmd(&["zpool", "list", "-H", "-o", "name,health,capacity"]), &cmd(&["zpool", "status"]), capacity_pct);
    disk_problems(&mut out);
    if !cfg.replication.is_empty() {
        let rows = last_sends(&cmd(&["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,creation"]), &cfg.replication);
        replication_problems(&rows, now_s(), &mut out);
    }
    let mut argv = vec!["systemctl", "is-active"];
    argv.extend(cfg.services.iter().map(String::as_str));
    // "failed" only: a service stopped on purpose (inactive) is not a problem.
    for (svc, st) in cfg.services.iter().zip(cmd(&argv).lines()) {
        if st == "failed" {
            out.insert(format!("svc:{svc}"), format!("Service {svc} failed"));
        }
    }
    out
}

/// From `zpool list -H -o name,health,capacity` and `zpool status`.
fn pool_problems(list: &str, status: &str, capacity_pct: u64) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for l in list.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        let [name, health, cap] = f[..] else { continue };
        if health != "ONLINE" {
            out.insert(format!("pool:{name}:{health}"), format!("Pool {name}: {health}"));
        }
        if cap.trim_end_matches('%').parse::<u64>().is_ok_and(|c| c >= capacity_pct) {
            out.insert(format!("full:{name}"), format!("Pool {name} is {cap} full (threshold {capacity_pct}%)"));
        }
    }
    let mut pool = "";
    for l in status.lines().map(str::trim) {
        if let Some(p) = l.strip_prefix("pool: ") {
            pool = p;
        } else if let Some(e) = l.strip_prefix("errors: ") {
            if e != "No known data errors" {
                out.insert(format!("errors:{pool}:{e}"), format!("Pool {pool}: {e}"));
            }
        }
    }
    out
}

/// SMART: failed self-assessment, NVMe critical warning, error counters.
fn disk_problems(out: &mut BTreeMap<String, String>) {
    for l in health().lines() {
        let Ok(d) = serde_json::from_str::<Value>(l) else { continue };
        let dev = d["dev"].as_str().unwrap_or("?");
        let who = format!("{dev} ({} {})", d["model"].as_str().unwrap_or(""), d["serial"].as_str().unwrap_or(""));
        if d["passed"] == false {
            out.insert(format!("smart:{dev}"), format!("Disk {who}: SMART self-test failed"));
        }
        for (k, label) in [("critical", "NVMe critical warning"), ("media_errors", "media errors"), ("realloc", "reallocated sectors")] {
            if let Some(n) = d[k].as_u64().filter(|n| *n > 0) {
                out.insert(format!("{k}:{dev}:{n}"), format!("Disk {who}: {label} = {n}"));
            }
        }
    }
}

fn notify(cfg: &Config, a: &Alerts, title: &str, msg: &str, priority: &str, tags: &str) -> Result<(), String> {
    let host = cfg.public["title"].as_str().unwrap_or("cairn-nas");
    let (title, msg) = (tr(&cfg.lang, title), tr(&cfg.lang, msg));
    let (t, p, g) = (format!("title={host}: {title}"), format!("priority={priority}"), format!("tags={tags}"));
    let mut argv = vec!["curl", "-fsS", "-m", "15", "--url-query", &t, "--url-query", &p, "--url-query", &g, "--data-binary", "@-"];
    let hf = a.headers_file.as_ref().map(|f| format!("@{f}"));
    if let Some(h) = &hf {
        argv.extend(["-H", h.as_str()]);
    }
    argv.push(&a.url);
    run(&argv, Some(&msg))
}

/// Daily: empties what has been in the shares' recycle bins for more than recycle_days.
fn housekeeping(cfg: &'static Config) {
    loop {
        let state = load_manage(cfg);
        for s in state["smb"].as_object().into_iter().flatten().map(|(_, s)| s).filter(|s| s["recycle"] == true) {
            let bin = format!("{}/.recycle", s["path"].as_str().unwrap_or(""));
            if std::path::Path::new(&bin).is_dir() {
                let days = format!("+{}", cfg.recycle_days);
                let _ = run(&["find", &bin, "-mindepth", "1", "-type", "f", "-mtime", &days, "-delete"], None);
                let _ = run(&["find", &bin, "-mindepth", "1", "-type", "d", "-empty", "-delete"], None);
            }
        }
        std::thread::sleep(Duration::from_secs(86400));
    }
}

/// Background loop: notifies new problems, then their return to normal.
fn alert_loop(cfg: &'static Config) {
    let Some(a) = &cfg.alerts else { return };
    let mut sent: BTreeMap<String, String> = serde_json::from_str(&read(&cfg.alerts_file)).unwrap_or_default();
    loop {
        let now = problems(cfg, a.capacity_pct);
        for (k, m) in &now {
            if !sent.contains_key(k) && notify(cfg, a, "alert", m, "high", "warning").is_ok() {
                sent.insert(k.clone(), m.clone());
            }
        }
        for (k, m) in sent.clone() {
            if !now.contains_key(&k) && notify(cfg, a, "resolved", &m, "default", "white_check_mark").is_ok() {
                sent.remove(&k);
            }
        }
        let _ = write_atomic(&cfg.alerts_file, &json!(sent).to_string());
        std::thread::sleep(Duration::from_secs(a.interval_s));
    }
}

/* ---------- UI state (labels and colour tags edited from the page) ---------- */

static UI_WRITE: Mutex<()> = Mutex::new(());

fn short(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control))
}

/// {"labels": {key: text}, "tags": {id: {"name", "color": "#rrggbb"}}, "assign": {key: id}}
fn valid_ui(v: &Value) -> bool {
    let obj = |k: &str, max: usize| v[k].as_object().filter(|o| o.len() <= max);
    let (Some(labels), Some(tags), Some(assign)) = (obj("labels", 500), obj("tags", 50), obj("assign", 500)) else { return false };
    let key_ok = |k: &str| short(&json!(k), 120);
    let color_ok = |c: &Value| c.as_str().is_some_and(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()));
    v.as_object().is_some_and(|o| o.len() == 3)
        && labels.iter().all(|(k, l)| key_ok(k) && short(l, 64))
        && tags.iter().all(|(id, t)| key_ok(id) && short(&t["name"], 32) && color_ok(&t["color"]) && t.as_object().is_some_and(|o| o.len() == 2))
        && assign.iter().all(|(k, id)| key_ok(k) && id.as_str().is_some_and(|id| tags.contains_key(id)))
}

fn load_ui(path: &str) -> Value {
    serde_json::from_str(&read(path)).unwrap_or_else(|_| json!({"labels": {}, "tags": {}, "assign": {}}))
}

fn save_ui(path: &str, v: &Value) -> std::io::Result<()> {
    let _guard = UI_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, v.to_string())?;
    fs::rename(tmp, path)
}

/* ---------- shares, accounts and pools created from the page (opt-in `features`) ---------- */
// The panel only writes its own files (nfs_file, smb_file, manage_file) and only
// changes accounts it created (GECOS = MARK) or groups listed in its state: what
// the admin manages elsewhere (/etc/exports, Ansible, LDAP…) is never touched.

#[derive(Clone, Copy)]
struct Features {
    nfs: bool,
    smb: bool,
    users: bool,
    pools: bool,
}

static MANAGE: Mutex<()> = Mutex::new(());
const MARK: &str = "cairn-nas";
const SQUASH: [&str; 3] = ["root_squash", "no_root_squash", "all_squash"];
const LAYOUTS: [(&str, usize); 5] = [("stripe", 1), ("mirror", 2), ("raidz1", 3), ("raidz2", 4), ("raidz3", 5)];

fn is_account(s: &str) -> bool {
    let mut c = s.chars();
    s.len() <= 32
        && c.next().is_some_and(|f| f.is_ascii_lowercase() || f == '_')
        && c.all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == '_' || x == '-')
}

fn is_share(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !["global", "homes", "printers"].contains(&s.to_ascii_lowercase().as_str())
}

/// NFS client: IPv4, IPv4/prefix or host name.
fn is_host(s: &str) -> bool {
    let (ip, prefix) = s.split_once('/').map_or((s, None), |(a, b)| (a, Some(b)));
    if ip.parse::<std::net::Ipv4Addr>().is_ok() {
        return prefix.is_none_or(|p| p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u8>().is_ok_and(|n| n <= 32));
    }
    prefix.is_none()
        && s.len() <= 253
        && s.starts_with(|c: char| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn is_password(s: &str) -> bool {
    (8..=128).contains(&s.chars().count()) && !s.chars().any(char::is_control)
}

fn regular(id: u32) -> bool {
    (1000..60000).contains(&id)
}

/// (name, uid, gid, gecos) for every account.
fn passwd() -> Vec<(String, u32, u32, String)> {
    read("/etc/passwd")
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            Some((f[0].to_string(), f.get(2)?.parse().ok()?, f.get(3)?.parse().ok()?, f.get(4)?.to_string()))
        })
        .collect()
}

/// (name, gid, supplementary members) for every group.
fn groups() -> Vec<(String, u32, Vec<String>)> {
    read("/etc/group")
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            let members = f.get(3)?.split(',').filter(|m| !m.is_empty()).map(String::from).collect();
            Some((f[0].to_string(), f.get(2)?.parse().ok()?, members))
        })
        .collect()
}

fn mountpoints() -> Vec<String> {
    cmd(&["zfs", "list", "-H", "-o", "mountpoint"]).lines().filter(|l| l.starts_with('/')).map(String::from).collect()
}

/// Paths exported by the admin's own /etc/exports: the panel never exports them too.
fn admin_exports() -> Vec<String> {
    read("/etc/exports").lines().filter(|l| l.starts_with('/')).filter_map(|l| l.split_whitespace().next()).map(String::from).collect()
}

/// Whole disks with no partition, holder or signature: the only ones offered to zpool create.
fn free_disks() -> Vec<Value> {
    let ids: Vec<(String, String)> =
        by_id().lines().filter_map(|l| l.split_once('|')).map(|(a, b)| (a.to_string(), b.to_string())).collect();
    disks()
        .into_iter()
        .filter(|d| {
            let sys = format!("/sys/block/{d}");
            let parts = fs::read_dir(&sys).map(|r| r.flatten().any(|e| e.file_name().to_string_lossy().starts_with(d.as_str()))).unwrap_or(true);
            let holders = fs::read_dir(format!("{sys}/holders")).map(|mut r| r.next().is_some()).unwrap_or(true);
            let signature = !cmd(&["blkid", "-p", "-o", "export", &format!("/dev/{d}")]).trim().is_empty();
            !parts && !holders && !signature
        })
        .filter_map(|d| {
            let id = ids.iter().filter(|(n, t)| t == &d && !n.contains("-part") && !n.starts_with("nvme-eui")).map(|(n, _)| n.clone()).min()?;
            let size = read(&format!("/sys/block/{d}/size")).trim().parse::<u64>().unwrap_or(0) * 512;
            Some(json!({"dev": d, "id": id, "size": size, "model": read(&format!("/sys/block/{d}/device/model")).trim()}))
        })
        .collect()
}

fn load_manage(cfg: &Config) -> Value {
    let mut v: Value = serde_json::from_str(&read(&cfg.manage_file)).unwrap_or(Value::Null);
    if !v.is_object() {
        v = json!({});
    }
    for (k, d) in [("nfs", json!({})), ("smb", json!({})), ("groups", json!([]))] {
        if v.get(k).is_none() {
            v[k] = d;
        }
    }
    v
}

fn render_nfs(state: &Value) -> String {
    let mut out = String::from("# Managed by cairn-nas (shares created from the page), do not edit by hand.\n");
    for (name, s) in state["nfs"].as_object().into_iter().flatten() {
        let clients: Vec<String> = s["clients"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let rw = if c["rw"] == true { "rw" } else { "ro" };
                format!("{}({rw},sync,no_subtree_check,{})", c["host"].as_str().unwrap_or(""), c["squash"].as_str().unwrap_or("root_squash"))
            })
            .collect();
        out += &format!("# {name}\n{} {}\n", s["path"].as_str().unwrap_or(""), clients.join(" "));
    }
    out
}

fn principal(k: &str) -> String {
    match k.split_once(':') {
        Some(("g", g)) => format!("@{g}"),
        Some((_, u)) => u.to_string(),
        None => k.to_string(),
    }
}

/// Samba writes as the owner of the shared directory (force user/group), so new
/// files match the existing ones; who may read or write is Samba's lists.
/// Never as root: a root-owned directory gets no force line (share_save
/// refuses it unless an owner is chosen, which chowns the directory).
const SHADOW: &str = r"   shadow:snapdir = .zfs/snapshot
   shadow:sort = desc
   shadow:format = -%Y-%m-%d-%H%M
   shadow:snapprefix = ^zfs-auto-snap_\(frequent\)\{0,1\}\(hourly\)\{0,1\}\(daily\)\{0,1\}\(weekly\)\{0,1\}\(monthly\)\{0,1\}
   shadow:delimiter = -20
";
// Deleted files go to <share>/.recycle/<user>, purged after recycle_days (housekeeping).
const RECYCLE: &str = "   recycle:repository = .recycle/%U
   recycle:keeptree = yes
   recycle:versions = yes
   recycle:touch = yes
   recycle:directory_mode = 0770
   recycle:exclude = *.tmp,~$*,.DS_Store
";

fn render_smb(state: &Value, owner: impl Fn(&str) -> (String, String)) -> String {
    let mut out = String::from("# Managed by cairn-nas (shares created from the page), do not edit by hand.\n");
    for (name, s) in state["smb"].as_object().into_iter().flatten() {
        let path = s["path"].as_str().unwrap_or("");
        let access: Vec<(&String, &Value)> = s["access"].as_object().into_iter().flatten().collect();
        let list = |rw_only: bool| access.iter().filter(|(_, m)| !rw_only || m.as_str() == Some("rw")).map(|(k, _)| principal(k)).collect::<Vec<_>>().join(" ");
        let (u, g) = owner(path);
        let mut force = String::new();
        if u != "root" {
            force += &format!("   force user = {u}\n");
        }
        if g != "root" {
            force += &format!("   force group = {g}\n");
        }
        let encrypt = if s["encrypt"] == "required" { "required" } else { "desired" };
        // Time Machine destination (vfs_fruit, loaded globally with streams_xattr).
        let mut tm = String::new();
        if s["timemachine"] == true {
            tm += "   fruit:time machine = yes\n";
            if let Some(max) = s["tm_max"].as_str().filter(|m| !m.is_empty()) {
                tm += &format!("   fruit:time machine max size = {max}\n");
            }
        }
        // Windows "Previous Versions" from the dataset's zfs-auto-snapshot
        // snapshots (names in UTC, e.g. zfs-auto-snap_hourly-2026-11-03-1617).
        // A share's vfs objects replace the global list: fruit and streams_xattr are repeated.
        let (versions, recycle) = (s["versions"] == true, s["recycle"] == true);
        let mut vfs = String::new();
        if versions || recycle {
            let mods = [(versions, "shadow_copy2"), (recycle, "recycle"), (true, "fruit streams_xattr")];
            vfs = format!("   vfs objects = {}\n", mods.iter().filter(|m| m.0).map(|m| m.1).collect::<Vec<_>>().join(" "));
            vfs += if versions { SHADOW } else { "" };
            vfs += if recycle { RECYCLE } else { "" };
        }
        out += &format!(
            "\n[{name}]\n   path = {path}\n   browseable = yes\n   guest ok = no\n   read only = yes\n   server smb encrypt = {encrypt}\n   valid users = {}\n   write list = {}\n{force}{tm}{vfs}   create mask = 0664\n   directory mask = 2775\n",
            list(false),
            list(true)
        );
    }
    out
}

fn owner_of(path: &str) -> (String, String) {
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = fs::metadata(path) else { return ("root".into(), "root".into()) };
    let u = passwd().into_iter().find(|p| p.1 == m.uid()).map_or_else(|| "root".into(), |p| p.0);
    let g = groups().into_iter().find(|g| g.1 == m.gid()).map_or_else(|| "root".into(), |g| g.0);
    (u, g)
}

fn run(argv: &[&str], stdin: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new(argv[0])
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", argv[0]))?;
    if let Some(mut pipe) = child.stdin.take() {
        if let Some(input) = stdin {
            let _ = pipe.write_all(input.as_bytes());
        }
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if o.status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(if o.stderr.is_empty() { &o.stdout } else { &o.stderr }).trim().to_string();
    Err(format!("{} : {msg}", argv[0]))
}

fn write_atomic(path: &str, text: &str) -> Result<(), String> {
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, text).and_then(|()| fs::rename(&tmp, path)).map_err(|e| format!("{path}: {e}"))
}

/// Addresses a share asked to let through the firewall: NFS = its clients when
/// open_fw, SMB = its "fw" list. Loaded by the admin's nftables config
/// (include) at boot, and live by apply().
fn render_fw(state: &Value, table: &str) -> String {
    let mut out = String::from("# Managed by cairn-nas: addresses opened by the shares created from the page.\n");
    let collect = |kind: &str| -> Vec<String> {
        let mut v: Vec<String> = state[kind]
            .as_object()
            .into_iter()
            .flatten()
            .flat_map(|(_, s)| match kind {
                "nfs" if s["open_fw"] == true => s["clients"].as_array().into_iter().flatten().filter_map(|c| c["host"].as_str().map(String::from)).collect(),
                "smb" => strings(s, "fw"),
                _ => vec![],
            })
            .collect();
        v.sort();
        v.dedup();
        v
    };
    for kind in ["nfs", "smb"] {
        let addrs = collect(kind);
        if !addrs.is_empty() {
            out += &format!("add element {table} cairn_{kind} {{ {} }}\n", addrs.join(", "));
        }
    }
    out
}

fn is_ip_or_net(s: &str) -> bool {
    is_host(s) && s.split('/').next().is_some_and(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
}

/// Renders the panel's exports/Samba/firewall files, reloads, then saves the
/// state; a file whose reload fails is put back as it was.
// ponytail: a failure in a later step leaves the earlier ones applied; the
// state is not saved, so the next successful change re-renders everything.
fn apply(cfg: &Config, state: &Value) -> Result<(), String> {
    type Reload<'a> = Box<dyn Fn(&str) -> Result<(), String> + 'a>;
    let mut steps: Vec<(&str, String, Reload)> = vec![];
    if cfg.features.nfs {
        steps.push((cfg.nfs_file.as_str(), render_nfs(state), Box::new(|_: &str| run(&["exportfs", "-r", "-a"], None))));
    }
    if cfg.features.smb {
        steps.push((cfg.smb_file.as_str(), render_smb(state, owner_of), Box::new(|_: &str| run(&["smbcontrol", "smbd", "reload-config"], None))));
    }
    if let Some(t) = &cfg.firewall_table {
        // One nft transaction: empty both sets, then add what the file lists.
        let reload = move |content: &str| run(&["nft", "-f", "-"], Some(&format!("flush set {t} cairn_nfs\nflush set {t} cairn_smb\n{content}")));
        steps.push((cfg.fw_file.as_str(), render_fw(state, t), Box::new(reload)));
    }
    for (file, content, reload) in &steps {
        let old = fs::read_to_string(file).ok();
        if old.as_deref() == Some(content.as_str()) {
            continue;
        }
        if let Some(dir) = std::path::Path::new(file).parent() {
            let _ = fs::create_dir_all(dir);
        }
        write_atomic(file, content)?;
        if let Err(e) = reload(content) {
            let _ = match &old {
                Some(o) => fs::write(file, o),
                None => fs::remove_file(file),
            };
            let _ = reload(old.as_deref().unwrap_or(""));
            return Err(e);
        }
    }
    write_atomic(&cfg.manage_file, &state.to_string())
}

fn set_smb_password(name: &str, pass: &str) -> Result<(), String> {
    if !std::path::Path::new("/usr/bin/smbpasswd").exists() {
        return Err("Samba is not installed: no password to set".into());
    }
    run(&["smbpasswd", "-a", "-s", name], Some(&format!("{pass}\n{pass}\n")))
}

/// Shares still granting access to `key` ("u:name" / "g:name").
fn shares_using(state: &Value, key: &str) -> Vec<String> {
    state["smb"].as_object().into_iter().flatten().filter(|(_, s)| s["access"].get(key).is_some()).map(|(n, _)| n.clone()).collect()
}

/// Accounts that have a Samba password (only those can log in to a share).
fn samba_users() -> Vec<String> {
    cmd(&["pdbedit", "-L"]).lines().filter_map(|l| l.split_once(':').map(|(n, _)| n.to_string())).collect()
}

/// What the page needs to draw the shares, accounts and pool forms.
fn manage_view(cfg: &Config, lang: &str) -> Value {
    let state = load_manage(cfg);
    let owned_groups = strings(&state, "groups");
    let gr = groups();
    let sm = if cfg.features.smb { samba_users() } else { vec![] };
    let users: Vec<Value> = passwd()
        .into_iter()
        .filter(|p| regular(p.1))
        .map(|(name, uid, _, gecos)| {
            let member: Vec<&String> = gr.iter().filter(|g| g.2.contains(&name)).map(|g| &g.0).collect();
            json!({"name": name, "uid": uid, "owned": gecos == MARK, "groups": member, "samba": sm.contains(&name)})
        })
        .collect();
    let groups: Vec<Value> = gr
        .iter()
        .filter(|g| regular(g.1))
        .map(|(name, gid, members)| json!({"name": name, "gid": gid, "owned": owned_groups.contains(name), "members": members}))
        .collect();
    json!({
        "state": state, "users": users, "groups": groups, "mountpoints": mountpoints(), "admin_exports": admin_exports(),
        "free_disks": if cfg.features.pools { json!(free_disks()) } else { json!([]) },
        "alerts": cfg.alerts.as_ref().map(|a| json!({
            // Host only: the URL may carry a topic name, the headers a token.
            "target": a.url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(""),
            "capacity_pct": a.capacity_pct,
            "problems": problems(cfg, a.capacity_pct).values().map(|m| tr(lang, m)).collect::<Vec<_>>(),
        })),
        "sessions": smb_sessions(),
        "journal": journal(),
        "updates": updates(),
        "bonjour": if std::path::Path::new("/usr/sbin/avahi-daemon").exists() { cmd(&["systemctl", "is-active", "avahi-daemon"]).trim().to_string() } else { "absent".into() },
    })
}

/// Open SMB sessions with the shares they use (smbstatus -j).
fn smb_sessions() -> Vec<Value> {
    if !std::path::Path::new("/usr/bin/smbstatus").exists() {
        return vec![];
    }
    let v: Value = serde_json::from_str(&cmd(&["smbstatus", "-j"])).unwrap_or_default();
    let shares = |sid: &Value| -> Vec<Value> {
        let mut s: Vec<Value> = v["tcons"].as_object().into_iter().flatten().filter(|(_, t)| &t["session_id"] == sid).map(|(_, t)| t["service"].clone()).collect();
        s.dedup();
        s
    };
    v["sessions"].as_object().into_iter().flatten().map(|(_, s)| json!({
        "user": s["username"], "machine": s["remote_machine"], "dialect": s["session_dialect"], "since": s["creation_time"],
        "encryption": s["encryption"]["cipher"], "shares": shares(&s["session_id"]),
    })).collect()
}

/// Last writes made from the page (the "manage" and "action" log lines of this service).
fn journal() -> Vec<String> {
    let out = cmd(&["journalctl", "-u", "cairn-nas", "-n", "2000", "-o", "short-iso", "--no-pager"]);
    let mut lines: Vec<String> = out.lines().filter_map(|l| {
        let (head, msg) = l.split_once("]: ")?;
        (msg.starts_with("manage user=") || msg.starts_with("action user=")).then(|| format!("{} {msg}", head.split(' ').next().unwrap_or("")))
    }).collect();
    lines.reverse();
    lines.truncate(50);
    lines
}

static UPDATES: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

/// Pending package updates (apt's own daily refresh keeps the lists current), cached 10 min.
fn updates() -> Value {
    let mut c = UPDATES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, v)) = c.as_ref().filter(|(t, _)| t.elapsed().as_secs() < 600) {
        return v.clone();
    }
    let (pkgs, held) = upgradable(&cmd(&["apt", "list", "--upgradable"]), &cmd(&["apt-mark", "showhold"]));
    let v = json!({"packages": pkgs, "held": held, "reboot": std::path::Path::new("/run/reboot-required").exists()});
    *c = Some((Instant::now(), v.clone()));
    v
}

/// From `apt list --upgradable` and `apt-mark showhold`: (to upgrade, held back).
fn upgradable(list: &str, holds: &str) -> (Vec<String>, Vec<String>) {
    let held: Vec<&str> = holds.lines().map(str::trim).collect();
    list.lines().filter(|l| l.contains('/')).filter_map(|l| l.split('/').next()).map(String::from).partition(|p| !held.contains(&p.as_str()))
}

/// One write operation from the page; returns what to log (never a password).
fn manage(cfg: &Config, a: &Value) -> Result<String, String> {
    let _guard = MANAGE.lock().unwrap_or_else(|e| e.into_inner());
    manage_op(cfg, a)
}

/// Unlocked body of manage(): the Time Machine wizard chains other operations.
fn manage_op(cfg: &Config, a: &Value) -> Result<String, String> {
    let f = cfg.features;
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let need = |on: bool| if on { Ok(()) } else { Err("feature disabled on this server".to_string()) };
    let mut state = load_manage(cfg);
    let owned_groups = strings(&state, "groups");
    let pw = passwd();
    let gr = groups();
    let owned_user = |n: &str| pw.iter().any(|p| p.0 == n && regular(p.1) && p.3 == MARK);
    let (op, name) = (s("op"), s("name"));
    match op.as_str() {
        "share_save" | "share_delete" => {
            let kind = s("kind");
            need(match kind.as_str() { "nfs" => f.nfs, "smb" => f.smb, _ => false })?;
            if op == "share_delete" {
                if state[kind.as_str()].as_object_mut().and_then(|m| m.remove(&name)).is_none() {
                    return Err("unknown share".into());
                }
                apply(cfg, &state)?;
                return Ok(format!("op=share_delete kind={kind} name={name}"));
            }
            let path = s("path");
            if !is_share(&name) {
                return Err("share name refused (letters, digits, - and _)".into());
            }
            if !mountpoints().contains(&path) {
                return Err("path refused: ZFS dataset mount points only".into());
            }
            let share = if kind == "nfs" {
                if admin_exports().contains(&path) {
                    return Err("this path is already exported by /etc/exports (managed outside the panel)".into());
                }
                if state["nfs"].as_object().into_iter().flatten().any(|(n, x)| n != &name && x["path"] == path.as_str()) {
                    return Err("this path is already exported by another share".into());
                }
                let clients = a["clients"].as_array().filter(|c| !c.is_empty() && c.len() <= 32).ok_or("at least one client (32 at most)")?;
                let mut out = vec![];
                for c in clients {
                    let (host, squash) = (c["host"].as_str().unwrap_or(""), c["squash"].as_str().unwrap_or(""));
                    if !is_host(host) || !SQUASH.contains(&squash) || !c["rw"].is_boolean() {
                        return Err(format!("client refused: {host}"));
                    }
                    out.push(json!({"host": host, "rw": c["rw"], "squash": squash}));
                }
                let open_fw = a["open_fw"] == true;
                if open_fw && cfg.firewall_table.is_none() {
                    return Err("firewall opening not configured on this server".into());
                }
                if open_fw && !out.iter().all(|c| c["host"].as_str().is_some_and(is_ip_or_net)) {
                    return Err("the firewall only accepts IP addresses or networks, not names".into());
                }
                json!({"path": path, "clients": out, "open_fw": open_fw})
            } else {
                let access = a["access"].as_object().filter(|m| !m.is_empty() && m.len() <= 64).ok_or("at least one user or group")?;
                let sm = samba_users();
                let samba_user = |u: &str| sm.iter().any(|x| x == u) && pw.iter().any(|p| p.0 == u && regular(p.1));
                for (k, m) in access {
                    let known = match k.split_once(':') {
                        Some(("u", u)) => samba_user(u),
                        Some(("g", g)) => gr.iter().any(|x| x.0 == g && regular(x.1)),
                        _ => false,
                    };
                    if !known || !matches!(m.as_str(), Some("ro" | "rw")) {
                        return Err(format!("access refused: {} (account without a Samba password?)", &k[k.find(':').map_or(0, |i| i + 1)..]));
                    }
                }
                let fw = strings(a, "fw");
                if !fw.is_empty() && cfg.firewall_table.is_none() {
                    return Err("firewall opening not configured on this server".into());
                }
                if fw.len() > 32 || !fw.iter().all(|h| is_ip_or_net(h)) {
                    return Err("firewall: IP addresses or networks only (32 at most)".into());
                }
                let encrypt = match s("encrypt").as_str() {
                    "" | "desired" => "desired",
                    "required" => "required",
                    _ => return Err("encryption: desired or required".into()),
                };
                let timemachine = a["timemachine"] == true;
                let tm_max = s("tm_max");
                if !tm_max.is_empty() && (!is_quota(&tm_max) || tm_max == "none") {
                    return Err("Time Machine size: e.g. 500G, 1T, or empty".into());
                }
                let owner = s("owner");
                if owner.is_empty() {
                    if owner_of(&path).0 == "root" {
                        return Err("the folder belongs to root: choose who owns the files".into());
                    }
                } else {
                    if !samba_user(&owner) {
                        return Err("owner refused: accounts with a Samba password only".into());
                    }
                    // The shared directory only, never its content.
                    run(&["chown", &format!("{owner}:"), &path], None)?;
                }
                json!({"path": path, "access": access, "fw": fw, "owner": owner, "encrypt": encrypt, "timemachine": timemachine, "tm_max": if timemachine { tm_max } else { String::new() }, "versions": a["versions"] == true, "recycle": a["recycle"] == true})
            };
            state[kind.as_str()][name.as_str()] = share;
            apply(cfg, &state)?;
            Ok(format!("op=share_save kind={kind} name={name} path={path}"))
        }
        "user_create" => {
            need(f.users)?;
            let (pass, wanted) = (s("password"), strings(a, "groups"));
            if !is_account(&name) || pw.iter().any(|p| p.0 == name) || gr.iter().any(|g| g.0 == name) {
                return Err("user name refused or already taken (lowercase, digits, - and _)".into());
            }
            if !is_password(&s("password")) {
                return Err("password: 8 to 128 characters".into());
            }
            if !wanted.iter().all(|g| owned_groups.contains(g)) {
                return Err("group refused".into());
            }
            let list = wanted.join(",");
            let mut argv = vec!["useradd", "-M", "-s", "/usr/sbin/nologin", "-c", MARK];
            if !list.is_empty() {
                argv.extend(["-G", list.as_str()]);
            }
            argv.push(&name);
            run(&argv, None)?;
            if f.smb {
                if let Err(e) = set_smb_password(&name, &pass) {
                    let _ = run(&["userdel", &name], None);
                    return Err(e);
                }
            }
            Ok(format!("op=user_create name={name} groups={list}"))
        }
        "user_password" | "user_groups" | "user_delete" => {
            need(f.users)?;
            if !owned_user(&name) {
                return Err("account not managed by the panel".into());
            }
            match op.as_str() {
                "user_password" => {
                    if !is_password(&s("password")) {
                        return Err("password: 8 to 128 characters".into());
                    }
                    set_smb_password(&name, &s("password"))?;
                    Ok(format!("op=user_password name={name}"))
                }
                "user_groups" => {
                    let wanted = strings(a, "groups");
                    if !wanted.iter().all(|g| owned_groups.contains(g)) {
                        return Err("group refused".into());
                    }
                    run(&["usermod", "-G", &wanted.join(","), &name], None)?;
                    Ok(format!("op=user_groups name={name} groups={}", wanted.join(",")))
                }
                _ => {
                    let used = shares_using(&state, &format!("u:{name}"));
                    if !used.is_empty() {
                        return Err(format!("remove it from the shares first: {}", used.join(", ")));
                    }
                    if f.smb {
                        let _ = run(&["smbpasswd", "-x", &name], None);
                    }
                    run(&["userdel", &name], None)?;
                    Ok(format!("op=user_delete name={name}"))
                }
            }
        }
        "group_create" => {
            need(f.users)?;
            if !is_account(&name) || pw.iter().any(|p| p.0 == name) || gr.iter().any(|g| g.0 == name) {
                return Err("group name refused or already taken".into());
            }
            run(&["groupadd", &name], None)?;
            state["groups"].as_array_mut().ok_or("unreadable state")?.push(json!(name));
            apply(cfg, &state)?;
            Ok(format!("op=group_create name={name}"))
        }
        "group_delete" => {
            need(f.users)?;
            if !owned_groups.contains(&name) {
                return Err("group not managed by the panel".into());
            }
            let used = shares_using(&state, &format!("g:{name}"));
            if !used.is_empty() {
                return Err(format!("remove it from the shares first: {}", used.join(", ")));
            }
            run(&["groupdel", &name], None)?;
            state["groups"].as_array_mut().ok_or("unreadable state")?.retain(|g| g.as_str() != Some(name.as_str()));
            apply(cfg, &state)?;
            Ok(format!("op=group_delete name={name}"))
        }
        "updates_apply" => {
            // Held packages (apt-mark hold) stay as they are; existing config files are kept.
            let pkgs = updates()["packages"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default();
            run(&["apt-get", "update", "-q"], None)?;
            let res = run(&["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-y", "-q", "-o", "Dpkg::Options::=--force-confdef",
                "-o", "Dpkg::Options::=--force-confold", "upgrade", "--with-new-pkgs"], None);
            *UPDATES.lock().unwrap_or_else(|e| e.into_inner()) = None;
            res?;
            Ok(format!("op=updates_apply packages={pkgs}"))
        }
        "alert_test" => {
            let a = cfg.alerts.as_ref().ok_or("alerts not configured on this server")?;
            notify(cfg, a, "test", "Test message sent from the panel.", "default", "bell")?;
            Ok("op=alert_test".into())
        }
        "bonjour" => {
            // mDNS announcement of the server and its Time Machine shares (avahi).
            need(f.smb)?;
            let on = a["on"] == true;
            run(&["systemctl", if on { "enable" } else { "disable" }, "--now", "avahi-daemon.socket", "avahi-daemon.service"], None)?;
            Ok(format!("op=bonjour on={on}"))
        }
        "timemachine_create" => {
            // Wizard: dataset (existing, or created when pools are on) + account + Time Machine share.
            need(f.smb && f.users)?;
            let (ds, size, ip) = (s("dataset"), s("size"), s("ip"));
            if !is_account(&name) || pw.iter().any(|p| p.0 == name) || gr.iter().any(|g| g.0 == name) || state["smb"].get(&name).is_some() {
                return Err("name refused or already taken (lowercase, digits, - and _)".into());
            }
            if !is_quota(&size) || size == "none" {
                return Err("size: e.g. 500G, 1T".into());
            }
            if !ip.is_empty() && !is_ip_or_net(&ip) {
                return Err("address of the Mac: IP or network".into());
            }
            if !is_password(&s("password")) {
                return Err("password: 8 to 128 characters".into());
            }
            let existing: Vec<String> = cmd(&["zfs", "list", "-H", "-o", "name"]).lines().map(String::from).collect();
            let created = !existing.contains(&ds);
            if !ds.contains('/') {
                return Err("dedicated dataset only, never the root of a pool".into());
            }
            if created {
                if !f.pools {
                    return Err("dataset does not exist, and dataset creation is disabled on this server".into());
                }
                let ok = ds.rsplit_once('/').is_some_and(|(parent, leaf)| existing.contains(&parent.to_string()) && is_name(leaf));
                if !ok {
                    return Err("dataset refused (existing parent + simple name)".into());
                }
                run(&["zfs", "create", "-o", &format!("quota={size}"), "-o", "recordsize=1M", "-o", "com.sun:auto-snapshot=false", &ds], None)?;
            }
            let path = cmd(&["zfs", "get", "-H", "-o", "value", "mountpoint", &ds]).trim().to_string();
            if state["smb"].as_object().into_iter().flatten().any(|(_, x)| x["path"] == path.as_str()) {
                return Err("this dataset is already shared over SMB".into());
            }
            manage_op(cfg, &json!({"op": "user_create", "name": name, "password": s("password")}))?;
            let share = json!({"op": "share_save", "kind": "smb", "name": name, "path": path, "access": {format!("u:{name}"): "rw"},
                "fw": if ip.is_empty() { vec![] } else { vec![ip.clone()] }, "owner": name, "encrypt": "required", "timemachine": true, "tm_max": size});
            if let Err(e) = manage_op(cfg, &share) {
                let _ = manage_op(cfg, &json!({"op": "user_delete", "name": name}));
                return Err(e);
            }
            Ok(format!("op=timemachine_create name={name} dataset={ds} created={created} ip={ip}"))
        }
        "dataset_create" => {
            need(f.pools)?;
            let (ds, comp) = (s("dataset"), s("compression"));
            let existing: Vec<String> = cmd(&["zfs", "list", "-H", "-o", "name"]).lines().map(String::from).collect();
            let ok = ds.rsplit_once('/').is_some_and(|(parent, leaf)| existing.contains(&parent.to_string()) && is_name(leaf));
            if !ok || existing.contains(&ds) || !COMPRESSION.contains(&comp.as_str()) {
                return Err("dataset refused (existing parent + simple name)".into());
            }
            run(&["zfs", "create", "-o", &format!("compression={comp}"), &ds], None)?;
            Ok(format!("op=dataset_create dataset={ds} compression={comp}"))
        }
        "pool_create" => {
            need(f.pools)?;
            let (layout, wanted) = (s("layout"), strings(a, "disks"));
            let reserved = ["mirror", "raidz", "draid", "spare", "log", "cache", "special", "dedup"];
            if !is_name(&name) || !name.starts_with(|c: char| c.is_ascii_alphabetic()) || reserved.iter().any(|r| name.starts_with(r)) || pools().contains(&name) {
                return Err("pool name refused or already taken".into());
            }
            if s("confirm") != name {
                return Err("confirmation: type the pool name again".into());
            }
            let Some((_, min)) = LAYOUTS.iter().find(|(l, _)| *l == layout) else { return Err("unknown layout".into()) };
            let free: Vec<String> = free_disks().iter().filter_map(|d| d["id"].as_str().map(String::from)).collect();
            let mut unique = wanted.clone();
            unique.sort();
            unique.dedup();
            if wanted.len() < *min || unique.len() != wanted.len() || !wanted.iter().all(|d| free.contains(d)) {
                return Err(format!("{layout}: at least {min} free disk(s), each used once"));
            }
            let devs: Vec<String> = wanted.iter().map(|d| format!("/dev/disk/by-id/{d}")).collect();
            let mut argv = vec!["zpool", "create", "-o", "ashift=12", "-O", "compression=lz4", "-O", "atime=off", "-O", "xattr=sa", name.as_str()];
            if layout != "stripe" {
                argv.push(&layout);
            }
            argv.extend(devs.iter().map(String::as_str));
            run(&argv, None)?;
            Ok(format!("op=pool_create name={name} layout={layout} disks={}", wanted.join(",")))
        }
        _ => Err("unknown operation".into()),
    }
}


/* ---------- actions ---------- */

fn is_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c)) && s != "." && s != ".."
}

fn is_dataset(pools: &[String], s: &str) -> bool {
    pools.iter().any(|pool| match s.strip_prefix(pool.as_str()) {
        Some("") => true,
        Some(rest) => rest.strip_prefix('/').is_some_and(|r| r.split('/').all(is_name)),
        None => false,
    })
}

fn pools() -> Vec<String> {
    cmd(&["zpool", "list", "-H", "-o", "name"]).lines().map(String::from).collect()
}

fn is_quota(s: &str) -> bool {
    if s == "none" {
        return true;
    }
    let num = s.strip_suffix(|c: char| "KMGTPkmgtp".contains(c)).unwrap_or(s);
    let mut parts = num.splitn(2, '.');
    let int_ok = parts.next().is_some_and(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_digit()));
    int_ok && parts.next().is_none_or(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()))
}

/// Validated argv for an action. `pools` are the imported pools, `snapshots` the existing snapshot names.
fn build_argv(pools: &[String], services: &[String], a: &Value, snapshots: impl Fn() -> Vec<String>) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let v = |x: &[&str]| -> Result<Vec<String>, String> { Ok(x.iter().map(|s| s.to_string()).collect()) };
    match s("action").as_str() {
        "scrub_start" | "scrub_stop" => {
            let pool = s("pool");
            if !pools.contains(&pool) {
                return Err("unknown pool".into());
            }
            if s("action") == "scrub_start" { v(&["zpool", "scrub", &pool]) } else { v(&["zpool", "scrub", "-s", &pool]) }
        }
        "dataset_set" => {
            let (ds, comp, quota, auto) = (s("dataset"), s("compression"), s("quota"), s("autosnap"));
            if !is_dataset(pools, &ds) || !COMPRESSION.contains(&comp.as_str()) || !is_quota(&quota) || !["", "true", "false"].contains(&auto.as_str()) {
                return Err("value refused".into());
            }
            let mut argv = v(&["zfs", "set", &format!("compression={comp}"), &format!("quota={quota}")])?;
            // zfs-auto-snapshot's per-dataset switch (inherited by children).
            if !auto.is_empty() {
                argv.push(format!("com.sun:auto-snapshot={auto}"));
            }
            argv.push(ds);
            Ok(argv)
        }
        "snapshot_create" => {
            let (ds, name) = (s("dataset"), s("name"));
            if !is_dataset(pools, &ds) || !is_name(&name) {
                return Err("name refused".into());
            }
            let snap = format!("{ds}@{name}");
            if a["recursive"].as_bool() == Some(true) { v(&["zfs", "snapshot", "-r", &snap]) } else { v(&["zfs", "snapshot", &snap]) }
        }
        "snapshot_destroy" => {
            // Only an existing snapshot: "@" is mandatory, never a dataset or the pool.
            let snap = s("snapshot");
            let ok = snap.split_once('@').is_some_and(|(ds, name)| is_dataset(pools, ds) && is_name(name));
            if !ok {
                return Err("snapshot refused".into());
            }
            if !snapshots().contains(&snap) {
                return Err("unknown snapshot".into());
            }
            v(&["zfs", "destroy", &snap])
        }
        "service_restart" => {
            let svc = s("service");
            if !services.contains(&svc) {
                return Err("service not allowed".into());
            }
            v(&["systemctl", "restart", &svc])
        }
        _ => Err("unknown action".into()),
    }
}

/* ---------- HTTP ---------- */

fn header(r: &Request, name: &str) -> String {
    r.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().trim().to_string()).unwrap_or_default()
}

/* ---------- built-in sign-in ---------- */

static SESSIONS: Mutex<BTreeMap<String, (String, Instant)>> = Mutex::new(BTreeMap::new());
// ip -> (consecutive failures, blocked until)
static FAILS: Mutex<BTreeMap<String, (u32, Instant)>> = Mutex::new(BTreeMap::new());
static CRYPT: Mutex<()> = Mutex::new(()); // crypt() returns a static buffer

#[link(name = "crypt")]
extern "C" {
    fn crypt(phrase: *const c_char, setting: *const c_char) -> *mut c_char;
}

/// libcrypt hash of `pass` with the method and salt of `setting` (any scheme of /etc/shadow).
fn crypt_hash(pass: &str, setting: &str) -> Option<String> {
    let (p, s) = (CString::new(pass).ok()?, CString::new(setting).ok()?);
    let _g = CRYPT.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: valid C strings; the result is copied before the lock is released.
    let out = unsafe { crypt(p.as_ptr(), s.as_ptr()) };
    (!out.is_null()).then(|| unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned())
}

/// Constant-time comparison of the hash of `pass` with `hash`.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn crypt_matches(pass: &str, hash: &str) -> bool {
    crypt_hash(pass, hash).is_some_and(|h| ct_eq(&h, hash))
}

/// System account with a usable password, member (primary or supplementary) of the admin group.
fn check_login(l: &Login, name: &str, pass: &str) -> bool {
    if !is_account(name) || pass.is_empty() || pass.len() > 256 {
        return false;
    }
    let Some(group) = groups().into_iter().find(|g| g.0 == l.admin_group) else { return false };
    let primary = passwd().iter().any(|p| p.0 == name && p.2 == group.1);
    if !primary && !group.2.iter().any(|m| m == name) {
        return false;
    }
    let shadow = read("/etc/shadow");
    let Some(hash) = shadow.lines().find_map(|l| l.strip_prefix(&format!("{name}:"))).and_then(|r| r.split(':').next()) else { return false };
    // "!" / "*": locked or no password (e.g. the share accounts made by the panel).
    !hash.is_empty() && !hash.starts_with(['!', '*']) && crypt_matches(pass, hash)
}

fn token() -> String {
    let mut b = [0u8; 32];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("/dev/urandom");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn cookie(r: &Request, name: &str) -> Option<String> {
    header(r, "Cookie").split(';').find_map(|c| c.trim().strip_prefix(&format!("{name}=")).map(String::from))
}

/// Delay before the next try from this address: 2^failures seconds, up to 5 min.
fn blocked_for(ip: &str) -> u64 {
    let f = FAILS.lock().unwrap_or_else(|e| e.into_inner());
    // Rounded up: 0.9 s left is still blocked.
    f.get(ip).map_or(0, |(_, until)| (until.saturating_duration_since(Instant::now()).as_millis() as u64).div_ceil(1000))
}

fn record_failure(ip: &str) {
    let mut f = FAILS.lock().unwrap_or_else(|e| e.into_inner());
    let n = f.get(ip).map_or(0, |e| e.0) + 1;
    f.insert(ip.to_string(), (n, Instant::now() + Duration::from_secs((1u64 << n.min(9)).min(300))));
}

/// Authenticated user, or None (not from the proxy, or no/wrong identity).
fn user(cfg: &Config, r: &Request) -> Option<String> {
    if let Some(l) = &cfg.login {
        let tok = cookie(r, "cairn_session")?;
        let mut s = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
        if s.get(&tok).is_some_and(|(_, seen)| seen.elapsed().as_secs() > l.session_s) {
            s.remove(&tok);
        }
        let (u, seen) = s.get_mut(&tok)?;
        *seen = Instant::now();
        return Some(u.clone());
    }
    let ip = r.remote_addr()?.ip().to_string();
    if !cfg.trusted_proxies.contains(&ip) {
        return None;
    }
    let user = header(r, &cfg.user_header);
    let groups = header(r, &cfg.groups_header);
    let in_group = cfg.require_groups.is_empty() || groups.split(',').any(|g| cfg.require_groups.iter().any(|n| n == g.trim()));
    (!user.is_empty() && in_group).then_some(user)
}

fn respond(r: Request, code: u16, body: String, ctype: &str) {
    respond_cookie(r, code, body, ctype, None)
}

fn respond_cookie(r: Request, code: u16, body: String, ctype: &str, set_cookie: Option<String>) {
    let h = |k: &str, v: &str| Header::from_bytes(k, v).unwrap();
    let mut resp = Response::from_string(body)
        .with_status_code(code)
        .with_header(h("Content-Type", &format!("{ctype}; charset=utf-8")))
        .with_header(h("Cache-Control", "no-store"))
        .with_header(h("X-Content-Type-Options", "nosniff"))
        .with_header(h("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'"));
    if let Some(c) = set_cookie {
        resp = resp.with_header(h("Set-Cookie", &c));
    }
    let _ = r.respond(resp);
}

fn login(l: &Login, mut r: Request, lang: &str) {
    let ip = r.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    if !header(&r, "Content-Type").starts_with("application/json") {
        return respond(r, 400, json!({"error": tr(lang, "invalid request")}).to_string(), "application/json");
    }
    let wait = blocked_for(&ip);
    if wait > 0 {
        return respond(r, 429, json!({"error": tr(lang, &format!("too many attempts: try again in {wait} s"))}).to_string(), "application/json");
    }
    let mut body = String::new();
    let _ = r.as_reader().take(4096).read_to_string(&mut body);
    let a: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let name = a["user"].as_str().unwrap_or("").to_string();
    if !check_login(l, &name, a["password"].as_str().unwrap_or("")) {
        record_failure(&ip);
        eprintln!("login refused user={name} ip={ip}");
        std::thread::sleep(Duration::from_secs(1));
        return respond(r, 401, json!({"error": tr(lang, "wrong user name or password")}).to_string(), "application/json");
    }
    FAILS.lock().unwrap_or_else(|e| e.into_inner()).remove(&ip);
    let t = token();
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner()).insert(t.clone(), (name.clone(), Instant::now()));
    eprintln!("login user={name} ip={ip}");
    let c = format!("cairn_session={t}; Path=/; HttpOnly; Secure; SameSite=Strict");
    respond_cookie(r, 200, json!({"ok": true}).to_string(), "application/json", Some(c))
}

fn handle(cfg: &Config, mut r: Request) {
    let path = r.url().split('?').next().unwrap_or("").to_string();
    let lang = lang_of(cfg, &r);
    let err = |e: &str| json!({"error": tr(lang, e)}).to_string();
    if path == "/healthz" {
        return respond(r, 200, "ok".into(), "text/plain"); // liveness only, no data
    }
    if path == "/icon.svg" {
        return respond(r, 200, ICON.into(), "image/svg+xml"); // public: tab icon, dashboards
    }
    if let (Some(t), Method::Get, "/api/summary") = (&cfg.summary_token, r.method(), path.as_str()) {
        if header(&r, "Authorization").strip_prefix("Bearer ").is_some_and(|b| ct_eq(b, t)) {
            return respond(r, 200, summary(cfg).to_string(), "application/json");
        }
    }
    if let Some(l) = &cfg.login {
        // Signed out: the page itself loads and shows the sign-in form.
        match (r.method().clone(), path.as_str()) {
            (Method::Get, "/") => return respond(r, 200, INDEX.into(), "text/html"),
            (Method::Get, "/panel.js") => return respond(r, 200, JS.into(), "text/javascript"),
            (Method::Get, "/panel.css") => return respond(r, 200, CSS.into(), "text/css"),
            (Method::Get, "/i18n.js") => return respond(r, 200, I18N.into(), "text/javascript"),
            (Method::Post, "/api/login") => return login(l, r, lang),
            (Method::Post, "/api/logout") => {
                if let Some(t) = cookie(&r, "cairn_session") {
                    SESSIONS.lock().unwrap_or_else(|e| e.into_inner()).remove(&t);
                }
                let gone = "cairn_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict".to_string();
                return respond_cookie(r, 200, json!({"ok": true}).to_string(), "application/json", Some(gone));
            }
            _ => {}
        }
    }
    let Some(user) = user(cfg, &r) else {
        let code = if cfg.login.is_some() { 401 } else { 403 };
        return respond(r, code, tr(lang, "access denied"), "text/plain");
    };
    let method = r.method().clone();
    match (method, path.as_str()) {
        (Method::Get, "/") => respond(r, 200, INDEX.into(), "text/html"),
        (Method::Get, "/panel.js") => respond(r, 200, JS.into(), "text/javascript"),
        (Method::Get, "/panel.css") => respond(r, 200, CSS.into(), "text/css"),
        (Method::Get, "/i18n.js") => respond(r, 200, I18N.into(), "text/javascript"),
        (Method::Get, "/api/config") => {
            let mut c = cfg.public.clone();
            c["user"] = json!(user);
            c["ui"] = load_ui(&cfg.state_file);
            respond(r, 200, c.to_string(), "application/json")
        }
        (Method::Get, "/api/fast") => respond(r, 200, fast(), "text/plain"),
        (Method::Get, "/api/summary") => respond(r, 200, summary(cfg).to_string(), "application/json"),
        (Method::Get, "/api/slow") => respond(r, 200, slow(cfg), "text/plain"),
        (Method::Get, "/api/manage") => respond(r, 200, manage_view(cfg, lang).to_string(), "application/json"),
        (Method::Post, "/api/manage") => {
            if !header(&r, "Content-Type").starts_with("application/json") {
                return respond(r, 400, err("invalid request"), "application/json");
            }
            let mut body = String::new();
            let _ = r.as_reader().take(16384).read_to_string(&mut body);
            let a: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            match manage(cfg, &a) {
                Ok(what) => {
                    eprintln!("manage user={user} {what}"); // never the password
                    respond(r, 200, json!({"ok": true}).to_string(), "application/json")
                }
                Err(e) => {
                    eprintln!("manage user={user} op={} refused: {e}", a["op"].as_str().unwrap_or("?"));
                    respond(r, 400, err(&e), "application/json")
                }
            }
        }
        (Method::Post, "/api/ui") => {
            if !header(&r, "Content-Type").starts_with("application/json") {
                return respond(r, 400, err("invalid request"), "application/json");
            }
            let mut body = String::new();
            let _ = r.as_reader().take(65536).read_to_string(&mut body);
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if !valid_ui(&v) {
                return respond(r, 400, err("invalid labels"), "application/json");
            }
            match save_ui(&cfg.state_file, &v) {
                Ok(()) => {
                    eprintln!("ui user={user} saved");
                    respond(r, 200, json!({"ok": true}).to_string(), "application/json")
                }
                Err(e) => respond(r, 500, json!({"error": e.to_string()}).to_string(), "application/json"),
            }
        }
        (Method::Post, "/api/action") => {
            // CSRF: a cross-site form cannot send a JSON body without a CORS preflight.
            if !header(&r, "Content-Type").starts_with("application/json") {
                return respond(r, 400, err("invalid request"), "application/json");
            }
            let mut body = String::new();
            let _ = r.as_reader().take(4096).read_to_string(&mut body);
            let a: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let snaps = || cmd(&["zfs", "list", "-H", "-t", "snapshot", "-o", "name"]).lines().map(String::from).collect();
            match build_argv(&pools(), &cfg.services, &a, snaps) {
                Err(e) => respond(r, 400, err(&e), "application/json"),
                Ok(argv) => match Command::new(&argv[0]).args(&argv[1..]).output() {
                    Ok(o) => {
                        eprintln!("action user={user} argv={argv:?} rc={:?}", o.status.code());
                        if o.status.success() {
                            respond(r, 200, json!({"ok": true}).to_string(), "application/json")
                        } else {
                            let err = String::from_utf8_lossy(if o.stderr.is_empty() { &o.stdout } else { &o.stderr }).trim().to_string();
                            respond(r, 500, json!({"error": err}).to_string(), "application/json")
                        }
                    }
                    Err(e) => respond(r, 500, json!({"error": e.to_string()}).to_string(), "application/json"),
                },
            }
        }
        _ => respond(r, 404, tr(lang, "not found"), "text/plain"),
    }
}

/* ---------- demo ---------- */

/// `cairn-nas --demo [addr]`: the page on recorded sample data, no root, no
/// sign-in, nothing written (labels and tags are kept in memory only).
const DEMO_FAST: [&str; 8] = [
    include_str!("../demo/fast1.txt"), include_str!("../demo/fast2.txt"), include_str!("../demo/fast3.txt"), include_str!("../demo/fast4.txt"),
    include_str!("../demo/fast5.txt"), include_str!("../demo/fast6.txt"), include_str!("../demo/fast7.txt"), include_str!("../demo/fast8.txt"),
];
static DEMO_UI: Mutex<Option<Value>> = Mutex::new(None);
static DEMO_TICK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn demo(mut r: Request) {
    let path = r.url().split('?').next().unwrap_or("").to_string();
    let lang = if header(&r, "Accept-Language").starts_with("fr") { "fr" } else { "en" };
    let jsn = "application/json";
    match (r.method().clone(), path.as_str()) {
        (Method::Get, "/") => respond(r, 200, INDEX.into(), "text/html"),
        (Method::Get, "/panel.js") => respond(r, 200, JS.into(), "text/javascript"),
        (Method::Get, "/panel.css") => respond(r, 200, CSS.into(), "text/css"),
        (Method::Get, "/i18n.js") => respond(r, 200, I18N.into(), "text/javascript"),
        (Method::Get, "/icon.svg") => respond(r, 200, ICON.into(), "image/svg+xml"),
        (Method::Get, "/api/config") => {
            let mut c: Value = serde_json::from_str(include_str!("../demo/config.json")).unwrap_or_default();
            c["user"] = json!("demo");
            if let Some(ui) = DEMO_UI.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                c["ui"] = ui;
            }
            respond(r, 200, c.to_string(), jsn)
        }
        (Method::Get, "/api/fast") => {
            let i = DEMO_TICK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            respond(r, 200, DEMO_FAST[i % DEMO_FAST.len()].into(), "text/plain")
        }
        (Method::Get, "/api/slow") => respond(r, 200, include_str!("../demo/slow.txt").into(), "text/plain"),
        (Method::Get, "/api/manage") => respond(r, 200, include_str!("../demo/manage.json").into(), jsn),
        (Method::Post, "/api/ui") => {
            let mut body = String::new();
            let _ = r.as_reader().take(65536).read_to_string(&mut body);
            match serde_json::from_str::<Value>(&body) {
                Ok(v) if valid_ui(&v) => {
                    *DEMO_UI.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
                    respond(r, 200, json!({"ok": true}).to_string(), jsn)
                }
                _ => respond(r, 400, json!({"error": tr(lang, "invalid labels")}).to_string(), jsn),
            }
        }
        (Method::Post, _) => respond(r, 400, json!({"error": tr(lang, "demo mode: nothing is changed")}).to_string(), jsn),
        _ => respond(r, 404, tr(lang, "not found"), "text/plain"),
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: cairn-nas /etc/cairn-nas.json | --demo [address:port]");
    if path == "--demo" {
        let listen = std::env::args().nth(2).unwrap_or("127.0.0.1:8080".into());
        let server = Server::http(&listen).expect("cannot listen");
        eprintln!("cairn-nas demo on http://{listen}");
        for r in server.incoming_requests() {
            std::thread::spawn(move || demo(r));
        }
        return;
    }
    let cfg: &'static Config = Box::leak(Box::new(Config::load(&path)));
    let server = match &cfg.tls {
        Some((cert, key)) => Server::https(&cfg.listen, tiny_http::SslConfig {
            certificate: fs::read(cert).expect("tls cert unreadable"),
            private_key: fs::read(key).expect("tls key unreadable"),
        }),
        None => Server::http(&cfg.listen),
    }
    .expect("cannot listen");
    eprintln!("cairn-nas listening on {}", cfg.listen);
    std::thread::spawn(move || alert_loop(cfg));
    std::thread::spawn(move || housekeeping(cfg));
    for r in server.incoming_requests() {
        std::thread::spawn(move || handle(cfg, r));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: Value) -> Result<Vec<String>, String> {
        build_argv(&["tank".to_string(), "fast".to_string()], &["nfs-server".to_string()], &a, || vec!["tank/cloud@a".to_string()])
    }

    #[test]
    fn validation() {
        assert_eq!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "zstd", "quota": "500G"})).unwrap(),
            ["zfs", "set", "compression=zstd", "quota=500G", "tank/cloud"]);
        assert_eq!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "lz4", "quota": "1.5T"})).unwrap()[3], "quota=1.5T");
        assert!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "zstd", "quota": "5G; rm -rf /"})).is_err());
        assert!(argv(json!({"action": "dataset_set", "dataset": "other/x", "compression": "lz4", "quota": "none"})).is_err());
        assert!(argv(json!({"action": "dataset_set", "dataset": "tankX", "compression": "lz4", "quota": "none"})).is_err());
        assert!(argv(json!({"action": "dataset_set", "dataset": "tank/..", "compression": "lz4", "quota": "none"})).is_err());
        assert!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "bogus", "quota": "none"})).is_err());
        assert_eq!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "lz4", "quota": "none", "autosnap": "false"})).unwrap(),
            ["zfs", "set", "compression=lz4", "quota=none", "com.sun:auto-snapshot=false", "tank/cloud"]);
        assert!(argv(json!({"action": "dataset_set", "dataset": "tank/cloud", "compression": "lz4", "quota": "none", "autosnap": "yes"})).is_err());
        assert_eq!(argv(json!({"action": "snapshot_create", "dataset": "tank/cloud", "name": "m-1", "recursive": true})).unwrap(),
            ["zfs", "snapshot", "-r", "tank/cloud@m-1"]);
        assert!(argv(json!({"action": "snapshot_create", "dataset": "tank/cloud", "name": "a b"})).is_err());
        assert_eq!(argv(json!({"action": "snapshot_destroy", "snapshot": "tank/cloud@a"})).unwrap(), ["zfs", "destroy", "tank/cloud@a"]);
        assert!(argv(json!({"action": "snapshot_destroy", "snapshot": "tank/cloud"})).is_err()); // dataset, not snapshot
        assert!(argv(json!({"action": "snapshot_destroy", "snapshot": "tank/cloud@zz"})).is_err()); // unknown
        assert!(argv(json!({"action": "snapshot_destroy", "snapshot": "tank/cloud@a -r"})).is_err());
        assert_eq!(argv(json!({"action": "service_restart", "service": "nfs-server"})).unwrap(), ["systemctl", "restart", "nfs-server"]);
        assert!(argv(json!({"action": "service_restart", "service": "ssh"})).is_err());
        assert_eq!(argv(json!({"action": "scrub_start", "pool": "fast"})).unwrap(), ["zpool", "scrub", "fast"]);
        assert_eq!(argv(json!({"action": "scrub_stop", "pool": "tank"})).unwrap(), ["zpool", "scrub", "-s", "tank"]);
        assert!(argv(json!({"action": "scrub_start", "pool": "-a"})).is_err());
        assert!(argv(json!({"action": "scrub_start"})).is_err());
        assert!(argv(json!({"action": "snapshot_create", "dataset": "fast/vm", "name": "m-1"})).is_ok());
        assert!(argv(json!({"action": "rm"})).is_err());
    }

    #[test]
    fn replication_age() {
        let snaps = "backup/tank@zfs-auto-snap_daily-1\t100\t1000\nbackup/tank@zfs-auto-snap_frequent-2\t5\t2000\n\
            backup/tank/cloud@syncoid_x\t0\t1500\nbackup/tank/cloud@other\t0\t9000\nbackup/tankX@a\t0\t9999\nother@a\t0\t9999\n";
        let reps = [Replica { dataset: "backup/tank".into(), prefix: String::new(), max_age_s: 3600 }];
        assert_eq!(last_sends(snaps, &reps), [("backup/tank".to_string(), Some(2000), 3600), ("backup/tank/cloud".to_string(), Some(9000), 3600)]);
        let reps = [Replica { dataset: "backup/tank".into(), prefix: "syncoid_".into(), max_age_s: 3600 },
            Replica { dataset: "fast".into(), prefix: String::new(), max_age_s: 7200 }];
        let rows = last_sends("backup/tank/cloud@syncoid_x\t1500\n", &reps); // name,creation only (alerts)
        assert_eq!(rows, [("backup/tank".to_string(), None, 3600), ("backup/tank/cloud".to_string(), Some(1500), 3600), ("fast".to_string(), None, 7200)]);
        let mut out = BTreeMap::new();
        replication_problems(&rows[..2], 1500 + 3600, &mut out);
        assert_eq!(out.len(), 1); // exactly at the limit: still fine
        replication_problems(&rows[1..2], 1500 + 3600 * 5 + 1, &mut out);
        assert_eq!(out["repl:backup/tank/cloud"], "Replication of backup/tank/cloud is late: last snapshot 5 h ago (threshold 1 h)");
        assert_eq!(tr("fr", &out["repl:backup/tank"]), "Réplication de backup/tank : aucun snapshot pour l'instant");
    }

    #[test]
    fn ui_state_validation() {
        let ok = json!({"labels": {"nic:enp95s0": "LAN MANAGEMENT"}, "tags": {"t1": {"name": "Proxmox", "color": "#111111"}},
            "assign": {"host:192.168.1.51": "t1"}});
        assert!(valid_ui(&ok));
        assert!(valid_ui(&json!({"labels": {}, "tags": {}, "assign": {}})));
        assert!(!valid_ui(&json!({"labels": {}, "tags": {}, "assign": {"x": "missing"}}))); // unknown tag
        assert!(!valid_ui(&json!({"labels": {}, "tags": {"t": {"name": "a", "color": "red"}}, "assign": {}})));
        assert!(!valid_ui(&json!({"labels": {"k": "x".repeat(65)}, "tags": {}, "assign": {}})));
        assert!(!valid_ui(&json!({"labels": {"k": "a\u{0}"}, "tags": {}, "assign": {}})));
        assert!(!valid_ui(&json!({"labels": {}, "tags": {}, "assign": {}, "extra": 1})));
        assert!(!valid_ui(&json!(null)));
    }

    #[test]
    fn manage_validation() {
        assert!(is_host("192.168.1.0/24") && is_host("192.168.1.45") && is_host("pc-salon.home"));
        assert!(!is_host("192.168.1.0/33") && !is_host("192.168.1.0/+8") && !is_host("*") && !is_host("a b") && !is_host("x(rw)") && !is_host(""));
        assert!(is_account("alice") && is_account("_svc-1") && !is_account("Alice") && !is_account("1a") && !is_account("a:b") && !is_account(""));
        assert!(is_share("Photos_2") && !is_share("homes") && !is_share("a b") && !is_share("x]") && !is_share(""));
        assert!(is_password("12345678") && !is_password("1234567") && !is_password("abcdefgh\nroot"));
    }

    #[test]
    fn manage_rendering() {
        let st = json!({"nfs": {"media": {"path": "/tank/media", "clients": [{"host": "192.168.1.0/24", "rw": false, "squash": "root_squash"},
            {"host": "192.168.1.45", "rw": true, "squash": "all_squash"}]}},
            "smb": {"Photos": {"path": "/tank/photos", "access": {"u:alice": "rw", "g:famille": "ro"}}}, "groups": ["famille"]});
        assert!(render_nfs(&st).contains("/tank/media 192.168.1.0/24(ro,sync,no_subtree_check,root_squash) 192.168.1.45(rw,sync,no_subtree_check,all_squash)\n"));
        let smb = render_smb(&st, |_| ("owner".into(), "users".into()));
        assert!(smb.contains("[Photos]\n   path = /tank/photos\n"));
        assert!(smb.contains("valid users = @famille alice\n   write list = alice\n   force user = owner\n   force group = users\n"));
        let as_root = render_smb(&st, |_| ("root".into(), "root".into()));
        assert!(!as_root.contains("force"), "never force root");
        assert!(as_root.contains("write list = alice\n   create mask"));
        assert!(smb.contains("   server smb encrypt = desired\n"));
        let mut req = st.clone();
        req["smb"]["Photos"]["encrypt"] = json!("required");
        assert!(render_smb(&req, |_| ("owner".into(), "users".into())).contains("   server smb encrypt = required\n"));
        assert!(!smb.contains("time machine") && !smb.contains("shadow"));
        req["smb"]["Photos"]["versions"] = json!(true);
        assert!(render_smb(&req, |_| ("owner".into(), "users".into())).contains("   vfs objects = shadow_copy2 fruit streams_xattr\n   shadow:snapdir = .zfs/snapshot\n"));
        req["smb"]["Photos"]["recycle"] = json!(true);
        let both = render_smb(&req, |_| ("owner".into(), "users".into()));
        assert!(both.contains("   vfs objects = shadow_copy2 recycle fruit streams_xattr\n") && both.contains("   recycle:repository = .recycle/%U\n"));
        req["smb"]["Photos"]["timemachine"] = json!(true);
        req["smb"]["Photos"]["tm_max"] = json!("1T");
        assert!(render_smb(&req, |_| ("owner".into(), "users".into())).contains("   fruit:time machine = yes\n   fruit:time machine max size = 1T\n"));
        assert_eq!(shares_using(&st, "g:famille"), ["Photos"]);
        assert!(shares_using(&st, "u:bob").is_empty());
        assert_eq!(render_fw(&st, "inet nas").lines().count(), 1); // nothing opened yet
        let open = json!({"nfs": {"a": {"open_fw": true, "clients": [{"host": "192.168.1.80"}, {"host": "192.168.1.0/24"}]},
            "b": {"open_fw": false, "clients": [{"host": "192.168.1.99"}]}}, "smb": {"c": {"fw": ["192.168.1.80"]}, "d": {"fw": ["192.168.1.80"]}}});
        let fw = render_fw(&open, "inet nas");
        assert!(fw.contains("add element inet nas cairn_nfs { 192.168.1.0/24, 192.168.1.80 }\n"));
        assert!(fw.contains("add element inet nas cairn_smb { 192.168.1.80 }\n"));
        assert!(!fw.contains("192.168.1.99"));
        assert!(is_ip_or_net("10.0.0.0/8") && !is_ip_or_net("pc.home"));
    }

    #[test]
    fn password_check() {
        let h = crypt_hash("correct horse", "$6$saltsaltsalt$").unwrap();
        assert!(h.starts_with("$6$saltsaltsalt$") && crypt_matches("correct horse", &h));
        assert!(!crypt_matches("correct hors", &h) && !crypt_matches("", &h));
        // libxcrypt answers "*0"/"*1" to a bad setting: never a match.
        assert!(!crypt_matches("pw", "*0") && !crypt_matches("pw", "!locked"));
        record_failure("192.0.2.1");
        assert!(blocked_for("192.0.2.1") >= 1 && blocked_for("192.0.2.2") == 0);
        assert_eq!(token().len(), 64);
    }

    #[test]
    fn pool_alerts() {
        let list = "fast\tONLINE\t12%\ntank\tDEGRADED\t91%\n";
        let status = "  pool: fast\n state: ONLINE\nerrors: No known data errors\n\n  pool: tank\n state: DEGRADED\nerrors: 2 data errors, use '-v' for a list\n";
        let p = pool_problems(list, status, 85);
        assert_eq!(p.keys().cloned().collect::<Vec<_>>(), ["errors:tank:2 data errors, use '-v' for a list", "full:tank", "pool:tank:DEGRADED"]);
        assert!(pool_problems("fast\tONLINE\t12%\n", "  pool: fast\nerrors: No known data errors\n", 85).is_empty());
    }

    #[test]
    fn held_packages_stay_apart() {
        let list = "En train de lister…\nwazuh-agent/stable 4.14.9-1 amd64 [upgradable from: 4.14.8-1]\nopenssl/trixie-security 3.5.4-1 amd64 [upgradable from: 3.5.1-1]\n";
        let (up, held) = upgradable(list, "wazuh-agent\n");
        assert_eq!((up, held), (vec!["openssl".to_string()], vec!["wazuh-agent".to_string()]));
    }

    #[test]
    fn summary_shape() {
        let mut p = BTreeMap::new();
        p.insert("full:tank".to_string(), "Pool tank plein".to_string());
        let s = summary_json("tank\tONLINE\t3\t1000\t30\nbad line\n", &p, "k10temp|0000:00:18.3|Tctl|76250\nnvme|nvme0|Composite|41850\n");
        assert_eq!(s["pools"]["tank"], json!({"health": "ONLINE", "capacity": 3, "size": 1000, "alloc": 30}));
        assert_eq!(s["problems"], 1);
        assert_eq!(s["temp_max_c"], 76);
        assert!(ct_eq("abc", "abc") && !ct_eq("abc", "abd") && !ct_eq("abc", "abcd"));
    }

    #[test]
    fn translations() {
        assert_eq!(tr("fr", "unknown pool"), "pool inconnu");
        assert_eq!(tr("en", "unknown pool"), "unknown pool");
        assert_eq!(tr("fr", "Pool tank is 91% full (threshold 85%)"), "Pool tank rempli à 91% (seuil 85 %)");
        assert_eq!(tr("fr", "Disk sda (X 1): media errors = 3"), "Disque sda (X 1) : erreurs de lecture = 3");
        assert_eq!(tr("fr", "Disk sda (X 1): SMART self-test failed"), "Disque sda (X 1) : test SMART en échec");
        assert_eq!(tr("fr", "cannot open /dev/x"), "cannot open /dev/x"); // system text stays as is
        for (en, fr) in FR {
            assert_eq!(en.matches("{}").count(), fr.matches("{}").count(), "{en}");
        }
    }

    #[test]
    fn sections_keep_empty_outputs() {
        assert_eq!(join(vec!["a".into(), String::new(), "b\n".into()]), "a\n@@\n@@\nb\n");
    }
}
