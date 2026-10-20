import type { Rng } from '../random/rng';

export type TableSize = 4 | 6;

export type BonusDieKind = 'gold' | 'silver' | 'bronze' | 'copper';

export type BonusDie = {
  kind: BonusDieKind;
  faces: number;
};

// Dé bonus selon la place au mini-jeu (01-vision-et-plateau.md, section 6).
const BONUS_DICE: Record<TableSize, ReadonlyArray<BonusDie | null>> = {
  4: [{ kind: 'gold', faces: 6 }, { kind: 'silver', faces: 3 }, { kind: 'bronze', faces: 2 }, null],
  6: [
    { kind: 'gold', faces: 6 },
    { kind: 'silver', faces: 4 },
    { kind: 'bronze', faces: 3 },
    { kind: 'copper', faces: 2 },
    null,
    null,
  ],
};

/** `rank` commence à 0 pour le premier. */
export function bonusDieForRank(rank: number, tableSize: TableSize): BonusDie | null {
  return BONUS_DICE[tableSize][rank] ?? null;
}

export type DiceRoll = {
  normal: number;
  bonus: number | null;
  /** Dé 1-6 en plus quand le dé normal et le dé bonus font le même chiffre. */
  extra: number | null;
  total: number;
};

export function rollDice(rng: Rng, bonusDie: BonusDie | null): DiceRoll {
  const normal = rng.int(1, 6);
  const bonus = bonusDie ? rng.int(1, bonusDie.faces) : null;
  const extra = bonus === normal ? rng.int(1, 6) : null;
  return { normal, bonus, extra, total: normal + (bonus ?? 0) + (extra ?? 0) };
}

export type TieBreak = {
  /** Lancers de deux dés des ex aequo, dans l'ordre d'origine. */
  rolls: { playerId: string; dice: [number, number] }[];
  /** Ex aequo restants après les dés, départagés au hasard par le Plateau. */
  randomlyOrdered: string[][];
};

/**
 * Règle commune d'égalité : les ex aequo lancent deux dés chacun, le plus grand total
 * prend la place la plus haute ; si l'égalité persiste, le Plateau tranche au hasard.
 * `groups` va du meilleur au moins bon, chaque groupe contient des ex aequo.
 */
export function breakTies(
  groups: readonly (readonly string[])[],
  rng: Rng,
): { order: string[]; tieBreaks: TieBreak[] } {
  const order: string[] = [];
  const tieBreaks: TieBreak[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      order.push(...group);
      continue;
    }
    const rolls = group.map((playerId) => ({
      playerId,
      dice: [rng.int(1, 6), rng.int(1, 6)] as [number, number],
    }));
    const byTotal = new Map<number, string[]>();
    for (const { playerId, dice } of rolls) {
      const total = dice[0] + dice[1];
      byTotal.set(total, [...(byTotal.get(total) ?? []), playerId]);
    }
    const randomlyOrdered: string[][] = [];
    for (const total of [...byTotal.keys()].sort((a, b) => b - a)) {
      const tied = byTotal.get(total) ?? [];
      if (tied.length > 1) randomlyOrdered.push(tied);
      order.push(...(tied.length > 1 ? rng.shuffle(tied) : tied));
    }
    tieBreaks.push({ rolls, randomlyOrdered });
  }
  return { order, tieBreaks };
}
