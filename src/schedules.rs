//! Schedules (`features.schedules`): automatic snapshots per dataset and label
//! (zfs-auto-snapshot's own properties, and the keep counts of its cron
//! lines), scrub per pool (OpenZFS' zfs-scrub-{weekly,monthly}@ timers) and
//! SMART self-tests (timers written here, running `cairn-nas --selftest`).
//! Nothing changes until it is edited in the page.

use super::*;
use std::path::Path;

pub(crate) const FR: &[(&str, &str)] = &[
    ("Pool {}: last scrub found {} errors", "Pool {} : le dernier scrub a trouvé {} erreurs"),
    ("Disk {}: last SMART self-test failed ({})", "Disque {} : le dernier autotest SMART a échoué ({})"),
    ("unknown dataset", "dataset inconnu"),
    ("unknown label", "étiquette inconnue"),
    ("keep: 1 to 1000", "conservation : de 1 à 1000"),
    ("zfs-auto-snapshot is not installed (apt install zfs-auto-snapshot)", "zfs-auto-snapshot n'est pas installé (apt install zfs-auto-snapshot)"),
    ("no --keep for this label in {}", "pas de --keep pour cette étiquette dans {}"),
    ("frequency refused", "fréquence refusée"),
    ("this system has no zfs-scrub timers (OpenZFS 2.2 or later)", "ce système n'a pas les minuteurs zfs-scrub (OpenZFS 2.2 ou plus)"),
    ("self-test: short or long", "autotest : court ou long"),
];

const LABELS: [&str; 5] = ["frequent", "hourly", "daily", "weekly", "monthly"];
const SCRUB_TIMER: &str = "/usr/lib/systemd/system/zfs-scrub-weekly@.timer";

/// zfs-auto-snapshot's cron file for a label (Debian package layout).
fn cron_file(label: &str) -> String {
    if label == "frequent" { "/etc/cron.d/zfs-auto-snapshot".into() } else { format!("/etc/cron.{label}/zfs-auto-snapshot") }
}

/// Byte range of the N of `--keep=N` on the active zfs-auto-snapshot line of `label`.
fn keep_span(text: &str, label: &str) -> Option<(usize, usize)> {
    let mut at = 0;
    for l in text.split_inclusive('\n') {
        let active = !l.trim_start().starts_with('#') && l.contains("zfs-auto-snapshot ");
        if active && l.split_whitespace().any(|w| w == format!("--label={label}")) {
            let k = l.find("--keep=")? + 7;
            let n = l[k..].chars().take_while(char::is_ascii_digit).count();
            return (n > 0).then_some((at + k, at + k + n));
        }
        at += l.len();
    }
    None
}

fn keep_of(text: &str, label: &str) -> Option<u64> {
    keep_span(text, label).and_then(|(a, b)| text[a..b].parse().ok())
}

/// zfs-auto-snapshot's rule (without --default-exclude): a dataset is
/// snapshotted for a label unless its general switch or the label's own
/// property is false; unset counts as on.
fn effective(general: &str, label: &str) -> bool {
    general != "false" && label != "false"
}

/// `zfs set` of the switches that change so that exactly `wanted` labels are
/// on: the general switch only goes on when a label is wanted and off when
/// none is; labels get an explicit value only when their state changes.
fn labels_argv(ds: &str, props: &Value, wanted: &[String]) -> Result<Option<Vec<String>>, String> {
    if !wanted.iter().all(|w| LABELS.contains(&w.as_str())) {
        return Err("unknown label".into());
    }
    let p = |k: &str| props[k].as_str().unwrap_or("-").to_string();
    let mut argv = vec!["zfs".to_string(), "set".into()];
    let general = if wanted.is_empty() { "false".to_string() } else if p("") == "false" { "true".into() } else { p("") };
    if general != p("") {
        argv.push(format!("com.sun:auto-snapshot={general}"));
    }
    if !wanted.is_empty() {
        for l in LABELS {
            let on = wanted.iter().any(|w| w == l);
            if effective(&general, &p(l)) != on {
                argv.push(format!("com.sun:auto-snapshot:{l}={on}"));
            }
        }
    }
    argv.push(ds.into());
    Ok((argv.len() > 3).then_some(argv))
}

/// {dataset: {"": general switch, label: value}} from `zfs get -H -o name,property,value`.
fn autosnap_props(out: &str) -> Value {
    let mut v = json!({});
    for l in out.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        let [name, prop, val] = f[..] else { continue };
        let Some(key) = prop.strip_prefix("com.sun:auto-snapshot") else { continue };
        v[name][key.trim_start_matches(':')] = json!(val);
    }
    v
}

