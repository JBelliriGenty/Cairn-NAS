//! Off-site backups with restic (`features.offsite`): repositories (local
//! path, SFTP, S3, B2) whose password and credentials live in root-only files
//! under /etc/cairn-nas/restic and never leave the server; per-dataset jobs
//! backing up a fresh ZFS snapshot (daily or weekly systemd timer), retention
//! with `forget --prune`, last-run status and alerts, restore of a path into
//! a new folder.

use super::*;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub(crate) const FR: &[(&str, &str)] = &[
    ("Off-site backup of {} failed: {}", "Sauvegarde externe de {} en échec : {}"),
    ("Off-site backup of {}: none for {} h", "Sauvegarde externe de {} : aucune depuis {} h"),
    ("restic is not installed (apt install restic)", "restic n'est pas installé (apt install restic)"),
    ("repository name refused (letters, digits, - and _)", "nom de dépôt refusé (lettres, chiffres, - et _)"),
    ("repository type: local, sftp, s3 or b2", "type de dépôt : local, sftp, s3 ou b2"),
    ("location refused: {}", "emplacement refusé : {}"),
    ("repository password: 8 to 256 characters", "mot de passe du dépôt : de 8 à 256 caractères"),
    ("access key and secret required", "clé d'accès et secret requis"),
    ("unknown repository", "dépôt inconnu"),
    ("used by the backup of: {}", "utilisé par la sauvegarde de : {}"),
    ("mounted filesystems only", "systèmes de fichiers montés seulement"),
    ("keep: 0 to 1000 per period, at least one above 0", "conservation : de 0 à 1000 par période, au moins une au-dessus de 0"),
    ("unknown backup job", "sauvegarde inconnue"),
    ("snapshot id refused", "identifiant de snapshot refusé"),
    ("restore into: a new folder inside a dataset", "restaurer dans : un nouveau dossier dans un dataset"),
    ("create this machine's SFTP key first", "créez d'abord la clé SFTP de cette machine"),
    ("a backup or a restore is already running", "une sauvegarde ou une restauration est déjà en cours"),
];

const RESTIC_DIR: &str = "/etc/cairn-nas/restic";
const RESTIC_KEY: &str = "/var/lib/cairn-nas/restic_ed25519";
const RESTIC_STATUS: &str = "/var/lib/cairn-nas/restic-status.json";
const SNAP_PREFIX: &str = "cairn-restic-";
/// The snapshot is bind-mounted here, one stable path per dataset, so restic finds its parent and only reads changed files.
const STAGE: &str = "/run/cairn-nas/restic";
const BACKUP_EVERY: [(&str, &str, u64); 2] = [("daily", "*-*-* 04:00", 26), ("weekly", "Sun *-*-* 04:00", 8 * 24 + 2)];

/// The restic repository string of a validated location, or why it is refused.
fn repo_url(kind: &str, loc: &str) -> Result<String, String> {
    let safe = |s: &str, extra: &str| !s.is_empty() && s.len() <= 255 && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    let bad = |why: &str| Err(format!("location refused: {why}"));
    match kind {
        "local" if loc.starts_with('/') && safe(loc, "/._-") => Ok(loc.to_string()),
        "local" => bad("an absolute path"),
        "sftp" => {
            let ok = loc.split_once('@').and_then(|(u, r)| r.split_once(':').map(|(h, p)| (u, h, p)))
                .is_some_and(|(u, h, p)| is_account(u) && is_host(h) && !h.contains('/') && p.starts_with('/') && safe(p, "/._-"));
            if ok { Ok(format!("sftp:{loc}")) } else { bad("user@host:/path") }
        }
        "s3" if (loc.starts_with("https://") || loc.starts_with("http://")) && safe(loc, "/._-:") => Ok(format!("s3:{loc}")),
        "s3" => bad("https://endpoint/bucket/path"),
        "b2" => {
            let ok = loc.split_once(':').is_some_and(|(b, p)| safe(b, "-") && (p.is_empty() || safe(p, "/._-")));
            if ok { Ok(format!("b2:{loc}")) } else { bad("bucket:path") }
        }
        _ => Err("repository type: local, sftp, s3 or b2".into()),
    }
}

