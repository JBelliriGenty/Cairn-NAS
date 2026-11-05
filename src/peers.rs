//! Other Cairn instances ("peers"), read-only: every POLL_S, each peer's
//! GET /api/summary is fetched in the background (its bearer token, from a
//! root-only file, goes to curl on stdin, never on the command line nor to the
//! browser); the page reads the last results from memory (/api/peers), so a
//! dead peer never slows it. A peer unreachable for longer than the threshold
//! is alerted; its own problems are not (each machine alerts on its own).

use super::*;

pub(crate) const FR: &[(&str, &str)] = &[
    ("Machine {} has been unreachable for over {} min", "Machine {} injoignable depuis plus de {} min"),
    ("invalid summary", "résumé invalide"),
];

const POLL_S: u64 = 30;

pub(crate) struct Peer {
    name: String,
    url: String,  // where this server fetches <url>/api/summary
    link: String, // what the browser opens
    token: String,
}

#[derive(Default, Clone)]
struct State {
    summary: Option<Value>, // last good answer
    ok: bool,
    down_since: Option<u64>, // first failure after the last success
    error: String,
    checked: u64,
}

static STATES: Mutex<BTreeMap<String, State>> = Mutex::new(BTreeMap::new());

fn http(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

/// `peers` in the config: [{name, url, link, token_file}].
pub(crate) fn load(v: &Value) -> Vec<Peer> {
    let peers: Vec<Peer> = v["peers"].as_array().into_iter().flatten().map(|p| {
        let s = |k: &str| p[k].as_str().unwrap_or("").trim().to_string();
        let (name, url, link, file) = (s("name"), s("url"), s("link"), s("token_file"));
        assert!(!name.is_empty(), "config: peers: name required");
        assert!(http(&url) && http(&link), "config: peers: {name}: url and link must start with http:// or https://");
        let token = fs::read_to_string(&file).unwrap_or_else(|_| panic!("config: peers: {name}: token_file unreadable")).trim().to_string();
        assert!(token.len() >= 32 && !token.contains(['"', '\\', '\n']), "config: peers: {name}: invalid token");
        Peer { name, url: url.trim_end_matches('/').to_string(), link, token }
    }).collect();
    let mut names: Vec<&str> = peers.iter().map(|p| p.name.as_str()).collect();
    names.sort();
    names.dedup();
    assert!(names.len() == peers.len(), "config: peers: duplicate name");
    peers
}

/// A peer's /api/summary, reduced to the known fields (a peer is not trusted
/// to send anything else to this page).
fn parse_summary(body: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "invalid summary")?;
    let (Some(pools), Some(problems)) = (v["pools"].as_object(), v["problems"].as_u64()) else { return Err("invalid summary".into()) };
    let mut out = json!({});
    for (name, p) in pools.iter().take(64) {
        let health = p["health"].as_str().ok_or("invalid summary")?;
        out[name.chars().take(64).collect::<String>()] = json!({"health": health.chars().take(16).collect::<String>(),
            "capacity": p["capacity"].as_u64().unwrap_or(0), "size": p["size"].as_u64().unwrap_or(0), "alloc": p["alloc"].as_u64().unwrap_or(0)});
    }
    let messages: Vec<String> = v["messages"].as_array().into_iter().flatten().filter_map(|m| m.as_str()).take(50).map(|m| m.chars().take(300).collect()).collect();
    let mut res = json!({"pools": out, "problems": problems, "messages": messages, "temp_max_c": v["temp_max_c"].as_i64()});
    if v["full"].is_object() {
        res["full"] = clean(&v["full"], 0);
    }
    Ok(res)
}

/// A peer's free-form part (`full`) bounded: scalars, short strings, small
/// arrays and objects, shallow. The page escapes whatever it shows.
fn clean(v: &Value, depth: usize) -> Value {
    match v {
        Value::String(s) => json!(s.chars().take(200).collect::<String>()),
        Value::Array(a) if depth < 4 => a.iter().take(64).map(|x| clean(x, depth + 1)).collect(),
        Value::Object(o) if depth < 4 => Value::Object(o.iter().take(64).map(|(k, x)| (k.chars().take(64).collect(), clean(x, depth + 1))).collect()),
        Value::Array(_) | Value::Object(_) => Value::Null,
        _ => v.clone(),
    }
}

