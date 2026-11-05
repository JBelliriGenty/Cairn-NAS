# Changelog

## Unreleased

- ZFS volumes (zvols) in Storage: list (size, used, ratio, block size), create (thin or reserved, block size, compression) and grow, with `features.pools`.
- Deletion of datasets, volumes and pools from Storage (`features.pools`): full name retyped, refused while a share, an `/etc/exports` path or a replication uses it, children only when asked, never a pool root, never forced; snapshots go with it.
- iSCSI export of volumes (`features.iscsi`, LIO through `targetcli`): one target per volume, access only for the listed initiators, restored at boot after the ZFS volumes; an exported volume cannot be deleted.

## 0.1.0 (2026-11-05)

First public release.

- Overview, disks (SMART), ZFS pools and datasets, snapshots, scrub.
- NFS and SMB shares, Time Machine wizard, accounts and groups.
- Services, pending updates, action journal, alerts (ntfy or webhook).
- `GET /api/summary` for dashboards.
- Built-in sign-in over HTTPS, or behind an authenticating proxy.
- English and French interface.
- Disk replacement (`features.disks`): take a pool member offline, bring it back online, or replace it with a blank disk from the Disks view; refused while a resilver runs or when it would leave the vdev without redundancy. Resilver and scrub progress with time left.
- Replication status: newest snapshot of each replicated dataset in a Backup view and an Overview tile, alert when it is too old (`replication` in the config).
- Replication set up from the page (`features.replication`): the backup machine pulls the source's datasets every night with syncoid, through a source account that may only `zfs send`; longer snapshot retention on the backup side.
- `cairn-nas --demo`: the page on sample data, nothing written.
- Prebuilt binary for x86_64 Linux (Debian 13) in the releases.
