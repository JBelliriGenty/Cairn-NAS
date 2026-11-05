#!/bin/sh
# cairn-nas installer for Debian 13 + ZFS, standalone mode (built-in sign-in
# over HTTPS). Run as root from this directory (release archive or source
# checkout): sh install.sh
# Idempotent: an existing config, certificate or smb.conf include is kept.
set -eu

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v zpool >/dev/null || { echo "ZFS (zfsutils-linux) is required" >&2; exit 1; }
cd "$(dirname "$0")"

echo "== packages"
apt-get install -y openssl smartmontools samba nfs-kernel-server zfs-auto-snapshot avahi-daemon

# A release archive ships the binary next to this script; a source checkout builds it.
if [ -f cairn-nas ]; then
  install -m 0755 cairn-nas /usr/local/bin/cairn-nas
else
  echo "== build"
  apt-get install -y cargo libssl-dev pkg-config
  cargo build --release --locked
  install -m 0755 target/release/cairn-nas /usr/local/bin/cairn-nas
fi

echo "== admin group"
getent group nas-admin >/dev/null || groupadd nas-admin

echo "== TLS certificate (self-signed, replace with your own if you have one)"
mkdir -p /etc/cairn-nas
if [ ! -f /etc/cairn-nas/cert.pem ]; then
  host=$(hostname)
  san="DNS:$host,DNS:$host.local$(hostname -I | tr ' ' '\n' | grep -v '^$' | sed 's/^/,IP:/' | tr -d '\n')"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$host" -addext "subjectAltName=$san" \
    -keyout /etc/cairn-nas/key.pem -out /etc/cairn-nas/cert.pem 2>/dev/null
  chmod 0600 /etc/cairn-nas/key.pem
fi

echo "== config"
if [ ! -f /etc/cairn-nas.json ]; then
  cat > /etc/cairn-nas.json <<EOF
{
  "listen": "0.0.0.0:8443",
  "title": "$(hostname | tr a-z A-Z)",
  "subtitle": "stockage",
  "login": {"admin_group": "nas-admin", "session_minutes": 30},
  "tls": {"cert": "/etc/cairn-nas/cert.pem", "key": "/etc/cairn-nas/key.pem"},
  "services": ["smbd", "nfs-server", "zfs-zed"],
  "features": {"nfs": true, "smb": true, "users": true, "pools": false},
  "nics": [],
  "hosts": {}
}
EOF
fi

echo "== Samba and NFS files written by the panel"
touch /etc/samba/cairn-nas.conf
grep -q '^[[:space:]]*include = /etc/samba/cairn-nas.conf' /etc/samba/smb.conf ||
  printf '\n# Shares created from cairn-nas\ninclude = /etc/samba/cairn-nas.conf\n' >> /etc/samba/smb.conf
mkdir -p /etc/exports.d

echo "== service"
cat > /etc/systemd/system/cairn-nas.service <<'EOF'
[Unit]
Description=cairn-nas (storage admin panel)
After=network-online.target zfs.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cairn-nas /etc/cairn-nas.json
Restart=on-failure
StateDirectory=cairn-nas
# root: zfs, smartctl, systemctl, useradd/smbpasswd, /etc/exports.d and
# /etc/samba, so /etc stays writable (ProtectSystem=true, not full).
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
ProtectSystem=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cairn-nas
systemctl restart cairn-nas

cat <<EOF

cairn-nas is running: https://$(hostname -I | cut -d' ' -f1):8443
Sign in with a system account of the nas-admin group, e.g.:
  usermod -aG nas-admin <your-account>
Settings: /etc/cairn-nas.json (systemctl restart cairn-nas after a change).
EOF
