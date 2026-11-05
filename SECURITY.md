# Security

Cairn runs as root: it calls `zfs`, `zpool`, `smartctl`, `systemctl`,
`useradd`/`smbpasswd` and writes the Samba, NFS and nftables files it manages.
A flaw in it can be a flaw in the whole NAS.

## Reporting a vulnerability

Please report it privately: on GitHub, **Security → Report a vulnerability**
in this repository. Do not open a public issue. You should get an answer
within a week; a fix comes before any public detail.

Only the latest release is supported.

## What the design relies on

- Writes go through a closed list of actions, each with its own input
  validation and tests (`build_argv` and `manage` in `src/main.rs`); commands
  run without a shell.
- Built-in sign-in: system accounts of the admin group (`/etc/shadow`), HTTPS
  required, growing delay after failures, `HttpOnly; Secure; SameSite=Strict`
  session cookie.
- Proxy mode: identity headers are trusted from `trusted_proxies` only.
- `Content-Security-Policy: default-src 'self'`, no third-party code in the
  page; JSON bodies only, so a cross-site form cannot post.
- Do not expose the panel to the Internet; keep it on the LAN or behind a
  VPN or an authenticating proxy.
