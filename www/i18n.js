// cairn-nas translations. The code is written in English; each language below
// maps an English source string to its translation (missing = English shown).
// Placeholders: t("{n} packages", { n: 3 }). Plurals: tp(n, "{n} disk", "{n} disks").
// Add a language: copy the "fr" block, translate the values, add it to LANGS.
"use strict";

const LANGS = { en: { name: "English", locale: "en-GB" }, fr: { name: "Français", locale: "fr-FR" } };

const DICT = {
  fr: {
    // units
    "B": "o", "KB": "Ko", "MB": "Mo", "GB": "Go", "TB": "To", "PB": "Po",
    "b/s": "b/s", "Kb/s": "Kb/s", "Mb/s": "Mb/s", "Gb/s": "Gb/s",
    "{d} d": "{d} j",
    // language switch, theme, page frame (index.html)
    "Language: {name}": "Langue : {name}",
    "Theme: {name}": "Thème : {name}", "auto": "auto", "light": "clair", "dark": "sombre",
    "Overview": "Vue d'ensemble", "System": "Système", "Network": "Réseau", "Disks": "Disques",
    "Storage": "Stockage", "Shares": "Partages", "Accounts": "Comptes", "Services": "Services",
    "Tags…": "Étiquettes…", "Sign out": "Se déconnecter", "Loading…": "Chargement…",
    "Datasets": "Datasets", "Snapshots": "Snapshots", "Cancel": "Annuler", "OK": "Valider",
    // common words
    "Name": "Nom", "Save": "Enregistrer", "Saved": "Enregistré", "Create": "Créer", "Edit": "Modifier",
    "Delete": "Supprimer", "Close": "Fermer", "Change": "Changer", "Start": "Démarrer", "Stop": "Arrêter",
    "Restart": "Redémarrer", "Turn on": "Activer", "Update": "Mettre à jour", "None": "Aucune", "yes": "oui", "no": "non",
    "Password": "Mot de passe", "Username": "Identifiant", "Confirmation": "Confirmation",
    "Groups": "Groupes", "Access": "Accès", "Read": "Lecture", "Write": "Écriture", "read": "lecture", "write": "écriture",
    "{name}: {value}": "{name} : {value}", "{name} deleted": "{name} supprimé",
    // errors and banners (server messages are not translated here)
    "Could not save: {err}": "Enregistrement impossible : {err}", "Read failed: {err}": "Lecture impossible : {err}",
    "Could not read ZFS/services: {err}": "Lecture ZFS/services impossible : {err}", "Refused: {err}": "Refusé : {err}",
    "Failed: {err}": "Échec : {err}", "Unreadable configuration: {err}": "Configuration illisible : {err}",
    "Action in progress…": "Action en cours…",
    // names and colour tags
    "Rename, tag": "Renommer, étiqueter", "Rename {name}": "Renommer {name}",
    "No tags yet: use the “Tags…” button in the sidebar.": "Pas encore d'étiquette : bouton « Étiquettes… » de la barre latérale.",
    "Appearance of {name}": "Apparence de {name}", "Display name": "Nom affiché", "Tag": "Étiquette",
    "Empty = system name. The system name stays shown in small print next to it.": "Vide = nom système. Le nom système reste affiché en petit à côté.",
    "Tags": "Étiquettes", "Existing (tick to delete)": "Existantes (cocher pour supprimer)", "New tag": "Nouvelle étiquette",
    "e.g. Proxmox node": "ex. Nœud Proxmox", "Colour": "Couleur",
    "Black": "Noir", "Red": "Rouge", "Orange": "Orange", "Yellow": "Jaune", "Green": "Vert", "Blue": "Bleu",
    "Purple": "Violet", "Pink": "Rose", "Grey": "Gris",
    // disk health
    "unknown": "inconnue", "critical": "critique", "needs attention": "à surveiller", "good": "bonne",
    // header and overview
    "{n} service stopped": "{n} service arrêté", "{n} services stopped": "{n} services arrêtés", "services OK": "services OK",
    "kernel {v}": "noyau {v}", "up for {d}": "allumé depuis {d}", "refreshed {time}": "rafraîchi {time}",
    "Processor": "Processeur", "Memory": "Mémoire", "CPU temp.": "Temp. CPU",
    "load {v}": "charge {v}", "of {v}": "sur {v}", "threshold 80 °C": "seuil 80 °C",
    "pool {name} {state}": "pool {name} {state}", "pool {name} {pct} % full": "pool {name} plein à {pct} %",
    "disk {name} {health}": "disque {name} {health}", "service {name} stopped": "service {name} arrêté",
    "All good: {pools}, {good} / {disks}, {services}": "Tout va bien : {pools}, {good} / {disks}, {services}",
    "{n} pool online": "{n} pool en ligne", "{n} pools online": "{n} pools en ligne",
    "{n} healthy disk": "{n} disque sain", "{n} healthy disks": "{n} disques sains",
    "{n} active service": "{n} service actif", "{n} active services": "{n} services actifs",
    "Disk health": "Santé des disques", "{good} / {total} in good health": "{good} / {total} en bonne santé",
    "{n} ZFS pools": "{n} pools ZFS", "ZFS pool": "Pool ZFS", "{v} free": "{v} libres",
    "Network (all interfaces)": "Réseau (toutes interfaces)", "{up} / {total} active": "{up} / {total} actifs",
    "Stopped: {list}": "Arrêtés : {list}",
    "NFS: {exports} exports · {conn} / {clients} clients connected": "NFS : {exports} exports · {conn} / {clients} clients connectés",
    "Up for {d}": "Allumé depuis {d}", "ARC: {pct} % hit rate": "ARC : {pct} % de succès",
    // system
    "Per thread": "Par thread", "Applications": "Applications", "ZFS cache (ARC)": "Cache ZFS (ARC)",
    "System cache": "Cache système", "Free": "Libre", "Load (over {n} threads)": "Charge (sur {n} threads)",
    "Uptime": "Allumé depuis", "Kernel": "Noyau", "ARC (hit rate)": "ARC (succès)",
    "CPU (package)": "CPU (paquet)", "CPU (hottest core)": "CPU (cœur le plus chaud)", "Temperatures": "Températures",
    // network
    "no link": "pas de lien",
    // disks
    "single disk": "disque seul", "Not in a pool": "Hors pool",
    "{n} disk · {size} raw": "{n} disque · {size} bruts", "{n} disks · {size} raw": "{n} disques · {size} bruts",
    "Max temperature": "Température max", "Health": "Santé", "{ok} / {total} good": "{ok} / {total} bonne",
    "ZFS errors": "Erreurs ZFS", "Pool used": "Pool occupé", "Disk by disk": "Détail disque par disque",
    "Temperature": "Température", "Wear": "Usure", "Spare": "Réserve", "Power-on hours": "Heures", "Written": "Écrit",
    "Unsafe shutdowns": "Arrêts brutaux", "Media errors": "Erreurs média", "ZFS errors R/W/C": "Erreurs ZFS L/É/S",
    "read {rate}/s": "lecture {rate}/s", "write {rate}/s": "écriture {rate}/s",
    // storage
    "no scrub yet": "aucun scrub encore", "New dataset": "Nouveau dataset", "New pool": "Nouveau pool",
    "Allocated": "Occupé", "Raw size": "Taille brute", "Fragmentation": "Fragmentation", "Errors": "Erreurs",
    "Last scrub: {v}": "Dernier scrub : {v}", "Stop scrub": "Arrêter le scrub", "Start a scrub": "Lancer un scrub",
    "Dataset": "Dataset", "Used": "Utilisé", "Available": "Disponible", "Compression": "Compression", "Ratio": "Gain",
    "New volume": "Nouveau volume", "Volumes": "Volumes", "Volume": "Volume", "Size": "Taille", "Grow": "Agrandir",
    "Delete the pool": "Supprimer le pool", "Delete permanently": "Supprimer définitivement",
    "A block device of a fixed size (/dev/zvol/…), e.g. a virtual machine disk. It can be grown later, never shrunk.":
      "Un périphérique bloc de taille fixe (/dev/zvol/…), par ex. le disque d'une machine virtuelle. Il peut être agrandi plus tard, jamais réduit.",
    "e.g. vm-disk": "ex. disque-vm", "Size (e.g. 100G, 1.5T)": "Taille (ex. 100G, 1.5T)",
    "Thin (sparse): space is taken as data is written": "Allocation dynamique (sparse) : l'espace est pris au fil des écritures",
    "Not thin: the whole size is reserved in the pool now, so writes never fail for lack of space. The block size cannot be changed afterwards.":
      "Sans allocation dynamique : toute la taille est réservée dans le pool dès maintenant, les écritures ne manquent donc jamais de place. La taille de bloc ne peut plus être changée ensuite.",
    "Volume {name} created": "Volume {name} créé", "Grow {name}": "Agrandir {name}", "Current size: {size}": "Taille actuelle : {size}",
    "New size (e.g. 200G, 2T)": "Nouvelle taille (ex. 200G, 2T)",
    "A volume can only grow. Then extend the partition and file system inside it, from the machine that uses it.":
      "Un volume ne peut que grandir. Étendez ensuite la partition et le système de fichiers qu'il contient, depuis la machine qui l'utilise.",
    "{name} grown": "{name} agrandi", "Confirmation: retype the full name": "Confirmation : retapez le nom complet",
    "Deletion is permanent: the volume <b>{name}</b>, its data and all its snapshots are destroyed. There is no undo.":
      "La suppression est définitive : le volume <b>{name}</b>, ses données et tous ses snapshots sont détruits. Aucun retour en arrière.",
    "Deletion is permanent: <b>{name}</b>, its files and all its snapshots are destroyed. There is no undo.":
      "La suppression est définitive : <b>{name}</b>, ses fichiers et tous ses snapshots sont détruits. Aucun retour en arrière.",
    "{n} snapshot is deleted with it.": "{n} snapshot est supprimé avec lui.", "{n} snapshots are deleted with it.": "{n} snapshots sont supprimés avec lui.",
    "Child datasets:": "Datasets enfants :", "With its children ({n}), deleted too": "Avec ses enfants ({n}), supprimés aussi",
    "Refused while a share, an export or a replication uses it, or while its files are open.":
      "Refusé tant qu'un partage, un export ou une réplication l'utilise, ou que ses fichiers sont ouverts.",
    "Delete the pool {pool}?": "Supprimer le pool {pool} ?",
    "Deletion is permanent: the pool <b>{pool}</b> and everything in it ({n} datasets and volumes, all snapshots) are destroyed. There is no undo.":
      "La suppression est définitive : le pool <b>{pool}</b> et tout son contenu ({n} datasets et volumes, tous les snapshots) sont détruits. Aucun retour en arrière.",
    "Refused while a share, an export or a replication points into it. The disks are left as they are (not wiped): they become free again only once erased.":
      "Refusé tant qu'un partage, un export ou une réplication pointe dedans. Les disques restent en l'état (non effacés) : ils ne redeviennent libres qu'une fois effacés.",
    "Pool {name} deleted": "Pool {name} supprimé",
    "iSCSI": "iSCSI", "{n} machine": "{n} machine", "{n} machines": "{n} machines",
    "Stop the export": "Arrêter l'export",
    "iSCSI access to {name}": "Accès iSCSI à {name}", "Export {name} over iSCSI": "Exporter {name} en iSCSI", "Target: {iqn}": "Cible : {iqn}",
    "Portal: port 3260 on {ips}. No machine is allowed by default: list each one by its iSCSI name (on Linux and Proxmox: /etc/iscsi/initiatorname.iscsi). A volume must be used by one machine at a time, unless a cluster file system manages it.":
      "Portail : port 3260 sur {ips}. Aucune machine n'est autorisée par défaut : indiquez chacune par son nom iSCSI (sous Linux et Proxmox : /etc/iscsi/initiatorname.iscsi). Un volume ne doit servir qu'à une machine à la fois, sauf système de fichiers de cluster.",
    "Allowed machines (one iSCSI name per line)": "Machines autorisées (un nom iSCSI par ligne)", "Export": "Exporter",
    "{name} exported over iSCSI": "{name} exporté en iSCSI",
    "Stop the iSCSI export of {name}?": "Arrêter l'export iSCSI de {name} ?",
    "Connected machines lose this disk at once. The data stays on the volume.": "Les machines connectées perdent ce disque immédiatement. Les données restent sur le volume.",
    "iSCSI export of {name} stopped": "Export iSCSI de {name} arrêté",
    "Block size": "Bloc", "Quota": "Quota", "Auto snapshots": "Snapshots auto", "Snapshot": "Snapshot",
    "No snapshots. Use the “Snapshot” button on a dataset to create one.": "Aucun snapshot. Bouton « Snapshot » sur un dataset pour en créer un.",
    "Unique size": "Taille propre", "Created": "Créé le", "{n} dataset": "{n} dataset", "{n} datasets": "{n} datasets",
    "Delete all {n}": "Supprimer les {n}", "{n} snapshot": "{n} snapshot", "{n} snapshots": "{n} snapshots",
    "last {when}": "dernier {when}", "Replication": "Réplication", "Last snapshot": "Dernier snapshot", "Age": "Âge", "State": "État",
    "never": "jamais", "Backup": "Sauvegarde",
    "Copies kept on this machine": "Copies gardées sur cette machine", "Run now": "Lancer maintenant", "New replication": "Nouvelle réplication",
    "This machine's key, to paste on the source machine (Backup view, “Allow a backup machine”):": "Clé de cette machine, à coller sur la machine source (vue Sauvegarde, « Autoriser une machine de sauvegarde ») :",
    "This machine first needs its own key to connect to the source machines.": "Cette machine a d'abord besoin de sa propre clé pour se connecter aux machines sources.",
    "Create this machine's key": "Créer la clé de cette machine",
    "No replication. Every night at 03:00 this machine copies the datasets of another Cairn machine (syncoid), and keeps their automatic snapshots longer.": "Aucune réplication. Chaque nuit à 03:00, cette machine copie les datasets d'une autre machine Cairn (syncoid) et garde leurs snapshots automatiques plus longtemps.",
    "Backup machines allowed to copy this one": "Machines de sauvegarde autorisées à copier celle-ci", "Allow a backup machine": "Autoriser une machine de sauvegarde",
    "Revoke": "Révoquer",
    "None. An allowed machine can only read (zfs send) the chosen datasets, from its own address, with its own key: it can neither change nor delete anything here.": "Aucune. Une machine autorisée peut seulement lire (zfs send) les datasets choisis, depuis sa propre adresse et avec sa propre clé : elle ne peut rien modifier ni supprimer ici.",
    "Source machine": "Machine source", "e.g. 192.168.1.10": "par ex. 192.168.1.10", "e.g. 192.168.1.20": "par ex. 192.168.1.20",
    "Dataset to copy (with its children)": "Dataset à copier (avec ses enfants)",
    "Copy into (local dataset, created by the first copy)": "Copier dans (dataset local, créé par la première copie)",
    "Allow this machine on the source first (its Backup view, with the key shown here). The source's automatic snapshots are what is copied: turn them on there. The first copy starts right away.": "Autorisez d'abord cette machine sur la source (sa vue Sauvegarde, avec la clé affichée ici). Ce sont les snapshots automatiques de la source qui sont copiés : activez-les là-bas. La première copie démarre tout de suite.",
    "Replication into {name} created": "Réplication vers {name} créée",
    "Backup machine address": "Adresse de la machine de sauvegarde", "Its public key (shown in its Backup view)": "Sa clé publique (affichée dans sa vue Sauvegarde)",
    "Datasets it may copy": "Datasets qu'elle peut copier", "Allow": "Autoriser", "{name} allowed": "{name} autorisée", "Confirm": "Confirmer",
    "Key created": "Clé créée", "Nothing replicated yet.": "Rien de répliqué pour l'instant.", "Replication started": "Réplication lancée",
    "Stop the replication into {name}?": "Arrêter la réplication vers {name} ?",
    "The nightly copy stops. What was already copied stays in <b>{name}</b>.": "La copie de chaque nuit s'arrête. Ce qui a déjà été copié reste dans <b>{name}</b>.",
    "Replication into {name} stopped": "Réplication vers {name} arrêtée",
    "Revoke {name}?": "Révoquer {name} ?",
    "<b>{name}</b> will no longer be able to copy this machine. Its copies stay on it.": "<b>{name}</b> ne pourra plus copier cette machine. Ses copies restent chez elle.",
    "{name} revoked": "{name} révoquée",
    "No replication configured: list the replicated datasets under <code>replication</code> in the panel configuration.": "Aucune réplication configurée : listez les datasets répliqués sous <code>replication</code> dans la configuration du panneau.",
    "replication of {name} late": "réplication de {name} en retard", "{ok} / {total} up to date": "{ok} / {total} à jour",
    "Late: {list}": "En retard : {list}", "Oldest last snapshot: {age}": "Dernier snapshot le plus ancien : {age}", "late (over {h} h)": "en retard (plus de {h} h)", "up to date": "à jour", "automatic rotation": "rotation automatique",
    "In": "Dans", "e.g. photos": "ex. photos", "Dataset {name} created": "Dataset {name} créé",
    "No free disk: every disk already has partitions or data, or belongs to a pool.": "Aucun disque libre : tous les disques ont déjà des partitions, des données ou appartiennent à un pool.",
    "Only blank disks are offered. <b>The chosen disks will be completely erased.</b>": "Seuls les disques vierges sont proposés. <b>Les disques choisis seront entièrement effacés.</b>",
    "e.g. data": "ex. data", "Layout": "Disposition", "Confirmation: retype the pool name": "Confirmation : retapez le nom du pool",
    "Create the pool": "Créer le pool", "Pool {name} created": "Pool {name} créé",
    // disk replacement (features.disks)
    "Bring online": "Remettre en ligne", "Take offline": "Mettre hors ligne", "Replace": "Remplacer",
    "Resilver": "Reconstruction", "Scrub": "Scrub",
    "{what}: {pct} % done, {eta} left": "{what} : {pct} % fait, encore {eta}", "{what}: {pct} % done": "{what} : {pct} % fait",
    "Take {dev} offline?": "Mettre {dev} hors ligne ?",
    "ZFS stops using this disk; <b>{pool}</b> keeps running on the others, with less redundancy, until the disk is brought back online or replaced.":
      "ZFS cesse d'utiliser ce disque ; <b>{pool}</b> continue sur les autres, avec moins de redondance, jusqu'à ce que le disque soit remis en ligne ou remplacé.",
    "Refused when the disk group would be left without redundancy: replace the disk instead, the old one keeps working until the copy is done.":
      "Refusé si le groupe de disques se retrouvait sans redondance : remplacez plutôt le disque, l'ancien reste en service jusqu'à la fin de la copie.",
    "{dev} is offline": "{dev} est hors ligne", "{dev} is back online": "{dev} est de nouveau en ligne",
    "Replace {dev} in {pool}": "Remplacer {dev} dans {pool}", "New disk": "Nouveau disque",
    "Plug in the new disk: it appears here once it is blank (no partition, no signature).":
      "Branchez le nouveau disque : il apparaît ici une fois vierge (ni partition, ni signature).",
    "ZFS copies the data onto the new disk (resilver), then detaches the old one. <b>The chosen disk will be completely erased.</b> It must be at least as large as the old one.":
      "ZFS recopie les données sur le nouveau disque (reconstruction), puis détache l'ancien. <b>Le disque choisi sera entièrement effacé.</b> Il doit être au moins aussi grand que l'ancien.",
    "Resilver started on {pool}": "Reconstruction lancée sur {pool}",
    "Mirror (RAID 1)": "Miroir (RAID 1)", "RAIDZ1 · 1 parity disk": "RAIDZ1 · 1 disque de parité",
    "RAIDZ2 · 2 parity disks": "RAIDZ2 · 2 disques de parité", "RAIDZ3 · 3 parity disks": "RAIDZ3 · 3 disques de parité",
    "Stripe without redundancy": "Agrégat sans redondance",
    "Edit {name}": "Modifier {name}", "Quota (e.g. 500G, 1T, none)": "Quota (ex. 500G, 1T, none)",
    "Automatic snapshots": "Snapshots automatiques",
    "yes (rotation: quarter-hour, hour, day, week, month)": "oui (rotation : quart d'heure, heure, jour, semaine, mois)",
    "Compression only applies to data written afterwards. Child datasets inherit the automatic snapshot choice.": "La compression ne s'applique qu'aux données écrites ensuite. Les datasets enfants héritent du choix des snapshots automatiques.",
    "{name} updated": "{name} modifié", "Snapshot of {name}": "Snapshot de {name}", "manual": "manuel",
    "Include child datasets (-r)": "Inclure les datasets enfants (-r)", "Snapshot {name} created": "Snapshot {name} créé",
    "Delete the snapshot?": "Supprimer le snapshot ?", "<b>{name}</b> will be permanently deleted.": "<b>{name}</b> sera supprimé définitivement.",
    "Delete the {n} snapshots @{snap}?": "Supprimer les {n} snapshots @{snap} ?", "Will be permanently deleted:": "Seront supprimés définitivement :",
    "{n} snapshots deleted": "{n} snapshots supprimés",
    "Failed after {done} / {total} snapshots deleted: {err}": "Échec après {done} / {total} snapshots supprimés : {err}",
    "Scrub stopped on {pool}": "Scrub arrêté sur {pool}", "Scrub started on {pool}": "Scrub lancé sur {pool}",
    // shares
    "Server exports": "Exports du serveur", "/etc/exports, managed outside the panel": "/etc/exports, gérés hors du panneau",
    "{ip} — click to rename or tag": "{ip} — cliquer pour renommer ou étiqueter",
    "Green = client connected right now (NFSv4, port 2049). Click a client to rename or tag it.": "Vert = client connecté en ce moment (NFSv4, port 2049). Cliquer un client pour le renommer ou l'étiqueter.",
    "Panel shares": "Partages du panneau", "New NFS share": "Nouveau partage NFS", "New SMB share": "Nouveau partage SMB",
    "New Time Machine destination": "Nouvelle destination Time Machine", "Type": "Type", "Folder": "Dossier",
    "firewall open": "pare-feu ouvert", "encryption required": "chiffrement obligatoire", "recycle bin": "corbeille",
    "previous versions": "versions précédentes", "group {name}": "groupe {name}",
    "No shares created from the panel.": "Aucun partage créé depuis le panneau.",
    "Current SMB connections": "Connexions SMB en cours", "no share open": "aucun partage ouvert",
    "encrypted {v}": "chiffré {v}", "not encrypted": "non chiffré", "since {when}": "depuis {when}",
    "Bonjour announcement": "Annonce Bonjour",
    "on: Macs see the server and its Time Machine destinations without typing an address": "active : les Mac voient le serveur et ses destinations Time Machine sans saisir d'adresse",
    "off: connect by address (smb://…)": "arrêtée : se connecter par adresse (smb://…)",
    "Bonjour announcement on": "Annonce Bonjour activée", "Bonjour announcement off": "Annonce Bonjour arrêtée",
    "SMB: \\\\{host}\\name (Windows) or smb://{host}/name (macOS), with an account from the Accounts section.": "SMB : \\\\{host}\\nom (Windows) ou smb://{host}/nom (macOS), avec un compte de la rubrique Comptes.",
    "NFS: access by client IP address, no account.": "NFS : accès par adresse IP du client, sans compte.",
    "e.g. Photos": "ex. Photos", "Folder (ZFS dataset)": "Dossier (dataset ZFS)",
    "Clients · IP address, network (192.168.1.0/24) or name; empty lines are ignored": "Clients · adresse IP, réseau (192.168.1.0/24) ou nom ; lignes vides ignorées",
    "Client {n}": "Client {n}", "Rights": "Droits", "root user": "Utilisateur root",
    "read only": "lecture", "read + write": "lecture + écriture",
    "root → anonymous": "root → anonyme", "root kept": "root conservé", "all anonymous": "tous anonymes",
    "Open the firewall (NFS, port 2049) for these clients": "Ouvrir le pare-feu (NFS, port 2049) pour ces clients",
    "Closed by default: tick it if the client does not already have access. IP addresses or networks only. Deleting the share closes the access again.": "Fermé par défaut : à cocher si le client n'a pas déjà accès. Adresses IP ou réseaux seulement. Supprimer le partage referme l'accès.",
    "NFS share {name}": "Partage NFS {name}", "NFS share {name} saved": "Partage NFS {name} enregistré",
    "no Samba password": "pas de mot de passe Samba", "Access for {name}": "Accès de {name}", "no access": "aucun",
    "No accounts: create one in the Accounts section.": "Aucun compte : créez-en un dans la rubrique Comptes.",
    "Open the firewall (SMB, port 445) for": "Ouvrir le pare-feu (SMB, port 445) pour",
    "empty = closed; e.g. 192.168.1.20, 192.168.1.0/24": "vide = fermé ; ex. 192.168.1.20, 192.168.1.0/24",
    "Encryption": "Chiffrement", "if the client can encrypt (macOS, Windows 10 and later)": "si le client sait chiffrer (macOS, Windows 10 et +)",
    "required: refuse clients that do not encrypt": "obligatoire : refuse les clients qui ne chiffrent pas",
    "Previous versions (Windows) from the dataset's automatic snapshots": "Versions précédentes (Windows) à partir des snapshots automatiques du dataset",
    "Recycle bin: deleted files go to .recycle and are erased after {n} days": "Corbeille : les fichiers supprimés vont dans .recycle et sont effacés après {n} jours",
    "Time Machine destination (Mac backups)": "Destination Time Machine (sauvegardes de Mac)",
    "Time Machine maximum size": "Taille maximale Time Machine", "empty = no limit; e.g. 1T": "vide = sans limite ; ex. 1T",
    "File owner": "Propriétaire des fichiers", "current owner of the folder": "propriétaire actuel du dossier",
    "Samba writes new files as this account. Choosing an account makes it the owner of the shared folder itself, not of its contents. Required if the folder belongs to root (never any writing as root). Only the accounts chosen under Access can connect.": "Samba écrit les nouveaux fichiers sous ce compte. Choisir un compte en fait le propriétaire du dossier partagé lui-même, pas de son contenu. Obligatoire si le dossier appartient à root (jamais d'écriture en root). Seuls les comptes choisis dans Accès se connectent.",
    "SMB share {name}": "Partage SMB {name}", "SMB share {name} saved": "Partage SMB {name} enregistré",
    "Mac name (account and share)": "Nom du Mac (compte et partage)", "e.g. macbook-pro": "ex. macbook-pro",
    "e.g. tank/timemachine/macbook-pro": "ex. tank/timemachine/macbook-pro",
    "Existing: reused. New: created with this quota, 1M blocks, no automatic snapshots.": "Existant : réutilisé. Nouveau : créé avec ce quota, blocs de 1M, sans snapshots automatiques.",
    "Existing dataset only (created by the administrator, ideally with a quota).": "Dataset existant uniquement (créé par l'administrateur, idéalement avec quota).",
    "Reserved size": "Taille réservée",
    "Open the SMB firewall for (the Mac's IP, or the network if it uses DHCP)": "Ouvrir le pare-feu SMB pour (IP du Mac, ou le réseau s'il est en DHCP)",
    "empty = closed; e.g. 192.168.1.107 or 192.168.1.0/24": "vide = fermé ; ex. 192.168.1.107 ou 192.168.1.0/24",
    "Encryption required. On the Mac: Settings > Time Machine > Add Destination, account = Mac name.": "Chiffrement obligatoire. Sur le Mac : Réglages > Time Machine > Ajouter une destination, compte = nom du Mac.",
    "Time Machine destination {name} created": "Destination Time Machine {name} créée",
    "Delete the share?": "Supprimer le partage ?",
    "The share <b>{name}</b> will no longer be accessible. The files stay in the dataset.": "Le partage <b>{name}</b> ne sera plus accessible. Les fichiers restent dans le dataset.",
    "Share {name} deleted": "Partage {name} supprimé",
    // accounts
    "Account management is disabled on this server.": "Gestion des comptes désactivée sur ce serveur.",
    "Users": "Utilisateurs", "New user": "Nouvel utilisateur", "Source": "Origine", "panel": "panneau",
    "system, read-only": "système, lecture seule",
    "Linux accounts that cannot log in to the server (no shell, no SSH), with a Samba password for SMB shares.": "Comptes Linux sans connexion au serveur (ni shell ni SSH), avec un mot de passe Samba pour les partages SMB.",
    "New group": "Nouveau groupe", "no members": "aucun membre",
    "No groups. A group gives several accounts the same access (e.g. family).": "Aucun groupe. Un groupe donne le même accès à plusieurs comptes (ex. famille).",
    "No groups created.": "Aucun groupe créé.", "Password (at least 8 characters)": "Mot de passe (8 caractères au moins)",
    "The two passwords do not match.": "Les deux mots de passe sont différents.", "e.g. alice": "ex. alice",
    "Account {name} created": "Compte {name} créé", "Password for {name}": "Mot de passe de {name}",
    "Password for {name} changed": "Mot de passe de {name} changé", "Groups for {name}": "Groupes de {name}",
    "Groups for {name} saved": "Groupes de {name} enregistrés", "Delete {name}?": "Supprimer {name} ?",
    "<b>{name}</b> will be deleted. Their files stay on the shares.": "<b>{name}</b> sera supprimé. Ses fichiers restent sur les partages.",
    "e.g. family": "ex. famille", "Group {name} created": "Groupe {name} créé",
    // services, updates, alerts, journal
    "System updates": "Mises à jour du système",
    "{n} package to update": "{n} paquet à mettre à jour", "{n} packages to update": "{n} paquets à mettre à jour",
    "System up to date": "Système à jour", "restart required": "redémarrage nécessaire",
    "Held (apt-mark hold), not updated: {list}": "Retenus (apt-mark hold), non mis à jour : {list}",
    "Action log": "Journal des actions", "No recent actions.": "Aucune action récente.",
    "Install the updates?": "Installer les mises à jour ?",
    "{n} package: {list}": "{n} paquet : {list}", "{n} packages: {list}": "{n} paquets : {list}",
    "apt-get upgrade, configuration files kept. The affected services restart (Samba: open connections are dropped). May take a few minutes.": "apt-get upgrade, fichiers de configuration conservés. Les services concernés redémarrent (Samba : connexions en cours coupées). Peut prendre quelques minutes.",
    "Updates installed": "Mises à jour installées", "Alerts": "Alertes", "Send a test": "Envoyer un test",
    "Not configured: set <code>alerts.url</code> in the panel configuration.": "Non configurées : renseigner <code>alerts.url</code> dans la configuration du panneau.",
    "Sent to {target}: degraded or faulted pool, pool {pct} % full, disk failing SMART or with errors, failed service, late replication. One message when it starts, another when it is back to normal.": "Envoyées à {target} : pool dégradé ou en erreur, pool rempli à {pct} %, disque en échec SMART ou avec erreurs, service en échec, réplication en retard. Un message à l'apparition, un autre au retour à la normale.",
    "No current problems": "Aucun problème en cours", "Test alert sent": "Alerte de test envoyée",
    "{name} restarted": "{name} redémarré",
    // pool layout: log, cache, spare, data groups, RAIDZ expansion, export/import, features, trim
    "Log (SLOG)": "Journal (SLOG)", "Cache (L2ARC)": "Cache (L2ARC)", "Spare disk": "Disque de secours", "Special": "Spécial", "Dedup": "Dédup",
    "Remove from the pool": "Retirer du pool", "RAIDZ expansion": "Extension RAIDZ", "Import a pool": "Importer un pool",
    "ashift {n} ({size} sectors)": "ashift {n} (secteurs de {size})", "automatic trim: {v}": "trim automatique : {v}", "on": "activé", "off": "désactivé",
    "ZFS features to enable (zpool upgrade)": "fonctions ZFS à activer (zpool upgrade)", "all ZFS features enabled": "toutes les fonctions ZFS activées", "trim in progress": "trim en cours",
    "Add a log device (SLOG)": "Ajouter un journal (SLOG)", "Add a cache device (L2ARC)": "Ajouter un cache (L2ARC)", "Add a spare disk": "Ajouter un disque de secours",
    "Trim now": "Lancer un trim", "Turn automatic trim off": "Désactiver le trim automatique", "Turn automatic trim on": "Activer le trim automatique",
    "Add a data group": "Ajouter un groupe de données", "Expand a RAIDZ group": "Étendre un groupe RAIDZ", "Enable new ZFS features": "Activer les nouvelles fonctions ZFS",
    "Layout and maintenance": "Disposition et maintenance",
    "Add a log device (SLOG) to {pool}": "Ajouter un journal (SLOG) à {pool}",
    "A log device (SLOG) receives the synchronous writes (NFS, virtual machines, databases) on a fast SSD before ZFS writes them to the pool; ordinary writes do not use it. Choose an SSD with power-loss protection (capacitors, found on data-center models such as the Intel S3500): the panel cannot check it, and a consumer SSD without it gives little or no gain. A few GB are used. Two or three disks are mirrored. It can be removed at any time, without losing data.":
      "Un journal (SLOG) reçoit les écritures synchrones (NFS, machines virtuelles, bases de données) sur un SSD rapide avant que ZFS ne les écrive dans le pool ; les écritures ordinaires ne l'utilisent pas. Choisissez un SSD avec protection contre les coupures de courant (condensateurs, sur les modèles pour centre de données comme l'Intel S3500) : le panneau ne peut pas le vérifier, et un SSD grand public sans cette protection n'apporte que peu ou pas de gain. Quelques Go suffisent. Deux ou trois disques sont mis en miroir. Il peut être retiré à tout moment, sans perte de données.",
    "Add a cache device (L2ARC) to {pool}": "Ajouter un cache (L2ARC) à {pool}",
    "A cache device (L2ARC) keeps a copy of often-read data on an SSD, beyond the memory cache (ARC). Useful only when the data read often does not fit in memory; it uses a little memory itself. No redundancy needed: losing it loses no data. It can be removed at any time.":
      "Un cache (L2ARC) garde une copie des données souvent lues sur un SSD, en plus du cache en mémoire (ARC). Utile seulement quand les données souvent lues ne tiennent pas en mémoire ; il consomme lui-même un peu de mémoire. Pas besoin de redondance : le perdre ne perd aucune donnée. Il peut être retiré à tout moment.",
    "Add a spare disk to {pool}": "Ajouter un disque de secours à {pool}",
    "A spare disk waits unused; when a disk of the pool fails, ZFS puts the spare in its place and rebuilds onto it. It must be at least as large as the pool's disks. It can be removed while unused.":
      "Un disque de secours attend sans servir ; quand un disque du pool tombe en panne, ZFS le met à sa place et reconstruit dessus. Il doit être au moins aussi grand que les disques du pool. Il peut être retiré tant qu'il ne sert pas.",
    "Add a data group to {pool}": "Ajouter un groupe de données à {pool}",
    "The pool grows by a new group of disks; new data is spread over all the groups. <b>This cannot be undone</b>: a pool with a RAIDZ group can never lose a group. Use the same layout and disk size as the existing groups; zpool refuses a different redundancy level.":
      "Le pool s'agrandit d'un nouveau groupe de disques ; les nouvelles données sont réparties sur tous les groupes. <b>C'est définitif</b> : un pool avec un groupe RAIDZ ne peut jamais perdre un groupe. Utilisez la même disposition et la même taille de disque que les groupes existants ; zpool refuse un niveau de redondance différent.",
    "Existing groups: {layout} of {n} disks.": "Groupes existants : {layout} de {n} disques.", "Add": "Ajouter", "Added to {pool}": "Ajouté à {pool}",
    "Remove {dev} from {pool}?": "Retirer {dev} de {pool} ?", "Remove": "Retirer", "{dev} removed from {pool}": "{dev} retiré de {pool}",
    "Synchronous writes go back to the pool's own disks (slower). No data is lost.": "Les écritures synchrones retournent sur les disques du pool (plus lent). Aucune donnée n'est perdue.",
    "Reads are served by the pool's disks and the memory cache. No data is lost.": "Les lectures sont servies par les disques du pool et le cache en mémoire. Aucune donnée n'est perdue.",
    "The pool no longer has this spare disk.": "Le pool n'a plus ce disque de secours.",
    "The disk keeps its ZFS label: it is offered again as a free disk only once erased (wipefs -a).": "Le disque garde son étiquette ZFS : il n'est proposé de nouveau comme disque libre qu'une fois effacé (wipefs -a).",
    "Expand a RAIDZ group of {pool}": "Étendre un groupe RAIDZ de {pool}", "Group": "Groupe", "Expand": "Étendre", "Expansion started on {pool}": "Extension lancée sur {pool}",
    "One more disk in the group (OpenZFS 2.3 or later). The data is spread again in the background, the pool stays usable; progress shows here. <b>This cannot be undone.</b> Data written before keeps its old parity ratio until rewritten, so part of the new space shows only then. The disk must be at least as large as the others and <b>will be completely erased</b>.":
      "Un disque de plus dans le groupe (OpenZFS 2.3 ou plus récent). Les données sont redistribuées en arrière-plan, le pool reste utilisable ; l'avancement s'affiche ici. <b>C'est définitif.</b> Les données déjà écrites gardent leur ancien rapport de parité jusqu'à leur réécriture : une partie de l'espace gagné n'apparaît qu'alors. Le disque doit être au moins aussi grand que les autres et <b>sera entièrement effacé</b>.",
    "Export {pool}?": "Exporter {pool} ?", "Pool {name} exported": "Pool {name} exporté",
    "The pool is cleanly detached from this server: its datasets are unmounted and it leaves the page until it is imported again, here or on another machine (move the disks).":
      "Le pool est détaché proprement de ce serveur : ses datasets sont démontés et il quitte la page jusqu'à ce qu'il soit importé de nouveau, ici ou sur une autre machine (en y déplaçant les disques).",
    "No pool to import: the disks of an exported pool show up here once plugged in.": "Aucun pool à importer : les disques d'un pool exporté apparaissent ici une fois branchés.",
    "Pools found on the disks": "Pools trouvés sur les disques", "Import": "Importer", "Pool {name} imported": "Pool {name} importé",
    "A pool still in use by another machine (not exported there) is not imported from the panel.": "Un pool encore utilisé par une autre machine (non exporté là-bas) n'est pas importé depuis le panneau.",
    "Enable the new ZFS features on {pool}?": "Activer les nouvelles fonctions ZFS sur {pool} ?", "Enable": "Activer", "ZFS features enabled on {pool}": "Fonctions ZFS activées sur {pool}",
    "Every feature of this server's ZFS version is enabled on the pool. <b>This cannot be undone: older systems (an older Debian, another NAS, a rescue disk) can no longer import the pool.</b> The data stays as it is.":
      "Toutes les fonctions de la version de ZFS de ce serveur sont activées sur le pool. <b>C'est définitif : des systèmes plus anciens (une Debian plus ancienne, un autre NAS, un disque de secours) ne pourront plus importer le pool.</b> Les données restent telles quelles.",
    "Trim {pool} now?": "Lancer un trim sur {pool} ?", "Trim started on {pool}": "Trim lancé sur {pool}",
    "TRIM tells the SSDs which blocks are free, which keeps their write speed up. It runs in the background; disks that do not support it are skipped.":
      "Le TRIM indique aux SSD les blocs libres, ce qui maintient leur vitesse d'écriture. Il tourne en arrière-plan ; les disques qui ne le gèrent pas sont ignorés.",
    "Automatic trim on for {pool}": "Trim automatique activé sur {pool}", "Automatic trim off for {pool}": "Trim automatique désactivé sur {pool}",
    // sign-in
    "Sign-in": "Connexion", "Sign in": "Se connecter",
    "A server account that belongs to the administration group.": "Compte du serveur membre du groupe d'administration.",
    // snapshot restore (features.restore)
    "Restore…": "Restaurer…", "Restore": "Restaurer", "Continue": "Continuer", "Up": "Remonter", "Modified": "Modifié",
    "Download": "Télécharger", "Download (.tar)": "Télécharger (.tar)", "Empty folder.": "Dossier vide.", "What to do": "Que faire",
    "Restore from a snapshot of {name}": "Restaurer depuis un snapshot de {name}",
    "Browse it: download or copy back files and folders": "Le parcourir : télécharger ou recopier des fichiers et dossiers",
    "Clone it into a new dataset (read-write copy, the original stays as it is)": "Le cloner dans un nouveau dataset (copie modifiable, l'original reste tel quel)",
    "Roll the dataset back to it (destructive)": "Revenir en arrière jusqu'à lui (destructif)",
    "Inside {name}": "Dans {name}", "Downloads stop at 4 GiB: restore larger items instead.": "Les téléchargements s'arrêtent à 4 Gio : restaurez plutôt ce qui est plus gros.",
    "Restore {name}?": "Restaurer {name} ?", "{name} restored": "{name} restauré",
    "<b>{path}</b> is copied from the snapshot back into the dataset, next to the original, as <b>{as}</b>. Nothing is overwritten.":
      "<b>{path}</b> est recopié du snapshot dans le dataset, à côté de l'original, sous le nom <b>{as}</b>. Rien n'est écrasé.",
    "Clone {name}": "Cloner {name}", "Clone": "Cloner", "{name} created": "{name} créé",
    "A read-write copy that shares its blocks with the snapshot (no space used at first). While the clone exists, the snapshot cannot be deleted.":
      "Une copie modifiable qui partage ses blocs avec le snapshot (aucune place prise au départ). Tant que le clone existe, le snapshot ne peut pas être supprimé.",
    "Roll {name} back?": "Revenir en arrière sur {name} ?", "Roll back": "Revenir en arrière", "{name} rolled back": "{name} remis à l'état du snapshot",
    "Every change made to <b>{name}</b> since {when} is lost: files written, changed or deleted after that go back to how they were. There is no undo.":
      "Tout ce qui a changé dans <b>{name}</b> depuis le {when} est perdu : les fichiers écrits, modifiés ou supprimés depuis reviennent à leur état d'alors. Impossible d'annuler.",
    "{n} newer snapshot is destroyed too:": "{n} snapshot plus récent est aussi détruit :", "{n} newer snapshots are destroyed too:": "{n} snapshots plus récents sont aussi détruits :",
    "and {n} more": "et {n} autres",
    "Refused while a replication or an iSCSI export uses it, or when a newer snapshot has a clone. To get back a few files only, browse the snapshot instead.":
      "Refusé tant qu'une réplication ou un export iSCSI l'utilise, ou si un snapshot plus récent a un clone. Pour ne récupérer que quelques fichiers, parcourez plutôt le snapshot.",
    // schedules (features.schedules)
    "Last self-test": "Dernier autotest", "15 min": "15 min", "hour": "heure", "day": "jour", "week": "semaine", "month": "mois", "{h} h": "{h} h", "all": "toutes",
    "every 15 min": "toutes les 15 min", "hourly": "toutes les heures", "daily": "tous les jours", "weekly": "toutes les semaines", "monthly": "tous les mois",
    "every day": "chaque jour", "every week": "chaque semaine", "every month": "chaque mois",
    "Automatic snapshot rotation": "Rotation des snapshots automatiques", "keep {n}": "en garder {n}",
    "For the whole machine (zfs-auto-snapshot); which datasets get each rotation is chosen with Edit. A replication's backup side keeps its own copies longer.":
      "Pour toute la machine (zfs-auto-snapshot) ; les datasets concernés par chaque rotation se choisissent avec Modifier. Le côté sauvegarde d'une réplication garde ses propres copies plus longtemps.",
    "zfs-auto-snapshot is not installed (apt install zfs-auto-snapshot).": "zfs-auto-snapshot n'est pas installé (apt install zfs-auto-snapshot).",
    "Scheduled scrub: {v}": "Scrub planifié : {v}", "SMART self-tests": "Autotests SMART",
    "Short test: {a}. Long test: {b}. The last result of each disk is in its card (Disk by disk); a failed test raises an alert.":
      "Test court : {a}. Test long : {b}. Le dernier résultat de chaque disque figure sur sa carte (Disque par disque) ; un test échoué déclenche une alerte.",
    "Rotation: {name}": "Rotation : {name}", "Snapshots kept per dataset": "Snapshots gardés par dataset",
    "Older ones are deleted at the next run. A replication pulling from this machine needs its last copied snapshot to still be here: keep enough to cover its schedule.":
      "Les plus anciens sont supprimés au passage suivant. Une réplication qui tire depuis cette machine a besoin que son dernier snapshot copié soit encore là : gardez-en assez pour couvrir sa fréquence.",
    "Rotation updated": "Rotation mise à jour", "Scheduled scrub of {pool}": "Scrub planifié de {pool}", "Frequency": "Fréquence",
    "OpenZFS timers (zfs-scrub-weekly@ / zfs-scrub-monthly@). Debian's zfsutils-linux also scrubs every pool on the second Sunday of the month (/etc/cron.d/zfsutils-linux).":
      "Minuteries OpenZFS (zfs-scrub-weekly@ / zfs-scrub-monthly@). Le paquet zfsutils-linux de Debian lance aussi un scrub de chaque pool le deuxième dimanche du mois (/etc/cron.d/zfsutils-linux).",
    "Scrub schedule of {pool} saved": "Planification du scrub de {pool} enregistrée",
    "Short test (a few minutes)": "Test court (quelques minutes)", "Long test (hours on a large disk)": "Test long (des heures sur un gros disque)",
    "Every disk at 01:30 (weekly and monthly: on Sunday). Disks keep working during the test.": "Tous les disques à 01:30 (hebdomadaire et mensuel : le dimanche). Les disques restent utilisables pendant le test.",
    "Self-test schedule saved": "Planification des autotests enregistrée",
    // native encryption (features.encryption)
    "New encrypted dataset": "Nouveau dataset chiffré", "unlocked": "déverrouillé", "locked": "verrouillé",
    "{st}, key of {root}": "{st}, clé de {root}", "Lock": "Verrouiller", "Unlock": "Déverrouiller", "key file": "fichier de clé", "passphrase": "phrase de passe",
    "unlocked at boot": "déverrouillé au démarrage", "not unlocked at boot": "non déverrouillé au démarrage", "e.g. papers": "ex. papiers", "Key": "Clé",
    "Passphrase: asked at each unlock, never stored": "Phrase de passe : demandée à chaque déverrouillage, jamais enregistrée",
    "Key file on this machine (/etc/cairn-nas/keys, root only)": "Fichier de clé sur cette machine (/etc/cairn-nas/keys, root seulement)",
    "Passphrase (8 characters or more)": "Phrase de passe (8 caractères ou plus)", "Passphrase again": "Phrase de passe, à nouveau",
    "Unlock at boot (key file only)": "Déverrouiller au démarrage (fichier de clé seulement)",
    "An existing dataset cannot be encrypted in place: create an encrypted one and copy the data into it. A lost passphrase or key file means lost data; a key file protects the disks taken away, not the machine itself.":
      "Un dataset existant ne peut pas être chiffré sur place : créez-en un chiffré et copiez-y les données. Phrase de passe ou fichier de clé perdu = données perdues ; un fichier de clé protège les disques emportés, pas la machine elle-même.",
    "The two passphrases differ": "Les deux phrases de passe diffèrent", "Encrypted dataset {name} created": "Dataset chiffré {name} créé",
    "{name} unlocked": "{name} déverrouillé", "Unlock {name}": "Déverrouiller {name}", "Passphrase": "Phrase de passe", "Lock {name}": "Verrouiller {name}",
    "Its file systems and those below it are unmounted and the key is forgotten until the next unlock. Refused while a share or a replication uses them.":
      "Ses systèmes de fichiers et ceux en dessous sont démontés et la clé oubliée jusqu'au prochain déverrouillage. Refusé tant qu'un partage ou une réplication les utilise.",
    "{name} locked": "{name} verrouillé", "{name} unlocked at boot": "{name} déverrouillé au démarrage", "{name} no longer unlocked at boot": "{name} n'est plus déverrouillé au démarrage",
    // off-site backup (features.offsite)
    "Off-site backup": "Sauvegarde externe", "restic is not installed (apt install restic).": "restic n'est pas installé (apt install restic).",
    "Local folder or disk": "Dossier ou disque local", "SFTP server": "Serveur SFTP", "S3-compatible storage": "Stockage compatible S3", "Backblaze B2": "Backblaze B2",
    "{n} daily": "{n} quotidiennes", "{n} weekly": "{n} hebdomadaires", "{n} monthly": "{n} mensuelles",
    "never run": "jamais lancée", "succeeded": "réussie", "failed": "en échec", "Repositories": "Dépôts", "New repository": "Nouveau dépôt",
    "No repository. A repository is where restic keeps the encrypted, deduplicated copies: a disk or folder, an SFTP server, S3-compatible or B2 storage.":
      "Aucun dépôt. Un dépôt est l'endroit où restic garde les copies chiffrées et dédupliquées : un disque ou un dossier, un serveur SFTP, un stockage compatible S3 ou B2.",
    "This machine's SFTP key, to add to the server's authorized_keys:": "Clé SFTP de cette machine, à ajouter dans le authorized_keys du serveur :",
    "SFTP repositories need this machine's own key.": "Les dépôts SFTP demandent une clé propre à cette machine.",
    "Passwords and access keys stay in root-only files on this machine (/etc/cairn-nas/restic) and are never shown again. Without the repository password, the copies cannot be read: keep it somewhere else too.":
      "Mots de passe et clés d'accès restent dans des fichiers réservés à root sur cette machine (/etc/cairn-nas/restic) et ne sont plus jamais affichés. Sans le mot de passe du dépôt, les copies sont illisibles : gardez-le aussi ailleurs.",
    "Backups": "Sauvegardes", "New backup": "Nouvelle sauvegarde", "Kept": "Conservées", "Last run": "Dernier passage",
    "every day at 04:00": "chaque jour à 04:00", "Sundays at 04:00": "le dimanche à 04:00",
    "No backup. Each backup copies a fresh snapshot of a dataset (its own files, not its child datasets) to a repository, then applies the retention.":
      "Aucune sauvegarde. Chaque sauvegarde copie un snapshot frais d'un dataset (ses propres fichiers, pas ses datasets enfants) vers un dépôt, puis applique la rétention.",
    "A backup or a restore is running.": "Une sauvegarde ou une restauration est en cours.",
    "Last restore: {ds} into {target}, {when}: {res}": "Dernière restauration : {ds} dans {target}, {when} : {res}",
    "Repository {name}": "Dépôt {name}", "e.g. offsite": "ex. externe", "Location": "Emplacement",
    "Local: /path · SFTP: user@host:/path · S3: https://endpoint/bucket/path · B2: bucket:path": "Local : /chemin · SFTP : utilisateur@hôte:/chemin · S3 : https://point-d-accès/bucket/chemin · B2 : bucket:chemin",
    "Repository password (8 characters or more)": "Mot de passe du dépôt (8 caractères ou plus)", "unchanged": "inchangé",
    "Access key ID (S3, B2)": "Identifiant de clé d'accès (S3, B2)", "Secret key (S3, B2)": "Clé secrète (S3, B2)", "Region (S3, optional)": "Région (S3, facultatif)",
    "An existing restic repository at that place is used as it is (same password); otherwise it is created.": "Un dépôt restic déjà présent à cet endroit est repris tel quel (même mot de passe) ; sinon il est créé.",
    "Repository {name} saved": "Dépôt {name} enregistré", "Backup of {name}": "Sauvegarde de {name}", "Repository": "Dépôt",
    "Daily copies kept": "Copies quotidiennes gardées", "Weekly copies kept": "Copies hebdomadaires gardées", "Monthly copies kept": "Copies mensuelles gardées",
    "Older copies are forgotten and their data pruned after each run (restic forget --prune). Child datasets are not included: give each its own backup.":
      "Les copies plus anciennes sont oubliées et leurs données purgées après chaque passage (restic forget --prune). Les datasets enfants ne sont pas inclus : donnez à chacun sa sauvegarde.",
    "Backup of {name} saved": "Sauvegarde de {name} enregistrée", "Restore {name}": "Restaurer {name}", "No copy in the repository yet.": "Pas encore de copie dans le dépôt.",
    "Copy": "Copie", "File or folder (empty: everything)": "Fichier ou dossier (vide : tout)", "e.g. 2025/invoices": "ex. 2025/factures",
    "Into (a new folder inside a dataset)": "Dans (un nouveau dossier d'un dataset)",
    "Nothing is overwritten: the folder must not exist yet. The restore runs in the background; its result shows here.": "Rien n'est écrasé : le dossier ne doit pas encore exister. La restauration tourne en arrière-plan ; son résultat s'affiche ici.",
    "Restore started": "Restauration lancée", "Remove repository {name}": "Retirer le dépôt {name}",
    "This machine forgets the repository and its password; the copies already in it stay where they are.": "Cette machine oublie le dépôt et son mot de passe ; les copies qu'il contient restent où elles sont.",
    "Repository {name} removed": "Dépôt {name} retiré", "Stop the backup of {name}": "Arrêter la sauvegarde de {name}",
    "No more copies are made; those already in the repository stay there.": "Plus aucune copie n'est faite ; celles déjà dans le dépôt y restent.",
    "Backup of {name} stopped": "Sauvegarde de {name} arrêtée", "Backup of {name} started": "Sauvegarde de {name} lancée",
    // machines (other Cairn instances)
    "Machines": "Machines", "{ok} / {total} OK": "{ok} / {total} OK", "unreachable": "injoignable", "not checked yet": "pas encore interrogée",
    "{n} problem": "{n} problème", "{n} problems": "{n} problèmes", "no problem": "aucun problème",
    "Unreachable since {time} ({d})": "Injoignable depuis le {time} ({d})", "Not checked yet.": "Pas encore interrogée.",
    "this machine": "cette machine", "Open": "Ouvrir", "Last known state:": "Dernier état connu :", "Problems": "Problèmes",
  },
};

