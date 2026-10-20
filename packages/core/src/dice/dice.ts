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

/** Dés spéciaux (01-vision-et-plateau.md, section 6), gardés dans la bourse à dés. */
export type SpecialDieKind = 'stable' | 'allOrNothing' | 'trapped';

export const SPECIAL_DICE: SpecialDieKind[] = ['stable', 'allOrNothing', 'trapped'];
export const SPECIAL_DICE_POUCH_SIZE = 3;

// Proportions à régler au simulateur.
const STABLE_FACES = [2, 2, 3, 3, 3, 3];
const ALL_OR_NOTHING_FACES = [0, 0, 0, 8, 8, 8];
/** Dé Piégé : le chiffre annoncé est sur 2 faces sur 6, les 4 autres sont piégées. */
const TRAPPED_CALLED_FACES = 2;

/** Dé spécial joué ce tour. `call` : chiffre annoncé pour le Dé Piégé. */
export type SpecialDieUse = { kind: SpecialDieKind; call: number | null };

export type DiceRoll = {
  /** Dé principal : le dé normal, ou le dé spécial qui l'a remplacé. */
  normal: number;
  special: SpecialDieKind | null;
  /** Dé Piégé tombé sur une face piégée : on n'avance pas. */
  trapped: boolean;
  bonus: number | null;
  /** Dé 1-6 en plus quand le dé normal et le dé bonus font le même chiffre. */
  extra: number | null;
  /** Dé 1-6 du Dé Turbo. */
  turbo: number | null;
  total: number;
};

export type RollOptions = {
  /** Faces du dé normal : 4 quand on a posé une Colle ce tour-ci. */
  normalFaces?: number;
  turbo?: boolean;
  /** Dé spécial joué à la place du dé normal (pas de double avec un dé spécial). */
  special?: SpecialDieUse | null;
};

export function rollDice(rng: Rng, bonusDie: BonusDie | null, options: RollOptions = {}): DiceRoll {
  const special = options.special ?? null;
  const main = special
    ? rollSpecial(rng, special)
    : { value: rng.int(1, options.normalFaces ?? 6), trapped: false };
  const bonus = bonusDie ? rng.int(1, bonusDie.faces) : null;
  const extra = special === null && bonus === main.value ? rng.int(1, 6) : null;
  const turbo = options.turbo ? rng.int(1, 6) : null;
  const total = main.trapped ? 0 : main.value + (bonus ?? 0) + (extra ?? 0) + (turbo ?? 0);
  return {
    normal: main.value,
    special: special?.kind ?? null,
    trapped: main.trapped,
    bonus,
    extra,
    turbo,
    total,
  };
}

function rollSpecial(rng: Rng, { kind, call }: SpecialDieUse): { value: number; trapped: boolean } {
  switch (kind) {
    case 'stable':
      return { value: rng.pick(STABLE_FACES), trapped: false };
    case 'allOrNothing':
      return { value: rng.pick(ALL_OR_NOTHING_FACES), trapped: false };
    case 'trapped': {
      const hit = rng.int(1, 6) <= TRAPPED_CALLED_FACES;
      return hit ? { value: call ?? 1, trapped: false } : { value: 0, trapped: true };
    }
  }
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
