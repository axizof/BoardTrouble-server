import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { GAME_VERSION } from '@board-trouble/core';

// Les mises à jour du serveur (choix de l'utilisateur, 2026-11-15 : proposées en un clic) : il
// regarde la dernière Release de son repo GitHub (au lancement, puis toutes les 6 heures). Une
// version plus récente s'affiche dans le tableau de bord ; s'il tourne en exécutable (pas depuis
// les sources), un clic télécharge le nouvel exécutable de son système, le met à la place et
// redémarre. Depuis les sources, on lui dit de faire `git pull`.

/** Le repo dont on suit les Releases (le repo public du serveur), modifiable : BT_UPDATE_REPO. */
const DEFAULT_REPO = 'axizof/BoardTrouble-server';
const CHECK_EVERY = 6 * 60 * 60_000;

export type AvailableUpdate = {
  version: string;
  notes: string;
  /** Un clic suffit (exécutable du bon système trouvé dans la Release) ; sinon, à la main. */
  canApply: boolean;
};

/** "1.2.3" plus récent que "1.2.0" ? (Les numéros, dans l'ordre ; un "v" devant est ignoré.) */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) =>
    version
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Le nom de l'exécutable de ce système dans une Release (convention de l'étape Releases). */
export function assetName(platform = process.platform, arch = process.arch): string {
  const system = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  return `board-trouble-server-${system}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/** Le serveur tourne en exécutable compilé (sinon, depuis les sources avec Bun). */
export function isCompiled(): boolean {
  return !/[\\/]bun(\.exe)?$/i.test(process.execPath);
}

type Release = { version: string; notes: string; assetUrl: string | null };

export class UpdateChecker {
  readonly #repo: string;
  readonly #log: (line: string) => void;
  #release: Release | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(log: (line: string) => void) {
    this.#repo = process.env.BT_UPDATE_REPO || DEFAULT_REPO;
    this.#log = log;
    if (process.env.BT_NO_UPDATE_CHECK === '1') return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), CHECK_EVERY);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** La version plus récente disponible, ou null. */
  get available(): AvailableUpdate | null {
    const release = this.#release;
    if (!release || !isNewer(release.version, GAME_VERSION)) return null;
    return {
      version: release.version,
      notes: release.notes,
      canApply: isCompiled() && release.assetUrl !== null,
    };
  }

  async check(): Promise<void> {
    try {
      const response = await fetch(`https://api.github.com/repos/${this.#repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'board-trouble-server' },
      });
      // Pas encore de Release (404), ou GitHub qui limite : rien à proposer pour l'instant.
      if (!response.ok) return;
      const data = (await response.json()) as {
        tag_name?: unknown;
        body?: unknown;
        assets?: { name?: unknown; browser_download_url?: unknown }[];
      };
      if (typeof data.tag_name !== 'string') return;
      const asset = data.assets?.find((one) => one.name === assetName());
      const wasKnown = this.#release?.version;
      this.#release = {
        version: data.tag_name.replace(/^v/, ''),
        notes: typeof data.body === 'string' ? data.body.slice(0, 2000) : '',
        assetUrl:
          typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null,
      };
      const update = this.available;
      if (update && update.version !== wasKnown) {
        this.#log(`Mise à jour disponible : version ${update.version} (tableau de bord)`);
      }
    } catch (error) {
      // Pas d'Internet (une partie en LAN fermé) : le serveur marche très bien sans. On le note.
      this.#log(`Vérification des mises à jour impossible : ${String(error)}`);
    }
  }

  /**
   * Télécharge l'exécutable de la nouvelle version et le met à la place de celui-ci (l'ancien est
   * gardé à côté en `.old`). Rend une erreur à afficher, ou null si c'est fait (il reste à
   * redémarrer).
   */
  async apply(): Promise<string | null> {
    const update = this.available;
    const url = this.#release?.assetUrl;
    if (!update || !url) return 'Aucune mise à jour à installer.';
    if (!update.canApply) return 'Depuis les sources : mets à jour avec git pull, puis relance.';
    const current = process.execPath;
    const incoming = `${current}.new`;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'board-trouble-server' } });
      if (!response.ok) return `Téléchargement refusé (${response.status}).`;
      writeFileSync(incoming, new Uint8Array(await response.arrayBuffer()));
      if (process.platform !== 'win32') chmodSync(incoming, 0o755);
      // Windows laisse renommer un exécutable en cours d'exécution, pas l'écraser.
      rmSync(`${current}.old`, { force: true });
      renameSync(current, `${current}.old`);
      renameSync(incoming, current);
      this.#log(`Version ${update.version} installée : redémarrage`);
      return null;
    } catch (error) {
      return `Mise à jour impossible : ${String(error)}`;
    }
  }
}
