//! Native ZFS encryption (`features.encryption`): create an encrypted dataset
//! (passphrase, or a raw key file under /etc/cairn-nas/keys), show its key
//! status, unlock (load-key + mount) and lock (unmount -u) it, and load the
//! keys of key-file datasets at boot. Existing datasets cannot be encrypted
//! in place. Passphrases only travel on stdin, never in argv or the log.

use super::*;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub(crate) const FR: &[(&str, &str)] = &[
    ("dataset refused (existing parent + simple name)", "dataset refusé (parent existant + nom simple)"),
    ("passphrase: 8 to 512 characters", "phrase de passe : de 8 à 512 caractères"),
    ("key: passphrase or key file", "clé : phrase de passe ou fichier de clé"),
    ("unlock at boot needs a key file", "le déverrouillage au démarrage demande un fichier de clé"),
    ("not an encryption root: unlock {} instead", "pas une racine de chiffrement : déverrouillez plutôt {}"),
    ("not encrypted", "non chiffré"),
    ("already unlocked", "déjà déverrouillé"),
    ("already locked", "déjà verrouillé"),
];

const KEYS_DIR: &str = "/etc/cairn-nas/keys";
const UNLOCK_UNIT: &str = "/etc/systemd/system/cairn-unlock.service";

fn is_passphrase(s: &str) -> bool {
    (8..=512).contains(&s.len()) && !s.chars().any(char::is_control)
}

// ponytail: tank/a_b and tank/a/b share a key file name; create_new refuses the second one.
fn key_file(ds: &str) -> String {
    format!("{KEYS_DIR}/{}.key", ds.replace('/', "_"))
}

/// Validated `zfs create` of an encrypted dataset; the passphrase goes on stdin, never in argv.
fn create_argv(a: &Value, existing: &[String]) -> Result<Vec<String>, String> {
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let ds = s("dataset");
    let ok = ds.rsplit_once('/').is_some_and(|(p, leaf)| existing.iter().any(|e| e == p) && is_name(leaf));
    if !ok || existing.contains(&ds) {
        return Err("dataset refused (existing parent + simple name)".into());
    }
    let mut argv: Vec<String> = ["zfs", "create", "-o", "encryption=on"].iter().map(|x| x.to_string()).collect();
    match s("keyformat").as_str() {
        "passphrase" => {
            if !is_passphrase(&s("passphrase")) {
                return Err("passphrase: 8 to 512 characters".into());
            }
            if a["boot"] == true {
                return Err("unlock at boot needs a key file".into());
            }
            argv.extend(["-o".into(), "keyformat=passphrase".into(), "-o".into(), "keylocation=prompt".into()]);
        }
        "keyfile" => argv.extend(["-o".into(), "keyformat=raw".into(), "-o".into(), format!("keylocation=file://{}", key_file(&ds))]),
        _ => return Err("key: passphrase or key file".into()),
    }
    argv.push(ds);
    Ok(argv)
}

/// name, encryption, encryptionroot, keystatus, keyformat, keylocation of the encrypted datasets.
fn rows() -> Vec<Vec<String>> {
    cmd(&["zfs", "list", "-H", "-t", "filesystem,volume", "-o", "name,encryption,encryptionroot,keystatus,keyformat,keylocation"])
        .lines().map(|l| l.split('\t').map(String::from).collect::<Vec<_>>()).filter(|f| f.len() == 6 && f[1] != "off").collect()
}

/// Unit loading the keys of `datasets` before zfs-mount (Debian masks zfs-load-key.service).
fn render_unlock_unit(datasets: &[String]) -> String {
    let lines: String = datasets.iter().map(|d| format!("ExecStart=-/usr/sbin/zfs load-key {d}\n")).collect();
    format!("# Managed by {MARK}: unlock these encrypted datasets (key files) at boot.\n[Unit]\nDescription=cairn-nas: unlock encrypted datasets\n\
        DefaultDependencies=no\nAfter=zfs-import.target\nBefore=zfs-mount.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\n{lines}\n[Install]\nWantedBy=zfs-mount.service\n")
}

fn write_unlock_unit(state: &Value) -> Result<(), String> {
    let list = strings(state, "unlock_boot");
    if list.is_empty() {
        let _ = run(&["systemctl", "disable", "cairn-unlock.service"], None);
        let _ = fs::remove_file(UNLOCK_UNIT);
        return run(&["systemctl", "daemon-reload"], None);
    }
    write_atomic(UNLOCK_UNIT, &render_unlock_unit(&list))?;
    run(&["systemctl", "daemon-reload"], None)?;
    run(&["systemctl", "enable", "cairn-unlock.service"], None)
}

pub(crate) fn view(state: &Value) -> Value {
    let boot = strings(state, "unlock_boot");
    json!(rows().iter().map(|r| json!({"name": r[0], "root": r[2], "keystatus": r[3], "keyformat": r[4],
        "keyfile": r[5].starts_with("file://"), "boot": boot.contains(&r[0])})).collect::<Vec<_>>())
}

