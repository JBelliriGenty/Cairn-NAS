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

mod restore;
mod schedules;
mod encryption;
mod offsite;
mod peers;

const INDEX: &str = include_str!("../www/index.html");
const JS: &str = include_str!("../www/panel.js");
const CSS: &str = include_str!("../www/panel.css");
const ICON: &str = include_str!("../www/icon.svg");
const I18N: &str = include_str!("../www/i18n.js");
const COMPRESSION: [&str; 5] = ["lz4", "zstd", "zstd-fast", "gzip", "off"];
const VOLBLOCK: [&str; 5] = ["8K", "16K", "32K", "64K", "128K"]; // 8 KiB << index

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
    peers: Vec<peers::Peer>, // other Cairn instances shown in Machines
    peer_unreachable_s: u64, // alert when a peer stays unreachable this long
    iscsi_base: String, // target names: <iscsi_base>:<volume>
    path: String, // this config file, for the cairn-repl service
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
#[derive(Clone)]
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
        let features = Features { nfs: f("nfs"), smb: f("smb"), users: f("users"), pools: f("pools"), vdevs: f("vdevs"), disks: f("disks"), replication: f("replication"), iscsi: f("iscsi"), restore: f("restore"), schedules: f("schedules"), encryption: f("encryption"), offsite: f("offsite") };
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
        public["features"] = json!({"nfs": features.nfs, "smb": features.smb, "users": features.users, "pools": features.pools, "vdevs": features.vdevs, "disks": features.disks, "replication": features.replication, "iscsi": features.iscsi, "restore": features.restore, "schedules": features.schedules, "encryption": features.encryption, "offsite": features.offsite,
            "firewall": firewall_table.is_some(), "login": login.is_some(), "autosnap": std::path::Path::new("/usr/sbin/zfs-auto-snapshot").exists()});
        let peers = peers::load(&v);
        public["features"]["peers"] = json!(!peers.is_empty());
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
            peers,
            peer_unreachable_s: v["peer_unreachable_minutes"].as_u64().unwrap_or(15).max(1) * 60,
            iscsi_base: v["iscsi_base"].as_str().map(String::from)
                .unwrap_or_else(|| format!("iqn.2003-01.org.linux-iscsi.{}", iqn_part(read("/proc/sys/kernel/hostname").trim()))),
            path: path.to_string(),
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
    let repl: String = last_sends(&snaps, &replicas(cfg)).iter().map(|(ds, last, max)| match last {
        Some(t) => format!("{ds}\t{t}\t{}\t{max}\n", now.saturating_sub(*t)),
        None => format!("{ds}\t-\t-\t{max}\n"),
    }).collect();
    join(vec![
        read("/proc/sys/kernel/hostname") + &read("/proc/sys/kernel/osrelease"),
        // Every imported pool: a pool added later shows up without any config change.
        cmd(&["zpool", "get", "-Hp", "health,size,allocated,free,fragmentation,capacity,ashift,autotrim"]),
        cmd(&["zpool", "status", "-t"]), // -t: trim state of each disk
        cmd(&["zfs", "list", "-Hp", "-t", "filesystem,volume", "-o", "name,used,avail,refer,compressratio,compression,recordsize,quota,mountpoint,com.sun:auto-snapshot,type,volsize,volblocksize"]),
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

/// Replicated datasets watched: the config's, plus the pulls set up from the page.
fn replicas(cfg: &Config) -> Vec<Replica> {
    let mut out = cfg.replication.clone();
    for target in load_manage(cfg)["repl_pull"].as_object().into_iter().flatten().map(|(t, _)| t) {
        if !out.iter().any(|r| &r.dataset == target) {
            out.push(Replica { dataset: target.clone(), prefix: String::new(), max_age_s: REPL_MAX_AGE_S });
        }
    }
    out
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
            "unsafe": h["unsafe_shutdowns"], "realloc": realloc, "selftest": schedules::last_selftest(&v),
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
    ("an update is already running", "une mise à jour est déjà en cours"),
    ("Pool {} is {} full (threshold {}%)", "Pool {} rempli à {} (seuil {} %)"),
    ("Pool {}: {}", "Pool {} : {}"),
    ("Pool {}: {}", "Pool {} : {}"),
    ("Disk {}: SMART self-test failed", "Disque {} : test SMART en échec"),
    ("Disk {}: {} = {}", "Disque {} : {} = {}"),
    ("Replication of {} is late: last snapshot {} h ago (threshold {} h)", "Réplication de {} en retard : dernier snapshot il y a {} h (seuil {} h)"),
    ("public key refused: one ssh-ed25519 line", "clé publique refusée : une ligne ssh-ed25519"),
    ("backup machine: an IPv4 address", "machine de sauvegarde : une adresse IPv4"),
    ("datasets refused", "datasets refusés"),
    ("unknown machine", "machine inconnue"),
    ("source machine: an IPv4 address or a host name", "machine source : une adresse IPv4 ou un nom d'hôte"),
    ("source dataset refused", "dataset source refusé"),
    ("local dataset refused: inside an existing dataset of a pool, e.g. backup/tank", "dataset local refusé : dans un dataset existant d'un pool, par ex. backup/tank"),
    ("create this machine's key first", "créez d'abord la clé de cette machine"),
    ("syncoid is not installed (apt install sanoid)", "syncoid n'est pas installé (apt install sanoid)"),
    ("unknown replication", "réplication inconnue"),
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
    ("size: e.g. 100G, 1.5T", "taille : ex. 100G, 1.5T"),
    ("volume refused (existing parent dataset + simple name)", "volume refusé (dataset parent existant + nom simple)"),
    ("block size: 8K to 128K", "taille de bloc : 8K à 128K"),
    ("unknown volume", "volume inconnu"),
    ("a volume can only grow: give a size larger than the current one", "un volume ne peut que grandir : indiquez une taille supérieure à l'actuelle"),
    ("never the root of a pool: delete the pool instead", "jamais la racine d'un pool : supprimez plutôt le pool"),
    ("unknown dataset", "dataset inconnu"),
    ("targetcli is not installed (apt install targetcli-fb)", "targetcli n'est pas installé (apt install targetcli-fb)"),
    ("unknown export", "export inconnu"),
    ("initiators: one iSCSI name (iqn.…) per machine, 32 at most", "initiateurs : un nom iSCSI (iqn.…) par machine, 32 au plus"),
    ("another volume already has this iSCSI name", "un autre volume a déjà ce nom iSCSI"),
    ("confirmation: type the full name again", "confirmation : retapez le nom complet"),
    ("still in use, remove it first from: {}", "encore utilisé, retirez-le d'abord de : {}"),
    ("it has child datasets: tick “with its children” to delete them too", "il contient des datasets enfants : cochez « avec ses enfants » pour les supprimer aussi"),
    ("{}: offlining this disk would leave no redundancy, replace it instead (the old disk keeps working until the copy is done)",
        "{} : mettre ce disque hors ligne ne laisserait aucune redondance, remplacez-le plutôt (l'ancien disque reste en service jusqu'à la fin de la copie)"),
    ("not a disk of this pool", "pas un disque de ce pool"),
    ("a replacement or resilver is in progress on this pool: wait for it to finish", "un remplacement ou une reconstruction est en cours sur ce pool : attendez la fin"),
    ("this disk is not offline", "ce disque n'est pas hors ligne"),
    ("this disk is already offline", "ce disque est déjà hors ligne"),
    ("replacement: a free disk only", "remplacement : un disque libre uniquement"),
    ("confirmation: type the pool name again", "confirmation : retapez le nom du pool"),
    ("{}: at least {} free disk(s), each used once", "{} : au moins {} disque(s) libre(s), chacun une seule fois"),
    ("only a log, cache or spare device can be removed", "seul un périphérique de journal (log), de cache ou de secours peut être retiré"),
    ("this spare is standing in for a failed disk: replace that disk first", "ce disque de secours remplace un disque en panne : remplacez d'abord ce disque"),
    ("not a RAIDZ group of this pool", "pas un groupe RAIDZ de ce pool"),
    ("a scrub, resilver or expansion is in progress on this pool: wait for it to finish", "un scrub, une reconstruction ou une extension est en cours sur ce pool : attendez la fin"),
    ("expansion: a free disk only", "extension : un disque libre uniquement"),
    ("free disks only, each used once", "disques libres uniquement, chacun une seule fois"),
    ("log: one disk, or two or three mirrored", "journal (log) : un disque, ou deux ou trois en miroir"),
    ("{} would lower the redundancy of the pool: its groups survive {} failed disk(s)", "{} réduirait la redondance du pool : ses groupes supportent {} disque(s) en panne"),
    ("unknown role", "rôle inconnu"),
    ("RAIDZ expansion needs the pool's new ZFS features: enable them first", "l'extension RAIDZ demande les nouvelles fonctions ZFS du pool : activez-les d'abord"),
    ("not in the list of importable pools", "absent de la liste des pools importables"),
    ("a pool with this name is already imported", "un pool de ce nom est déjà importé"),
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
    // specific module messages first: FR has catch-alls such as "Pool {}: {}"
    peers::FR.iter().chain(restore::FR).chain(schedules::FR).chain(encryption::FR).chain(offsite::FR).chain(FR).find_map(|(en, fr)| fill(en, msg).map(|caps| {
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
    let reps = replicas(cfg);
    if !reps.is_empty() {
        let rows = last_sends(&cmd(&["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,creation"]), &reps);
        replication_problems(&rows, now_s(), &mut out);
    }
    if cfg.features.offsite {
        offsite::problems(&load_manage(cfg), &mut out);
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
        } else if let Some(n) = l.strip_prefix("scan: scrub repaired ").and_then(|r| r.split(" with ").nth(1)).and_then(|r| r.split(' ').next()).filter(|n| *n != "0") {
            out.insert(format!("scrub:{pool}:{n}"), format!("Pool {pool}: last scrub found {n} errors"));
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
        let st = &d["selftest"];
        if st["passed"] == false {
            out.insert(format!("selftest:{dev}:{}", st["hours"]), format!("Disk {who}: last SMART self-test failed ({})", st["status"].as_str().unwrap_or("?")));
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
        let mut now = problems(cfg, a.capacity_pct);
        peers::problems(cfg, &mut now); // this machine's view of its peers, not part of its own summary
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
    pools: bool, // create, grow, export/import, upgrade and delete pools; datasets and volumes
    vdevs: bool, // add and remove log, cache and spare devices (reversible), trim
    disks: bool, // take pool members offline/online, replace them
    replication: bool, // let a backup machine pull this one, pull others (syncoid)
    iscsi: bool, // export volumes over iSCSI (LIO, targetcli)
    restore: bool, // browse snapshots, restore files, clone, roll back
    schedules: bool, // automatic snapshots per label, scrub and SMART self-test schedules
    encryption: bool, // create encrypted datasets, lock and unlock them
    offsite: bool, // restic repositories, backup jobs, restore
}

fn feature(on: bool) -> Result<(), String> {
    if on { Ok(()) } else { Err("feature disabled on this server".into()) }
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
        "state": &state, "users": users, "groups": groups, "mountpoints": mountpoints(), "admin_exports": admin_exports(),
        "schedules": if cfg.features.schedules { schedules::view(&state) } else { Value::Null },
        "encryption": if cfg.features.encryption { encryption::view(&state) } else { Value::Null },
        "offsite": if cfg.features.offsite { offsite::view(&state) } else { Value::Null },
        "free_disks": if cfg.features.pools || cfg.features.vdevs || cfg.features.disks { json!(free_disks()) } else { json!([]) },
        "alerts": cfg.alerts.as_ref().map(|a| json!({
            // Host only: the URL may carry a topic name, the headers a token.
            "target": a.url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(""),
            "capacity_pct": a.capacity_pct,
            "problems": problems(cfg, a.capacity_pct).values().map(|m| tr(lang, m)).collect::<Vec<_>>(),
        })),
        "sessions": smb_sessions(),
        "journal": journal(),
        "updates": updates(),
        "upgrade": UPGRADE.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        "repl_pubkey": if cfg.features.replication { read(&format!("{REPL_KEY}.pub")).trim().to_string() } else { String::new() },
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

/// The running (or last) "Update" job: {running, phase, pct, pkg} then {running: false, ok, error}.
static UPGRADE: Mutex<Value> = Mutex::new(Value::Null);

/// apt in transient units: the service's ProtectSystem makes /usr read-only, so dpkg cannot
/// write there from inside it. dpkg --configure -a finishes an interrupted run.
fn upgrade() -> Result<(), String> {
    let host = |argv: &[&str]| {
        let mut a = vec!["systemd-run", "--wait", "--pipe", "--quiet", "--collect", "--setenv=DEBIAN_FRONTEND=noninteractive"];
        a.extend_from_slice(argv);
        a.into_iter().map(String::from).collect::<Vec<_>>()
    };
    let set = |v: Value| *UPGRADE.lock().unwrap_or_else(|e| e.into_inner()) = v;
    let run_host = |argv: &[&str]| run(&host(argv).iter().map(String::as_str).collect::<Vec<_>>(), None);
    run_host(&["apt-get", "update", "-q"])?;
    set(json!({"running": true, "phase": "prepare", "pct": 5}));
    run_host(&["dpkg", "--configure", "-a"])?;
    let argv = host(&["apt-get", "-y", "-q", "-o", "APT::Status-Fd=1", "-o", "Dpkg::Options::=--force-confdef",
        "-o", "Dpkg::Options::=--force-confold", "upgrade", "--with-new-pkgs"]);
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("systemd-run: {e}"))?;
    // ponytail: stderr read after stdout ends; apt writes little there (pipe buffer is 64 KiB).
    for line in std::io::BufRead::lines(std::io::BufReader::new(child.stdout.take().ok_or("no stdout")?)).map_while(Result::ok) {
        if let Some(v) = apt_status(&line) {
            set(v);
        }
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if o.status.success() {
        return Ok(());
    }
    Err(format!("apt-get : {}", String::from_utf8_lossy(&o.stderr).trim()))
}

/// One APT::Status-Fd line ("dlstatus:file:pct:msg", "pmstatus:pkg:pct:msg") as job progress:
/// download is 5-40 % of the bar, install 40-100 %.
fn apt_status(line: &str) -> Option<Value> {
    let mut f = line.splitn(4, ':');
    let (kind, what, pct) = (f.next()?, f.next()?, f.next()?.parse::<f64>().ok()?);
    let (phase, base, span) = match kind {
        "dlstatus" => ("download", 5.0, 35.0),
        "pmstatus" => ("install", 40.0, 60.0),
        _ => return None,
    };
    let pkg = if kind == "pmstatus" { what } else { "" };
    Some(json!({"running": true, "phase": phase, "pct": (base + pct * span / 100.0).round() as u64, "pkg": pkg}))
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
            let mut job = UPGRADE.lock().unwrap_or_else(|e| e.into_inner());
            if job["running"] == true {
                return Err("an update is already running".into());
            }
            // Held packages (apt-mark hold) stay as they are; existing config files are kept.
            let pkgs = updates()["packages"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default();
            *job = json!({"running": true, "phase": "prepare", "pct": 0});
            // In the background: the page follows it on /api/updates (apt can take minutes).
            std::thread::spawn(|| {
                let res = upgrade();
                *UPDATES.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if let Err(e) = &res {
                    eprintln!("manage op=updates_apply failed: {e}");
                }
                *UPGRADE.lock().unwrap_or_else(|e| e.into_inner()) = json!({"running": false, "ok": res.is_ok(), "error": res.err()});
            });
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
        "zvol_create" | "zvol_grow" | "dataset_destroy" | "pool_destroy" => {
            // Destroys: shares, exports and replications are checked first, never -f or -R.
            need(f.pools)?;
            let argv = if op.starts_with("zvol") {
                zvol_argv(&op, a, &zfs_rows())?
            } else {
                let snaps: Vec<String> = cmd(&["zfs", "list", "-H", "-t", "snapshot", "-o", "name"]).lines().map(String::from).collect();
                destroy_argv(&op, a, &zfs_rows(), &snaps, &pools(), &state, &admin_exports())?
            };
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op={op} argv={}", argv.join(" ")))
        }
        "iscsi_save" | "iscsi_delete" => {
            need(f.iscsi)?;
            if !std::path::Path::new("/usr/bin/targetcli").exists() {
                return Err("targetcli is not installed (apt install targetcli-fb)".into());
            }
            let zvol = s("zvol");
            let fresh = !state["iscsi"][zvol.as_str()].is_object();
            let (cmds, entry) = iscsi_plan(&op, a, &zfs_rows(), &state, &cfg.iscsi_base)?;
            install_iscsi_dropin()?;
            for c in &cmds {
                if let Err(e) = run(&c.iter().map(String::as_str).collect::<Vec<_>>(), None) {
                    // A new export is undone; a changed one keeps what was applied (targetcli ls shows it).
                    if fresh && op == "iscsi_save" {
                        let _ = run(&["targetcli", "/iscsi", "delete", entry["iqn"].as_str().unwrap_or("")], None);
                        let _ = run(&["targetcli", "/backstores/block", "delete", entry["backstore"].as_str().unwrap_or("")], None);
                    }
                    return Err(e);
                }
            }
            run(&["targetcli", "saveconfig"], None)?;
            if entry.is_null() {
                state["iscsi"].as_object_mut().map(|m| m.remove(&zvol));
            } else {
                state["iscsi"][zvol.as_str()] = entry.clone();
            }
            save_manage(cfg, &state)?;
            Ok(format!("op={op} zvol={zvol} target={} initiators={}", entry["iqn"].as_str().unwrap_or("-"), strings(&entry, "initiators").join(",")))
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
        "disk_offline" | "disk_online" | "disk_replace" => {
            need(f.disks)?;
            let pool = s("pool");
            if !pools().contains(&pool) {
                return Err("unknown pool".into());
            }
            let free: Vec<String> =
                if op == "disk_replace" { free_disks().iter().filter_map(|d| d["id"].as_str().map(String::from)).collect() } else { vec![] };
            let argv = disk_argv(&op, &pool, &cmd(&["zpool", "status", &pool]), &free, a)?;
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op={op} pool={pool} device={} new={}", s("device"), s("new")))
        }
        "vdev_add" | "vdev_remove" | "raidz_expand" => {
            // Log, cache and spare devices come and go (features.vdevs); data groups stay for good (features.pools).
            let data = op == "raidz_expand" || (op == "vdev_add" && s("role") == "data");
            need(if data { f.pools } else { f.vdevs || f.pools })?;
            let pool = s("pool");
            if !pools().contains(&pool) {
                return Err("unknown pool".into());
            }
            let free: Vec<String> = if op == "vdev_remove" { vec![] } else { free_disks().iter().filter_map(|d| d["id"].as_str().map(String::from)).collect() };
            let argv = vdev_argv(&op, &pool, &cmd(&["zpool", "status", &pool]), &free, a)?;
            // Checked first: zpool attach partitions the new disk before refusing on this.
            if op == "raidz_expand" && !matches!(cmd(&["zpool", "get", "-H", "-o", "value", "feature@raidz_expansion", &pool]).trim(), "enabled" | "active") {
                return Err("RAIDZ expansion needs the pool's new ZFS features: enable them first".into());
            }
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op={op} argv={}", argv.join(" ")))
        }
        "pool_export" | "pool_import" | "pool_upgrade" | "pool_trim" | "pool_autotrim" => {
            need(if matches!(op.as_str(), "pool_trim" | "pool_autotrim") { f.vdevs || f.pools } else { f.pools })?;
            let importable = if op == "pool_import" { parse_importable(&cmd(&["zpool", "import"])) } else { vec![] };
            let argv = pool_argv(&op, a, &pools(), &importable, &zfs_rows(), &state, &admin_exports())?;
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op={op} argv={}", argv.join(" ")))
        }
        "repl_allow" | "repl_revoke" => {
            need(f.replication)?;
            let host = s("host");
            if op == "repl_revoke" {
                let Some(old) = state["repl_allow"].as_object_mut().and_then(|m| m.remove(&host)) else { return Err("unknown machine".into()) };
                let still: Vec<String> = state["repl_allow"].as_object().into_iter().flatten().flat_map(|(_, e)| strings(e, "datasets")).collect();
                for ds in strings(&old, "datasets").iter().filter(|d| !still.contains(d)) {
                    run(&["zfs", "unallow", "-u", REPL_USER, "send,hold", ds], None)?;
                }
                write_repl_keys(&state)?;
                save_manage(cfg, &state)?;
                return Ok(format!("op=repl_revoke host={host}"));
            }
            let key = ssh_key(&s("key")).ok_or("public key refused: one ssh-ed25519 line")?;
            let datasets = strings(a, "datasets");
            let pl = pools();
            if host.parse::<std::net::Ipv4Addr>().is_err() {
                return Err("backup machine: an IPv4 address".into());
            }
            if datasets.is_empty() || datasets.len() > 32 || !datasets.iter().all(|d| is_dataset(&pl, d)) {
                return Err("datasets refused".into());
            }
            if !pw.iter().any(|p| p.0 == REPL_USER) {
                run(&["useradd", "-r", "-m", "-d", REPL_HOME, "-s", "/bin/sh", "-c", MARK, REPL_USER], None)?;
            }
            for ds in &datasets {
                run(&["zfs", "allow", "-u", REPL_USER, "send,hold", ds], None)?;
            }
            state["repl_allow"][host.as_str()] = json!({"key": key, "datasets": datasets});
            write_repl_keys(&state)?;
            save_manage(cfg, &state)?;
            Ok(format!("op=repl_allow host={host} datasets={}", datasets.join(",")))
        }
        "repl_key" => {
            need(f.replication)?;
            if !std::path::Path::new(REPL_KEY).exists() {
                let _ = fs::create_dir_all("/var/lib/cairn-nas");
                let comment = format!("cairn-repl@{}", read("/proc/sys/kernel/hostname").trim());
                run(&["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", &comment, "-f", REPL_KEY], None)?;
            }
            Ok("op=repl_key".into())
        }
        "repl_pull_save" => {
            need(f.replication)?;
            let (host, source, target) = (s("host"), s("source"), s("target"));
            if !is_host(&host) || host.contains('/') {
                return Err("source machine: an IPv4 address or a host name".into());
            }
            if !source.split('/').all(is_name) {
                return Err("source dataset refused".into());
            }
            let parent = target.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
            if !is_dataset(&pools(), &target) || !cmd(&["zfs", "list", "-H", "-o", "name"]).lines().any(|l| l == parent) {
                return Err("local dataset refused: inside an existing dataset of a pool, e.g. backup/tank".into());
            }
            if !std::path::Path::new(REPL_KEY).exists() {
                return Err("create this machine's key first".into());
            }
            if !std::path::Path::new("/usr/sbin/syncoid").exists() {
                return Err("syncoid is not installed (apt install sanoid)".into());
            }
            state["repl_pull"][target.as_str()] = json!({"host": host, "source": source});
            install_repl_units(cfg)?;
            save_manage(cfg, &state)?;
            run(&["systemctl", "start", "--no-block", "cairn-repl.service"], None)?;
            Ok(format!("op=repl_pull_save host={host} source={source} target={target}"))
        }
        "repl_pull_delete" => {
            need(f.replication)?;
            // The copy stays: the panel never deletes a dataset.
            if state["repl_pull"].as_object_mut().and_then(|m| m.remove(&name)).is_none() {
                return Err("unknown replication".into());
            }
            save_manage(cfg, &state)?;
            Ok(format!("op=repl_pull_delete target={name}"))
        }
        "repl_run" => {
            need(f.replication)?;
            run(&["systemctl", "start", "--no-block", "cairn-repl.service"], None)?;
            Ok("op=repl_run".into())
        }
        "snap_restore" | "snap_clone" | "snap_rollback" => restore::manage_op(cfg, a, &state),
        "autosnap_labels" | "autosnap_keep" | "scrub_every" | "smart_every" => schedules::manage_op(cfg, a, &mut state),
        "enc_create" | "enc_unlock" | "enc_lock" | "enc_boot" => encryption::manage_op(cfg, a, &mut state),
        "restic_repo_save" | "restic_repo_delete" | "restic_key" | "restic_job_save" | "restic_job_delete" | "restic_run" | "restic_restore" => offsite::manage_op(cfg, a, &mut state),
        _ => Err("unknown operation".into()),
    }
}

/// (depth, name, state) of each row of the config section of `zpool status`.
fn status_rows(status: &str) -> Vec<(usize, String, String)> {
    let Some(config) = status.split("\nconfig:").nth(1) else { return vec![] };
    config
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("NAME"))
        .skip(1)
        .take_while(|l| !l.trim().is_empty())
        .map(|l| {
            let body = l.strip_prefix('\t').unwrap_or(l);
            let mut f = body.split_whitespace();
            (body.len() - body.trim_start().len(), f.next().unwrap_or("").to_string(), f.next().unwrap_or("").to_string())
        })
        .collect()
}

/// A top-level vdev: its section ("" = data, else logs, cache, spares,
/// special, dedup), name, state, leaves (name, state), and whether a
/// replacing/spare vdev sits inside it.
struct Vdev {
    section: String,
    name: String,
    state: String,
    leaves: Vec<(String, String)>,
    nested: bool,
}

/// Every top-level vdev of `pool` (rows of its own `zpool status`).
fn vdevs(rows: &[(usize, String, String)], pool: &str) -> Vec<Vdev> {
    let Some(start) = rows.iter().position(|r| r.0 == 0 && r.1 == pool) else { return vec![] };
    let body = &rows[start + 1..];
    let (mut out, mut section, mut i) = (vec![], String::new(), 0);
    while i < body.len() {
        let top = &body[i];
        if top.0 == 0 {
            section = top.1.clone(); // "logs", "cache", "spares"…: same depth as the pool
            i += 1;
            continue;
        }
        let end = i + 1 + body[i + 1..].iter().position(|r| r.0 <= top.0).unwrap_or(body.len() - i - 1);
        let kids = &body[i + 1..end];
        let leaves: Vec<(String, String)> = if kids.is_empty() {
            vec![(top.1.clone(), top.2.clone())]
        } else {
            kids.iter().enumerate().filter(|(k, r)| kids.get(k + 1).is_none_or(|n| n.0 <= r.0)).map(|(_, r)| (r.1.clone(), r.2.clone())).collect()
        };
        out.push(Vdev { section: section.clone(), name: top.1.clone(), state: top.2.clone(), leaves, nested: kids.iter().any(|r| r.0 > top.0 + 2) });
        i = end;
    }
    out
}

/// The data vdev of `pool` holding the leaf `dev` (never logs, cache or spares).
fn vdev_of(rows: &[(usize, String, String)], pool: &str, dev: &str) -> Option<Vdev> {
    vdevs(rows, pool).into_iter().find(|v| v.section.is_empty() && v.leaves.iter().any(|l| l.0 == dev))
}

/// Disks of a vdev that may fail without losing data.
fn parity(v: &Vdev) -> i64 {
    if v.name.starts_with("mirror") {
        return v.leaves.len() as i64 - 1;
    }
    let level = v.name.strip_prefix("raidz").or_else(|| v.name.strip_prefix("draid"));
    level.map_or(0, |r| r.chars().next().and_then(|c| c.to_digit(10)).unwrap_or(1) as i64)
}

/// Validated argv for disk_offline / disk_online / disk_replace on `pool`,
/// from its `zpool status` and the free disks (by-id names).
fn disk_argv(op: &str, pool: &str, status: &str, free: &[String], a: &Value) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let dev = s("device");
    let v = vdev_of(&status_rows(status), pool, &dev).ok_or("not a disk of this pool")?;
    let state = v.leaves.iter().find(|l| l.0 == dev).map_or("", |l| l.1.as_str());
    let argv = |x: &[&str]| x.iter().map(|s| s.to_string()).collect();
    if op == "disk_online" {
        return if state == "OFFLINE" { Ok(argv(&["zpool", "online", pool, &dev])) } else { Err("this disk is not offline".into()) };
    }
    if s("confirm") != pool {
        return Err("confirmation: type the pool name again".into());
    }
    if v.nested || status.contains("resilver in progress") {
        return Err("a replacement or resilver is in progress on this pool: wait for it to finish".into());
    }
    if op == "disk_offline" {
        if state == "OFFLINE" {
            return Err("this disk is already offline".into());
        }
        // zpool itself refuses below zero ("no valid replicas"); a healthy
        // disk is only taken offline if the vdev keeps one level of redundancy.
        let others_down = v.leaves.iter().filter(|l| l.0 != dev && l.1 != "ONLINE").count() as i64;
        if parity(&v) - others_down - 1 < i64::from(state == "ONLINE") {
            return Err(format!("{}: offlining this disk would leave no redundancy, replace it instead (the old disk keeps working until the copy is done)", v.name));
        }
        return Ok(argv(&["zpool", "offline", pool, &dev]));
    }
    let new = s("new");
    if !free.contains(&new) {
        return Err("replacement: a free disk only".into());
    }
    Ok(argv(&["zpool", "replace", pool, &dev, &format!("/dev/disk/by-id/{new}")]))
}

/* ---------- pool layout: log, cache, spare, data vdevs, RAIDZ expansion ---------- */

/// Validated argv for vdev_add / vdev_remove / raidz_expand on `pool`, from
/// its `zpool status` and the free disks (by-id names). Never -f: zpool's own
/// checks (mismatched replication, disk in use) stay in force.
fn vdev_argv(op: &str, pool: &str, status: &str, free: &[String], a: &Value) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let all = vdevs(&status_rows(status), pool);
    let mut argv: Vec<String> = vec!["zpool".into()];
    if op == "vdev_remove" {
        // Only what zpool removes without moving data: a log, a cache or a spare device.
        let dev = s("device");
        let v = all.iter().find(|v| v.name == dev && ["logs", "cache", "spares"].contains(&v.section.as_str())).ok_or("only a log, cache or spare device can be removed")?;
        if v.state == "INUSE" {
            return Err("this spare is standing in for a failed disk: replace that disk first".into());
        }
        argv.extend(["remove".into(), pool.into(), dev]);
        return Ok(argv);
    }
    if s("confirm") != pool {
        return Err("confirmation: type the pool name again".into());
    }
    let data: Vec<&Vdev> = all.iter().filter(|v| v.section.is_empty()).collect();
    if op == "raidz_expand" {
        let vdev = s("vdev");
        if !data.iter().any(|v| v.name == vdev && v.name.starts_with("raidz")) {
            return Err("not a RAIDZ group of this pool".into());
        }
        if status.contains("in progress") {
            return Err("a scrub, resilver or expansion is in progress on this pool: wait for it to finish".into());
        }
        let new = s("new");
        if !free.contains(&new) {
            return Err("expansion: a free disk only".into());
        }
        argv.extend(["attach".into(), pool.into(), vdev, format!("/dev/disk/by-id/{new}")]);
        return Ok(argv);
    }
    let (role, disks) = (s("role"), strings(a, "disks"));
    let mut unique = disks.clone();
    unique.sort();
    unique.dedup();
    if disks.is_empty() || disks.len() > 32 || unique.len() != disks.len() || !disks.iter().all(|d| free.contains(d)) {
        return Err("free disks only, each used once".into());
    }
    argv.extend(["add".into(), pool.into()]);
    match role.as_str() {
        // Two or three log devices are mirrored: a lone log lost in a crash loses the last writes.
        "log" if disks.len() <= 3 => argv.extend(if disks.len() > 1 { vec!["log".into(), "mirror".into()] } else { vec!["log".into()] }),
        "log" => return Err("log: one disk, or two or three mirrored".into()),
        "cache" | "spare" => argv.push(role.clone()),
        "data" => {
            let layout = s("layout");
            let Some((_, min)) = LAYOUTS.iter().find(|(l, _)| *l == layout) else { return Err("unknown layout".into()) };
            if disks.len() < *min || (layout == "stripe" && disks.len() != 1) {
                return Err(format!("{layout}: at least {min} free disk(s), each used once"));
            }
            // A group with less redundancy than the existing ones would become the weak point of the whole pool.
            let new = Vdev { section: String::new(), name: format!("{layout}-new"), state: String::new(), leaves: disks.iter().map(|d| (d.clone(), String::new())).collect(), nested: false };
            let weakest = data.iter().map(|v| parity(v)).min().unwrap_or(0);
            if parity(&new) < weakest {
                return Err(format!("{layout} would lower the redundancy of the pool: its groups survive {weakest} failed disk(s)"));
            }
            if layout != "stripe" {
                argv.push(layout);
            }
        }
        _ => return Err("unknown role".into()),
    }
    argv.extend(disks.iter().map(|d| format!("/dev/disk/by-id/{d}")));
    Ok(argv)
}

/// (name, id, state, text) of each pool listed by `zpool import` (no argument).
fn parse_importable(out: &str) -> Vec<Value> {
    out.split("  pool: ").skip(1).filter_map(|b| {
        let field = |k: &str| b.lines().find_map(|l| l.trim().strip_prefix(k)).map(|v| v.trim().to_string());
        let name = b.lines().next()?.trim().to_string();
        let id = field("id:")?;
        Some(json!({"name": name, "id": id, "state": field("state:").unwrap_or_default(), "text": format!("  pool: {}", b.trim_end())}))
    }).collect()
}

/// Validated argv for pool_export / pool_import / pool_upgrade / pool_trim / pool_autotrim.
/// Export is refused while shares, exports or replications use the pool;
/// import takes a pool from the `zpool import` listing, by id, never -f.
fn pool_argv(op: &str, a: &Value, pools: &[String], importable: &[Value], rows: &[Zrow], state: &Value, exports: &[String]) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let pool = s("pool");
    let v = |x: &[&str]| -> Vec<String> { x.iter().map(|s| s.to_string()).collect() };
    if op == "pool_import" {
        let id = s("id");
        let p = importable.iter().find(|p| p["id"] == id.as_str()).ok_or("not in the list of importable pools")?;
        if pools.iter().any(|x| p["name"] == x.as_str()) {
            return Err("a pool with this name is already imported".into());
        }
        return Ok(v(&["zpool", "import", &id]));
    }
    if !pools.contains(&pool) {
        return Err("unknown pool".into());
    }
    match op {
        "pool_trim" => Ok(v(&["zpool", "trim", &pool])),
        "pool_autotrim" => Ok(v(&["zpool", "set", if a["on"] == true { "autotrim=on" } else { "autotrim=off" }, &pool])),
        "pool_upgrade" | "pool_export" => {
            if s("confirm") != pool {
                return Err("confirmation: type the pool name again".into());
            }
            if op == "pool_upgrade" {
                return Ok(v(&["zpool", "upgrade", &pool]));
            }
            let under: Vec<&Zrow> = rows.iter().filter(|r| r.name == pool || r.name.starts_with(&format!("{pool}/"))).collect();
            let used = in_use(state, exports, &under);
            if !used.is_empty() {
                return Err(format!("still in use, remove it first from: {}", used.join(", ")));
            }
            Ok(v(&["zpool", "export", &pool]))
        }
        _ => Err("unknown operation".into()),
    }
}


/* ---------- iSCSI export of volumes (LIO, targetcli) ---------- */

const ISCSI_DROPIN: &str = "/etc/systemd/system/rtslib-fb-targetctl.service.d/cairn-nas.conf";

/// Lowercase, `/` -> `.`, `_` -> `-`: what an iSCSI name accepts.
fn iqn_part(s: &str) -> String {
    s.to_ascii_lowercase().replace('/', ".").replace('_', "-")
}

/// An initiator name: iqn.… or eui.…, lowercase letters, digits, `.`, `-`, `:`.
fn is_iqn(s: &str) -> bool {
    (s.starts_with("iqn.") || s.starts_with("eui.")) && s.len() <= 223 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".-:".contains(c))
}

/// targetcli commands for iscsi_save / iscsi_delete of a volume, and the new
/// state entry (Null when deleted). One target per volume, its single LUN,
/// access only for the listed initiators (LIO's default: no ACL, no access).
fn iscsi_plan(op: &str, a: &Value, rows: &[Zrow], state: &Value, base: &str) -> Result<(Vec<Vec<String>>, Value), String> {
    let zvol = a["zvol"].as_str().unwrap_or("").to_string();
    let old = &state["iscsi"][zvol.as_str()];
    let tc = |x: &[&str]| -> Vec<String> { std::iter::once("targetcli").chain(x.iter().copied()).map(String::from).collect() };
    if op == "iscsi_delete" {
        let (Some(iqn), Some(bs)) = (old["iqn"].as_str(), old["backstore"].as_str()) else { return Err("unknown export".into()) };
        return Ok((vec![tc(&["/iscsi", "delete", iqn]), tc(&["/backstores/block", "delete", bs])], Value::Null));
    }
    if !rows.iter().any(|r| r.name == zvol && r.kind == "volume") {
        return Err("unknown volume".into());
    }
    let mut inits: Vec<String> = strings(a, "initiators").iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    inits.sort();
    inits.dedup();
    if inits.is_empty() || inits.len() > 32 || !inits.iter().all(|i| is_iqn(i)) {
        return Err("initiators: one iSCSI name (iqn.…) per machine, 32 at most".into());
    }
    let (iqn, bs) = (format!("{base}:{}", iqn_part(&zvol)), format!("cairn.{}", iqn_part(&zvol)));
    if state["iscsi"].as_object().into_iter().flatten().any(|(z, e)| z != &zvol && e["iqn"] == iqn.as_str()) {
        return Err("another volume already has this iSCSI name".into());
    }
    let acls = format!("/iscsi/{iqn}/tpg1/acls");
    let mut cmds = vec![];
    let before = if old.is_object() {
        strings(old, "initiators")
    } else {
        cmds.push(tc(&["/backstores/block", "create", &format!("name={bs}"), &format!("dev=/dev/zvol/{zvol}")]));
        cmds.push(tc(&["/iscsi", "create", &iqn]));
        cmds.push(tc(&[&format!("/iscsi/{iqn}/tpg1/luns"), "create", &format!("/backstores/block/{bs}")]));
        vec![]
    };
    cmds.extend(before.iter().filter(|i| !inits.contains(i)).map(|i| tc(&[&acls, "delete", i])));
    cmds.extend(inits.iter().filter(|i| !before.contains(i)).map(|i| tc(&[&acls, "create", i])));
    Ok((cmds, json!({"iqn": iqn, "backstore": bs, "initiators": inits})))
}

/// Exports are restored at boot by rtslib-fb-targetctl: after the zvols exist.
fn install_iscsi_dropin() -> Result<(), String> {
    let text = format!("# Managed by {MARK}: restore iSCSI exports once the ZFS volumes exist.\n[Unit]\nAfter=zfs-volumes.target\nWants=zfs-volumes.target\n");
    if read(ISCSI_DROPIN) != text {
        let _ = fs::create_dir_all("/etc/systemd/system/rtslib-fb-targetctl.service.d");
        write_atomic(ISCSI_DROPIN, &text)?;
        run(&["systemctl", "daemon-reload"], None)?;
    }
    Ok(())
}

/* ---------- actions ---------- */

/* ---------- replication (syncoid, pulled by the backup machine) ---------- */

const REPL_USER: &str = "cairn-repl"; // on the source: may only zfs send (zfs allow send,hold)
const REPL_HOME: &str = "/var/lib/cairn-repl";
const REPL_KEY: &str = "/var/lib/cairn-nas/repl_ed25519"; // on the backup machine
const REPL_MAX_AGE_S: u64 = 26 * 3600; // daily pull at 03:00, plus a margin
// Kept on the backup machine per zfs-auto-snapshot label: longer than the source.
const REPL_KEEP: [(&str, usize); 5] = [("frequent", 4), ("hourly", 24), ("daily", 62), ("weekly", 16), ("monthly", 24)];

/// "ssh-ed25519 <base64>" from a pasted public key line (comment dropped).
fn ssh_key(s: &str) -> Option<String> {
    let mut f = s.split_whitespace();
    let (kind, b64) = (f.next()?, f.next()?);
    (kind == "ssh-ed25519" && (60..=100).contains(&b64.len()) && b64.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)))
        .then(|| format!("{kind} {b64}"))
}

/// authorized_keys of the source account: each backup machine, from its own address only.
fn render_repl_keys(state: &Value) -> String {
    let mut out = format!("# Managed by {MARK}: backup machines allowed to pull (zfs send only).\n");
    for (host, e) in state["repl_allow"].as_object().into_iter().flatten() {
        out += &format!("from=\"{host}\",restrict {} {REPL_USER}@{host}\n", e["key"].as_str().unwrap_or(""));
    }
    out
}

/// Replication state only: nothing to render, so no apply() (and no firewall reload).
fn save_manage(cfg: &Config, state: &Value) -> Result<(), String> {
    write_atomic(&cfg.manage_file, &state.to_string())
}

fn write_repl_keys(state: &Value) -> Result<(), String> {
    let dir = format!("{REPL_HOME}/.ssh");
    fs::create_dir_all(&dir).map_err(|e| format!("{dir}: {e}"))?;
    write_atomic(&format!("{dir}/authorized_keys"), &render_repl_keys(state))?;
    run(&["chown", "-R", &format!("{REPL_USER}:"), &dir], None)?;
    run(&["chmod", "-R", "go-rwx", &dir], None)
}

/// The nightly cairn-repl service: this binary with --pull.
fn install_repl_units(cfg: &Config) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let units = [
        ("/etc/systemd/system/cairn-repl.service", format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: pull the replications set up in the panel\n\
            After=network-online.target zfs.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nEnvironment=HOME=/root\nExecStart={} --pull {}\n",
            exe.display(), cfg.path)),
        ("/etc/systemd/system/cairn-repl.timer", format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: nightly replication\n\n\
            [Timer]\nOnCalendar=*-*-* 03:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n")),
    ];
    for (file, text) in &units {
        if read(file) != *text {
            write_atomic(file, text)?;
        }
    }
    run(&["systemctl", "daemon-reload"], None)?;
    run(&["systemctl", "enable", "--now", "cairn-repl.timer"], None)
}

fn pull_argv(host: &str, source: &str, target: &str) -> Vec<String> {
    // --no-sync-snap: the source's own automatic snapshots are what is copied.
    ["syncoid", "-r", "--no-sync-snap", "--no-privilege-elevation", &format!("--sshkey={REPL_KEY}"),
        "--sshoption=StrictHostKeyChecking=accept-new", &format!("{REPL_USER}@{host}:{source}"), target]
        .iter().map(|x| x.to_string()).collect()
}

/// Snapshots of one dataset (oldest first) beyond REPL_KEEP; manual ones are never touched.
fn to_prune(names: &[&str]) -> Vec<String> {
    let mut out = vec![];
    for (label, keep) in REPL_KEEP {
        let tag = format!("@zfs-auto-snap_{label}-");
        let mine: Vec<&&str> = names.iter().filter(|n| n.contains(&tag)).collect();
        out.extend(mine.iter().take(mine.len().saturating_sub(keep)).map(|n| n.to_string()));
    }
    out
}

/// `cairn-nas --pull <config>`: every pull set up in the panel, then pruning. Run by cairn-repl.service.
fn pull(cfg: &Config) -> i32 {
    let mut failed = 0;
    for (target, j) in load_manage(cfg)["repl_pull"].as_object().into_iter().flatten() {
        let argv = pull_argv(j["host"].as_str().unwrap_or(""), j["source"].as_str().unwrap_or(""), target);
        eprintln!("pull {}", argv.join(" "));
        if !Command::new(&argv[0]).args(&argv[1..]).status().is_ok_and(|s| s.success()) {
            eprintln!("pull {target}: failed");
            failed += 1;
            continue;
        }
        for ds in cmd(&["zfs", "list", "-H", "-o", "name", "-r", target]).lines() {
            let snaps = cmd(&["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-d", "1", ds]);
            for snap in to_prune(&snaps.lines().collect::<Vec<_>>()) {
                let _ = run(&["zfs", "destroy", &snap], None);
            }
        }
    }
    i32::from(failed > 0)
}

/// One row of `zfs list -Hp -t filesystem,volume -o name,type,mountpoint,volsize,volblocksize`.
struct Zrow {
    name: String,
    kind: String, // filesystem | volume
    mount: String,
    volsize: u64, // 0 for a filesystem
    block: u64,
}

fn parse_zrows(out: &str) -> Vec<Zrow> {
    out.lines().filter_map(|l| {
        let f: Vec<&str> = l.split('\t').collect();
        let [name, kind, mount, vs, bs] = f[..] else { return None };
        Some(Zrow { name: name.into(), kind: kind.into(), mount: mount.into(), volsize: vs.parse().unwrap_or(0), block: bs.parse().unwrap_or(0) })
    }).collect()
}

fn zfs_rows() -> Vec<Zrow> {
    parse_zrows(&cmd(&["zfs", "list", "-Hp", "-t", "filesystem,volume", "-o", "name,type,mountpoint,volsize,volblocksize"]))
}

/// "100G", "1.5T", "512M" in bytes (powers of 1024); None for anything else.
fn size_bytes(s: &str) -> Option<u64> {
    if s == "none" || !is_quota(s) {
        return None;
    }
    let (num, unit) = match s.chars().last()? {
        c if c.is_ascii_alphabetic() => (&s[..s.len() - 1], c.to_ascii_uppercase()),
        _ => (s, 'B'),
    };
    let b = num.parse::<f64>().ok()? * 1024f64.powi("BKMGTP".find(unit)? as i32);
    (1.0..9.0e18).contains(&b).then_some(b as u64)
}

/// Validated argv for zvol_create / zvol_grow. Sizes are sent in bytes,
/// rounded up to the block size (zfs refuses any other volsize).
fn zvol_argv(op: &str, a: &Value, rows: &[Zrow]) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let ds = s("dataset");
    let size = size_bytes(&s("size")).ok_or("size: e.g. 100G, 1.5T")?;
    let v = |x: &[&str]| -> Vec<String> { x.iter().map(|s| s.to_string()).collect() };
    if op == "zvol_grow" {
        let vol = rows.iter().find(|r| r.name == ds && r.kind == "volume").ok_or("unknown volume")?;
        let bs = vol.block.max(512);
        let new = size.div_ceil(bs) * bs;
        if new <= vol.volsize {
            return Err("a volume can only grow: give a size larger than the current one".into());
        }
        return Ok(v(&["zfs", "set", &format!("volsize={new}"), &ds]));
    }
    let ok = ds.rsplit_once('/').is_some_and(|(p, leaf)| rows.iter().any(|r| r.name == p && r.kind == "filesystem") && is_name(leaf));
    if !ok || rows.iter().any(|r| r.name == ds) {
        return Err("volume refused (existing parent dataset + simple name)".into());
    }
    let (bs, comp) = (s("volblocksize"), s("compression"));
    let block = 8192u64 << VOLBLOCK.iter().position(|b| *b == bs).ok_or("block size: 8K to 128K")?;
    if !COMPRESSION.contains(&comp.as_str()) {
        return Err("value refused".into());
    }
    let mut argv = v(&["zfs", "create"]);
    if a["sparse"] == true {
        argv.push("-s".into()); // thin: no space reserved up front
    }
    argv.extend(v(&["-V", &(size.div_ceil(block) * block).to_string(), "-o", &format!("volblocksize={bs}"), "-o", &format!("compression={comp}"), &ds]));
    Ok(argv)
}

