import { CHANGELOG, GAME_VERSION } from '@board-trouble/core';
import { assetName } from '../src/updates';

// Le texte de la Release de cette version : ses nouveautés (core, changelog.ts), puis quel fichier
// télécharger et comment le lancer. Le workflow de Release l'écrit dans un fichier.

const entry = CHANGELOG.find((one) => one.version === GAME_VERSION);
if (!entry) {
  console.error(
    `Pas de nouveautés pour la version ${GAME_VERSION} (packages/core/src/changelog.ts)`,
  );
  process.exit(1);
}
const lines = [
  `## ${entry.title}`,
  '',
  ...entry.items.map((item) => `- ${item}`),
  '',
  '## Lancer un serveur',
  '',
  'Télécharge le fichier de ton système, lance-le, puis donne aux joueurs une des adresses affichées : ils y ouvrent le jeu dans leur navigateur. Le tableau de bord est sur `/admin`, et le serveur te proposera lui-même les prochaines mises à jour.',
  '',
  `- Windows : \`${assetName('win32', 'x64')}\` (double-clic ; Windows peut demander de confirmer : "Informations complémentaires", puis "Exécuter quand même").`,
  `- Mac (Apple Silicon : M1 et plus récents) : \`${assetName('darwin', 'arm64')}\` ; Mac Intel : \`${assetName('darwin', 'x64')}\`. Dans le Terminal : \`chmod +x <fichier>\`, puis \`xattr -d com.apple.quarantine <fichier>\`, puis \`./<fichier>\`.`,
  `- Linux : \`${assetName('linux', 'x64')}\` (ou \`arm64\` pour un Raspberry Pi 64 bits) : \`chmod +x <fichier>\`, puis \`./<fichier>\`.`,
  '',
];
console.log(lines.join('\n'));
