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

En conception. Le code arrive après la validation des documents de conception.

## Licence

[GNU AGPL-3.0](LICENSE) : tu peux héberger, modifier et redistribuer ce serveur librement. Si tu mets en ligne une version modifiée, tu dois publier son code source sous la même licence.

## Contenu prévu

```
packages/core/      règles du jeu, simulation des mini-jeux, bots, protocole
apps/server/        serveur réseau : salons, reconnexion, modération, sauvegardes
tools/simulator/    simulateur d'équilibrage (parties entre bots)
```
