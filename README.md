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

Pour l'instant, depuis les sources (les exécutables viendront avec les releases) : le client cloné à côté de ce repo et compilé (`npm run build` dans le client), puis :

```
bun run start                       # port 7350 par défaut
bun run start --port 7400 --name "Les copains" --client ../client/dist
```

La console affiche les adresses à donner aux joueurs (celle de ta machine et celles du réseau local). Les joueurs ouvrent l'une d'elles dans leur navigateur : le serveur leur envoie le jeu lui-même, puis ils choisissent Multijoueur, rejoignent ou créent un salon (avec un mot de passe s'ils veulent). Les réglages existent aussi en variables d'environnement : `BT_PORT`, `BT_NAME`, `BT_CLIENT`.

Pour tester comme par Internet : `bun run start --lag 80` simule un réseau lent (80 ms de latence, avec des à-coups).

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