/// Environment variables of the credentials file of a repository type.
fn cred_vars(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "s3" => Some(("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")),
        "b2" => Some(("B2_ACCOUNT_ID", "B2_ACCOUNT_KEY")),
        _ => None,
    }
}

fn secret_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}

/// Root-only file (0600), its directory 0700.
fn write_secret(path: &str, text: &str) -> Result<(), String> {
    let dir = Path::new(path).parent().ok_or("bad path")?;
    fs::create_dir_all(dir).and_then(|()| fs::set_permissions(dir, fs::Permissions::from_mode(0o700))).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = format!("{path}.tmp");
    let _ = fs::remove_file(&tmp);
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes())).and_then(|()| fs::rename(&tmp, path)).map_err(|e| format!("{path}: {e}"))
}

/// restic with the repository's location, password file and credentials in its environment.
fn restic(state: &Value, repo: &str) -> Result<Command, String> {
    let r = &state["restic_repos"][repo];
    let (kind, loc) = (r["kind"].as_str().ok_or("unknown repository")?, r["location"].as_str().unwrap_or(""));
    let mut c = Command::new("restic");
    c.env("RESTIC_REPOSITORY", repo_url(kind, loc)?).env("RESTIC_PASSWORD_FILE", format!("{RESTIC_DIR}/{repo}.pass"))
        .env("RESTIC_CACHE_DIR", "/var/cache/cairn-nas/restic").env("HOME", "/root");
    for (k, v) in read(&format!("{RESTIC_DIR}/{repo}.env")).lines().filter_map(|l| l.split_once('=')) {
        c.env(k, v);
    }
    if kind == "sftp" {
        c.args(["-o", &format!("sftp.args=-i {RESTIC_KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes")]);
    }
    Ok(c)
}

