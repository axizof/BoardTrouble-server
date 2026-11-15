import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Les données du serveur gardées sur disque, dans `data/` (ignoré par git : rien de privé ne
// part dans le repo public) : un fichier JSON par sujet (bannis, presets). Écriture atomique :
// un fichier temporaire, puis renommé (une coupure pendant l'écriture n'abîme rien).

export class DataStore {
  readonly #dir: string;
  readonly #log: (line: string) => void;

  constructor(dir: string, log: (line: string) => void) {
    this.#dir = dir;
    this.#log = log;
  }

  /** Relit un fichier ; `read` le valide (absent ou illisible : `read(null)`). */
  load<T>(name: string, read: (raw: unknown) => T): T {
    const path = join(this.#dir, `${name}.json`);
    if (!existsSync(path)) return read(null);
    try {
      return read(JSON.parse(readFileSync(path, 'utf-8')));
    } catch (error) {
      this.#log(`Fichier ${path} illisible, ignoré : ${String(error)}`);
      return read(null);
    }
  }

  save(name: string, value: unknown): void {
    mkdirSync(this.#dir, { recursive: true });
    const path = join(this.#dir, `${name}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, path);
  }
}