/// /proc/stat "cpu" line: (total, idle+iowait).
fn cpu_times(stat: &str) -> (u64, u64) {
    let f: Vec<u64> = stat.lines().next().unwrap_or("").split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    (f.iter().take(8).sum(), f.get(3).unwrap_or(&0) + f.get(4).unwrap_or(&0))
}

/// Sum of received and sent bytes of the listed interfaces in /proc/net/dev
/// (all wired ones, e*, when the list is empty).
fn net_bytes(dev: &str, nics: &[String]) -> (u64, u64) {
    dev.lines().filter_map(|l| l.split_once(':')).filter(|(n, _)| {
        let n = n.trim();
        if nics.is_empty() { n.starts_with('e') } else { nics.iter().any(|x| x == n) }
    }).fold((0, 0), |(rx, tx), (_, rest)| {
        let f: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        (rx + f.first().unwrap_or(&0), tx + f.get(8).unwrap_or(&0))
    })
}

/// What the Overview shows of this machine, for the other Cairn instances
/// (`/api/summary?full=1`): CPU and network over half a second.
pub(crate) fn full(cfg: &Config) -> Value {
    let nics: Vec<String> = cfg.public["nics"].as_array().into_iter().flatten().filter_map(|n| n[0].as_str().map(String::from)).collect();
    let (c0, n0) = (cpu_times(&read("/proc/stat")), net_bytes(&read("/proc/net/dev"), &nics));
    std::thread::sleep(Duration::from_millis(500));
    let (c1, n1) = (cpu_times(&read("/proc/stat")), net_bytes(&read("/proc/net/dev"), &nics));
    let busy = if c1.0 > c0.0 { 100.0 * (1.0 - (c1.1 - c0.1) as f64 / (c1.0 - c0.0) as f64) } else { 0.0 };
    let meminfo = read("/proc/meminfo");
    let mem_of = |k: &str| meminfo.lines().find_map(|l| l.strip_prefix(k)?.strip_prefix(':')?.split_whitespace().next()?.parse::<u64>().ok()).unwrap_or(0) * 1024;
    let cpu_temp = hwmon().lines().filter_map(|l| {
        let f: Vec<&str> = l.split('|').collect();
        (["coretemp", "k10temp"].contains(&f[0])).then(|| f[3].parse::<i64>().ok().map(|t| t / 1000)).flatten()
    }).max();
    let loadavg = read("/proc/loadavg");
    let load: Vec<f64> = loadavg.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
    let uptime = read("/proc/uptime").split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    let disks: Vec<Value> = health().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).map(|d| json!({
        "dev": d["dev"], "model": d["model"], "temp": d["temp"], "passed": d["passed"], "critical": d["critical"], "media_errors": d["media_errors"],
        "spare": d["spare"], "spare_thr": d["spare_thr"], "used": d["used"], "realloc": d["realloc"], "selftest": {"passed": d["selftest"]["passed"]},
    })).collect();
    let mut argv = vec!["systemctl", "is-active"];
    argv.extend(cfg.services.iter().map(String::as_str));
    let services: Vec<Value> = cfg.services.iter().zip(cmd(&argv).lines()).map(|(s, st)| json!([s, st])).collect();
    let now = now_s();
    let repl: Vec<Value> = last_sends(&cmd(&["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,creation"]), &replicas(cfg)).into_iter()
        .map(|(ds, last, max)| json!([ds, last.map(|t| now.saturating_sub(t)), max])).collect();
    json!({"cpu_pct": busy, "cores": read("/proc/stat").lines().filter(|l| l.starts_with("cpu") && !l.starts_with("cpu ")).count(),
        "load": load, "uptime_s": uptime, "cpu_temp_c": cpu_temp,
        "mem": {"total": mem_of("MemTotal"), "used": mem_of("MemTotal").saturating_sub(mem_of("MemAvailable"))},
        "net": {"rx_bps": (n1.0.saturating_sub(n0.0)) * 16, "tx_bps": (n1.1.saturating_sub(n0.1)) * 16},
        "disks": disks, "services": services, "replication": repl})
}

