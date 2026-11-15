<p align="center">
  <img src="assets/logo.png" alt="Board Trouble" width="520">
</p>

# Board Trouble - serveur

Serveur de jeu de **Board Trouble**, un party game web : une course de plateau en 3D entrecoupée de mini-jeux, où tout peut se retourner jusqu'au dernier lancer.

N'importe qui peut lancer ce serveur, comme un serveur Minecraft :
- **sur le même réseau** : on lance l'exécutable, puis les joueurs ouvrent l'adresse affichée dans leur navigateur ;
- **par Internet** : sur un VPS, ou depuis chez soi à travers un tunnel.

Le serveur fait autorité : il applique toutes les règles, tire les dés et ne révèle à chaque joueur que ce qu'il a le droit de voir.

## État du projet

Le moteur de règles, les mini-jeux et leurs bots sont faits ; le multijoueur arrive par étapes (salons et parties en réseau d'abord).

## Lancer un serveur

Le plus simple : télécharge l'exécutable de ton système dans les [Releases](../../releases/latest) (Windows, Mac, Linux), et lance-le. Le jeu est dedans, rien d'autre à installer.

Depuis les sources : le client cloné à côté de ce repo et compilé (`npm run build` dans le client), puis :

```
bun run start                       # port 7350 par défaut
bun run start --port 7400 --name "Les copains" --client ../client/dist
```

La console affiche les adresses à donner aux joueurs (celle de ta machine et celles du réseau local). Les joueurs ouvrent l'une d'elles dans leur navigateur : le serveur leur envoie le jeu lui-même, puis ils choisissent Multijoueur, rejoignent ou créent un salon (avec un mot de passe s'ils veulent). Les réglages existent aussi en variables d'environnement : `BT_PORT`, `BT_NAME`, `BT_CLIENT`.

Avec une manette : un navigateur ne la donne qu'à une page en HTTPS. Le serveur sert donc aussi le jeu en HTTPS, sur le port suivant (7351 si le jeu est sur 7350), avec un certificat qu'il fabrique lui-même au premier lancement (dans `data/tls/`). La console donne cette adresse ; chaque joueur accepte une fois l'avertissement du navigateur ("connexion non privée", puis continuer). Options : `--https-port 7400`, ou `--no-https` (variables `BT_HTTPS_PORT`, `BT_NO_HTTPS=1`).

Pour tester comme par Internet : `bun run start --lag 80` simule un réseau lent (80 ms de latence, avec des à-coups).

### Le tableau de bord

Sur `http://localhost:7350/admin` (le port du serveur) : la vue d'ensemble (joueurs, salons, processeur, mémoire, adresses à donner), les salons (en créer un à partir d'un preset, forcer l'étape suivante d'une partie bloquée, fermer), les joueurs (ping, expulser, bannir de tout le serveur), la console en direct, et les réglages (presets de salon, redémarrer, arrêter). Depuis la machine du serveur, il s'ouvre directement ; depuis une autre, il demande le mot de passe admin : celui de la variable `BT_ADMIN_PASSWORD`, sinon un mot de passe tiré au lancement et affiché dans la console. Les bannis et les presets sont gardés dans `data/` (option `--data`, variable `BT_DATA`).

### Les mises à jour

Le serveur regarde la dernière Release de ce repo au lancement, puis toutes les 6 heures. Une version plus récente s'affiche dans le tableau de bord : un clic l'installe et redémarre le serveur (jamais pendant une partie) quand il tourne en exécutable ; lancé depuis les sources, mets-le à jour avec `git pull`. `BT_NO_UPDATE_CHECK=1` pour ne pas chercher de mise à jour.

### Les comptes Discord

Un joueur peut se connecter avec Discord (depuis l'écran Multijoueur) : il retrouve alors sa place depuis n'importe quel appareil, et les autres voient "Discord" à côté de son nom. La connexion passe par l'API centrale de Board Trouble, qui lui donne un jeton signé ; le serveur le vérifie lui-même avec la clé publique de l'API, qu'il lit au lancement. Les exécutables des Releases connaissent déjà l'adresse de l'API : rien à régler. Depuis les sources, on la donne (`BT_AUTH_URL=<adresse de l'API>`), ou directement sa clé (`BT_AUTH_PUBLIC_KEY=<la clé>`). Si l'API ne répond pas au lancement, le serveur marche sans Discord : chacun garde sa place sur son navigateur. La console dit si la connexion Discord est activée.

### Les Releases

Chaque push sur `main` publie la Release de la version du jeu (`GAME_VERSION`, `packages/core/src/version.ts`) si elle n'existe pas encore : ses nouveautés (`packages/core/src/changelog.ts`) et un exécutable par système (`board-trouble-server-<windows|macos|linux>-<x64|arm64>`), avec le jeu compilé embarqué. Pour en publier une : monter `GAME_VERSION` et ajouter ses nouveautés en tête du changelog (un test le vérifie). Le workflow (`.github/workflows/release.yml`) a besoin de deux secrets du repo : `CLIENT_REPO_TOKEN` (lecture du repo du client) et `BT_API_URL` (l'adresse de l'API centrale).

## Licence

[GNU AGPL-3.0](LICENSE) : tu peux héberger, modifier et redistribuer ce serveur librement. Si tu mets en ligne une version modifiée, tu dois publier son code source sous la même licence.

## Organisation

```
packages/core/      règles du jeu : plateau, dés, tours, portes, bots (TypeScript pur, tourne aussi dans le navigateur)
tools/simulator/    simulateur d'équilibrage : des milliers de parties entre bots
apps/server/        serveur réseau : sert le jeu, salons, parties (reconnexion, modération et sauvegardes à venir)
```

## Développement

Prérequis : [Bun](https://bun.sh) 1.4 ou plus.

```
bun install         # installer les dépendances
bun run check       # lint et format (Biome), types (TypeScript), tests
bun run simulate    # simuler des parties : --games 2000 --table 4|6 --seed 1
```

Le moteur de règles est une fonction pure : il reçoit l'état de la partie et une intention ("je lance", "je prends ce chemin"), la valide, et renvoie le nouvel état avec la liste des événements à animer. Tout le hasard passe par un générateur à graine : une même graine rejoue exactement la même partie.
