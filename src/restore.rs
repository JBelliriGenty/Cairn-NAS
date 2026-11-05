//! Snapshot restore (`features.restore`): browse a snapshot, download a file
//! or a folder from it, copy one back next to the original, clone a snapshot
//! into a new dataset, roll a dataset back.

use super::*;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub(crate) const FR: &[(&str, &str)] = &[
    ("unknown snapshot", "snapshot inconnu"),
    ("only snapshots of a mounted filesystem can be browsed", "seuls les snapshots d'un système de fichiers monté se parcourent"),
    ("path refused", "chemin refusé"),
    ("choose a file or a folder, not the whole snapshot", "choisissez un fichier ou un dossier, pas tout le snapshot"),
    ("the folder holding it no longer exists: clone the snapshot instead", "le dossier qui le contenait n'existe plus : clonez plutôt le snapshot"),
    ("{} already exists: rename or remove it first", "{} existe déjà : renommez-le ou supprimez-le d'abord"),
    ("name not supported (not UTF-8)", "nom non pris en charge (pas en UTF-8)"),
    ("too large to download (over {} GiB): restore it instead", "trop gros pour un téléchargement (plus de {} Gio) : restaurez-le plutôt"),
    ("clone refused (existing parent dataset of the same pool + simple name)", "clone refusé (dataset parent existant du même pool + nom simple)"),
    ("a newer snapshot has clones ({}): a rollback would need -R, refused", "un snapshot plus récent a des clones ({}) : il faudrait -R, refusé"),
    ("refused while a replication or an iSCSI export uses it: {}", "refusé tant qu'une réplication ou un export iSCSI l'utilise : {}"),
];

const DOWNLOAD_MAX_GIB: u64 = 4;

fn snapshot_names() -> Vec<String> {
    cmd(&["zfs", "list", "-H", "-t", "snapshot", "-o", "name"]).lines().map(String::from).collect()
}

/// `rel` resolved inside `base` (symlinks and `..` resolved), or None when it
/// does not exist or leaves `base`.
fn inside(base: &Path, rel: &str) -> Option<PathBuf> {
    let root = fs::canonicalize(base).ok()?;
    let p = fs::canonicalize(root.join(rel.trim_start_matches('/'))).ok()?;
    p.starts_with(&root).then_some(p)
}

/// (<mountpoint>/.zfs/snapshot/<name>, mountpoint) of an existing snapshot of a mounted filesystem.
fn snap_dir(snap: &str, rows: &[Zrow], snaps: &[String]) -> Result<(PathBuf, String), String> {
    let (ds, name) = snap.split_once('@').ok_or("unknown snapshot")?;
    if !snaps.iter().any(|s| s == snap) {
        return Err("unknown snapshot".into());
    }
    let r = rows.iter().find(|r| r.name == ds && r.kind == "filesystem" && r.mount.starts_with('/')).ok_or("only snapshots of a mounted filesystem can be browsed")?;
    Ok((Path::new(&r.mount).join(".zfs/snapshot").join(name), r.mount.clone()))
}

fn listing(dir: &Path) -> Value {
    let mut out: Vec<Value> = fs::read_dir(dir).into_iter().flatten().flatten().take(5000).filter_map(|e| {
        let m = e.metadata().ok()?; // the entry itself: a symlink is not followed
        Some(json!({"name": e.file_name().to_string_lossy(), "dir": m.is_dir(), "link": m.file_type().is_symlink(), "size": m.len(), "mtime": m.mtime()}))
    }).collect();
    out.sort_by(|a, b| b["dir"].as_bool().cmp(&a["dir"].as_bool()).then_with(|| a["name"].as_str().cmp(&b["name"].as_str())));
    json!(out)
}

/// Sum of the file sizes under `p`, None past `max`.
fn tree_size(p: &Path, max: u64) -> Option<u64> {
    let (mut total, mut stack) = (0u64, vec![p.to_path_buf()]);
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                total += m.len();
                if total > max {
                    return None;
                }
            }
        }
    }
    Some(total)
}

