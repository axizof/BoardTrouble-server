// Le journal du serveur (ce que la console affiche), gardé en mémoire pour la console du tableau
// de bord : les dernières lignes, et chaque nouvelle à ceux qui écoutent.

export class LogBuffer {
  readonly #size: number;
  #lines: string[] = [];
  readonly #listeners = new Set<(line: string) => void>();

  constructor(size: number) {
    this.#size = size;
  }

  push(line: string): void {
    this.#lines = [...this.#lines.slice(1 - this.#size), line];
    for (const listener of this.#listeners) listener(line);
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  listen(listener: (line: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
