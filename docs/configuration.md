# Configuration reference

Everything Cairn reads or writes, key by key. The [README](../README.md)
explains what the panel does; this page is what you edit.

| File | Who writes it | |
|---|---|---|
| `/etc/cairn-nas.json` (first argument) | you (`install.sh` writes a first one) | sign-in, address, features, alerts |
| `tls.cert`, `tls.key` | you (`install.sh` makes a self-signed pair) | PEM certificate and key |
| token files (`summary_token_file`, `peers[].token_file`) | you | one secret per file, never in the config |
| `alerts.headers_file` | you | header lines added to each alert |
| `state_file` (`/var/lib/cairn-nas/ui.json`) | the page | labels, tags and groupings set by hand |
| `manage_file` (`/var/lib/cairn-nas/manage.json`) | the page | shares, groups, replication, iSCSI, restic, SMART schedules |
| system files listed in [Files written by Cairn](#files-written-by-cairn) | Cairn | exports, Samba, nftables, systemd units |

Paths are used as written: give absolute paths (a relative one is read from
the folder Cairn was started in, `/` under systemd).

Check a config: there is no dry run. Check the JSON first, then restart the
panel and read its first log line:

```sh
python3 -m json.tool /etc/cairn-nas.json > /dev/null && echo "valid JSON"
systemctl restart cairn-nas && journalctl -u cairn-nas -n 5
```

`cairn-nas listening on <address>` means the config was accepted. It stops
at once, with a message, on invalid JSON, a `login` without `tls`, a TLS file
it cannot read, a `summary_token_file` it cannot read or shorter than 32
characters, or an invalid `peers` entry (no name, duplicate name, `url` or
`link` not starting with `http://` / `https://`, unreadable or short token).

Changes take effect on restart (`systemctl restart cairn-nas`); the page's
own files are read on each request.

## cairn-nas.json

| Key | Type | Default | |
|---|---|---|---|
| `listen` | `"host:port"` | `"127.0.0.1:9091"` | `install.sh` sets `"0.0.0.0:8443"` |
| `title` | string | none | page header |
| `subtitle` | string | none | |
| `lang` | `"en"` \| `"fr"` | `"en"` | alerts and `/api/summary`; the page's default when the browser asks for neither; each viewer can switch |
| `login` | object | none | built-in sign-in, see [`login`](#login); needs `tls` |
| `tls` | `{"cert", "key"}` | none | PEM files `cert` and `key`; both set: HTTPS, else plain HTTP |
| `trusted_proxies` | list of IPs | `[]` | proxy mode: only these exact addresses (no CIDR) are answered |
| `user_header` | string | `"Remote-User"` | proxy mode: the signed-in user |
| `groups_header` | string | `"Remote-Groups"` | proxy mode: comma-separated groups |
| `require_groups` | list | `[]` | proxy mode: the user needs one of these groups; empty: any user |
| `services` | list of systemd units | `[]` | shown on Services, restartable from the page |
| `features` | object | all off | the writes allowed beyond the basics, see [`features`](#features) |
| `firewall_table` | string | none | nftables table holding the sets `cairn_nfs` / `cairn_smb` (e.g. `"inet nas"`); none: the firewall is never touched |
| `alerts` | object | none | see [`alerts`](#alerts) |
| `replication` | list | `[]` | replicated datasets shown in Backup, see [`replication`](#replication) |
| `recycle_days` | number | `30` | days the SMB recycle bin keeps a file (1 minimum) |
| `nics` | list of `[name, label]` | `[]` | display names of network interfaces, in this order |
| `hosts` | object IP → name | `{}` | display names of client machines (NFS clients, SMB sessions), offered when adding an NFS client |
| `peers` | list | `[]` | other Cairn machines, see [`peers`](#peers) |
| `peer_unreachable_minutes` | number | `15` | alert when a peer stays unreachable this long |
| `summary_token_file` | path | none | opens `GET /api/summary` to dashboards and to other Cairn; none: signed-in sessions only |
| `iscsi_base` | string | `iqn.2003-01.org.linux-iscsi.<hostname>` | iSCSI target names are `<iscsi_base>:<volume>` |
| `state_file` | path | `"/var/lib/cairn-nas/ui.json"` | |
| `manage_file` | path | `"/var/lib/cairn-nas/manage.json"` | |
| `alerts_file` | path | `"/var/lib/cairn-nas/alerts.json"` | problems already notified, so a restart does not send them again |
| `nfs_file` | path | `"/etc/exports.d/cairn-nas.exports"` | |
| `smb_file` | path | `"/etc/samba/cairn-nas.conf"` | must be included by `smb.conf` (`install.sh` adds the line) |
| `fw_file` | path | `"/etc/nftables.d/cairn-nas.nft"` | used with `firewall_table` only |

`nics` is a list, not an object, because its order is the order shown.
Labels, tags and groupings changed on the page go to `state_file` and win
over `nics` and `hosts`.

Unknown keys are ignored, so a typo does not stop the panel: it just has no
effect. If a setting seems ignored, check its spelling first.

### `login`

```json
"login": {"admin_group": "nas-admin", "session_minutes": 30}
```

| Key | Default | |
|---|---|---|
| `admin_group` | `"nas-admin"` | system group whose members may sign in (password checked against `/etc/shadow`) |
| `session_minutes` | `30` | idle time before the session expires (1 minimum) |

With `login`, `trusted_proxies` and the headers are not read. Each failed
sign-in doubles the delay for that address, up to 5 minutes.

### `features`

Each key is a boolean, `false` when absent. Off, the page hides the
buttons and the server refuses the action.

| Key | Allows |
|---|---|
| `nfs` | NFS shares and their clients |
| `smb` | SMB shares, Time Machine, Previous Versions, recycle bin |
| `users` | accounts (no shell, no SSH) with a Samba password, and groups |
| `pools` | create, grow, export, import, upgrade and delete pools; create and delete datasets and volumes |
| `vdevs` | add and remove log, cache and spare devices; trim |
| `disks` | take pool members offline or online, replace them |
| `replication` | let a backup machine pull this one, and pull others (syncoid) |
| `iscsi` | export volumes over iSCSI (LIO, `targetcli`) |
| `restore` | browse snapshots, restore files, clone, roll back |
| `schedules` | automatic snapshots per label, scrub and SMART self-test schedules |
| `encryption` | create encrypted datasets, lock and unlock them |
| `offsite` | restic repositories, backup jobs, restore |

Reading (pools, disks, shares, services) needs no feature.

### `alerts`

```json
"alerts": {"url": "https://ntfy.example.com/nas", "headers_file": "/etc/cairn-nas-ntfy-headers",
           "capacity_pct": 85, "interval_s": 300}
```

| Key | Default | |
|---|---|---|
| `url` | required | each alert is POSTed there as text; ntfy reads the title, priority and tags from the query string Cairn adds, any other webhook just gets the text |
| `headers_file` | none | header lines sent with each alert (`Authorization: Bearer …`): the secret stays out of the config |
| `capacity_pct` | `85` | a pool fuller than this is a problem (also used by `/api/summary`) |
| `interval_s` | `300` | time between checks (60 minimum) |

Alerted: degraded or full pool, failing disk, failed service in
`services`, late replication, unreachable peer. A problem is sent once,
and again when it clears.

### `replication`

```json
"replication": [{"dataset": "tank/data", "max_age_hours": 26, "snapshot_prefix": "syncoid_"}]
```

| Key | Default | |
|---|---|---|
| `dataset` | required | the dataset (its children included) |
| `max_age_hours` | `26` | alert when its newest snapshot is older (1 minimum) |
| `snapshot_prefix` | `""` | only snapshots starting with this count; on the sending side, set it to what your tool creates per send (`syncoid_`); on the receiving side, leave it empty |

Entries without `dataset` are skipped. This only watches: the pulls set up
from the page (`features.replication`) are kept in `manage_file`.

### `peers`

```json
"peers": [{"name": "Backup", "url": "http://192.0.2.20:9091", "link": "https://backup.example.lan",
           "token_file": "/etc/cairn-nas-peer-backup-token"}]
```

| Key | |
|---|---|
| `name` | required, unique |
| `url` | where this server reaches the peer (`http://` or `https://`) |
| `link` | what the browser opens for that peer (`http://` or `https://`) |
| `token_file` | the peer's summary token (its own `summary_token_file`), 32 characters minimum |

See the README, Machines, for what a peer token opens.

## Files the page writes

`state_file`, display only:

```json
{"labels": {"nic:enp1s0": "LAN", "host:192.0.2.30": "laptop"}, "tags": {}, "assign": {}}
```

`manage_file`: what the page set up, and the source of the system files
below (`nfs`, `smb`, `groups`, `repl_allow`, `repl_pull`, `iscsi`,
`restic_repos`, `restic_jobs`, `smart`, `unlock_boot`). The exports, the
Samba file and the firewall sets are rewritten from it on each change.

Edit it by hand only with the panel stopped, and keep a copy: a file that
is not valid JSON reads as empty, and the next change from the page then
rewrites the exports and Samba shares from nothing.

## Files written by Cairn

| File | When |
|---|---|
| `nfs_file`, `smb_file` | NFS and SMB shares |
| `fw_file` | per-share firewall opening, with `firewall_table` |
| `/etc/systemd/system/cairn-repl.{service,timer}`, `/var/lib/cairn-repl/` | replication: the nightly pull and the `cairn-repl` account (its `authorized_keys`) |
| `/var/lib/cairn-nas/repl_ed25519` | replication: the key a backup machine pulls with |
| `/etc/systemd/system/cairn-backup-*`, `/etc/cairn-nas/restic/`, `/var/lib/cairn-nas/restic_ed25519`, `restic-status.json` | off-site backups |
| `/etc/systemd/system/cairn-smart-*` | SMART self-test schedules |
| `/etc/cairn-nas/keys/`, `/etc/systemd/system/cairn-unlock.service` | encryption: raw key files and unlock at boot |
| `/etc/systemd/system/rtslib-fb-targetctl.service.d/cairn-nas.conf` | iSCSI |

Every write is a validated action from a closed list, run without a shell
and logged with the account name (`journalctl -u cairn-nas`). Files Cairn
did not write (`/etc/exports`, other Samba shares) are read, never changed.

## Command line

| | |
|---|---|
| `cairn-nas /etc/cairn-nas.json` | the panel |
| `cairn-nas --demo [address:port]` | sample data, nothing changed (`127.0.0.1:8080`) |
| `cairn-nas --pull <config>` | the replication pull (run by `cairn-repl.service`) |
| `cairn-nas --backup …`, `--restore …` | restic jobs (run by their systemd units) |

## Recipes

**Smallest useful config** (what `install.sh` writes): built-in sign-in over
HTTPS, shares and accounts.

```json
{"listen": "0.0.0.0:8443",
 "login": {"admin_group": "nas-admin", "session_minutes": 30},
 "tls": {"cert": "/etc/cairn-nas/cert.pem", "key": "/etc/cairn-nas/key.pem"},
 "services": ["smbd", "nfs-server", "zfs-zed"],
 "features": {"nfs": true, "smb": true, "users": true}}
```

**Behind Authelia (or any authenticating proxy)**: no `login`, answer only
the proxy, keep the panel to one group.

```json
{"listen": "0.0.0.0:9091", "trusted_proxies": ["192.0.2.5"], "require_groups": ["nas-admins"]}
```

**Alerts to ntfy**, with a token:

```json
{"alerts": {"url": "https://ntfy.example.com/nas", "headers_file": "/etc/cairn-nas-ntfy-headers"}}
```

with `/etc/cairn-nas-ntfy-headers` (`chmod 600`) holding
`Authorization: Bearer tk_…`.

**Open the summary to Homepage or Cairn Map**:

```sh
openssl rand -hex 32 > /etc/cairn-nas-summary-token && chmod 600 /etc/cairn-nas-summary-token
```

```json
{"summary_token_file": "/etc/cairn-nas-summary-token"}
```

**Two machines that see each other**: on each, a `summary_token_file`; on
each, a `peers` entry whose `token_file` holds the other one's token.