/// What still points into these datasets: the panel's shares, /etc/exports, replications.
fn in_use(state: &Value, exports: &[String], under: &[&Zrow]) -> Vec<String> {
    // A mount point of "/" (root on ZFS) contains every path.
    let mounts: Vec<&str> = under.iter().filter(|r| r.mount.starts_with('/')).map(|r| r.mount.trim_end_matches('/')).collect();
    let inside = |p: &str| mounts.iter().any(|m| p == *m || p.starts_with(&format!("{m}/")));
    let names: Vec<&str> = under.iter().map(|r| r.name.as_str()).collect();
    let mut out = vec![];
    for kind in ["nfs", "smb"] {
        for (n, sh) in state[kind].as_object().into_iter().flatten() {
            if inside(sh["path"].as_str().unwrap_or("")) {
                out.push(format!("{kind}:{n}"));
            }
        }
    }
    out.extend(exports.iter().filter(|p| inside(p)).map(|p| format!("/etc/exports:{p}")));
    for (host, e) in state["repl_allow"].as_object().into_iter().flatten() {
        if strings(e, "datasets").iter().any(|d| names.contains(&d.as_str())) {
            out.push(format!("repl:{host}"));
        }
    }
    out.extend(state["iscsi"].as_object().into_iter().flatten().filter(|(z, _)| names.contains(&z.as_str())).map(|(z, _)| format!("iscsi:{z}")));
    out.extend(state["repl_pull"].as_object().into_iter().flatten().filter(|(t, _)| names.contains(&t.as_str())).map(|(t, _)| format!("repl:{t}")));
    out.extend(state["restic_jobs"].as_object().into_iter().flatten().filter(|(d, _)| names.contains(&d.as_str())).map(|(d, _)| format!("backup:{d}")));
    out
}