/// Records one poll result.
fn record(st: &mut State, res: Result<Value, String>, now: u64) {
    st.checked = now;
    match res {
        Ok(s) => {
            *st = State { summary: Some(s), ok: true, down_since: None, error: String::new(), checked: now };
        }
        Err(e) => {
            st.ok = false;
            st.down_since.get_or_insert(now);
            st.error = e;
        }
    }
}

/// Peers unreachable for at least `limit_s`, as alerts (key -> message).
fn overdue(states: &BTreeMap<String, State>, limit_s: u64, now: u64, out: &mut BTreeMap<String, String>) {
    for (name, st) in states {
        if st.down_since.is_some_and(|d| now.saturating_sub(d) >= limit_s) {
            out.insert(format!("peer:{name}"), format!("Machine {name} has been unreachable for over {} min", limit_s / 60));
        }
    }
}

pub(crate) fn problems(cfg: &Config, out: &mut BTreeMap<String, String>) {
    overdue(&STATES.lock().unwrap_or_else(|e| e.into_inner()), cfg.peer_unreachable_s, now_s(), out);
}

fn fetch(p: &Peer) -> Result<Value, String> {
    parse_summary(&get(p, "/api/summary?full=1", 262144)?)
}

/// GET <peer>/<path> with its token, body at most `max` bytes.
fn get(p: &Peer, path: &str, max: u64) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let url = format!("{}{path}", p.url);
    let max = max.to_string();
    let mut child = Command::new("curl")
        .args(["-fsS", "-m", "8", "--max-filesize", &max, "--proto", "=http,https", "-K", "-", &url])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("curl: {e}"))?;
    if let Some(mut pipe) = child.stdin.take() {
        let _ = writeln!(pipe, "header = \"Authorization: Bearer {}\"", p.token);
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().trim_start_matches("curl: ").to_string());
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The peer's page data for the machine selector: GET /api/peer/<name>/<config|fast|slow>,
/// fetched on demand (read-only endpoints its token opens). Returns (body, content type).
pub(crate) fn proxy(cfg: &Config, path: &str, user: &str) -> Result<(String, &'static str), (u16, String)> {
    let (name, what) = path.strip_prefix("/api/peer/").and_then(|r| r.split_once('/')).ok_or((404, "not found".to_string()))?;
    let p = cfg.peers.iter().find(|p| p.name == name).ok_or((404, "not found".to_string()))?;
    let ctype = match what { "config" => "application/json", "fast" | "slow" => "text/plain", _ => return Err((404, "not found".into())) };
    let body = get(p, &format!("/api/{what}"), 16 << 20).map_err(|e| (502, e))?;
    if what != "config" {
        return Ok((body, ctype));
    }
    let mut c: Value = serde_json::from_str(&body).map_err(|_| (502, "invalid summary".to_string()))?;
    c["user"] = json!(user);
    Ok((c.to_string(), ctype))
}

