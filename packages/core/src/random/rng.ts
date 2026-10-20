/**
 * Générateur de hasard déterministe (mulberry32). Tout le hasard d'une partie passe par
 * lui : même graine et mêmes actions donnent exactement la même partie, ce qui rend
 * possibles les sauvegardes, les tests et le simulateur. Son état tient dans un entier,
 * stocké dans l'état de la partie et jamais envoyé aux clients.
 */
export class Rng {
  #state: number;

  constructor(state: number) {
    this.#state = state >>> 0;
  }

  get state(): number {
    return this.#state;
  }

  /** Nombre dans [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Entier dans [min, max], bornes comprises. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick sur une liste vide');
    return item;
  }

  /** Copie mélangée (Fisher-Yates), la liste d'origine n'est pas modifiée. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }
}
