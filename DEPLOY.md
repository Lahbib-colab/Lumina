# Mettre LUMINA en ligne (fonctionne partout)

Une fois en ligne, ouvrez simplement l'adresse du serveur depuis n'importe quel appareil : LUMINA s'affiche et
utilise automatiquement le serveur pour extraire les liens et convertir en MP4. Aucun réglage dans le navigateur,
aucun problème CORS, aucun ordinateur à laisser allumé chez vous.

## Choisir
| Option | Pour qui | Points d'attention |
|---|---|---|
| **A. VPS + `docker-compose.https.yml`** | Le plus fiable et durable | Il faut un serveur loué et un nom de domaine |
| **B. Render (`render.yaml`)** | Le plus simple, sans serveur à gérer | Les offres gratuites s'endorment après inactivité et le disque est temporaire |
| **C. Votre ordinateur / NAS (`docker-compose.yml`)** | Usage à la maison | Accessible hors de chez vous seulement avec un tunnel (Tailscale, Cloudflare Tunnel) |

Le disque temporaire n'est pas un problème : le MP4 est copié dans l'appareil après la conversion, puis supprimé du
serveur (et de toute façon nettoyé après 24 h).

## A. VPS avec https automatique
1. Louez un petit serveur Linux, installez Docker, et dirigez un nom de domaine (enregistrement A) vers son adresse IP.
2. Copiez ce dossier sur le serveur, puis :
   ```bash
   cp .env.example .env
   nano .env            # renseignez LUMINA_TOKEN (openssl rand -hex 24) et DOMAIN
   docker compose -f docker-compose.https.yml up -d --build
   ```
3. Ouvrez `https://votre-domaine`. Au premier lancement, LUMINA demande le jeton : saisissez-le une seule fois.

## B. Render
1. Mettez ce dossier dans un dépôt GitHub privé.
2. Sur render.com : **New > Blueprint**, choisissez le dépôt. Un jeton est généré automatiquement
   (onglet *Environment*, variable `LUMINA_TOKEN`).
3. Ouvrez l'adresse fournie par Render (https déjà inclus) et saisissez le jeton.

## Sur téléphone
Safari : Partager > **Sur l'écran d'accueil**. Chrome : menu > **Installer l'application**. LUMINA s'ouvre alors comme
une application, et les vidéos téléchargées se lisent **sans réseau**.

## Sécurité (important : le serveur est public)
- Le serveur **refuse de démarrer** sans `LUMINA_TOKEN` d'au moins 12 caractères. Gardez-le secret.
- 10 jetons erronés en 10 minutes bloquent l'adresse concernée.
- Les adresses locales et privées sont refusées comme source (`BLOCK_PRIVATE=1`) : le serveur ne peut pas servir
  à sonder un réseau interne.
- Toujours en **https** (les options A et B le font). En http, le jeton circulerait en clair.
- Pour changer le jeton : modifiez `LUMINA_TOKEN`, relancez, puis ressaisissez-le dans LUMINA (icône serveur).

## Variables utiles
`RETENTION_HOURS` (24 par défaut dans Docker, 0 = ne jamais supprimer), `MAX_PARALLEL` (conversions simultanées),
`BLOCK_PRIVATE`, `TRUST_PROXY` (1 derrière un proxy https). Voir README.md pour la liste complète.

Rappel : n'utilisez ce serveur qu'avec des vidéos dont vous détenez les droits ou la licence.
