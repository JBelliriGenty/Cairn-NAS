# Changelog

## 0.2.2 (2026-11-13)

- Fan speeds on the System view: every hwmon `fanN_input`, plus fans only the ACPI embedded controller knows (`fans` in the config, read-only `ec_sys` offsets).

## 0.2.1 (2026-11-08)

- `/api/slow` ends with the SMB shares the panel manages (its `smb_file`), so a dashboard reading it with the summary token sees them too.
- Fix: in Backup, the off-site cards and their table no longer run past the page at desktop widths; wide tables (Backups, Datasets) wrap their buttons two by two instead of hiding them behind a horizontal scroll, and multi-line cells (encryption, a failed run's message) fit on phones.

## 0.2.0 (2026-11-05)

- Fix: *Update* failed with "read-only file system" (the service's `ProtectSystem` keeps `/usr` read-only); apt now runs in a transient unit (`systemd-run`), after `dpkg --configure -a` to finish an interrupted run.
- Machines view (`peers`): the other Cairn instances at a glance (pools, problems, temperature, reachability, link to their page), with a "Connected machines" part on Overview showing each one's own overview (system, disks, pools, network, services, replication, from `/api/summary?full=1`), read server-side from their `/api/summary` with their token, every 30 s in the background; machine selector showing any page of a peer read-only (its token now also opens `/api/config`, `/api/fast`, `/api/slow`); alert when one stays unreachable past `peer_unreachable_minutes` (15).
- ZFS volumes (zvols) in Storage: list (size, used, ratio, block size), create (thin or reserved, block size, compression) and grow, with `features.pools`.
- Deletion of datasets, volumes and pools from Storage (`features.pools`): full name retyped, refused while a share, an `/etc/exports` path or a replication uses it, children only when asked, never a pool root, never forced; snapshots go with it.
- iSCSI export of volumes (`features.iscsi`, LIO through `targetcli`): one target per volume, access only for the listed initiators, restored at boot after the ZFS volumes; an exported volume cannot be deleted.
- Log (SLOG, single or mirrored), cache (L2ARC) and spare devices: added from blank disks and removed from the page (`features.vdevs`, reversible changes only), shown with their role in Storage and Disks.
- Pools grow (`features.pools`): a new data group (less redundancy than the existing groups refused, never `-f`) or RAIDZ expansion by one disk (OpenZFS 2.3+), with its progress.
- Pool export (refused while in use) and import of the pools `zpool import` lists (`features.pools`).
- Pool properties in Storage: ashift, automatic trim (toggle, `features.vdevs`), ZFS features left to enable (`zpool upgrade` after a warning, `features.pools`), manual trim.
- Snapshot restore (`features.restore`): browse a snapshot, download a file or a folder (tar, 4 GiB cap), copy it back next to the original (never overwritten), clone a snapshot into a new dataset, roll a dataset back (name retyped, newer snapshots listed; refused with clones, replication or iSCSI).
- Schedules (`features.schedules`): automatic snapshot rotations per dataset and kept counts (driving `zfs-auto-snapshot`), weekly or monthly scrub per pool (OpenZFS timers), SMART short and long self-tests (systemd timers) with the last result per disk; alerts on a failed self-test or a scrub that found errors.
- Native encryption (`features.encryption`): new encrypted datasets with a passphrase (stdin only, never stored) or a root-only key file, key status per dataset, unlock and lock from the page, unlock at boot for key-file datasets (`cairn-unlock.service`).
- Off-site backups with restic (`features.offsite`): local, SFTP, S3 and B2 repositories (password and keys in root-only files, never returned), daily or weekly backup of a fresh snapshot per dataset with retention (`forget --prune`), last-run status and alerts, restore of a file or folder into a new folder.
- *Update* runs in the background with a progress bar (download, then package being installed, from apt's status stream); a failure stays shown on the card.

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