fn read_autosnap() -> Value {
    let props: Vec<String> = std::iter::once("com.sun:auto-snapshot".to_string()).chain(LABELS.iter().map(|l| format!("com.sun:auto-snapshot:{l}"))).collect();
    let keep: BTreeMap<&str, Value> = LABELS.iter().map(|l| (*l, json!(keep_of(&read(&cron_file(l)), l)))).collect();
    json!({"keep": keep, "props": autosnap_props(&cmd(&["zfs", "get", "-H", "-t", "filesystem,volume", "-o", "name,property,value", &props.join(",")]))})
}

/// Writes `text` over `path`, keeping its mode (the cron.* scripts are executable).
fn rewrite(path: &str, text: &str) -> Result<(), String> {
    let mode = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?.permissions();
    let tmp = format!("{path}.cairn-tmp");
    fs::write(&tmp, text).and_then(|()| fs::set_permissions(&tmp, mode)).and_then(|()| fs::rename(&tmp, path)).map_err(|e| format!("{path}: {e}"))
}

/// systemctl commands for the OpenZFS scrub timers of a pool.
fn scrub_cmds(pool: &str, every: &str, pools: &[String]) -> Result<Vec<Vec<String>>, String> {
    if !pools.iter().any(|p| p == pool) {
        return Err("unknown pool".into());
    }
    if !["off", "weekly", "monthly"].contains(&every) {
        return Err("frequency refused".into());
    }
    let unit = |e: &str| format!("zfs-scrub-{e}@{pool}.timer");
    let mut out: Vec<Vec<String>> = ["weekly", "monthly"].iter().filter(|e| **e != every).map(|e| vec!["systemctl".into(), "disable".into(), "--now".into(), unit(e)]).collect();
    if every != "off" {
        out.push(vec!["systemctl".into(), "enable".into(), "--now".into(), unit(every)]);
    }
    Ok(out)
}

fn scrub_schedule(pools: &[String]) -> Value {
    let mut argv = vec!["systemctl".to_string(), "is-enabled".into()];
    for p in pools {
        argv.extend([format!("zfs-scrub-weekly@{p}.timer"), format!("zfs-scrub-monthly@{p}.timer")]);
    }
    let st: Vec<String> = if pools.is_empty() { vec![] } else { cmd(&argv.iter().map(String::as_str).collect::<Vec<_>>()).lines().map(String::from).collect() };
    let on = |i: usize| st.get(i).is_some_and(|s| s == "enabled");
    json!(pools.iter().enumerate().map(|(i, p)| (p.clone(), json!(if on(2 * i) { "weekly" } else if on(2 * i + 1) { "monthly" } else { "off" }))).collect::<BTreeMap<_, _>>())
}

const SMART_EVERY: [(&str, &str); 4] = [("off", ""), ("daily", "*-*-* 01:30"), ("weekly", "Sun *-*-* 01:30"), ("monthly", "Sun *-*-01..07 01:30")];

