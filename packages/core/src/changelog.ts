// Les nouveautés de chaque version, la plus récente d'abord : l'écran titre du jeu les montre, et
// la Release GitHub de chaque version les reprend (apps/server/scripts/releaseNotes.ts). À
// compléter à chaque mise à jour publiée, avec GAME_VERSION.

export type ChangelogEntry = { version: string; date: string; title: string; items: string[] };

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.5.0',
    date: '2026-11-15',
    title: 'Le multijoueur',
    items: [
      'Multijoueur : rejoins un serveur par son adresse, puis un salon (avec un mot de passe si son hôte le veut), ou crée le tien.',
      "L'hôte règle la partie pour tout le monde : les bots et leur niveau, la table, le temps pour décider, la vitesse du texte et les conseils du Plateau.",
      'Un tchat dans le salon et pendant la partie.',
      'Connecte-toi avec Discord pour retrouver ta place depuis tous tes appareils.',
      "Déconnecté ou absent trop longtemps : un bot Facile joue ta place, et tu la reprends en revenant. L'hôte peut aussi donner la place d'un bot à quelqu'un qui arrive.",
      'Les mini-jeux en réseau sont fluides : ton personnage réagit tout de suite, même avec une connexion lente.',
      'Six nouveaux mini-jeux : la Joute sur le tronc, le Roi de la colline, le Canonnier, Peinture fraîche, le Bras de fer et le Mini-golf.',
    ],
  },
];
