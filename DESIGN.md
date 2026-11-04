---
name: Cairn
description: Panneau d'administration d'un petit NAS Debian + ZFS, lisible d'un coup d'œil.
colors:
  accent-light: "#4f46e5"
  accent-dark: "#818cf8"
  cpu-light: "#6366f1"
  cpu-dark: "#818cf8"
  mem-light: "#0284c7"
  mem-dark: "#38bdf8"
  pool-light: "#0d9488"
  pool-dark: "#2dd4bf"
  temp-light: "#db2777"
  temp-dark: "#f472b6"
  rx-light: "#0284c7"
  rx-ink-light: "#0369a1"
  rx-dark: "#38bdf8"
  tx-light: "#ea580c"
  tx-ink-light: "#c2410c"
  tx-dark: "#fb923c"
  cache-light: "#8b5cf6"
  cache-dark: "#a78bfa"
  ok-light: "#1e7b4f"
  warn-light: "#b45309"
  bad-light: "#c4242a"
  ok-dark: "#3fc07a"
  warn-dark: "#e5a93b"
  bad-dark: "#e5566f"
  ok-bg-light: "#dcfae5"
  ok-ink-light: "#04250e"
  warn-bg-light: "#fffbeb"
  warn-ink-light: "#92400e"
  bad-bg-light: "#ffedea"
  bad-ink-light: "#831c1e"
  ok-bg-dark: "#172a1d"
  warn-bg-dark: "#2b2414"
  bad-bg-dark: "#2c1a20"
  frame-light: "#eef1f8"
  sheet-light: "#ffffff"
  ink-light: "#131416"
  muted-light: "#5d5f60"
  line-light: "#e5e8ef"
  control-light: "#8b909a"
  track-light: "#eceff5"
  primary-light: "#1d1f20"
  frame-dark: "#0c0d12"
  sheet-dark: "#15161c"
  ink-dark: "#f2f2f3"
  muted-dark: "#a4a7ab"
  line-dark: "#2a2c35"
  control-dark: "#6b7080"
  track-dark: "#23252e"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 600
  kpi:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 400
  verdict:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  bar: "3px"
  control: "6px"
  card: "8px"
  sheet: "16px"
  pill: "99px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.sheet-light}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-primary:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.sheet-light}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-danger:
    backgroundColor: "{colors.bad-bg-light}"
    textColor: "{colors.bad-ink-light}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  card:
    backgroundColor: "{colors.sheet-light}"
    rounded: "{rounded.card}"
    padding: "16px"
  sheet:
    backgroundColor: "{colors.sheet-light}"
    rounded: "{rounded.sheet}"
    padding: "24px"
  pill-ok:
    backgroundColor: "{colors.ok-bg-light}"
    textColor: "{colors.ok-ink-light}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  input:
    backgroundColor: "{colors.sheet-light}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
---

# Design System: Cairn

<!-- Direction « Feuille encadrée » (tasteskill, style framed-sheet), choisie
le 2026-11-03 ; palette « une teinte par mesure » le même jour (la première
version, grise avec un seul pétrole, était jugée triste). Source de vérité : les variables de :root dans www/panel.css ;
le thème sombre redéfinit toutes les couleurs. -->

## Overview

**Creative North Star : « Le tableau de bord »**

Cairn est un instrument de mesure, pas une vitrine. On l'ouvre pour savoir en
deux secondes si le NAS va bien, puis pour agir précisément (un partage, un
snapshot, un compte). Chaque mesure a sa teinte, la même dans toutes les
vues (le CPU est indigo partout), et le vert, l'ambre et le rouge restent
réservés aux états.

La structure est une **feuille encadrée** : la barre latérale repose sur un
cadre teinté, et la page est une feuille blanche posée dessus, décalée de
8 px des bords haut, droit et bas de la fenêtre, avec un filet et des coins de
16 px, sans ombre. La profondeur vient d'un seul pas de ton.

**Key Characteristics :**
- Un cadre bleuté, une feuille blanche, des cartes à filet sans ombre.
- Une teinte par mesure ; accent indigo sur la navigation ; action principale
  quasi noire.
- Pastilles d'état en paires claires (fond pâle, encre foncée de la même teinte).
- Chaque écran répond d'abord à sa question (la Vue d'ensemble : « le NAS
  va-t-il bien ? », en une phrase sous le titre).