/// enc_create, enc_unlock, enc_lock, enc_boot.
pub(crate) fn manage_op(cfg: &Config, a: &Value, state: &mut Value) -> Result<String, String> {
    feature(cfg.features.encryption)?;
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let op = s("op");
    let ds = s("dataset");
    if op == "enc_create" {
        let existing: Vec<String> = cmd(&["zfs", "list", "-H", "-o", "name"]).lines().map(String::from).collect();
        let argv = create_argv(a, &existing)?;
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        if s("keyformat") == "passphrase" {
            run(&argv, Some(&format!("{}\n", s("passphrase"))))?;
        } else {
            let key = key_file(&ds);
            if Path::new(&key).exists() {
                return Err(format!("{key} already exists: rename or remove it first"));
            }
            let mut b = [0u8; 32];
            fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| e.to_string())?;
            fs::create_dir_all(KEYS_DIR).and_then(|()| fs::set_permissions(KEYS_DIR, fs::Permissions::from_mode(0o700))).map_err(|e| format!("{KEYS_DIR}: {e}"))?;
            fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&key).and_then(|mut f| f.write_all(&b)).map_err(|e| format!("{key}: {e}"))?;
            if let Err(e) = run(&argv, None) {
                let _ = fs::remove_file(&key); // never used: nothing is encrypted with it
                return Err(e);
            }
            if a["boot"] == true {
                state["unlock_boot"] = json!(strings(state, "unlock_boot").into_iter().chain([ds.clone()]).collect::<Vec<_>>());
                write_unlock_unit(state)?;
                save_manage(cfg, state)?;
            }
        }
        return Ok(format!("op=enc_create dataset={ds} keyformat={} boot={}", s("keyformat"), a["boot"] == true));
    }
    let rows = rows();
    let r = rows.iter().find(|r| r[0] == ds).ok_or("not encrypted")?;
    if r[2] != ds {
        return Err(format!("not an encryption root: unlock {} instead", r[2]));
    }
    match op.as_str() {
        "enc_unlock" => {
            if r[3] == "available" {
                return Err("already unlocked".into());
            }
            if r[4] == "passphrase" {
                if !is_passphrase(&s("passphrase")) {
                    return Err("passphrase: 8 to 512 characters".into());
                }
                run(&["zfs", "load-key", &ds], Some(&format!("{}\n", s("passphrase"))))?;
            } else {
                run(&["zfs", "load-key", &ds], None)?;
            }
            // Each filesystem under it that mounts at boot (canmount=on), parents first.
            for l in cmd(&["zfs", "list", "-H", "-t", "filesystem", "-o", "name,canmount,mounted,keystatus", "-r", &ds]).lines() {
                if let [name, "on", "no", "available"] = l.split('\t').collect::<Vec<_>>()[..] {
                    run(&["zfs", "mount", name], None)?;
                }
            }
            Ok(format!("op=enc_unlock dataset={ds}"))
        }
        "enc_lock" => {
            if r[3] != "available" {
                return Err("already locked".into());
            }
            let zr = zfs_rows();
            let under: Vec<&Zrow> = zr.iter().filter(|z| z.name == ds || z.name.starts_with(&format!("{ds}/"))).collect();
            let used = in_use(state, &admin_exports(), &under);
            if !used.is_empty() {
                return Err(format!("still in use, remove it first from: {}", used.join(", ")));
            }
            run(&["zfs", "unmount", "-u", &ds], None)?;
            Ok(format!("op=enc_lock dataset={ds}"))
        }
        _ => {
            let on = a["on"] == true;
            if on && !r[5].starts_with("file://") {
                return Err("unlock at boot needs a key file".into());
            }
            let mut list: Vec<String> = strings(state, "unlock_boot").into_iter().filter(|d| d != &ds).collect();
            if on {
                list.push(ds.clone());
            }
            state["unlock_boot"] = json!(list);
            write_unlock_unit(state)?;
            save_manage(cfg, state)?;
            Ok(format!("op=enc_boot dataset={ds} on={on}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encryption() {
        let ex = vec!["tank".to_string(), "tank/docs".to_string()];
        let c = |a: Value| create_argv(&a, &ex);
        assert_eq!(c(json!({"dataset": "tank/safe", "keyformat": "passphrase", "passphrase": "correct horse"})).unwrap(),
            ["zfs", "create", "-o", "encryption=on", "-o", "keyformat=passphrase", "-o", "keylocation=prompt", "tank/safe"]);
        assert_eq!(c(json!({"dataset": "tank/docs/safe", "keyformat": "keyfile", "boot": true})).unwrap().last().unwrap(), "tank/docs/safe");
        assert!(c(json!({"dataset": "tank/docs/safe", "keyformat": "keyfile"})).unwrap().contains(&"keylocation=file:///etc/cairn-nas/keys/tank_docs_safe.key".to_string()));
        assert!(c(json!({"dataset": "tank/safe", "keyformat": "passphrase", "passphrase": "short"})).is_err());
        assert!(c(json!({"dataset": "tank/safe", "keyformat": "passphrase", "passphrase": "correct\nhorse"})).is_err());
        assert!(c(json!({"dataset": "tank/safe", "keyformat": "passphrase", "passphrase": "correct horse", "boot": true})).is_err());
        assert!(c(json!({"dataset": "tank/docs", "keyformat": "keyfile"})).is_err()); // exists: no in-place encryption
        assert!(c(json!({"dataset": "tank/x/y", "keyformat": "keyfile"})).is_err());
        assert!(c(json!({"dataset": "tank/../etc", "keyformat": "keyfile"})).is_err());
        assert!(c(json!({"dataset": "tank/safe", "keyformat": "hex"})).is_err());
        let unit = render_unlock_unit(&["tank/safe".into()]);
        assert!(unit.contains("ExecStart=-/usr/sbin/zfs load-key tank/safe\n") && unit.contains("Before=zfs-mount.service") && unit.contains("DefaultDependencies=no"));
        assert_eq!(tr("fr", "not an encryption root: unlock tank/safe instead"), "pas une racine de chiffrement : déverrouillez plutôt tank/safe");
    }
}
