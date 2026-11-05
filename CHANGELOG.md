# Changelog

## 0.1.0 (2026-11-05)

First public release.

- Overview, disks (SMART), ZFS pools and datasets, snapshots, scrub.
- NFS and SMB shares, Time Machine wizard, accounts and groups.
- Services, pending updates, action journal, alerts (ntfy or webhook).
- `GET /api/summary` for dashboards.
- Built-in sign-in over HTTPS, or behind an authenticating proxy.
- English and French interface.
- Disk replacement (`features.disks`): take a pool member offline, bring it back online, or replace it with a blank disk from the Disks view; refused while a resilver runs or when it would leave the vdev without redundancy. Resilver and scrub progress with time left.
- Replication status: newest snapshot of each replicated dataset in Storage, alert when it is too old (`replication` in the config).
- `cairn-nas --demo`: the page on sample data, nothing written.
- Prebuilt binary for x86_64 Linux (Debian 13) in the releases.