- Police système, `tabular-nums` sur tout chiffre qui bouge.

## Colors

Neutres bleutés, une teinte par mesure, trois couleurs d'état ; en sombre,
des neutres très légèrement bleutés et les mêmes rôles éclaircis.

### Primary
- **Indigo** (`accent-*`) : icônes de la navigation, page courante (fond
  indigo à 14 % sur le cadre), sélection des choix exclusifs, focus.

### Secondary : une teinte par mesure
- **Indigo CPU** (`cpu-*`) : jauge, courbe et fils du processeur.
- **Bleu ciel mémoire** (`mem-*`) : jauge mémoire, segment Applications.
- **Turquoise stockage** (`pool-*`) : jauge et barres des pools, cache ARC.
- **Rose températures** (`temp-*`) : jauge de température CPU.
- **Bleu réception, orange émission** (`rx-*`, `tx-*`) : courbes et débits
  réseau ; les variantes `*-ink` servent au texte (4,5:1).
- **Violet cache** (`cache-*`) : cache système de la pile mémoire.

### Tertiary
- **Vert sain, Ambre vigilance, Rouge panne** (`ok-*`, `warn-*`, `bad-*`) :
  états d'un pool, disque, service, client. Les variantes `*-bg` / `*-ink`
  forment les paires des pastilles, bannières et boutons de suppression.

### Neutral
- **Cadre** (`frame-*`) : fond de fenêtre et barre latérale.
- **Feuille** (`sheet-*`) : la page, les cartes, les dialogues.
- **Encre** (`ink-*`) et **Encre douce** (`muted-*`, 4,5:1 minimum) : texte.
- **Filet** (`line-*`) : bords de feuille, de cartes, séparateurs.
- **Contrôle** (`control-*`) : bord des boutons et champs, un pas plus fort.
- **Rail** (`track-*`) : fond des jauges et barres, élément de nav actif.
- **Action** (`primary-*`) : bouton principal, quasi noir en clair, inversé
  (clair sur foncé) en sombre.

### Named Rules
**La règle d'une teinte par mesure.** Une mesure garde sa teinte dans toutes
les vues ; une nouvelle mesure reçoit une teinte libre, jamais vert, ambre ou
rouge. Les boutons restent neutres.

**La règle du feu tricolore.** Vert, ambre et rouge ne signifient qu'un état.

**La règle des étiquettes.** Les couleurs choisies par l'utilisateur (`--tag`)
restent confinées à la bordure gauche d'une carte et au point d'étiquette.

## Typography

**Police :** pile système (`system-ui, -apple-system, "Segoe UI", sans-serif`),
aucune police chargée (CSP).

**Character :** neutre et native ; trois graisses (400, 600 et le gras des
`<b>`), échelle 12 / 14 / 16 / 18 / 22 / 28 (et 11 px pour les numéros de
fils CPU).

### Hierarchy
- **Headline** (600, 22 px) : titre de la vue.
- **KPI** (400, 28 px, chiffres tabulaires) : valeur au centre d'une jauge.
- **Verdict** (600, 18 px) : la phrase d'état en tête de la Vue d'ensemble.
- **Title** (600, 16 px) : intertitres, titres de dialogue, valeur de tuile.
- **Body** (400, 14 px / 1,45) : texte courant, tableaux, boutons, puces.
- **Label** (400, 12 px, casse de phrase) : libellés, méta-données, en-têtes
  de tableau. Pas de majuscules espacées.

## Layout

Sidebar de 228 px sur le cadre, feuille à droite (marges internes 24 px).
Les cartes se rangent en grilles : jauges `auto-fit` ≥ 220 px (elles
remplissent la rangée), tuiles ≥ 260 px, réseau et disques ≥ 300 px, pools
≥ 380 px ; écart 14 px.

Sous 820 px, le cadre disparaît : la feuille devient l'écran (sans marge,
filet ni coins), seule la navigation reste collée en haut (le nom en
dessus, étiquettes, thème et compte en bas de page), les jauges
en 2 × 2 (anneau au-dessus du texte) et chaque ligne de tableau devient une
carte qui nomme ses valeurs (`data-label` posé par panel.js).

## Elevation & Depth

Plat. Trois niveaux seulement : cadre, feuille, carte ; la séparation vient
d'un pas de ton et d'un filet de 1 px, jamais des deux plus une ombre.

