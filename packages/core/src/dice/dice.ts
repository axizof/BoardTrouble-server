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
  /** Chiffre annoncé avec le Dé Piégé : l'annonce est publique, réussie ou non. */
  call: number | null;
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
    call: special?.kind === 'trapped' ? special.call : null,
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

/** Un lancer de départage : les ex aequo qui se disputent la place `place` (0 : la première). */
export type TieBreak = {
  place: number;
  /** Deux dés chacun, dans l'ordre d'origine des joueurs. */
  rolls: { playerId: string; dice: [number, number] }[];
};

/** Les lancers loyaux ; encore à égalité après, le suivant est arrangé (sans que ça se voie). */
const FAIR_TIE_ROLLS = 3;

/**
 * Règle commune d'égalité : les ex aequo lancent deux dés chacun, le plus grand total prend la
 * place la plus haute. Ceux encore à égalité relancent entre eux, jusqu'à FAIR_TIE_ROLLS fois ;
 * au-delà, le lancer suivant est arrangé : un ordre tiré au hasard, et des dés qui lui
 * correspondent (aucune égalité possible). Chaque groupe ne se départage qu'entre ses places.
 * `groups` va du meilleur au moins bon, chaque groupe contient des ex aequo. Les lancers sont
 * dans l'ordre où les montrer.
 */
export function breakTies(
  groups: readonly (readonly string[])[],
  rng: Rng,
): { order: string[]; tieBreaks: TieBreak[] } {
  const order: string[] = [];
  const tieBreaks: TieBreak[] = [];
  const settle = (players: readonly string[], place: number, attempt: number) => {
    if (players.length === 1) {
      order.push(...players);
      return;
    }
    const rolls = attempt > FAIR_TIE_ROLLS ? arrangedRolls(players, rng) : fairRolls(players, rng);
    tieBreaks.push({ place, rolls });
    const byTotal = new Map<number, string[]>();
    for (const { playerId, dice } of rolls) {
      const total = dice[0] + dice[1];
      byTotal.set(total, [...(byTotal.get(total) ?? []), playerId]);
    }
    let next = place;
    for (const total of [...byTotal.keys()].sort((a, b) => b - a)) {
      const tied = byTotal.get(total) ?? [];
      settle(tied, next, attempt + 1);
      next += tied.length;
    }
  };
  let place = 0;
  for (const group of groups) {
    settle(group, place, 1);
    place += group.length;
  }
  return { order, tieBreaks };
}

function fairRolls(players: readonly string[], rng: Rng): TieBreak['rolls'] {
  return players.map((playerId) => ({ playerId, dice: [rng.int(1, 6), rng.int(1, 6)] }));
}

/** Un ordre au hasard, puis des totaux tous différents, du plus grand au plus petit. */
function arrangedRolls(players: readonly string[], rng: Rng): TieBreak['rolls'] {
  const ranked = rng.shuffle([...players]);
  const totals = rng
    .shuffle([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    .slice(0, players.length)
    .sort((a, b) => b - a);
  const diceOf = new Map(
    ranked.map((playerId, index) => {
      const total = totals[index] ?? 2;
      const first = rng.int(Math.max(1, total - 6), Math.min(6, total - 1));
      return [playerId, [first, total - first] as [number, number]];
    }),
  );
  return players.map((playerId) => ({ playerId, dice: diceOf.get(playerId) ?? [1, 1] }));
}