/// Runs it; stdout, or the last line restic printed on stderr.
fn restic_out(mut c: Command) -> Result<String, String> {
    let o = c.output().map_err(|e| format!("restic: {e}"))?;
    if o.status.success() {
        return Ok(String::from_utf8_lossy(&o.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&o.stderr);
    Err(format!("restic: {}", err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim()))
}

/// Retention arguments of a job ({keep_daily, keep_weekly, keep_monthly}).
fn keep_args(j: &Value) -> Vec<String> {
    [("daily", "--keep-daily"), ("weekly", "--keep-weekly"), ("monthly", "--keep-monthly")].iter()
        .filter_map(|(k, flag)| j[format!("keep_{k}")].as_u64().filter(|n| *n > 0).map(|n| [flag.to_string(), n.to_string()]))
        .flatten().collect()
}

fn validate_job(a: &Value, rows: &[Zrow], state: &Value) -> Result<Value, String> {
    let ds = a["dataset"].as_str().unwrap_or("");
    let repo = a["repo"].as_str().unwrap_or("");
    if !rows.iter().any(|r| r.name == ds && r.kind == "filesystem" && r.mount.starts_with('/')) {
        return Err("mounted filesystems only".into());
    }
    if !state["restic_repos"][repo].is_object() {
        return Err("unknown repository".into());
    }
    let every = a["every"].as_str().unwrap_or("");
    if !BACKUP_EVERY.iter().any(|(e, _, _)| *e == every) {
        return Err("frequency refused".into());
    }
    let keep: Vec<Option<u64>> = ["daily", "weekly", "monthly"].iter().map(|k| a[format!("keep_{k}")].as_u64().filter(|n| *n <= 1000)).collect();
    if keep.iter().any(Option::is_none) || keep.iter().all(|k| *k == Some(0)) {
        return Err("keep: 0 to 1000 per period, at least one above 0".into());
    }
    let since = state["restic_jobs"][ds]["since"].as_u64().unwrap_or_else(now_s);
    Ok(json!({"repo": repo, "every": every, "keep_daily": keep[0], "keep_weekly": keep[1], "keep_monthly": keep[2], "since": since}))
}

fn install_backup_units(cfg: &Config, state: &Value) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let used = |every: &str| state["restic_jobs"].as_object().into_iter().flatten().any(|(_, j)| j["every"] == every);
    for (every, cal, _) in BACKUP_EVERY {
        let base = format!("/etc/systemd/system/cairn-backup-{every}");
        if !used(every) {
            if Path::new(&format!("{base}.timer")).exists() {
                let _ = run(&["systemctl", "disable", "--now", &format!("cairn-backup-{every}.timer")], None);
                let _ = fs::remove_file(format!("{base}.timer"));
                let _ = fs::remove_file(format!("{base}.service"));
            }
            continue;
        }
        write_atomic(&format!("{base}.service"), &format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: {every} off-site backups (restic)\n\
            After=network-online.target zfs.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart={} --backup {every} {}\n", exe.display(), cfg.path))?;
        write_atomic(&format!("{base}.timer"), &format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: {every} off-site backups\n\n[Timer]\nOnCalendar={cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"))?;
    }
    run(&["systemctl", "daemon-reload"], None)?;
    for (every, _, _) in BACKUP_EVERY {
        if used(every) {
            run(&["systemctl", "enable", "--now", &format!("cairn-backup-{every}.timer")], None)?;
        }
    }
    Ok(())
}

fn is_snap_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Restore target: a folder that does not exist yet, whose parent is inside a mounted dataset.
fn restore_target(target: &str, mounts: &[String]) -> Result<(), String> {
    let p = Path::new(target);
    let refused = || Err("restore into: a new folder inside a dataset".to_string());
    if !target.starts_with('/') || target.contains("/..") || target.chars().any(char::is_control) || p.symlink_metadata().is_ok() {
        return refused();
    }
    let Some(parent) = p.parent().and_then(|x| fs::canonicalize(x).ok()) else { return refused() };
    let ok = mounts.iter().any(|m| fs::canonicalize(m).is_ok_and(|m| parent.starts_with(m)));
    if ok { Ok(()) } else { refused() }
}

fn status_file() -> Value {
    serde_json::from_str(&read(RESTIC_STATUS)).unwrap_or_else(|_| json!({}))
}

fn set_status(key: &str, sub: &str, v: Value) {
    let mut st = status_file();
    st[key][sub] = v;
    let _ = fs::create_dir_all("/var/lib/cairn-nas");
    let _ = write_atomic(RESTIC_STATUS, &st.to_string());
}

fn host() -> String {
    read("/proc/sys/kernel/hostname").trim().to_string()
}

/// One job: a fresh snapshot (a consistent copy) bind-mounted on a stable path, restic backup of it,
/// the snapshot released, then retention.
fn backup_job(state: &Value, ds: &str, j: &Value) -> Result<String, String> {
    let rows = zfs_rows();
    let mount = rows.iter().find(|r| r.name == ds && r.mount.starts_with('/')).map(|r| r.mount.clone()).ok_or("mounted filesystems only")?;
    let repo = j["repo"].as_str().unwrap_or("");
    let name = format!("{SNAP_PREFIX}{}", now_s());
    let snap = format!("{ds}@{name}");
    let stage = format!("{STAGE}/{}", ds.replace('/', "_"));
    let _ = run(&["umount", &stage], None); // left over by a crash
    fs::create_dir_all(&stage).map_err(|e| format!("{stage}: {e}"))?;
    run(&["zfs", "snapshot", &snap], None)?;
    let dir = Path::new(&mount).join(".zfs/snapshot").join(&name).display().to_string();
    let res = run(&["mount", "--bind", "-o", "ro", &dir, &stage], None).and_then(|()| {
        let r = restic(state, repo).and_then(|mut c| {
            c.args(["backup", "--quiet", "--tag", ds, "--host", &host(), "--group-by", "host,tags", &stage]);
            restic_out(c)
        });
        let _ = run(&["umount", &stage], None);
        r
    });
    let _ = run(&["zfs", "destroy", &snap], None);
    res?;
    let mut c = restic(state, repo)?;
    c.args(["forget", "--quiet", "--prune", "--tag", ds, "--host", &host(), "--group-by", "host,tags"]).args(keep_args(j));
    restic_out(c)?;
    Ok(name)
}

/// `cairn-nas --backup <daily|weekly|dataset> <config>`: the matching jobs; exit 1 if one failed.
pub(crate) fn backup_cli(cfg: &Config, which: &str) -> i32 {
    let state = load_manage(cfg);
    let mut failed = 0;
    for (ds, j) in state["restic_jobs"].as_object().into_iter().flatten().filter(|(ds, j)| j["every"] == which || *ds == which) {
        eprintln!("backup {ds} -> {}", j["repo"].as_str().unwrap_or(""));
        let res = backup_job(&state, ds, j);
        if let Err(e) = &res {
            eprintln!("backup {ds}: {e}");
            failed += 1;
        }
        let prev_ok = status_file()["jobs"][ds.as_str()]["last_ok"].clone();
        set_status("jobs", ds, json!({"time": now_s(), "ok": res.is_ok(), "msg": res.as_ref().err(), "last_ok": if res.is_ok() { json!(now_s()) } else { prev_ok }}));
    }
    i32::from(failed > 0)
}

/// `cairn-nas --restore <dataset> <snapshot id> <path> <target> <config>`.
pub(crate) fn restore_cli(cfg: &Config, args: &[String]) -> i32 {
    let [ds, id, rel, target] = args else { return 2 };
    let state = load_manage(cfg);
    let res = (|| -> Result<(), String> {
        let repo = state["restic_jobs"][ds.as_str()]["repo"].as_str().ok_or("unknown backup job")?;
        let mut c = restic(&state, repo)?;
        c.args(["snapshots", "--json", id]);
        let snaps: Value = serde_json::from_str(&restic_out(c)?).map_err(|e| e.to_string())?;
        let root = snaps[0]["paths"][0].as_str().ok_or("unknown snapshot")?.to_string();
        let mut c = restic(&state, repo)?;
        c.args(["restore", &format!("{id}:{root}"), "--target", target]);
        if !rel.is_empty() {
            c.args(["--include", &format!("/{}", rel.trim_start_matches('/'))]);
        }
        restic_out(c).map(|_| ())
    })();
    if let Err(e) = &res {
        eprintln!("restore {ds} {id}: {e}");
    }
    set_status("restore", "last", json!({"time": now_s(), "ok": res.is_ok(), "msg": res.as_ref().err(), "dataset": ds, "target": target}));
    i32::from(res.is_err())
}

/// The restic snapshots of a job, newest first.
fn backups(state: &Value, ds: &str) -> Result<Value, String> {
    let repo = state["restic_jobs"][ds]["repo"].as_str().ok_or("unknown backup job")?;
    let mut c = restic(state, repo)?;
    c.args(["snapshots", "--json", "--tag", ds]);
    let v: Value = serde_json::from_str(&restic_out(c)?).map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = v.as_array().into_iter().flatten().map(|s| json!({"id": s["short_id"], "time": s["time"], "size": s["summary"]["total_bytes_processed"]})).collect();
    out.reverse();
    Ok(json!(out))
}

/// GET /api/backups?dataset=…
pub(crate) fn serve(cfg: &Config, r: Request, lang: &str) {
    let ds = restore::query(r.url(), "dataset");
    match backups(&load_manage(cfg), &ds) {
        Ok(v) => respond(r, 200, v.to_string(), "application/json"),
        Err(e) => respond(r, 400, json!({"error": tr(lang, &e)}).to_string(), "application/json"),
    }
}

pub(crate) fn demo_serve(r: Request) {
    respond(r, 200, json!([{"id": "4f3a9c2e", "time": "2026-11-05T04:00:12+01:00", "size": 412_337_221_632u64},
        {"id": "8b1d07aa", "time": "2026-11-04T04:00:09+01:00", "size": 411_902_118_400u64}]).to_string(), "application/json");
}

/// Off-site backups failed or late.
pub(crate) fn problems(state: &Value, out: &mut BTreeMap<String, String>) {
    backup_problems(state, &status_file(), now_s(), out);
}

fn backup_problems(state: &Value, status: &Value, now: u64, out: &mut BTreeMap<String, String>) {
    for (ds, j) in state["restic_jobs"].as_object().into_iter().flatten() {
        let st = &status["jobs"][ds.as_str()];
        if st["ok"] == false {
            out.insert(format!("backup:{ds}:{}", st["time"]), format!("Off-site backup of {ds} failed: {}", st["msg"].as_str().unwrap_or("?")));
            continue;
        }
        let max_h = BACKUP_EVERY.iter().find(|(e, _, _)| j["every"] == *e).map_or(26, |x| x.2);
        let last = st["last_ok"].as_u64().or(j["since"].as_u64()).unwrap_or(now);
        if now.saturating_sub(last) > max_h * 3600 {
            out.insert(format!("backuplate:{ds}"), format!("Off-site backup of {ds}: none for {} h", (now - last) / 3600));
        }
    }
}

pub(crate) fn view(state: &Value) -> Value {
    let running = |u: &str| cmd(&["systemctl", "is-active", u]).trim() == "active" || cmd(&["systemctl", "is-active", u]).trim() == "activating";
    json!({"installed": Path::new("/usr/bin/restic").exists(), "repos": state["restic_repos"], "jobs": state["restic_jobs"],
        "status": status_file(), "key": read(&format!("{RESTIC_KEY}.pub")).trim(),
        "running": running("cairn-backup-now.service") || running("cairn-restore.service")})
}

/// restic_repo_save, restic_repo_delete, restic_key, restic_job_save, restic_job_delete, restic_run, restic_restore.
pub(crate) fn manage_op(cfg: &Config, a: &Value, state: &mut Value) -> Result<String, String> {
    feature(cfg.features.offsite)?;
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let op = s("op");
    match op.as_str() {
        "restic_repo_save" => {
            if !Path::new("/usr/bin/restic").exists() {
                return Err("restic is not installed (apt install restic)".into());
            }
            let (name, kind, loc) = (s("name"), s("kind"), s("location"));
            if !is_share(&name) {
                return Err("repository name refused (letters, digits, - and _)".into());
            }
            repo_url(&kind, &loc)?;
            let fresh = !state["restic_repos"][name.as_str()].is_object();
            let (pass, id, secret) = (s("password"), s("key_id"), s("secret"));
            if ((fresh || !pass.is_empty()) && !(8..=256).contains(&pass.len())) || pass.chars().any(char::is_control) {
                return Err("repository password: 8 to 256 characters".into());
            }
            if kind == "sftp" && !Path::new(RESTIC_KEY).exists() {
                return Err("create this machine's SFTP key first".into());
            }
            if let Some((ki, ks)) = cred_vars(&kind) {
                if (fresh || !id.is_empty() || !secret.is_empty()) && !(secret_ok(&id) && secret_ok(&secret)) {
                    return Err("access key and secret required".into());
                }
                if !id.is_empty() {
                    let region = s("region");
                    let region = if kind == "s3" && secret_ok(&region) { format!("AWS_DEFAULT_REGION={region}\n") } else { String::new() };
                    write_secret(&format!("{RESTIC_DIR}/{name}.env"), &format!("{ki}={id}\n{ks}={secret}\n{region}"))?;
                }
            }
            if !pass.is_empty() {
                write_secret(&format!("{RESTIC_DIR}/{name}.pass"), &pass)?;
            }
            let old = state["restic_repos"][name.as_str()].clone();
            state["restic_repos"][name.as_str()] = json!({"kind": kind, "location": loc});
            // An existing repository (same password) is used as it is; otherwise it is created.
            let mut check = restic(state, &name)?;
            check.args(["cat", "config"]);
            if restic_out(check).is_err() {
                let mut init = restic(state, &name)?;
                init.arg("init");
                if let Err(e) = restic_out(init) {
                    if fresh {
                        state["restic_repos"].as_object_mut().map(|m| m.remove(&name));
                        let _ = fs::remove_file(format!("{RESTIC_DIR}/{name}.pass"));
                        let _ = fs::remove_file(format!("{RESTIC_DIR}/{name}.env"));
                    } else {
                        state["restic_repos"][name.as_str()] = old;
                    }
                    return Err(e);
                }
            }
            save_manage(cfg, state)?;
            Ok(format!("op=restic_repo_save name={name} kind={kind} location={loc}"))
        }
        "restic_repo_delete" => {
            let name = s("name");
            if !state["restic_repos"][name.as_str()].is_object() {
                return Err("unknown repository".into());
            }
            let users: Vec<String> = state["restic_jobs"].as_object().into_iter().flatten().filter(|(_, j)| j["repo"] == name.as_str()).map(|(d, _)| d.clone()).collect();
            if !users.is_empty() {
                return Err(format!("used by the backup of: {}", users.join(", ")));
            }
            // The repository's data stays where it is; only this machine's access goes.
            state["restic_repos"].as_object_mut().map(|m| m.remove(&name));
            let _ = fs::remove_file(format!("{RESTIC_DIR}/{name}.pass"));
            let _ = fs::remove_file(format!("{RESTIC_DIR}/{name}.env"));
            save_manage(cfg, state)?;
            Ok(format!("op=restic_repo_delete name={name}"))
        }
        "restic_key" => {
            if !Path::new(RESTIC_KEY).exists() {
                let _ = fs::create_dir_all("/var/lib/cairn-nas");
                let comment = format!("cairn-backup@{}", host());
                run(&["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", &comment, "-f", RESTIC_KEY], None)?;
            }
            Ok("op=restic_key".into())
        }
        "restic_job_save" => {
            let job = validate_job(a, &zfs_rows(), state)?;
            let ds = s("dataset");
            if cmd(&["zfs", "get", "-H", "-o", "value", "mounted", &ds]).trim() != "yes" {
                return Err("mounted filesystems only".into()); // e.g. locked
            }
            state["restic_jobs"][ds.as_str()] = job.clone();
            install_backup_units(cfg, state)?;
            save_manage(cfg, state)?;
            Ok(format!("op=restic_job_save dataset={ds} repo={} every={} {}", job["repo"].as_str().unwrap_or(""), job["every"].as_str().unwrap_or(""), keep_args(&job).join(" ")))
        }
        "restic_job_delete" => {
            let ds = s("dataset");
            if state["restic_jobs"].as_object_mut().and_then(|m| m.remove(&ds)).is_none() {
                return Err("unknown backup job".into());
            }
            install_backup_units(cfg, state)?;
            save_manage(cfg, state)?;
            Ok(format!("op=restic_job_delete dataset={ds}"))
        }
        "restic_run" | "restic_restore" => {
            let ds = s("dataset");
            if !state["restic_jobs"][ds.as_str()].is_object() {
                return Err("unknown backup job".into());
            }
            if view(state)["running"] == true {
                return Err("a backup or a restore is already running".into());
            }
            let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string();
            // In its own transient unit: it outlives this request.
            let mut argv: Vec<String> = ["systemd-run", "--no-block", "--collect", "--property=Type=oneshot"].iter().map(|x| x.to_string()).collect();
            if op == "restic_run" {
                argv.extend(["--unit=cairn-backup-now".into(), exe, "--backup".into(), ds.clone(), cfg.path.clone()]);
                run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
                return Ok(format!("op=restic_run dataset={ds}"));
            }
            let (id, rel, target) = (s("snapshot"), s("path"), s("target"));
            if !is_snap_id(&id) {
                return Err("snapshot id refused".into());
            }
            if rel.chars().any(char::is_control) || rel.split('/').any(|p| p == "..") {
                return Err("path refused".into());
            }
            restore_target(&target, &mountpoints())?;
            argv.extend(["--unit=cairn-restore".into(), exe, "--restore".into(), ds.clone(), id.clone(), rel.clone(), target.clone(), cfg.path.clone()]);
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op=restic_restore dataset={ds} snapshot={id} path={rel} target={target}"))
        }
        _ => Err("unknown operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restic_validation() {
        assert_eq!(repo_url("local", "/backup/restic").unwrap(), "/backup/restic");
        assert!(repo_url("local", "backup").is_err());
        assert!(repo_url("local", "/a/../etc").is_err());
        assert_eq!(repo_url("sftp", "bk@192.168.10.87:/srv/restic").unwrap(), "sftp:bk@192.168.10.87:/srv/restic");
        assert!(repo_url("sftp", "bk@host:srv").is_err());
        assert!(repo_url("sftp", "-oProxyCommand=x@h:/p").is_err());
        assert_eq!(repo_url("s3", "https://s3.example.com/bucket/nas").unwrap(), "s3:https://s3.example.com/bucket/nas");
        assert!(repo_url("s3", "https://s3.example.com/b?x=1").is_err());
        assert_eq!(repo_url("b2", "my-bucket:nas/tank").unwrap(), "b2:my-bucket:nas/tank");
        assert!(repo_url("rclone", "x:y").is_err());
        let rows = parse_zrows("tank/docs	filesystem	/tank/docs	-	-
tank/vm	volume	-	1073741824	16384
");
        let st = json!({"restic_repos": {"off": {"kind": "local", "location": "/b"}}});
        let job = |a: Value| validate_job(&a, &rows, &st);
        let j = job(json!({"dataset": "tank/docs", "repo": "off", "every": "daily", "keep_daily": 7, "keep_weekly": 4, "keep_monthly": 0})).unwrap();
        assert_eq!(keep_args(&j), ["--keep-daily", "7", "--keep-weekly", "4"]);
        assert!(job(json!({"dataset": "tank/vm", "repo": "off", "every": "daily", "keep_daily": 7, "keep_weekly": 0, "keep_monthly": 0})).is_err()); // volume
        assert!(job(json!({"dataset": "tank/docs", "repo": "nope", "every": "daily", "keep_daily": 7, "keep_weekly": 0, "keep_monthly": 0})).is_err());
        assert!(job(json!({"dataset": "tank/docs", "repo": "off", "every": "hourly", "keep_daily": 7, "keep_weekly": 0, "keep_monthly": 0})).is_err());
        assert!(job(json!({"dataset": "tank/docs", "repo": "off", "every": "daily", "keep_daily": 0, "keep_weekly": 0, "keep_monthly": 0})).is_err());
        assert!(job(json!({"dataset": "tank/docs", "repo": "off", "every": "daily", "keep_daily": "7"})).is_err());
        assert!(is_snap_id("4f3a9c2e") && !is_snap_id("latest") && !is_snap_id("4f3a"));
        let d = std::env::temp_dir().join(format!("cairn-offsite-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let m = vec![d.display().to_string()];
        assert!(restore_target(&format!("{}/restored", d.display()), &m).is_ok());
        assert!(restore_target(&d.display().to_string(), &m).is_err()); // exists
        assert!(restore_target(&format!("{}/a/b", d.display()), &m).is_err()); // no parent
        assert!(restore_target("/etc/cairn-x", &m).is_err()); // outside the datasets
        assert!(restore_target(&format!("{}/../x", d.display()), &m).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn backup_alerts() {
        let st = json!({"restic_jobs": {"tank/docs": {"every": "daily", "since": 1000}, "tank/b": {"every": "weekly", "since": 1000}}});
        let mut out = BTreeMap::new();
        backup_problems(&st, &json!({"jobs": {"tank/docs": {"ok": false, "time": 5, "msg": "restic: repository locked"}}}), 2000, &mut out);
        assert_eq!(out.values().collect::<Vec<_>>(), ["Off-site backup of tank/docs failed: restic: repository locked"]);
        let mut out = BTreeMap::new();
        backup_problems(&st, &json!({}), 1000 + 27 * 3600, &mut out);
        assert_eq!(out.len(), 1); // the daily one only: the weekly has 8 days
        assert_eq!(tr("fr", "Off-site backup of tank/docs: none for 27 h"), "Sauvegarde externe de tank/docs : aucune depuis 27 h");
        for (en, fr) in FR {
            assert_eq!(en.matches("{}").count(), fr.matches("{}").count(), "{en}");
        }
    }
}
