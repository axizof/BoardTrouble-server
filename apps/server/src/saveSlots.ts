import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RoomSave, SaveSummary } from '@board-trouble/core';

// Les parties sauvegardées du serveur (01-architecture.md, section 9) : quelques emplacements,
// un fichier chacun dans `data/saves/`. Une partie en cours en occupe un ; finie, elle le
// libère. Écriture atomique (un fichier temporaire, puis renommé) ; une sauvegarde illisible
// est mise de côté dans `data/saves/corrupted/`, jamais chargée à moitié.

/** Version du fichier d'un emplacement : une autre version n'est pas chargée. */
export const SAVE_FILE_VERSION = 1;

/** Un emplacement : le salon (son nom, son mot de passe haché) et sa partie. */
export type SavedGame = {
  version: typeof SAVE_FILE_VERSION;
  savedAt: string;
  roomName: string;
  /** Le mot de passe du salon, haché (null : sans mot de passe). */
  password: string | null;
  room: RoomSave;
};

/** Les emplacements, sur disque ou en mémoire (les tests). */
export type SaveSlots = {
  readonly count: number;
  read(slot: number): SavedGame | null;
  write(slot: number, game: SavedGame): void;
  remove(slot: number): void;
  /** Les emplacements occupés, résumés. */
  list(): SaveSummary[];
};

export function summarize(slot: number, game: SavedGame): SaveSummary {
  const { state } = game.room.session;
  return {
    slot,
    roomName: game.roomName,
    savedAt: game.savedAt,
    round: state.round,
    players: state.players.map((player) => player.name),
  };
}

export class FileSaveSlots implements SaveSlots {
  readonly count: number;
  readonly #dir: string;
  readonly #log: (line: string) => void;

  constructor(dir: string, count: number, log: (line: string) => void) {
    this.#dir = dir;
    this.count = count;
    this.#log = log;
  }

  #path(slot: number): string {
    return join(this.#dir, `slot-${slot}.json`);
  }

  read(slot: number): SavedGame | null {
    const path = this.#path(slot);
    if (!existsSync(path)) return null;
    try {
      const game = JSON.parse(readFileSync(path, 'utf-8')) as SavedGame;
      if (game.version !== SAVE_FILE_VERSION || !game.room?.session?.state) {
        throw new Error(`format inconnu (version ${String(game.version)})`);
      }
      return game;
    } catch (error) {
      this.#setAside(slot, String(error));
      return null;
    }
  }

  write(slot: number, game: SavedGame): void {
    mkdirSync(this.#dir, { recursive: true });
    const path = this.#path(slot);
    writeFileSync(`${path}.tmp`, JSON.stringify(game));
    renameSync(`${path}.tmp`, path);
  }

  remove(slot: number): void {
    rmSync(this.#path(slot), { force: true });
  }

  list(): SaveSummary[] {
    if (!existsSync(this.#dir)) return [];
    const taken = readdirSync(this.#dir).flatMap((name) => {
      const match = /^slot-(\d+)\.json$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
    return taken
      .filter((slot) => slot >= 1 && slot <= this.count)
      .sort((a, b) => a - b)
      .flatMap((slot) => {
        const game = this.read(slot);
        return game ? [summarize(slot, game)] : [];
      });
  }

  /** Une sauvegarde illisible : mise de côté (on ne la perd pas), son emplacement libéré. */
  #setAside(slot: number, reason: string): void {
    const corrupted = join(this.#dir, 'corrupted');
    mkdirSync(corrupted, { recursive: true });
    const target = join(corrupted, `slot-${slot}-${Date.now()}.json`);
    renameSync(this.#path(slot), target);
    this.#log(`Sauvegarde ${slot} illisible (${reason}) : mise de côté dans ${target}`);
  }
}

/** Les emplacements en mémoire, pour les tests. */
export class MemorySaveSlots implements SaveSlots {
  readonly count: number;
  readonly #games = new Map<number, SavedGame>();

  constructor(count: number) {
    this.count = count;
  }

  read(slot: number): SavedGame | null {
    const game = this.#games.get(slot);
    return game ? structuredClone(game) : null;
  }

  write(slot: number, game: SavedGame): void {
    this.#games.set(slot, structuredClone(game));
  }

  remove(slot: number): void {
    this.#games.delete(slot);
  }

  list(): SaveSummary[] {
    return [...this.#games].sort(([a], [b]) => a - b).map(([slot, game]) => summarize(slot, game));
  }
}
