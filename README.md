<p align="center"><img src="www/icon.svg" width="96" alt=""></p>

# Cairn (`cairn-nas`)

[![CI](https://github.com/JBelliriGenty/Cairn-NAS/actions/workflows/ci.yml/badge.svg)](https://github.com/JBelliriGenty/Cairn-NAS/actions/workflows/ci.yml)

A web admin panel for a small **Debian + ZFS** NAS. One Rust binary with the
page embedded: no database, no third-party JavaScript, a few MB of RAM.

> Interface in English and French. Early days: it runs every day on its
> author's NAS, but the standalone installer has seen little testing on
> fresh machines. Issues and pull requests are welcome.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png"><img src="docs/screenshots/overview-light.png" alt="Overview: CPU, memory, storage, temperature, disk health, pools, network, services"></picture>

<table>
<tr><td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/stockage-dark.png"><img src="docs/screenshots/stockage-light.png" alt="Storage: ZFS pools and datasets"></picture></td><td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/partages-dark.png"><img src="docs/screenshots/partages-light.png" alt="Shares: NFS and SMB, current SMB sessions"></picture></td></tr>
<tr><td align="center">Storage</td><td align="center">Shares</td></tr>
<tr><td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/disques-dark.png"><img src="docs/screenshots/disques-light.png" alt="Disks: per-pool activity, temperature, SMART health"></picture></td><td><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/services-dark.png"><img src="docs/screenshots/services-light.png" alt="Services, alerts, updates and action journal"></picture></td></tr>
<tr><td align="center">Disks</td><td align="center">Services</td></tr>
</table>

Screenshots follow your GitHub theme (light or dark); the panel has both.
Demo data.

## What it does

- **Overview**: CPU, memory (including the ZFS ARC), network, disks and
  temperatures, live.
- **Disks**: SMART health (NVMe wear, reallocated sectors, errors).
- **Storage**: ZFS pools and datasets (compression, quota, automatic
  snapshots on/off), manual snapshots, scrub.
- **NFS and SMB shares**: created from the page, access by account or group,
  SMB3 minimum, encryption preferred or required, Time Machine, Windows
  Previous Versions, recycle bin, per-share firewall opening (nftables).
  Current SMB sessions.
- **Time Machine wizard**: account + preset share in one form (on an
  existing dataset, or a new one when `features.pools` is on). Macs find it
  through Bonjour (avahi).
- **Accounts**: Linux accounts without login (no shell, no SSH) with a Samba
  password, and groups.
- **Services**: state, restart, pending updates, journal of the actions done
  from the page.
- **Alerts**: degraded or full pool, failing disk, failed service, sent to
  ntfy or any webhook (text POST).
- **Dashboards**: read-only JSON summary for Homepage and the like.

Optional (off by default): creating datasets and pools on blank disks
(`features.pools`).

## Try it

`cairn-nas --demo` serves the page on sample data at `http://127.0.0.1:8080`
(or `--demo <address:port>`): no root, no ZFS needed, nothing is changed.

## Install (standalone mode)

Debian 13 with ZFS already set up (`zfsutils-linux`), as root, from the
[latest release](https://github.com/JBelliriGenty/Cairn-NAS/releases/latest)
(x86_64):

```sh
tar xzf cairn-nas-v*-x86_64-linux.tar.gz
cd cairn-nas-v*-x86_64-linux
sh install.sh
usermod -aG nas-admin <your-account>
```

Or from source (builds with Debian's `cargo`): `git clone` this repository and
run `sh install.sh` in it.

Then open `https://<address>:8443` and sign in with that system account. The
certificate is self-signed: replace `/etc/cairn-nas/cert.pem` and `key.pem`
with your own if you have one.

## Two authentication modes

- **Built-in sign-in** (`login` in the config, what `install.sh` sets up):
  HTTPS only (system OpenSSL), a system account member of `admin_group`
  checked against `/etc/shadow`, session cookie (`HttpOnly`, `Secure`,
  `SameSite=Strict`) expiring after `session_minutes` idle, delay doubled on
  each failure (up to 5 min) per address.
- **Behind an authenticating reverse proxy** (Traefik + Authelia, etc.):
  without `login`, the panel only answers the `trusted_proxies` addresses and
  reads the identity from `user_header` / `groups_header` (`require_groups`).

## Configuration (`/etc/cairn-nas.json`)

| Key | Purpose |
|---|---|
| `listen` | listen address:port |
| `title`, `subtitle` | page header |
| `login` | `{admin_group, session_minutes}`: built-in sign-in |
| `tls` | `{cert, key}` (PEM): HTTPS, required with `login` |
| `trusted_proxies`, `user_header`, `groups_header`, `require_groups` | proxy mode |
| `services` | systemd units shown and restartable |
| `features` | `{nfs, smb, users, pools}`: allowed writes |
| `firewall_table` | nftables table holding the `cairn_nfs` / `cairn_smb` sets (absent: the firewall is never touched) |
| `alerts` | `{url, headers_file, capacity_pct, interval_s}` |
| `replication` | list of `{dataset, max_age_hours, snapshot_prefix}`: replicated datasets (with their children) shown in Storage with their newest snapshot, alert past `max_age_hours` (26). On the receiving side any snapshot counts; on the sending side set `snapshot_prefix` to the one your tool creates per send (e.g. `syncoid_`) |
| `recycle_days` | how long the SMB recycle bin keeps files (30) |
| `lang` | `en` or `fr`: alerts, `/api/summary`, and the page's default when the browser asks for neither (`en`) |
| `nics`, `hosts` | display names of network interfaces and client machines |
| `summary_token_file` | file holding the token (32 characters min.) that opens `GET /api/summary` to dashboards |

## Dashboards (Homepage…)

`GET /api/summary` returns, read-only:

```json
{"pools": {"tank": {"health": "ONLINE", "capacity": 3, "size": 20000588955648, "alloc": 685076635648}},
 "problems": 0, "messages": [], "temp_max_c": 46}
```

`capacity` in %, `size`/`alloc` in bytes, `problems` = current alerts (pools,
SMART disks, failed services, late replication). A signed-in session can read it; otherwise it
needs the `Authorization: Bearer <token>` header with the token from
`summary_token_file` (`openssl rand -hex 32 > /etc/cairn-nas-summary-token`,
`chmod 600`). [Homepage](https://gethomepage.dev) widget:

```yaml
widget:
  type: customapi
  url: https://nas.example:8443/api/summary
  refreshInterval: 300000
  headers:
    Authorization: Bearer <token>
  mappings:
    - field: { pools: { tank: capacity } }
      label: tank
      format: percent
    - field: problems
      label: Problems
      format: number
    - field: temp_max_c
      label: Temp.
      format: number
      suffix: " °C"
```

For the card icon, copy `www/icon.svg` into Homepage's `public/icons` and use
`icon: /icons/cairn.svg`.

## What it writes

Only its own files: `/etc/exports.d/cairn-nas.exports`,
`/etc/samba/cairn-nas.conf` (included by `smb.conf`),
`/etc/nftables.d/cairn-nas.nft`, and its state in `/var/lib/cairn-nas/`.
Writes are a closed list of validated actions, run without a shell and
logged with the account name (`journalctl -u cairn-nas`).

## Translations

The code is written in English. The page picks the viewer's choice (Language
button), then the server's `lang`, then the browser's language. To add a
language: copy the `fr` block of `www/i18n.js`, translate its values, add the
language to `LANGS`; server messages (errors, alerts) have their own table,
`FR` in `src/main.rs`.

## Build and test

```sh
cargo build --release --locked
cargo test --release --locked
```

Rust from Debian 13 (`cargo` 1.85) is enough. `DESIGN.md` describes the
visual design.

Each push runs the tests on GitHub Actions; a `vX.Y.Z` tag publishes a
release with the binary (see `CHANGELOG.md`). Security reports: `SECURITY.md`.

## License

MIT, see `LICENSE`.