/// Background loop: polls every peer in parallel every POLL_S.
pub(crate) fn poll_loop(cfg: &'static Config) {
    loop {
        let results: Vec<(String, Result<Value, String>)> = std::thread::scope(|s| {
            let hs: Vec<_> = cfg.peers.iter().map(|p| s.spawn(move || (p.name.clone(), fetch(p)))).collect();
            hs.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let now = now_s();
        let mut states = STATES.lock().unwrap_or_else(|e| e.into_inner());
        for (name, res) in results {
            record(states.entry(name).or_default(), res, now);
        }
        drop(states);
        std::thread::sleep(Duration::from_secs(POLL_S));
    }
}

/// GET /api/peers: this machine first, then each peer as last seen.
pub(crate) fn view(cfg: &Config) -> Value {
    let now = now_s();
    let states = STATES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut out = vec![json!({"name": cfg.public["title"], "self": true, "ok": true, "summary": summary(cfg)})];
    for p in &cfg.peers {
        let st = states.get(&p.name).cloned().unwrap_or_default();
        out.push(json!({"name": p.name, "link": p.link, "ok": st.ok, "summary": st.summary, "error": st.error,
            "checked": st.checked > 0, "down_s": st.down_since.map(|d| now.saturating_sub(d))}));
    }
    json!(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries() {
        let s = parse_summary(r#"{"pools":{"tank":{"health":"ONLINE","capacity":42,"size":10,"alloc":4,"x":1}},"problems":1,"messages":["Pool tank: x"],"temp_max_c":51,"evil":"<script>"}"#).unwrap();
        assert_eq!(s, json!({"pools": {"tank": {"health": "ONLINE", "capacity": 42, "size": 10, "alloc": 4}}, "problems": 1, "messages": ["Pool tank: x"], "temp_max_c": 51}));
        assert_eq!(parse_summary(r#"{"pools":{},"problems":0,"temp_max_c":null}"#).unwrap()["temp_max_c"], Value::Null);
        assert!(parse_summary("<html>").is_err());
        assert!(parse_summary(r#"{"pools":[],"problems":0}"#).is_err());
        assert!(parse_summary(r#"{"pools":{"t":{}},"problems":0}"#).is_err());
    }

    #[test]
    fn unreachable() {
        let mut states = BTreeMap::new();
        let st: &mut State = states.entry("b".to_string()).or_default();
        record(st, Err("timeout".into()), 1000);
        record(st, Err("timeout".into()), 1030);
        assert_eq!((st.ok, st.down_since, st.error.as_str(), st.checked), (false, Some(1000), "timeout", 1030));
        let mut out = BTreeMap::new();
        overdue(&states, 900, 1899, &mut out);
        assert!(out.is_empty());
        overdue(&states, 900, 1900, &mut out);
        assert_eq!(out["peer:b"], "Machine b has been unreachable for over 15 min");
        assert_eq!(tr("fr", &out["peer:b"]), "Machine b injoignable depuis plus de 15 min");
        // the last good summary is kept while down, cleared of the failure on success
        let st = states.get_mut("b").unwrap();
        record(st, Ok(json!({"problems": 0})), 2000);
        record(st, Err("refused".into()), 2030);
        assert!(st.summary.is_some() && st.down_since == Some(2030));
        record(st, Ok(json!({"problems": 0})), 2060);
        assert!(st.ok && st.down_since.is_none() && st.error.is_empty());
        let full = parse_summary(r#"{"pools":{},"problems":0,"full":{"cpu_pct":3.5,"services":[["nfs-server","active"]],"deep":{"a":{"b":{"c":{"d":1}}}},"s":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#).unwrap();
        assert_eq!(full["full"]["services"], json!([["nfs-server", "active"]]));
        assert_eq!(full["full"]["deep"], json!({"a": {"b": {"c": null}}}));
        assert_eq!(full["full"]["s"].as_str().unwrap().len(), 200);
        assert_eq!(cpu_times("cpu  10 0 10 70 10 0 0 0 0 0
cpu0 1 2
"), (100, 80));
        let dev = "Inter-|
 face |
    lo: 9 0 0 0 0 0 0 0 9 0
 enp1s0: 100 0 0 0 0 0 0 0 50 0
 wlan0: 7 0 0 0 0 0 0 0 7 0
";
        assert_eq!(net_bytes(dev, &[]), (100, 50));
        assert_eq!(net_bytes(dev, &["wlan0".into()]), (7, 7));
        for (en, fr) in FR {
            assert_eq!(en.matches("{}").count(), fr.matches("{}").count(), "{en}");
        }
    }
}
