// Plateaux et aides pour les tests uniquement.
import type { BoardDefinition, Space, SpaceKind } from '../board/board';
import { Rng } from '../random/rng';

/** start -> s1 ... sN -> goal (porte finale). */
export function linearBoard(kinds: SpaceKind[], finalThreshold = 6): BoardDefinition {
  const ids = ['start', ...kinds.map((_, index) => `s${index + 1}`), 'goal'];
  const spaces: Record<string, Space> = {};
  ids.forEach((id, index) => {
    const kind: SpaceKind =
      index === 0
        ? { type: 'start' }
        : index === ids.length - 1
          ? { type: 'finalGate', threshold: finalThreshold }
          : (kinds[index - 1] ?? { type: 'empty' });
    const next = ids[index + 1];
    spaces[id] = { id, kind, floor: 0, next: next ? [next] : [] };
  });
  return { id: 'linear', name: 'Ligne de test', start: 'start', spaces };
}

export function emptySpaces(count: number): SpaceKind[] {
  return Array.from({ length: count }, () => ({ type: 'empty' }));
}

/**
 * start -> fork -> (a1 -> merge) ou (b1 -> b2 -> merge) -> merge -> m1 ... m10 -> goal.
 * La voie "a" est la voie principale (premier `next` de fork).
 */
export function forkBoard(mergeKind: SpaceKind = { type: 'empty' }): BoardDefinition {
  const space = (id: string, kind: SpaceKind, next: string[]): Space => ({
    id,
    kind,
    floor: 0,
    next,
  });
  const tail = Array.from({ length: 10 }, (_, index) => `m${index + 1}`);
  const spaces: Space[] = [
    space('start', { type: 'start' }, ['fork']),
    space('fork', { type: 'empty' }, ['a1', 'b1']),
    space('a1', { type: 'empty' }, ['merge']),
    space('b1', { type: 'empty' }, ['b2']),
    space('b2', { type: 'empty' }, ['merge']),
    space('merge', mergeKind, ['m1']),
    ...tail.map((id, index) => space(id, { type: 'empty' }, [tail[index + 1] ?? 'goal'])),
    space('goal', { type: 'finalGate', threshold: 6 }, []),
  ];
  return {
    id: 'fork',
    name: 'Embranchement de test',
    start: 'start',
    spaces: Object.fromEntries(spaces.map((item) => [item.id, item])),
  };
}

/** Un état de générateur dont les prochains `rng.int(1, 6)` donneront `values`. */
export function rngStateRolling(...values: number[]): number {
  for (let seed = 0; seed < 5_000_000; seed++) {
    const rng = new Rng(seed);
    if (values.every((value) => rng.int(1, 6) === value)) return seed;
  }
  throw new Error(`Aucune graine ne donne ${values.join(', ')}`);
}

export const FOUR_PLAYERS = [
  { id: 'ana', name: 'Ana' },
  { id: 'bob', name: 'Bob' },
  { id: 'cam', name: 'Cam' },
  { id: 'dan', name: 'Dan' },
];