/// Validated argv for dataset_destroy (a dataset or a volume, never a pool
/// root) and pool_destroy: full name retyped, refused while anything uses it.
/// Snapshots go with it (-r); child datasets only when asked. Never -f or -R:
/// a busy mount, a hold or a clone makes zfs refuse, and its message is shown.
fn destroy_argv(op: &str, a: &Value, rows: &[Zrow], snaps: &[String], pools: &[String], state: &Value, exports: &[String]) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let pool_op = op == "pool_destroy";
    let target = if pool_op { s("pool") } else { s("dataset") };
    if pool_op && !pools.contains(&target) {
        return Err("unknown pool".into());
    }
    if !pool_op && !target.contains('/') {
        return Err("never the root of a pool: delete the pool instead".into());
    }
    if !pool_op && !rows.iter().any(|r| r.name == target) {
        return Err("unknown dataset".into());
    }
    if s("confirm") != target {
        return Err(if pool_op { "confirmation: type the pool name again" } else { "confirmation: type the full name again" }.into());
    }
    let under: Vec<&Zrow> = rows.iter().filter(|r| r.name == target || r.name.starts_with(&format!("{target}/"))).collect();
    let used = in_use(state, exports, &under);
    if !used.is_empty() {
        return Err(format!("still in use, remove it first from: {}", used.join(", ")));
    }
    if pool_op {
        return Ok(vec!["zpool".into(), "destroy".into(), target]); // the disks' partitions stay as they are
    }
    if under.len() > 1 && a["recursive"] != true {
        return Err("it has child datasets: tick “with its children” to delete them too".into());
    }
    let mut argv = vec!["zfs".to_string(), "destroy".into()];
    if under.len() > 1 || snaps.iter().any(|n| n.starts_with(&format!("{target}@"))) {
        argv.push("-r".into());
    }
    argv.push(target);
    Ok(argv)
}

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
        (Method::Get, "/api/peers") if !cfg.peers.is_empty() => respond(r, 200, peers::view(cfg).to_string(), "application/json"),
        (Method::Get, "/api/manage") => respond(r, 200, manage_view(cfg, lang).to_string(), "application/json"),
        (Method::Get, "/api/updates") => respond(r, 200, UPGRADE.lock().unwrap_or_else(|e| e.into_inner()).to_string(), "application/json"),
        // On demand only: zpool import reads the label of every disk.
        (Method::Get, "/api/importable") if cfg.features.pools => respond(r, 200, json!(parse_importable(&cmd(&["zpool", "import"]))).to_string(), "application/json"),
        (Method::Get, "/api/browse" | "/api/download") if cfg.features.restore => restore::serve(r, &path, lang),
        (Method::Get, "/api/backups") if cfg.features.offsite => offsite::serve(cfg, r, lang),
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
        (Method::Get, "/api/peers") => respond(r, 200, include_str!("../demo/peers.json").into(), jsn),
        (Method::Get, "/api/importable") => respond(r, 200, json!(parse_importable(include_str!("../demo/import.txt"))).to_string(), jsn),
        (Method::Get, "/api/browse" | "/api/download") => restore::demo_serve(r, &path),
        (Method::Get, "/api/backups") => offsite::demo_serve(r),
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
    if path == "--pull" {
        let cfg = Config::load(&std::env::args().nth(2).expect("usage: cairn-nas --pull /etc/cairn-nas.json"));
        std::process::exit(pull(&cfg));
    }
    if path == "--backup" || path == "--restore" {
        // --backup <daily|weekly|dataset> <config>, --restore <dataset> <id> <path> <target> <config> (systemd units)
        let mut args: Vec<String> = std::env::args().skip(2).collect();
        let cfg = Config::load(&args.pop().expect("usage: cairn-nas --backup|--restore ... /etc/cairn-nas.json"));
        std::process::exit(if path == "--backup" { offsite::backup_cli(&cfg, args.first().map_or("", String::as_str)) } else { offsite::restore_cli(&cfg, &args) });
    }
    if path == "--selftest" {
        std::process::exit(schedules::selftest_cli(&std::env::args().nth(2).unwrap_or_default()));
    }
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
    if !cfg.peers.is_empty() {
        std::thread::spawn(move || peers::poll_loop(cfg));
    }
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
        let scrub = "  pool: fast\n  scan: scrub repaired 0B in 00:10:02 with 3 errors on Sun Nov  8 00:34:03 2026\nerrors: No known data errors\n";
        assert_eq!(pool_problems("", scrub, 85).values().collect::<Vec<_>>(), ["Pool fast: last scrub found 3 errors"]);
        assert!(pool_problems("", &scrub.replace("with 3", "with 0"), 85).is_empty());
        assert_eq!(tr("fr", "Pool fast: last scrub found 3 errors"), "Pool fast : le dernier scrub a trouvé 3 erreurs");
    }

    #[test]
    fn held_packages_stay_apart() {
        let list = "En train de lister…\nwazuh-agent/stable 4.14.9-1 amd64 [upgradable from: 4.14.8-1]\nopenssl/trixie-security 3.5.4-1 amd64 [upgradable from: 3.5.1-1]\n";
        let (up, held) = upgradable(list, "wazuh-agent\n");
        assert_eq!((up, held), (vec!["openssl".to_string()], vec!["wazuh-agent".to_string()]));
    }

    #[test]
    fn apt_status_progress() {
        assert_eq!(apt_status("pmstatus:openssl:50.0:Installing openssl (amd64)").unwrap(), json!({"running": true, "phase": "install", "pct": 70, "pkg": "openssl"}));
        assert_eq!(apt_status("dlstatus:3:100:Retrieving file 3 of 8").unwrap()["pct"], 40);
        assert!(apt_status("Setting up openssl (3.5.4-1) ...").is_none());
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

    fn status(rows: &str) -> String {
        format!("  pool: tank\n state: DEGRADED\nconfig:\n\n\tNAME        STATE     READ WRITE CKSUM\n{rows}\nerrors: No known data errors\n")
    }

    #[test]
    fn disk_replacement() {
        let free = ["ata-NEW".to_string()];
        let go = |st: &str, a: Value| disk_argv(a["op"].as_str().unwrap(), "tank", st, &free, &a);
        let mirror = status("\ttank        ONLINE       0     0     0\n\t  mirror-0  ONLINE       0     0     0\n\t    ata-A   ONLINE       0     0     0\n\t    ata-B   ONLINE       0     0     0\n\tlogs\n\t  ata-L     ONLINE       0     0     0");
        // Healthy 2-way mirror: offline would leave no redundancy (zpool allows it).
        let e = go(&mirror, json!({"op": "disk_offline", "device": "ata-A", "confirm": "tank"})).unwrap_err();
        assert!(e.starts_with("mirror-0: offlining"), "{e}");
        assert_eq!(tr("fr", &e), "mirror-0 : mettre ce disque hors ligne ne laisserait aucune redondance, remplacez-le plutôt (l'ancien disque reste en service jusqu'à la fin de la copie)");
        // Replace keeps redundancy: allowed, by-id path of a free disk only, confirmation required.
        assert_eq!(go(&mirror, json!({"op": "disk_replace", "device": "ata-A", "new": "ata-NEW", "confirm": "tank"})).unwrap(),
            ["zpool", "replace", "tank", "ata-A", "/dev/disk/by-id/ata-NEW"]);
        assert!(go(&mirror, json!({"op": "disk_replace", "device": "ata-A", "new": "ata-B", "confirm": "tank"})).is_err()); // pool member
        assert!(go(&mirror, json!({"op": "disk_replace", "device": "ata-A", "new": "../../sda", "confirm": "tank"})).is_err());
        assert!(go(&mirror, json!({"op": "disk_replace", "device": "ata-A", "new": "ata-NEW", "confirm": "tan"})).is_err());
        // Only data-vdev leaves: not the pool, a vdev, a log device or anything else.
        for dev in ["tank", "mirror-0", "ata-L", "logs", "-f", ""] {
            assert_eq!(go(&mirror, json!({"op": "disk_replace", "device": dev, "new": "ata-NEW", "confirm": "tank"})).unwrap_err(), "not a disk of this pool");
        }
        assert!(go(&mirror, json!({"op": "disk_online", "device": "ata-A"})).is_err()); // not offline
        // 3-way mirror: one healthy disk may go offline.
        let three = status("\ttank        ONLINE       0     0     0\n\t  mirror-0  ONLINE       0     0     0\n\t    ata-A   ONLINE       0     0     0\n\t    ata-B   ONLINE       0     0     0\n\t    ata-C   ONLINE       0     0     0");
        assert_eq!(go(&three, json!({"op": "disk_offline", "device": "ata-C", "confirm": "tank"})).unwrap(), ["zpool", "offline", "tank", "ata-C"]);
        assert!(go(&three, json!({"op": "disk_offline", "device": "ata-C"})).is_err()); // no confirmation
        // Degraded mirror (missing disk shown by guid): the healthy one stays, the missing one is replaced.
        let degraded = status("\ttank                  DEGRADED     0     0     0\n\t  mirror-0            DEGRADED     0     0     0\n\t    7656787387782886656  UNAVAIL      0     0     0  was /dev/disk/by-id/ata-A\n\t    ata-B             ONLINE       0     0     0");
        assert!(go(&degraded, json!({"op": "disk_offline", "device": "ata-B", "confirm": "tank"})).is_err());
        assert_eq!(go(&degraded, json!({"op": "disk_replace", "device": "7656787387782886656", "new": "ata-NEW", "confirm": "tank"})).unwrap()[3], "7656787387782886656");
        // raidz1 with a disk offline: online it, never offline a second one.
        let raidz = status("\ttank        DEGRADED     0     0     0\n\t  raidz1-0  DEGRADED     0     0     0\n\t    ata-A   OFFLINE      0     0     0\n\t    ata-B   ONLINE       0     0     0\n\t    ata-C   ONLINE       0     0     0");
        assert_eq!(go(&raidz, json!({"op": "disk_online", "device": "ata-A"})).unwrap(), ["zpool", "online", "tank", "ata-A"]);
        assert!(go(&raidz, json!({"op": "disk_offline", "device": "ata-A", "confirm": "tank"})).is_err()); // already
        assert!(go(&raidz, json!({"op": "disk_offline", "device": "ata-B", "confirm": "tank"})).is_err());
        // raidz2: one healthy disk may go; a FAULTED disk may go when one parity is left.
        let raidz2 = status("\ttank        DEGRADED     0     0     0\n\t  raidz2-0  DEGRADED     0     0     0\n\t    ata-A   FAULTED      0     0     0  too many errors\n\t    ata-B   ONLINE       0     0     0\n\t    ata-C   ONLINE       0     0     0\n\t    ata-D   ONLINE       0     0     0");
        assert!(go(&raidz2, json!({"op": "disk_offline", "device": "ata-A", "confirm": "tank"})).is_ok());
        assert!(go(&raidz2, json!({"op": "disk_offline", "device": "ata-B", "confirm": "tank"})).is_err());
        // Single-disk vdev: no redundancy at all.
        let single = status("\ttank        ONLINE       0     0     0\n\t  ata-A     ONLINE       0     0     0\n\t  ata-B     ONLINE       0     0     0");
        assert!(go(&single, json!({"op": "disk_offline", "device": "ata-B", "confirm": "tank"})).is_err());
        assert!(go(&single, json!({"op": "disk_replace", "device": "ata-B", "new": "ata-NEW", "confirm": "tank"})).is_ok());
        // Resilver in progress (real zpool 2.3 output): nothing but online until it is done.
        let resilver = "  pool: tank\n state: ONLINE\n  scan: resilver in progress since Thu Nov  5 09:55:35 2026\n\t1.47G / 1.47G scanned, 34.4M / 1.47G issued at 34.4M/s\n\t18.4M resilvered, 2.29% done, 00:00:42 to go\nconfig:\n\n\tNAME               STATE     READ WRITE CKSUM\n\ttank               ONLINE       0     0     0\n\t  mirror-0         ONLINE       0     0     0\n\t    ata-A          ONLINE       0     0     0\n\t    replacing-1    ONLINE       0     0     0\n\t      ata-B        ONLINE       0     0     0\n\t      ata-C        ONLINE       0     0     0  (resilvering)\n\nerrors: No known data errors\n";
        assert_eq!(go(resilver, json!({"op": "disk_replace", "device": "ata-A", "new": "ata-NEW", "confirm": "tank"})).unwrap_err(),
            "a replacement or resilver is in progress on this pool: wait for it to finish");
        assert!(go(resilver, json!({"op": "disk_offline", "device": "ata-B", "confirm": "tank"})).is_err());
        assert!(go(resilver, json!({"op": "disk_offline", "device": "replacing-1", "confirm": "tank"})).is_err());
    }

    // Real zpool 2.3.9 output: raidz1 + mirrored log + cache + spare ("logs" ends with a tab).
    const SPECIAL: &str = "  pool: zt\n state: ONLINE\nconfig:\n\n\tNAME             STATE     READ WRITE CKSUM\n\tzt               ONLINE       0     0     0\n\t  raidz1-0       ONLINE       0     0     0\n\t    ata-A        ONLINE       0     0     0\n\t    ata-B        ONLINE       0     0     0\n\t    ata-C        ONLINE       0     0     0\n\tlogs\t\n\t  mirror-1       ONLINE       0     0     0\n\t    ata-L1       ONLINE       0     0     0\n\t    ata-L2       ONLINE       0     0     0\n\tcache\n\t  ata-K        ONLINE       0     0     0\n\tspares\n\t  ata-S        AVAIL   \n\nerrors: No known data errors\n";

    #[test]
    fn vdev_tree() {
        let v = vdevs(&status_rows(SPECIAL), "zt");
        let got: Vec<(&str, &str, &str, usize)> = v.iter().map(|v| (v.section.as_str(), v.name.as_str(), v.state.as_str(), v.leaves.len())).collect();
        assert_eq!(got, [("", "raidz1-0", "ONLINE", 3), ("logs", "mirror-1", "ONLINE", 2), ("cache", "ata-K", "ONLINE", 1), ("spares", "ata-S", "AVAIL", 1)]);
        // Disk operations still see the data disks only.
        assert!(vdev_of(&status_rows(SPECIAL), "zt", "ata-B").is_some() && vdev_of(&status_rows(SPECIAL), "zt", "ata-L1").is_none());
    }

    #[test]
    fn vdev_changes() {
        let free = ["ata-N1".to_string(), "ata-N2".to_string(), "ata-N3".to_string()];
        let go = |st: &str, a: Value| vdev_argv(a["op"].as_str().unwrap(), "zt", st, &free, &a);
        let add = |role: &str, disks: &[&str]| json!({"op": "vdev_add", "role": role, "disks": disks, "confirm": "zt"});
        assert_eq!(go(SPECIAL, add("log", &["ata-N1"])).unwrap(), ["zpool", "add", "zt", "log", "/dev/disk/by-id/ata-N1"]);
        assert_eq!(go(SPECIAL, add("log", &["ata-N1", "ata-N2"])).unwrap(), ["zpool", "add", "zt", "log", "mirror", "/dev/disk/by-id/ata-N1", "/dev/disk/by-id/ata-N2"]);
        assert_eq!(go(SPECIAL, add("cache", &["ata-N1"])).unwrap()[3], "cache");
        assert_eq!(go(SPECIAL, add("spare", &["ata-N1", "ata-N2"])).unwrap()[3..5], ["spare", "/dev/disk/by-id/ata-N1"]);
        let mut data = add("data", &["ata-N1", "ata-N2", "ata-N3"]);
        data["layout"] = json!("raidz1");
        assert_eq!(go(SPECIAL, data.clone()).unwrap(), ["zpool", "add", "zt", "raidz1", "/dev/disk/by-id/ata-N1", "/dev/disk/by-id/ata-N2", "/dev/disk/by-id/ata-N3"]);
        // Refusals: not free, twice, no confirmation, unknown role or layout, lower redundancy.
        assert_eq!(go(SPECIAL, add("log", &["ata-A"])).unwrap_err(), "free disks only, each used once");
        assert!(go(SPECIAL, add("log", &["ata-N1", "ata-N1"])).is_err());
        assert!(go(SPECIAL, add("log", &[])).is_err());
        assert!(go(SPECIAL, add("cache", &["../../sda"])).is_err());
        assert!(go(SPECIAL, json!({"op": "vdev_add", "role": "log", "disks": ["ata-N1"], "confirm": "zx"})).is_err());
        assert_eq!(go(SPECIAL, add("special", &["ata-N1"])).unwrap_err(), "unknown role");
        let mut four = add("log", &["ata-N1", "ata-N2", "ata-N3"]);
        assert!(go(SPECIAL, four.clone()).is_ok());
        four["disks"] = json!(["ata-N1", "ata-N2", "ata-N3", "ata-N1"]);
        assert!(go(SPECIAL, four).is_err());
        data["layout"] = json!("stripe");
        assert!(go(SPECIAL, data.clone()).is_err()); // three disks as one stripe: refused
        data["disks"] = json!(["ata-N1"]);
        assert_eq!(go(SPECIAL, data.clone()).unwrap_err(), "stripe would lower the redundancy of the pool: its groups survive 1 failed disk(s)");
        assert_eq!(tr("fr", &go(SPECIAL, data.clone()).unwrap_err()), "stripe réduirait la redondance du pool : ses groupes supportent 1 disque(s) en panne");
        data["layout"] = json!("mirror");
        data["disks"] = json!(["ata-N1", "ata-N2"]);
        assert!(go(SPECIAL, data.clone()).is_ok()); // same redundancy, another layout: zpool decides (never -f)
        data["layout"] = json!("raidz9");
        assert_eq!(go(SPECIAL, data).unwrap_err(), "unknown layout");
        // Removal: log, cache, spare only; a mirrored log goes as a whole.
        let rm = |d: &str| json!({"op": "vdev_remove", "device": d});
        assert_eq!(go(SPECIAL, rm("mirror-1")).unwrap(), ["zpool", "remove", "zt", "mirror-1"]);
        assert_eq!(go(SPECIAL, rm("ata-K")).unwrap(), ["zpool", "remove", "zt", "ata-K"]);
        assert_eq!(go(SPECIAL, rm("ata-S")).unwrap(), ["zpool", "remove", "zt", "ata-S"]);
        for d in ["raidz1-0", "ata-A", "ata-L1", "logs", "zt", "-f", ""] {
            assert_eq!(go(SPECIAL, rm(d)).unwrap_err(), "only a log, cache or spare device can be removed", "{d}");
        }
        assert!(go(&SPECIAL.replace("AVAIL", "INUSE"), rm("ata-S")).is_err());
        // RAIDZ expansion: an existing raidz group, a free disk, nothing in progress.
        let ex = |v: &str, n: &str| json!({"op": "raidz_expand", "vdev": v, "new": n, "confirm": "zt"});
        assert_eq!(go(SPECIAL, ex("raidz1-0", "ata-N1")).unwrap(), ["zpool", "attach", "zt", "raidz1-0", "/dev/disk/by-id/ata-N1"]);
        assert_eq!(go(SPECIAL, ex("mirror-1", "ata-N1")).unwrap_err(), "not a RAIDZ group of this pool");
        assert!(go(SPECIAL, ex("raidz1-0", "ata-A")).is_err());
        let busy = SPECIAL.replace("config:", "expand: expansion of raidz1-0 in progress since Thu Nov  5 14:03:08 2026\n\t756M / 1.76G copied at 756M/s, 41.94% done, 00:00:01 to go\nconfig:");
        assert!(go(&busy, ex("raidz1-0", "ata-N1")).is_err());
        // A mirror pool: one disk alone would lower redundancy; a pair is fine.
        let mirror = status("\ttank        ONLINE       0     0     0\n\t  mirror-0  ONLINE       0     0     0\n\t    ata-A   ONLINE       0     0     0\n\t    ata-B   ONLINE       0     0     0");
        let pair = json!({"op": "vdev_add", "role": "data", "layout": "mirror", "disks": ["ata-N1", "ata-N2"], "confirm": "tank"});
        assert_eq!(vdev_argv("vdev_add", "tank", &mirror, &free, &pair).unwrap()[3], "mirror");
    }

    #[test]
    fn pool_ops() {
        let listing = "   pool: archive\n     id: 116076908731\n  state: ONLINE\n action: The pool can be imported using its name or numeric identifier.\n config:\n\n\tarchive     ONLINE\n\t  ata-X     ONLINE\n\n   pool: tank\n     id: 42\n  state: ONLINE\n status: The pool was last accessed by another system.\n action: The pool can be imported using its name or numeric identifier and\n\tthe '-f' flag.\n config:\n\n\ttank   ONLINE\n";
        let imp = parse_importable(listing);
        assert_eq!(imp.len(), 2);
        assert_eq!((imp[0]["name"].as_str(), imp[0]["id"].as_str(), imp[0]["state"].as_str()), (Some("archive"), Some("116076908731"), Some("ONLINE")));
        assert!(imp[1]["text"].as_str().unwrap().contains("last accessed by another system"));
        assert!(parse_importable("").is_empty());
        assert_eq!(parse_importable(include_str!("../demo/import.txt"))[0]["name"], "archive");
        let rows = parse_zrows("tank\tfilesystem\t/tank\t-\t-\ntank/a\tfilesystem\t/tank/a\t-\t-\nfast\tfilesystem\t/fast\t-\t-\n");
        let pools = ["tank".to_string(), "fast".to_string()];
        let st = json!({"nfs": {"m": {"path": "/tank/a"}}});
        let go = |a: Value| pool_argv(a["op"].as_str().unwrap(), &a, &pools, &imp, &rows, &st, &[]);
        assert_eq!(go(json!({"op": "pool_import", "id": "116076908731"})).unwrap(), ["zpool", "import", "116076908731"]);
        assert_eq!(go(json!({"op": "pool_import", "id": "42"})).unwrap_err(), "a pool with this name is already imported");
        assert_eq!(go(json!({"op": "pool_import", "id": "-f"})).unwrap_err(), "not in the list of importable pools");
        assert_eq!(go(json!({"op": "pool_export", "pool": "tank", "confirm": "tank"})).unwrap_err(), "still in use, remove it first from: nfs:m");
        assert_eq!(go(json!({"op": "pool_export", "pool": "fast", "confirm": "fast"})).unwrap(), ["zpool", "export", "fast"]);
        assert!(go(json!({"op": "pool_export", "pool": "fast"})).is_err());
        assert_eq!(go(json!({"op": "pool_upgrade", "pool": "fast", "confirm": "fast"})).unwrap(), ["zpool", "upgrade", "fast"]);
        assert!(go(json!({"op": "pool_upgrade", "pool": "fast", "confirm": "tank"})).is_err());
        assert!(go(json!({"op": "pool_upgrade", "pool": "-a", "confirm": "-a"})).is_err()); // never all pools
        assert_eq!(go(json!({"op": "pool_trim", "pool": "fast"})).unwrap(), ["zpool", "trim", "fast"]);
        assert_eq!(go(json!({"op": "pool_autotrim", "pool": "tank", "on": true})).unwrap(), ["zpool", "set", "autotrim=on", "tank"]);
        assert_eq!(go(json!({"op": "pool_autotrim", "pool": "tank", "on": "yes"})).unwrap()[2], "autotrim=off");
        assert_eq!(go(json!({"op": "pool_trim", "pool": "other"})).unwrap_err(), "unknown pool");
    }

    #[test]
    fn replication_setup() {
        let k = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        assert_eq!(ssh_key(&format!("{k} root@backup\n")).as_deref(), Some(k));
        assert!(ssh_key("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC").is_none());
        assert!(ssh_key(&format!("{k}\",command=\"sh")).is_none());
        assert!(ssh_key("").is_none());
        let state = json!({"repl_allow": {"10.0.0.1": {"key": k, "datasets": ["tank"]}}});
        assert!(render_repl_keys(&state).ends_with(&format!("from=\"10.0.0.1\",restrict {k} cairn-repl@10.0.0.1\n")));
        assert_eq!(pull_argv("nas", "tank", "backup/tank")[6..], ["cairn-repl@nas:tank", "backup/tank"]);
        let mut names: Vec<String> = (0..6).map(|i| format!("b/t@zfs-auto-snap_frequent-{i}")).collect();
        names.push("b/t@manual".into());
        names.push("b/t@zfs-auto-snap_daily-1".into());
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        assert_eq!(to_prune(&refs), ["b/t@zfs-auto-snap_frequent-0", "b/t@zfs-auto-snap_frequent-1"]);
    }

    #[test]
    fn zvols() {
        let rows = parse_zrows("tank\tfilesystem\t/tank\t-\t-\ntank/vm\tvolume\t-\t10737418240\t16384\nbad\n");
        assert_eq!(rows.len(), 2);
        let go = |a: Value| zvol_argv(a["op"].as_str().unwrap(), &a, &rows);
        assert_eq!(size_bytes("1.5T"), Some(3 << 39));
        assert_eq!(size_bytes("100g"), Some(100 << 30));
        assert!(size_bytes("none").is_none() && size_bytes("-1G").is_none() && size_bytes("1e9").is_none() && size_bytes("").is_none());
        assert_eq!(go(json!({"op": "zvol_create", "dataset": "tank/win", "size": "100G", "sparse": true, "volblocksize": "16K", "compression": "lz4"})).unwrap(),
            ["zfs", "create", "-s", "-V", "107374182400", "-o", "volblocksize=16K", "-o", "compression=lz4", "tank/win"]);
        // Not a multiple of the block: rounded up; not sparse = no -s.
        assert_eq!(go(json!({"op": "zvol_create", "dataset": "tank/w", "size": "1.1K", "volblocksize": "8K", "compression": "off"})).unwrap()[2..4], ["-V", "8192"]);
        for bad in [json!({"dataset": "tank/vm"}), json!({"dataset": "tank/vm/x"}), json!({"dataset": "other/x"}), json!({"dataset": "tank"}), json!({"dataset": "tank/a b"}),
            json!({"size": "1G; rm"}), json!({"size": "none"}), json!({"volblocksize": "4K"}), json!({"compression": "x"})] {
            let mut a = json!({"op": "zvol_create", "dataset": "tank/x", "size": "1G", "volblocksize": "8K", "compression": "lz4"});
            a.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
            assert!(go(a.clone()).is_err(), "{a}");
        }
        assert_eq!(go(json!({"op": "zvol_grow", "dataset": "tank/vm", "size": "20G"})).unwrap(), ["zfs", "set", "volsize=21474836480", "tank/vm"]);
        assert_eq!(go(json!({"op": "zvol_grow", "dataset": "tank/vm", "size": "10G"})).unwrap_err(), "a volume can only grow: give a size larger than the current one");
        assert!(go(json!({"op": "zvol_grow", "dataset": "tank/vm", "size": "5G"})).is_err());
        assert_eq!(go(json!({"op": "zvol_grow", "dataset": "tank", "size": "50G"})).unwrap_err(), "unknown volume");
    }

    #[test]
    fn destroys() {
        let rows = parse_zrows("tank\tfilesystem\t/tank\t-\t-\ntank/a\tfilesystem\t/tank/a\t-\t-\ntank/a/b\tfilesystem\t/srv/b\t-\t-\n\
            tank/ab\tfilesystem\t/tank/ab\t-\t-\ntank/vm\tvolume\t-\t1073741824\t16384\nfast\tfilesystem\t/fast\t-\t-\n");
        let snaps = ["tank/vm@s1".to_string(), "tank/ab2@x".to_string()];
        let pools = ["tank".to_string(), "fast".to_string()];
        let empty = json!({"nfs": {}, "smb": {}});
        let go = |a: Value, st: &Value, ex: &[String]| destroy_argv(a["op"].as_str().unwrap(), &a, &rows, &snaps, &pools, st, ex);
        let ds = |d: &str, c: &str, r: bool| json!({"op": "dataset_destroy", "dataset": d, "confirm": c, "recursive": r});
        assert_eq!(go(ds("tank/ab", "tank/ab", false), &empty, &[]).unwrap(), ["zfs", "destroy", "tank/ab"]); // tank/ab2@x is not its snapshot
        assert_eq!(go(ds("tank/vm", "tank/vm", false), &empty, &[]).unwrap(), ["zfs", "destroy", "-r", "tank/vm"]); // its snapshots go too
        assert_eq!(go(ds("tank/a", "tank/a", false), &empty, &[]).unwrap_err(), "it has child datasets: tick “with its children” to delete them too");
        assert_eq!(go(ds("tank/a", "tank/a", true), &empty, &[]).unwrap(), ["zfs", "destroy", "-r", "tank/a"]);
        assert_eq!(go(ds("tank", "tank", true), &empty, &[]).unwrap_err(), "never the root of a pool: delete the pool instead");
        assert_eq!(go(ds("tank/zz", "tank/zz", false), &empty, &[]).unwrap_err(), "unknown dataset");
        assert_eq!(go(ds("tank/ab", "ab", false), &empty, &[]).unwrap_err(), "confirmation: type the full name again");
        assert!(go(ds("tank/ab -r", "tank/ab -r", false), &empty, &[]).is_err());
        assert!(go(ds("tank/ab@x", "tank/ab@x", false), &empty, &[]).is_err());
        // Shares (the panel's, a child mounted elsewhere), /etc/exports, replications.
        let st = json!({"nfs": {"media": {"path": "/srv/b"}}, "smb": {"P": {"path": "/tank/ab"}}, "repl_allow": {"10.0.0.1": {"datasets": ["fast"]}}});
        assert_eq!(go(ds("tank/a", "tank/a", true), &st, &[]).unwrap_err(), "still in use, remove it first from: nfs:media");
        assert_eq!(go(ds("tank/ab", "tank/ab", false), &st, &[]).unwrap_err(), "still in use, remove it first from: smb:P");
        assert!(go(ds("tank/vm", "tank/vm", false), &st, &[]).is_ok());
        assert_eq!(go(ds("tank/ab", "tank/ab", false), &empty, &["/tank/ab/sub".into()]).unwrap_err(), "still in use, remove it first from: /etc/exports:/tank/ab/sub");
        assert!(go(ds("tank/ab", "tank/ab", false), &empty, &["/tank/abc".into()]).is_ok());
        let pool = |p: &str, c: &str| json!({"op": "pool_destroy", "pool": p, "confirm": c});
        assert_eq!(go(pool("fast", "fast"), &st, &[]).unwrap_err(), "still in use, remove it first from: repl:10.0.0.1");
        assert_eq!(go(pool("fast", "fast"), &empty, &[]).unwrap(), ["zpool", "destroy", "fast"]);
        assert_eq!(go(pool("tank", "tank"), &st, &[]).unwrap_err(), "still in use, remove it first from: nfs:media, smb:P");
        assert_eq!(go(pool("fast", "Fast"), &empty, &[]).unwrap_err(), "confirmation: type the pool name again");
        assert_eq!(go(pool("-f", "-f"), &empty, &[]).unwrap_err(), "unknown pool");
        let pulled = json!({"repl_pull": {"tank/a/b": {"host": "nas", "source": "x"}}});
        assert_eq!(go(ds("tank/a", "tank/a", true), &pulled, &[]).unwrap_err(), "still in use, remove it first from: repl:tank/a/b");
        assert_eq!(tr("fr", "still in use, remove it first from: nfs:media"), "encore utilisé, retirez-le d'abord de : nfs:media");
    }

    #[test]
    fn iscsi() {
        let rows = parse_zrows("tank\tfilesystem\t/tank\t-\t-\ntank/VM_1\tvolume\t-\t1073741824\t16384\ntank/vm.1\tvolume\t-\t1073741824\t16384\n");
        let base = "iqn.2003-01.org.linux-iscsi.nas";
        let ini = "iqn.1993-08.org.debian:01:abc";
        let empty = json!({});
        let go = |a: Value, st: &Value| iscsi_plan(a["op"].as_str().unwrap(), &a, &rows, st, base);
        let (cmds, entry) = go(json!({"op": "iscsi_save", "zvol": "tank/VM_1", "initiators": [ini, " ", ini]}), &empty).unwrap();
        let t = "iqn.2003-01.org.linux-iscsi.nas:tank.vm-1";
        assert_eq!(cmds, [
            vec!["targetcli", "/backstores/block", "create", "name=cairn.tank.vm-1", "dev=/dev/zvol/tank/VM_1"],
            vec!["targetcli", "/iscsi", "create", t],
            vec!["targetcli", &format!("/iscsi/{t}/tpg1/luns"), "create", "/backstores/block/cairn.tank.vm-1"],
            vec!["targetcli", &format!("/iscsi/{t}/tpg1/acls"), "create", ini],
        ]);
        assert_eq!(entry, json!({"iqn": t, "backstore": "cairn.tank.vm-1", "initiators": [ini]}));
        // Existing export: only the access list changes.
        let st = json!({"iscsi": {"tank/VM_1": entry}});
        let other = "iqn.2026-11.home.pve:node2";
        let (cmds, _) = go(json!({"op": "iscsi_save", "zvol": "tank/VM_1", "initiators": [other]}), &st).unwrap();
        assert_eq!(cmds, [vec!["targetcli", &format!("/iscsi/{t}/tpg1/acls"), "delete", ini], vec!["targetcli", &format!("/iscsi/{t}/tpg1/acls"), "create", other]]);
        // Refusals: no access list (never open to all), bad names, a filesystem, a name taken.
        for bad in [json!([]), json!(["*"]), json!(["IQN.1993-08.x"]), json!(["iqn.x y"]), json!(["iqn.a\",b"]), json!((0..33).map(|i| format!("iqn.x:{i}")).collect::<Vec<_>>())] {
            assert!(go(json!({"op": "iscsi_save", "zvol": "tank/VM_1", "initiators": bad}), &empty).is_err(), "{bad}");
        }
        assert_eq!(go(json!({"op": "iscsi_save", "zvol": "tank", "initiators": [ini]}), &empty).unwrap_err(), "unknown volume");
        let clash = json!({"iscsi": {"tank/vm.1": {"iqn": "iqn.2003-01.org.linux-iscsi.nas:tank.vm.1"}}});
        assert!(go(json!({"op": "iscsi_save", "zvol": "tank/vm.1", "initiators": [ini]}), &clash).is_ok()); // its own
        let clash = json!({"iscsi": {"tank/other": {"iqn": t}}});
        assert_eq!(go(json!({"op": "iscsi_save", "zvol": "tank/VM_1", "initiators": [ini]}), &clash).unwrap_err(), "another volume already has this iSCSI name");
        let (cmds, gone) = go(json!({"op": "iscsi_delete", "zvol": "tank/VM_1"}), &st).unwrap();
        assert_eq!(cmds, [vec!["targetcli", "/iscsi", "delete", t], vec!["targetcli", "/backstores/block", "delete", "cairn.tank.vm-1"]]);
        assert!(gone.is_null());
        assert_eq!(go(json!({"op": "iscsi_delete", "zvol": "tank/vm.1"}), &st).unwrap_err(), "unknown export");
        // An exported volume (or its pool) cannot be deleted.
        let a = json!({"op": "dataset_destroy", "dataset": "tank/VM_1", "confirm": "tank/VM_1"});
        assert_eq!(destroy_argv("dataset_destroy", &a, &rows, &[], &["tank".into()], &st, &[]).unwrap_err(), "still in use, remove it first from: iscsi:tank/VM_1");
    }

    #[test]
    fn sections_keep_empty_outputs() {
        assert_eq!(join(vec!["a".into(), String::new(), "b\n".into()]), "a\n@@\n@@\nb\n");
    }
}