/// The two unit files of a SMART self-test schedule, or None when off.
fn smart_units(kind: &str, every: &str, exe: &str) -> Result<Option<[(String, String); 2]>, String> {
    if !["short", "long"].contains(&kind) {
        return Err("self-test: short or long".into());
    }
    let Some((_, cal)) = SMART_EVERY.iter().find(|(e, _)| *e == every) else { return Err("frequency refused".into()) };
    if cal.is_empty() {
        return Ok(None);
    }
    let base = format!("/etc/systemd/system/cairn-smart-{kind}");
    Ok(Some([
        (format!("{base}.service"), format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: SMART {kind} self-test of every disk\n\n[Service]\nType=oneshot\nExecStart={exe} --selftest {kind}\n")),
        (format!("{base}.timer"), format!("# Managed by {MARK}.\n[Unit]\nDescription=cairn-nas: SMART {kind} self-test ({every})\n\n[Timer]\nOnCalendar={cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n")),
    ]))
}

/// The newest entry of the SMART self-test log (ATA or NVMe), from `smartctl -j -a`.
pub(crate) fn last_selftest(v: &Value) -> Value {
    if let Some(e) = v["ata_smart_self_test_log"]["standard"]["table"].get(0) {
        return json!({"kind": e["type"]["string"], "status": e["status"]["string"], "passed": e["status"]["passed"], "hours": e["lifetime_hours"]});
    }
    if let Some(e) = v["nvme_self_test_log"]["table"].get(0) {
        let r = &e["self_test_result"];
        return json!({"kind": e["self_test_code"]["string"], "status": r["string"], "passed": r["value"].as_u64().map(|x| x == 0), "hours": e["power_on_hours"]});
    }
    Value::Null
}

/// `cairn-nas --selftest short|long`: starts a SMART self-test on every disk.
pub(crate) fn selftest_cli(kind: &str) -> i32 {
    if !["short", "long"].contains(&kind) {
        return 2;
    }
    for d in disks() {
        if let Err(e) = run(&["smartctl", "-t", kind, &format!("/dev/{d}")], None) {
            eprintln!("selftest {d}: {e}");
        }
    }
    0
}

/// Part of GET /api/manage.
pub(crate) fn view(state: &Value) -> Value {
    json!({
        "autosnap": read_autosnap(), "autosnap_installed": Path::new("/usr/sbin/zfs-auto-snapshot").exists(),
        "scrub": scrub_schedule(&pools()), "scrub_timers": Path::new(SCRUB_TIMER).exists(),
        "smart": {"short": state["smart"]["short"].as_str().unwrap_or("off"), "long": state["smart"]["long"].as_str().unwrap_or("off")},
    })
}

/// autosnap_labels, autosnap_keep, scrub_every, smart_every.
pub(crate) fn manage_op(cfg: &Config, a: &Value, state: &mut Value) -> Result<String, String> {
    feature(cfg.features.schedules)?;
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    match s("op").as_str() {
        "autosnap_labels" => {
            let ds = s("dataset");
            if !zfs_rows().iter().any(|r| r.name == ds) {
                return Err("unknown dataset".into());
            }
            let props = read_autosnap()["props"][ds.as_str()].clone();
            let Some(argv) = labels_argv(&ds, &props, &strings(a, "labels"))? else { return Ok(format!("op=autosnap_labels dataset={ds} unchanged")) };
            run(&argv.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            Ok(format!("op=autosnap_labels argv={}", argv.join(" ")))
        }
        "autosnap_keep" => {
            let label = s("label");
            if !LABELS.contains(&label.as_str()) {
                return Err("unknown label".into());
            }
            let keep = a["keep"].as_u64().filter(|k| (1..=1000).contains(k)).ok_or("keep: 1 to 1000")?;
            if !Path::new("/usr/sbin/zfs-auto-snapshot").exists() {
                return Err("zfs-auto-snapshot is not installed (apt install zfs-auto-snapshot)".into());
            }
            let file = cron_file(&label);
            let text = read(&file);
            let (x, y) = keep_span(&text, &label).ok_or_else(|| format!("no --keep for this label in {file}"))?;
            rewrite(&file, &format!("{}{keep}{}", &text[..x], &text[y..]))?;
            Ok(format!("op=autosnap_keep label={label} keep={keep} file={file}"))
        }
        "scrub_every" => {
            if !Path::new(SCRUB_TIMER).exists() {
                return Err("this system has no zfs-scrub timers (OpenZFS 2.2 or later)".into());
            }
            let (pool, every) = (s("pool"), s("every"));
            for c in scrub_cmds(&pool, &every, &pools())? {
                run(&c.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
            }
            Ok(format!("op=scrub_every pool={pool} every={every}"))
        }
        _ => {
            let (kind, every) = (s("kind"), s("every"));
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let timer = format!("cairn-smart-{kind}.timer");
            match smart_units(&kind, &every, &exe.display().to_string())? {
                Some(files) => {
                    for (file, text) in &files {
                        write_atomic(file, text)?;
                    }
                    run(&["systemctl", "daemon-reload"], None)?;
                    run(&["systemctl", "enable", "--now", &timer], None)?;
                }
                None => {
                    let _ = run(&["systemctl", "disable", "--now", &timer], None);
                    for ext in ["timer", "service"] {
                        let _ = fs::remove_file(format!("/etc/systemd/system/cairn-smart-{kind}.{ext}"));
                    }
                    run(&["systemctl", "daemon-reload"], None)?;
                }
            }
            state["smart"][kind.as_str()] = json!(every);
            save_manage(cfg, state)?;
            Ok(format!("op=smart_every kind={kind} every={every}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autosnap_rotation() {
        let cron = "PATH=\"/usr/bin\"\n\n*/15 * * * * root which zfs-auto-snapshot > /dev/null || exit 0 ; zfs-auto-snapshot --quiet --syslog --label=frequent --keep=4 //\n";
        assert_eq!(keep_of(cron, "frequent"), Some(4));
        assert_eq!(keep_of(cron, "hourly"), None);
        let (a, b) = keep_span(cron, "frequent").unwrap();
        assert_eq!(format!("{}{}{}", &cron[..a], 12, &cron[b..]), cron.replace("--keep=4", "--keep=12"));
        let daily = "#!/bin/sh\n# exec zfs-auto-snapshot --label=daily --keep=9 //\nexec zfs-auto-snapshot --quiet --syslog --label=daily --keep=31 //\n";
        assert_eq!(keep_of(daily, "daily"), Some(31)); // the comment is skipped
        let props = autosnap_props("tank\tcom.sun:auto-snapshot\ttrue\ntank\tcom.sun:auto-snapshot:frequent\tfalse\ntank\tcom.sun:auto-snapshot:daily\t-\nfast\tcom.sun:auto-snapshot\tfalse\nx\tother\t1\n");
        assert_eq!(props["tank"][""], "true");
        assert!(props["x"].is_null());
        let w = |l: &[&str]| l.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let t = &props["tank"];
        assert_eq!(labels_argv("tank", t, &w(&["hourly", "daily", "weekly", "monthly"])).unwrap(), None); // unchanged
        assert_eq!(labels_argv("tank", t, &w(&["frequent", "daily"])).unwrap().unwrap(),
            ["zfs", "set", "com.sun:auto-snapshot:frequent=true", "com.sun:auto-snapshot:hourly=false", "com.sun:auto-snapshot:weekly=false", "com.sun:auto-snapshot:monthly=false", "tank"]);
        assert_eq!(labels_argv("tank", t, &[]).unwrap().unwrap(), ["zfs", "set", "com.sun:auto-snapshot=false", "tank"]);
        // Off: the general switch goes on, the labels not wanted get false.
        assert_eq!(labels_argv("fast", &props["fast"], &w(&["daily"])).unwrap().unwrap(),
            ["zfs", "set", "com.sun:auto-snapshot=true", "com.sun:auto-snapshot:frequent=false", "com.sun:auto-snapshot:hourly=false", "com.sun:auto-snapshot:weekly=false", "com.sun:auto-snapshot:monthly=false", "fast"]);
        assert_eq!(labels_argv("fast", &props["fast"], &[]).unwrap(), None);
        assert_eq!(labels_argv("new", &json!({}), &w(&LABELS)).unwrap(), None); // unset = on
        assert!(labels_argv("tank", t, &w(&["yearly"])).is_err());
    }

    #[test]
    fn scrub_and_smart_schedules() {
        let p = vec!["tank".to_string()];
        assert_eq!(scrub_cmds("tank", "monthly", &p).unwrap(), vec![
            vec!["systemctl", "disable", "--now", "zfs-scrub-weekly@tank.timer"], vec!["systemctl", "enable", "--now", "zfs-scrub-monthly@tank.timer"]]);
        assert_eq!(scrub_cmds("tank", "off", &p).unwrap().len(), 2);
        assert!(scrub_cmds("tank", "daily", &p).is_err());
        assert!(scrub_cmds("x;y", "off", &p).is_err());
        let u = smart_units("long", "monthly", "/usr/local/bin/cairn-nas").unwrap().unwrap();
        assert!(u[0].1.contains("ExecStart=/usr/local/bin/cairn-nas --selftest long"));
        assert!(u[1].1.contains("OnCalendar=Sun *-*-01..07 01:30"));
        assert!(smart_units("short", "off", "x").unwrap().is_none());
        assert!(smart_units("conveyance", "daily", "x").is_err());
        assert!(smart_units("short", "hourly", "x").is_err());
        let ata = json!({"ata_smart_self_test_log": {"standard": {"table": [{"type": {"string": "Short offline"}, "status": {"string": "Completed: read failure", "passed": false}, "lifetime_hours": 812}]}}});
        assert_eq!(last_selftest(&ata)["passed"], false);
        let nvme = json!({"nvme_self_test_log": {"table": [{"self_test_code": {"string": "Short"}, "self_test_result": {"value": 0, "string": "Completed without error"}, "power_on_hours": 90}]}});
        assert_eq!(last_selftest(&nvme)["passed"], true);
        assert!(last_selftest(&json!({})).is_null());
        for (en, fr) in FR {
            assert_eq!(en.matches("{}").count(), fr.matches("{}").count(), "{en}");
        }
    }
}
