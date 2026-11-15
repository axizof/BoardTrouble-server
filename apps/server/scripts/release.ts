import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GAME_VERSION } from '@board-trouble/core';
import { assetName } from '../src/updates';

// Les exécutables d'une Release (le workflow .github/workflows/release.yml) : le serveur et le jeu
// compilé, embarqué, en un seul fichier par système (une mise à jour remplace tout d'un coup).
//   bun apps/server/scripts/release.ts <dossier qui contient client/> <sortie> [cibles...]
// Sans cible : toutes. BT_RELEASE_AUTH_URL : l'adresse de l'API officielle (connexion Discord),
// écrite dans les exécutables.

/** Chaque cible de Bun, et le système et l'architecture qui nomment son exécutable. */
const TARGETS: Record<string, [NodeJS.Platform, NodeJS.Architecture]> = {
  'bun-windows-x64': ['win32', 'x64'],
  'bun-linux-x64': ['linux', 'x64'],
  'bun-linux-arm64': ['linux', 'arm64'],
  'bun-darwin-x64': ['darwin', 'x64'],
  'bun-darwin-arm64': ['darwin', 'arm64'],
};

const [stage, out, ...wanted] = process.argv.slice(2);
if (!stage || !out) {
  console.error(
    'Usage : bun apps/server/scripts/release.ts <dossier avec client/> <sortie> [cibles...]',
  );
  process.exit(1);
}
const entry = resolve(import.meta.dir, '../src/main.ts');
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });
const authUrl = process.env.BT_RELEASE_AUTH_URL?.trim().replace(/\/$/, '') ?? '';
if (authUrl === '')
  console.warn('BT_RELEASE_AUTH_URL absente : exécutables sans connexion Discord');
// L'embarqué garde son chemin relatif au dossier de travail : `client/...`, que main.ts cherche
// à côté de lui (import.meta.dir).
process.chdir(resolve(stage));

for (const target of wanted.length > 0 ? wanted : Object.keys(TARGETS)) {
  const system = TARGETS[target];
  if (!system) {
    console.error(`Cible inconnue : ${target}`);
    process.exit(1);
  }
  const outfile = join(outDir, assetName(...system));
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      target: target as Bun.Build.CompileTarget,
      outfile,
      assets: ['client'],
      // Le nom et la version dans les propriétés du .exe : seulement en compilant sur Windows
      // (Bun s'appuie sur ses API), d'où la Release qui le compile là.
      ...(target === 'bun-windows-x64' && process.platform === 'win32'
        ? { windows: { title: 'Board Trouble - serveur', version: GAME_VERSION } }
        : {}),
    },
    minify: true,
    define: authUrl === '' ? {} : { BUILT_AUTH_URL: JSON.stringify(authUrl) },
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }
  console.log(`${target} : ${outfile}`);
}
