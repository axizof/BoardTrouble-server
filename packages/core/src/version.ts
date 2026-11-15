// La version du jeu, la même pour le client et le serveur : un client se connecte à un serveur de
// la même version (en LAN, le serveur sert lui-même le jeu, ils vont toujours ensemble). Elle
// change à chaque mise à jour publiée, avec ses nouveautés (changelog.ts) : c'est elle qui donne
// son nom à la Release GitHub (vX.Y.Z).
export const GAME_VERSION = '0.5.1';
