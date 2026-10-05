# LUMINA Offline

> **Pour que ça fonctionne partout (téléphone, hors de chez soi) : voir [DEPLOY.md](DEPLOY.md).** Le serveur sert LUMINA à la racine (`/`) et l'outil de conversion seul sur `/convert/`.

Convertit des flux HLS (`.m3u8`) en fichiers MP4 pour le mode hors-ligne de LUMINA.
Sans dépendance npm. Interface web, API et client JavaScript inclus.

## Prérequis
- Node.js 18.17 ou plus récent
- FFmpeg (avec `ffprobe`) dans le PATH : `sudo apt install ffmpeg` / `brew install ffmpeg` / `winget install ffmpeg`

## Démarrer
```bash
node server.js          # puis ouvrir http://localhost:8787 (LUMINA) ou /convert/ (outil de conversion seul)
```

## Essayer sans source externe
```bash
node scripts/demo.js    # génère un flux de test et l'affiche sur http://localhost:8788/master.m3u8
```
Collez ce lien dans l'interface : conversion, miniature, lecture et téléchargement sont testables.

## Ce que fait l'outil
- Copie sans recodage (rapide, sans perte) ; recodage H.264/AAC automatique si les codecs ne sont pas compatibles MP4
- Choix de la qualité (meilleure, 1080p, 720p, 480p, 360p) parmi les variantes du flux
- Déchiffre les flux HLS AES-128 standard dont la clé est fournie par la playlist
- File d'attente (2 conversions en parallèle par défaut), annulation, relance, reprise propre après arrêt
- Progression en temps réel (vitesse, temps restant), miniature automatique
- Bibliothèque hors-ligne avec lecture (seek instantané grâce aux requêtes Range) et téléchargement

Non pris en charge : flux en direct, flux protégés par DRM (Widevine, FairPlay, PlayReady).
À utiliser uniquement avec des contenus dont vous détenez les droits ou la licence.

## Configuration (variables d'environnement)
| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 8787 | Port du serveur |
| `HOST` | 127.0.0.1 | `0.0.0.0` pour y accéder depuis un téléphone du même Wi-Fi (jeton obligatoire) |
| `LUMINA_TOKEN` | vide | Jeton d'accès (API et fichiers) |
| `LUMINA_DIR` | ./library | Dossier des MP4 |
| `MAX_PARALLEL` | 2 | Conversions simultanées |
| `LUMINA_ORIGIN` | vide | Origine autorisée (CORS) si LUMINA est hébergée ailleurs |
| `BLOCK_PRIVATE` | 0 | `1` refuse les adresses locales/privées comme source |
| `FALLBACK_TRANSCODE` | 1 | `0` désactive le recodage de secours |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg / ffprobe | Chemins personnalisés |

Exemple réseau local : `HOST=0.0.0.0 LUMINA_TOKEN=un-long-secret node server.js`

## API
| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/jobs` | `{url, title?, quality?, referer?}` : lance une conversion |
| GET | `/api/jobs` | Liste des tâches |
| DELETE | `/api/jobs/:id` | Annule (ou retire de la liste si terminée) |
| POST | `/api/jobs/:id/retry` | Relance une tâche en erreur ou annulée |
| GET | `/api/library` | Vidéos hors-ligne + espace disque |
| DELETE | `/api/library/:id` | Supprime une vidéo |
| GET | `/media/:id.mp4` | Lecture (Range) ; `?download=1` pour enregistrer |
| GET | `/api/events` | Flux temps réel (SSE) |
| GET | `/api/extract?url=…&referer=…` | Extrait les flux .m3u8 / .mp4 d'une page (et de ses iframes) : `{title, poster, candidates[]}` |

Avec un jeton : en-tête `Authorization: Bearer …` ou paramètre `?token=…`.

## Intégrer dans LUMINA
```html
<script src="client/lumina-offline.js"></script>
<script>
  const off = new LuminaOffline('http://localhost:8787', { token: '' });
  await off.download(m3u8Url, { title: 'Mon film', quality: '720' });
  off.subscribe({ onJob: j => majBarre(j.id, j.progress), onLibrary: l => afficher(l.items) });
  video.src = off.mediaUrl('mon-film'); // lecture hors-ligne
</script>
```

## Brancher le script LUMINA (fiches avec champ m3u8)
`integration/Lumina-Offline.js` reprend le script d'origine et envoie chaque lien `.m3u8` trouvé au serveur
via `GET /api/add` (une seule requête GET, jeton obligatoire, doublons ignorés).
1. Lancer le serveur : `HOST=0.0.0.0 LUMINA_TOKEN=votre-jeton node server.js`
2. Dans le script, renseigner `SERVEUR` (IP de l'ordinateur sur le Wi-Fi) et `JETON`.

## Brancher la plateforme LUMINA (LUMINA.html)
La plateforme sait extraire le lien .m3u8 depuis l'adresse d'une page et le convertir en MP4 pour le hors-ligne.
Sans serveur, elle le fait seule quand la source l'autorise (CORS). Pour les autres cas :
1. Lancer : `HOST=0.0.0.0 LUMINA_TOKEN=votre-jeton node server.js`
2. Dans LUMINA, icône serveur (en haut) : adresse `http://IP-de-l-ordinateur:8787` et jeton, puis « Tester ».
Avec un jeton, le serveur accepte les requêtes de LUMINA même ouverte comme fichier local.
Si LUMINA est servie en https, le serveur doit l'être aussi (le navigateur bloque le contenu mixte).
