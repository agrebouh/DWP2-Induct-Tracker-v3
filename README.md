# ⚡ DWP2 Induct Tracker v3

> Tableau de bord temps réel pour le suivi de l'induction en station AMZL, directement intégré dans SCC (Station Command Center).

![Version](https://img.shields.io/badge/version-5.0-blue)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## 📋 Description

DWP2 Induct Tracker est un **UserScript Tampermonkey** qui ajoute un overlay de monitoring en temps réel sur les pages SCC d'Amazon Logistics. Il permet de suivre :

- 📦 **Volume inducté** vs target par tranche horaire
- ⏱️ **Avance / Retard** en nombre de colis
- 📊 **Rate live** (colis/heure) depuis l'API SCC
- 🔴 **Packages Held** (bloqués)
- 📈 **Stow WIP** avec jauge et historique
- ⚖️ **Flow Balance** (Induct Rate vs Sort Rate)
- 🌙☀️ **Détail par shift** (Night Sort + Hybride)

## 🚀 Installation

### Prérequis
- Navigateur : Chrome, Firefox, ou Edge
- Extension : [Tampermonkey](https://www.tampermonkey.net/)

### Étapes
1. Installez **Tampermonkey** depuis le store de votre navigateur
2. Cliquez sur l'icône Tampermonkey → **Créer un nouveau script**
3. Supprimez le contenu par défaut
4. Copiez-collez le contenu de [`DWP2-Induct-Tracker-v3.user.js`](./DWP2-Induct-Tracker-v3.user.js)
5. Sauvegardez (Ctrl+S)
6. Naviguez sur SCC → le bouton ⚡ apparaît en bas à droite

## 🎮 Utilisation

| Action | Résultat |
|--------|----------|
| **Clic** sur ⚡ | Ouvre le panneau compact |
| **Double-clic** sur ⚡ | Ouvre le dashboard plein écran |
| **DBG** | Affiche le panneau debug API |
| **🔄** | Rafraîchit les données manuellement |

## ⚙️ Configuration

Tout est configurable depuis le panneau :

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| Volume Total | Forecast total du shift | 30 000 |
| Volume NS | Volume Night Sort (00:00–05:22) | 13 500 |
| Volume HS | Volume Hybride (auto = Total - NS) | 16 500 |
| Fin HS | Heure de fin du shift hybride | 08:30 |
| Station | Code station (DWP1-4) | DWP2 |

Les rates NS et HS sont **calculés automatiquement** à partir des volumes et du temps effectif (pauses déduites).

## 📐 Logique de calcul

### Tranches horaires
- **Night Sort** : 00:10 → 05:22 (temps effectif ~4h48, pause 03:30–03:55)
- **Hybride** : 05:37 → Fin HS configurable (pause 05:22–05:37)

### Target
Le target cumulé à l'instant T est calculé proportionnellement au temps effectif écoulé dans chaque tranche, en déduisant les pauses.

### Avance / Retard
```
Δ = Volume inducté réel − Target cumulé attendu à l'instant T
```

### Stow WIP
- Source primaire : API SCC `/station/flow/stow-wip/data`
- Fallback : `(Pending Sort / Induct Rate) × 60`
- Zone verte : 10–19 min | Jaune : < 10 | Rouge : > 19

## 🔌 APIs utilisées

| Endpoint | Données |
|----------|---------|
| `/ivs/getLocationMetric` | Volume inducté, rate par table |
| `/os/getDwellingPackageData` | Packages Held, Pending Sort |
| `/station/flow/stow-wip/data` | Stow WIP (minutes) |
| `/station/flow/sort/data` | Sort Rate (FPH) |

> Les données sont rafraîchies automatiquement toutes les **60 secondes**.

## 💾 Données persistantes

Le script utilise `localStorage` pour sauvegarder :
- Configuration (volumes, fin HS, station)
- Snapshots toutes les 5 min (pour le tableau détaillé)
- Historique WIP
- Reset automatique quotidien

## 🖥️ Captures d'écran

### Panneau compact
Overlay discret en haut à droite avec les KPIs essentiels.

### Dashboard plein écran
Vue complète avec :
- Barre avance/retard
- 6 KPIs principaux
- Détail par shift (NS + HS)
- Jauge Stow WIP + historique graphique
- Flow Balance (Induct vs Sort)
- Tableau détaillé par tranche horaire

## 🏗️ Structure du code

```
DWP2-Induct-Tracker-v3.user.js
├── CONFIG          → Pauses, slots, constantes
├── STATE           → État global + localStorage
├── INTERCEPT       → Capture API key SCC
├── API             → Appels fetch vers SCC
├── SNAPSHOTS       → Système de snapshots 5min
├── CALCULATIONS    → Target, delta, rates, ETA
├── COMPACT PANEL   → UI overlay (370px)
├── FULL SCREEN     → Dashboard plein écran
└── INIT            → Démarrage + retry
```

## 📝 Changelog

### v5.0
- Dashboard plein écran avec tableau détaillé
- Stow WIP avec jauge visuelle et historique
- Flow Balance (Induct vs Sort)
- Alertes contextuelles (WIP + avance/retard)
- Snapshots toutes les 5 minutes
- Multi-station (DWP1-4)
- Reset quotidien automatique
- Panneau debug API

## 👤 Auteur

**Aghiles** — AMZL DWP2-DS (Carros, FR)

## 📄 License

MIT — Utilisation libre en interne Amazon Logistics.