let LANG = "en";

function t(s, vars) {
  let r = (DICT[LANG] && DICT[LANG][s]) || s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return r;
}
const tp = (n, one, many, vars) => t(n > 1 || n === 0 && LANG === "en" ? many : one, Object.assign({ n }, vars));
const LOCALE = () => LANGS[LANG].locale;

// Order: the viewer's choice, then the server default (config "lang"), then the browser.
function pickLang(serverDefault) {
  let saved = null;
  try { saved = localStorage.getItem("cairn-lang"); } catch (e) { /* storage blocked */ }
  const browser = (navigator.languages || [navigator.language]).map(l => String(l).slice(0, 2)).find(l => LANGS[l]);
  return [saved, serverDefault, browser, "en"].find(l => l && LANGS[l]);
}

// Static page text: <b data-i18n>Overview</b>, plus data-i18n-title / -placeholder / -aria-label.
function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(e => {
    if (!e.dataset.i18n) e.dataset.i18n = e.textContent.trim();
    e.textContent = t(e.dataset.i18n);
  });
  for (const attr of ["title", "placeholder", "aria-label"]) {
    const k = "data-i18n-" + attr; // holds the English source once seen
    root.querySelectorAll("[" + k + "]").forEach(e => {
      if (!e.getAttribute(k)) e.setAttribute(k, e.getAttribute(attr) || "");
      e.setAttribute(attr, t(e.getAttribute(k)));
    });
  }
  document.documentElement.lang = LANG;
}

LANG = pickLang();