### Shadow Vocabulary
- **Flottant** (`0 12px 28px rgb(0 0 0 / .18)`) : dialogues uniquement.

### Named Rules
**La règle des trois niveaux.** Cadre, feuille, carte : pas de quatrième
niveau d'imbrication.

## Shapes

Coins serrés et réguliers : 16 px pour la feuille et les dialogues, 8 px pour
les cartes, 6 px pour boutons, champs et mini-disques, 3 px pour les fils CPU,
pilule pour pastilles, puces et barres. Les états se marquent par une bordure
épaisse d'un seul côté : 3 px en haut d'une tuile, 3–4 px à gauche d'un
disque, d'un groupe ou d'une carte étiquetée.

## Components

### Buttons
- **Shape :** 6 px, 6 × 12 px, bord `control`.
- **Primary :** fond `primary`, texte `on-primary` (quasi noir / inversé).
- **Danger :** paire rouge pâle avec bord rouge ; seulement pour supprimer.
  Dans une ligne de tableau, il reste neutre et ne rougit qu'au survol ou au
  focus (une colonne de boutons rouges crie plus fort que les données).
- **Ghost :** sans fond, dans la latérale.
- **Hover :** le bord passe en encre douce.

### Chips
- **Pastille** (`pill`) : état en lecture seule, paire claire de l'état.
- **Puce** (`chip`) : élément cliquable (client NFS, ligne de faits sous les
  tuiles) ; paire verte quand c'est connecté.

### Cards / Containers
- **Corner Style :** 8 px.
- **Background :** feuille.
- **Shadow Strategy :** aucune.
- **Border :** filet 1 px.
- **Internal Padding :** 16 px.
- **Tuile cliquable :** au survol, seul le bord se renforce.

### Inputs / Fields
- **Style :** bord `control`, fond feuille, 6 px de rayon, 6 × 10 px.
- **Choix exclusifs :** pastilles `swatch`, sélection = bord accent et fond
  accent à 12 % ; focus clavier = contour 2 px accent.

### Navigation
- Boutons pleine largeur, icône trait 18 px en indigo, texte encre douce ;
  survol = fond `track` ; page courante = fond indigo 14 %, texte indigo, 600.

### Verdict (composant signature)
Bandeau à la paire claire de l'état (vert, ambre ou rouge pâle, bord de la
teinte à 35 %), point d'état + une phrase : « Tout va bien : 2 pools en
ligne, 10 / 10 disques sains, 7 services actifs » (pluriels accordés), ou la
liste de ce qui ne va pas (pool dégradé ou plein, disque à surveiller,
service arrêté). C'est ce qu'on lit en premier.

### Jauge
Carte horizontale : anneau SVG de 84 px à gauche (72 px sur mobile), trait
11 px à bouts ronds, rail teinté de la mesure à 16 % (une jauge à 3 % reste
colorée), libellé, valeur à 28 px / 400 et détail à droite ; passe en ambre
puis rouge selon le seuil.

### Tuiles et faits
Sous les jauges, quatre tuiles (disques, pools, réseau, services avec un
point par service) ; les faits secondaires (NFS, allumé depuis, ARC) tiennent
sur une ligne de puces cliquables, pas dans des tuiles à moitié vides.

### Snapshots
Les snapshots manuels qui partagent un nom (un snapshot récursif, une
migration) tiennent sur une ligne : « @mig1 · 10 datasets », taille cumulée,
« Supprimer les 10 » avec une seule confirmation qui les liste.

## Do's and Don'ts

### Do:
- **Do** passer par les variables de `:root` ; aucune couleur en dur.
- **Do** garder chaque écran utilisable en clair, en sombre et sous 820 px.
- **Do** viser 4,5:1 pour tout texte, pastilles comprises.
- **Do** mettre les valeurs dynamiques dans des variables (`--tag`) ou des
  attributs posés par panel.js : la CSP interdit style et JS inline.

### Don't:
- **Don't** colorer un bouton (hors primaire et suppression) ni changer la
  teinte d'une mesure d'une vue à l'autre.
- **Don't** ajouter d'ombre à une carte ni à la feuille.
- **Don't** écrire un libellé en majuscules espacées.
- **Don't** utiliser vert, ambre ou rouge pour autre chose qu'un état.
- **Don't** charger de police, d'icône ou de script externe.