/// Query string value, percent-decoded.
pub(crate) fn query(url: &str, key: &str) -> String {
    let q = url.split_once('?').map_or("", |x| x.1);
    let Some((_, v)) = q.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key) else { return String::new() };
    let b = v.as_bytes();
    let (mut out, mut i) = (vec![], 0);
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len()).then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())).flatten();
        match hex {
            Some(x) => {
                out.push(x);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A download: attachment, never rendered by the browser.
fn send<R: Read + Send + 'static>(r: Request, name: &str, ctype: &str, data: R, len: Option<usize>) {
    let h = |k: &str, v: &str| Header::from_bytes(k, v).unwrap();
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    let headers = vec![h("Content-Type", ctype), h("Content-Disposition", &format!("attachment; filename=\"{safe}\"")), h("Cache-Control", "no-store"),
        h("X-Content-Type-Options", "nosniff"), h("Content-Security-Policy", "default-src 'none'")];
    let _ = r.respond(Response::new(tiny_http::StatusCode(200), headers, data, len, None));
}

/// GET /api/browse?snap=&path= (folder listing) and /api/download?snap=&path= (a file, or a folder as tar).
pub(crate) fn serve(r: Request, path: &str, lang: &str) {
    let fail = |r: Request, e: &str| respond(r, 400, json!({"error": tr(lang, e)}).to_string(), "application/json");
    let (snap, rel) = (query(r.url(), "snap"), query(r.url(), "path"));
    let (base, _) = match snap_dir(&snap, &zfs_rows(), &snapshot_names()) {
        Ok(b) => b,
        Err(e) => return fail(r, &e),
    };
    let (Ok(root), Some(p)) = (fs::canonicalize(&base), inside(&base, &rel)) else { return fail(r, "path refused") };
    let shown = p.strip_prefix(&root).map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    if path == "/api/browse" {
        if !p.is_dir() {
            return fail(r, "path refused");
        }
        return respond(r, 200, json!({"path": shown, "entries": listing(&p)}).to_string(), "application/json");
    }
    let max = DOWNLOAD_MAX_GIB << 30;
    let name = p.file_name().map_or_else(|| snap.replace(['/', '@'], "_"), |n| n.to_string_lossy().into_owned());
    let too_big = format!("too large to download (over {DOWNLOAD_MAX_GIB} GiB): restore it instead");
    if p.is_dir() {
        if tree_size(&p, max).is_none() {
            return fail(r, &too_big);
        }
        let (dir, leaf) = match (p.parent(), p.file_name()) {
            (Some(d), Some(l)) if p != root => (d.to_path_buf(), l.to_os_string()),
            _ => (root.clone(), ".".into()),
        };
        let child = Command::new("tar").arg("-C").arg(&dir).arg("-cf").arg("-").arg("--").arg(&leaf).stdout(std::process::Stdio::piped()).spawn();
        let Ok(mut child) = child else { return fail(r, "tar failed") };
        let Some(out) = child.stdout.take() else { return fail(r, "tar failed") };
        send(r, &format!("{name}.tar"), "application/x-tar", out, None);
        let _ = child.wait();
        return;
    }
    match fs::File::open(&p) {
        Ok(f) => {
            let len = f.metadata().map_or(0, |m| m.len());
            if len > max {
                return fail(r, &too_big);
            }
            send(r, &name, "application/octet-stream", f, Some(len as usize));
        }
        Err(e) => fail(r, &e.to_string()),
    }
}

/// (source, destination) to copy `rel` from the snapshot back into the live
/// dataset, next to the original, as "<name>.restored-<snapshot>": never over anything.
fn restore_plan(snap: &str, rel: &str, rows: &[Zrow], snaps: &[String]) -> Result<(String, String), String> {
    let (base, mount) = snap_dir(snap, rows, snaps)?;
    let root = fs::canonicalize(&base).map_err(|_| "unknown snapshot")?;
    let src = inside(&base, rel).ok_or("path refused")?;
    let relp = src.strip_prefix(&root).map_err(|_| "path refused")?.to_path_buf();
    let (Some(parent), Some(leaf)) = (relp.parent(), relp.file_name()) else { return Err("choose a file or a folder, not the whole snapshot".into()) };
    let live_parent = inside(Path::new(&mount), &parent.to_string_lossy()).ok_or("the folder holding it no longer exists: clone the snapshot instead")?;
    let mut n = leaf.to_os_string();
    n.push(format!(".restored-{}", snap.split_once('@').map_or("", |x| x.1)));
    let dest = live_parent.join(n);
    if dest.symlink_metadata().is_ok() {
        return Err(format!("{} already exists: rename or remove it first", dest.display()));
    }
    match (src.to_str(), dest.to_str()) {
        (Some(s), Some(d)) => Ok((s.to_string(), d.to_string())),
        _ => Err("name not supported (not UTF-8)".into()),
    }
}

fn clone_argv(a: &Value, rows: &[Zrow], snaps: &[String]) -> Result<Vec<String>, String> {
    let (snap, new) = (a["snapshot"].as_str().unwrap_or(""), a["dataset"].as_str().unwrap_or(""));
    if !snaps.iter().any(|s| s == snap) {
        return Err("unknown snapshot".into());
    }
    let pool = snap.split(['/', '@']).next().unwrap_or("");
    let ok = new.rsplit_once('/').is_some_and(|(p, leaf)| rows.iter().any(|r| r.name == p && r.kind == "filesystem") && is_name(leaf))
        && new.split('/').next() == Some(pool)
        && !rows.iter().any(|r| r.name == new);
    if !ok {
        return Err("clone refused (existing parent dataset of the same pool + simple name)".into());
    }
    Ok(vec!["zfs".into(), "clone".into(), snap.into(), new.into()])
}

/// Validated `zfs rollback` from `zfs list -Hp -t snapshot -o name,createtxg,clones -d 1 <dataset>`:
/// the dataset name retyped, newer snapshots destroyed with -r, never -R
/// (clones), refused while a replication or an iSCSI export uses the dataset.
fn rollback_argv(a: &Value, listing: &str, state: &Value, replicated: &[String]) -> Result<Vec<String>, String> {
    let snap = a["snapshot"].as_str().unwrap_or("");
    let ds = snap.split_once('@').map_or("", |x| x.0);
    let snaps: Vec<(&str, u64, &str)> = listing.lines().filter_map(|l| {
        let f: Vec<&str> = l.split('\t').collect();
        Some((*f.first()?, f.get(1)?.parse().ok()?, f.get(2).copied().unwrap_or("")))
    }).collect();
    let Some(&(_, txg, _)) = snaps.iter().find(|s| s.0 == snap) else { return Err("unknown snapshot".into()) };
    if a["confirm"].as_str() != Some(ds) {
        return Err("confirmation: type the full name again".into());
    }
    let newer: Vec<&(&str, u64, &str)> = snaps.iter().filter(|s| s.1 > txg).collect();
    let cloned: Vec<&str> = newer.iter().map(|s| s.2).filter(|c| !c.is_empty() && *c != "-").collect();
    if !cloned.is_empty() {
        return Err(format!("a newer snapshot has clones ({}): a rollback would need -R, refused", cloned.join(", ")));
    }
    // Replications send recursively: a replicated parent counts.
    let hit = |d: &str| ds == d || ds.starts_with(&format!("{d}/"));
    let mut used = vec![];
    for (host, e) in state["repl_allow"].as_object().into_iter().flatten() {
        if strings(e, "datasets").iter().any(|d| hit(d)) {
            used.push(format!("repl:{host}"));
        }
    }
    used.extend(state["repl_pull"].as_object().into_iter().flatten().filter(|(t, _)| hit(t)).map(|(t, _)| format!("repl:{t}")));
    used.extend(replicated.iter().filter(|d| hit(d)).map(|d| format!("repl:{d}")));
    used.extend(state["iscsi"].as_object().into_iter().flatten().filter(|(z, _)| *z == ds).map(|(z, _)| format!("iscsi:{z}")));
    if !used.is_empty() {
        return Err(format!("refused while a replication or an iSCSI export uses it: {}", used.join(", ")));
    }
    let mut argv = vec!["zfs".to_string(), "rollback".into()];
    if !newer.is_empty() {
        argv.push("-r".into());
    }
    argv.push(snap.into());
    Ok(argv)
}

/// snap_restore, snap_clone, snap_rollback.
pub(crate) fn manage_op(cfg: &Config, a: &Value, state: &Value) -> Result<String, String> {
    feature(cfg.features.restore)?;
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let argv = match s("op").as_str() {
        "snap_restore" => {
            let (snap, rel) = (s("snapshot"), s("path"));
            let (src, dest) = restore_plan(&snap, &rel, &zfs_rows(), &snapshot_names())?;
            run(&["cp", "-a", "--no-target-directory", &src, &dest], None)?;
            return Ok(format!("op=snap_restore snapshot={snap} path={rel} to={dest}"));
        }
        "snap_clone" => clone_argv(a, &zfs_rows(), &snapshot_names())?,
        _ => {
            let ds = s("snapshot").split_once('@').map(|x| x.0.to_string()).unwrap_or_default();
            if !is_dataset(&pools(), &ds) {
                return Err("unknown snapshot".into());
            }
            let listing = cmd(&["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,createtxg,clones", "-d", "1", &ds]);
            let replicated: Vec<String> = cfg.replication.iter().map(|r| r.dataset.clone()).collect();
            rollback_argv(a, &listing, state, &replicated)?
        }
    };
    run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
    Ok(format!("op={} argv={}", s("op"), argv.join(" ")))
}

/// --demo answers: a sample tree and a text file.
pub(crate) fn demo_serve(r: Request, path: &str) {
    if path == "/api/download" {
        let body = b"Sample file from a demo snapshot.\n".to_vec();
        let len = body.len();
        return send(r, "notes.txt", "text/plain", std::io::Cursor::new(body), Some(len));
    }
    let rel = query(r.url(), "path");
    let f = |name: &str, dir: bool, size: u64, mtime: u64| json!({"name": name, "dir": dir, "link": false, "size": size, "mtime": mtime});
    let entries = if rel.is_empty() {
        json!([f("2025", true, 4, 1762000000), f("2026", true, 9, 1762300000), f("notes.txt", false, 1830, 1762280000)])
    } else {
        json!([f("IMG_0412.jpg", false, 3_481_220, 1762100000), f("IMG_0413.jpg", false, 2_904_118, 1762100100)])
    };
    respond(r, 200, json!({"path": rel, "entries": entries}).to_string(), "application/json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside() {
        let d = std::env::temp_dir().join(format!("cairn-test-inside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("snap/a")).unwrap();
        fs::write(d.join("snap/a/f"), "x").unwrap();
        fs::write(d.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(d.join("secret"), d.join("snap/a/link")).unwrap();
        let base = d.join("snap");
        assert!(inside(&base, "a/f").is_some());
        assert!(inside(&base, "/a/f").is_some()); // a leading / stays relative
        assert!(inside(&base, "").is_some());
        assert!(inside(&base, "../secret").is_none());
        assert!(inside(&base, "a/../../secret").is_none());
        assert!(inside(&base, "a/link").is_none()); // symlink out of the snapshot
        assert!(inside(&base, "a/missing").is_none());
        assert!(tree_size(&base, 1000).is_some_and(|n| n > 1)); // the file + the symlink itself
        assert_eq!(tree_size(&base, 0), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn query_strings() {
        assert_eq!(query("/api/browse?snap=tank%2Fa%40s1&path=x%20y%2F..", "snap"), "tank/a@s1");
        assert_eq!(query("/api/browse?snap=a&path=x%20y%2F..", "path"), "x y/..");
        assert_eq!(query("/api/browse?snap=a", "path"), "");
        assert_eq!(query("/x?p=%zz%4", "p"), "%zz%4");
    }

    fn rows() -> Vec<Zrow> {
        parse_zrows("tank\tfilesystem\t/tank\t-\t-\ntank/docs\tfilesystem\t/tank/docs\t-\t-\ntank/vm\tvolume\t-\t1073741824\t16384\nfast\tfilesystem\t/fast\t-\t-\n")
    }

    #[test]
    fn restore_and_clone() {
        let snaps = vec!["tank/docs@s1".to_string(), "tank/vm@s1".to_string()];
        assert_eq!(snap_dir("tank/docs@s1", &rows(), &snaps).unwrap().0, Path::new("/tank/docs/.zfs/snapshot/s1"));
        assert!(snap_dir("tank/docs@zz", &rows(), &snaps).is_err());
        assert!(snap_dir("tank/vm@s1", &rows(), &snaps).is_err()); // a volume has no folder
        assert!(restore_plan("tank/docs@zz", "a", &rows(), &snaps).is_err());
        let ok = |a: Value| clone_argv(&a, &rows(), &snaps);
        assert_eq!(ok(json!({"snapshot": "tank/docs@s1", "dataset": "tank/docs-s1"})).unwrap(), ["zfs", "clone", "tank/docs@s1", "tank/docs-s1"]);
        assert!(ok(json!({"snapshot": "tank/docs@s1", "dataset": "tank/docs"})).is_err()); // exists
        assert!(ok(json!({"snapshot": "tank/docs@s1", "dataset": "fast/copy"})).is_err()); // other pool
        assert!(ok(json!({"snapshot": "tank/docs@s1", "dataset": "tank/x/y"})).is_err()); // no parent
        assert!(ok(json!({"snapshot": "tank/docs@s1", "dataset": "tank/a b"})).is_err());
        assert!(ok(json!({"snapshot": "tank/docs@s9", "dataset": "tank/c"})).is_err());
    }

    #[test]
    fn rollbacks() {
        let list = "tank/docs@a\t100\t\ntank/docs@b\t200\t\ntank/docs@c\t300\t\n";
        let st = json!({});
        let rb = |a: Value, l: &str, st: &Value, r: &[String]| rollback_argv(&a, l, st, r);
        assert_eq!(rb(json!({"snapshot": "tank/docs@c", "confirm": "tank/docs"}), list, &st, &[]).unwrap(), ["zfs", "rollback", "tank/docs@c"]);
        assert_eq!(rb(json!({"snapshot": "tank/docs@a", "confirm": "tank/docs"}), list, &st, &[]).unwrap(), ["zfs", "rollback", "-r", "tank/docs@a"]);
        assert_eq!(rb(json!({"snapshot": "tank/docs@a", "confirm": "tank"}), list, &st, &[]).unwrap_err(), "confirmation: type the full name again");
        assert_eq!(rb(json!({"snapshot": "tank/docs@z", "confirm": "tank/docs"}), list, &st, &[]).unwrap_err(), "unknown snapshot");
        let cloned = "tank/docs@a\t100\t\ntank/docs@b\t200\ttank/b-copy\n";
        assert!(rb(json!({"snapshot": "tank/docs@a", "confirm": "tank/docs"}), cloned, &st, &[]).unwrap_err().contains("-R"));
        // A clone of the target itself survives a rollback to it.
        assert!(rb(json!({"snapshot": "tank/docs@b", "confirm": "tank/docs"}), cloned, &st, &[]).is_ok());
        let repl = json!({"repl_allow": {"192.168.10.40": {"datasets": ["tank"]}}});
        assert!(rb(json!({"snapshot": "tank/docs@c", "confirm": "tank/docs"}), list, &repl, &[]).unwrap_err().contains("repl:192.168.10.40"));
        assert!(rb(json!({"snapshot": "tank/docs@c", "confirm": "tank/docs"}), list, &st, &["tank/docs".into()]).is_err());
        assert!(rb(json!({"snapshot": "tank/docs@c", "confirm": "tank/docs"}), list, &st, &["tank/doc".into()]).is_ok()); // not a parent
        let pull = json!({"repl_pull": {"tank/docs": {"host": "h", "source": "x"}}});
        assert!(rb(json!({"snapshot": "tank/docs@c", "confirm": "tank/docs"}), list, &pull, &[]).is_err());
        let vol = "tank/vm@a\t1\t\n";
        let iscsi = json!({"iscsi": {"tank/vm": {"iqn": "x"}}});
        assert!(rb(json!({"snapshot": "tank/vm@a", "confirm": "tank/vm"}), vol, &iscsi, &[]).unwrap_err().contains("iscsi:tank/vm"));
        for (en, fr) in FR {
            assert_eq!(en.matches("{}").count(), fr.matches("{}").count(), "{en}");
        }
    }
}
