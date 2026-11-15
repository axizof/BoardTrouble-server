import type { ServerBans } from '../gameServer';
import type { DataStore } from './dataStore';

// Les bannis de tout le serveur (le tableau de bord), gardés dans `data/bans.json` : ils restent
// bannis après un redémarrage (01-architecture.md, section 7).

type Ban = { id: string; name: string };

function readBans(raw: unknown): Ban[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (one): one is Ban =>
      typeof one === 'object' &&
      one !== null &&
      typeof one.id === 'string' &&
      typeof one.name === 'string',
  );
}

export class FileBans implements ServerBans {
  readonly #store: DataStore;
  #bans: Ban[];

  constructor(store: DataStore) {
    this.#store = store;
    this.#bans = store.load('bans', readBans);
  }

  has(id: string): boolean {
    return this.#bans.some((ban) => ban.id === id);
  }

  add(id: string, name: string): void {
    if (this.has(id)) return;
    this.#bans = [...this.#bans, { id, name }];
    this.#store.save('bans', this.#bans);
  }

  remove(id: string): void {
    this.#bans = this.#bans.filter((ban) => ban.id !== id);
    this.#store.save('bans', this.#bans);
  }

  list(): Ban[] {
    return [...this.#bans];
  }
}
