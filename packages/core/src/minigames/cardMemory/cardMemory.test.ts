import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT, sanitizeInput } from '../arena/arena';
import {
  CARD_MEMORY,
  HIDDEN_FACE,
  MEMORY_COLUMNS,
  MEMORY_PAIRS,
  MEMORY_TIME_LIMIT,
  type MemoryState,
  MISMATCH_SHOWN,
  MISTAKE_LOCK,
} from './cardMemory';

const board = (state: MemoryState, id = 'a') => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};
const aim = (target: number): ArenaInput => ({ ...IDLE_INPUT, target });
/** `a` vise ces cartes, une par pas. */
const flipAll = (state: MemoryState, cards: number[]) =>
  cards.reduce((current, card) => CARD_MEMORY.step(current, { a: aim(card) }), state);
/** Deux cartes de `a` qui vont ensemble, et une qui ne va pas avec la première. */
function cardsOf(state: MemoryState) {
  const { faces } = board(state);
  const first = 0;
  const twin = faces.findIndex((face, card) => card !== first && face === faces[first]);
  const other = faces.findIndex((face) => face !== faces[first]);
  return { first, twin, other };
}

describe('card memory', () => {
  test('everyone has the same pairs, laid out differently', () => {
    const state = CARD_MEMORY.create(['a', 'b'], { practice: false, seed: 1 });
    const sorted = (faces: number[]) => [...faces].sort((x, y) => x - y);
    expect(sorted(board(state, 'a').faces)).toEqual(sorted(board(state, 'b').faces));
    expect(board(state, 'a').faces).not.toEqual(board(state, 'b').faces);
    expect(board(state).faces).toHaveLength(MEMORY_PAIRS * 2);
  });

  test('a pair stays face up; two different cards hide again after a moment', () => {
    const state = CARD_MEMORY.create(['a'], { practice: false, seed: 1 });
    const { first, twin, other } = cardsOf(state);
    const paired = flipAll(state, [first, twin]);
    expect(board(paired).pairs).toBe(1);
    expect(board(paired).matched[first]).toBe(true);
    const missed = flipAll(state, [first, other]);
    expect(board(missed).up).toEqual([first, other]);
    let later = missed;
    for (let i = 0; i < Math.round(MISMATCH_SHOWN / ARENA_STEP); i++) {
      later = CARD_MEMORY.step(later, {});
    }
    expect(board(later).up).toEqual([]);
    expect(board(later).pairs).toBe(0);
  });

  test('after a mistake, no card can be flipped for two seconds', () => {
    const state = CARD_MEMORY.create(['a'], { practice: false, seed: 1 });
    const { first, twin, other } = cardsOf(state);
    const missed = flipAll(state, [first, other]);
    const lock = Math.round(MISTAKE_LOCK / ARENA_STEP);
    expect(board(missed).lockedUntil).toBe(missed.tick + lock);
    // Pendant le blocage, viser une carte ne fait rien ; après, si.
    let later = missed;
    for (let i = 0; i < lock - 2; i++) later = CARD_MEMORY.step(later, {});
    expect(board(flipAll(later, [twin])).up).toEqual([]);
    for (let i = 0; i < 3; i++) later = CARD_MEMORY.step(later, {});
    expect(board(flipAll(later, [twin])).up).toEqual([twin]);
  });

  test('the cursor moves one card per press, and the main button flips the card under it', () => {
    let state = CARD_MEMORY.create(['a'], { practice: false, seed: 1 });
    const right = { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    const down = { ...IDLE_INPUT, move: { x: 0, z: 1 } };
    // Tenu, le stick ne fait avancer que d'une case ; relâché puis repoussé, d'une autre.
    state = [right, right, IDLE_INPUT, right, down].reduce(
      (current, input) => CARD_MEMORY.step(current, { a: input }),
      state,
    );
    expect(board(state).cursor).toBe(MEMORY_COLUMNS + 2);
    state = CARD_MEMORY.step(state, { a: { ...IDLE_INPUT, primary: true } });
    expect(board(state).up).toEqual([MEMORY_COLUMNS + 2]);
  });

  test('a player only sees the faces of his own flipped cards and of the pairs found', () => {
    const state = CARD_MEMORY.create(['a', 'b'], { practice: false, seed: 1 });
    const { first, twin, other } = cardsOf(state);
    const played = flipAll(flipAll(state, [first, twin]), [other]);
    const mine = CARD_MEMORY.viewFor?.(played, { type: 'player', playerId: 'a' });
    const theirs = CARD_MEMORY.viewFor?.(played, { type: 'player', playerId: 'b' });
    const watcher = CARD_MEMORY.viewFor?.(played, { type: 'spectator' });
    if (!mine || !theirs || !watcher) throw new Error('Vue attendue');
    const shown = (view: MemoryState) => board(view).faces.filter((face) => face !== HIDDEN_FACE);
    // La paire et la carte retournée, pour lui ; la paire seulement, pour les autres.
    expect(shown(mine)).toHaveLength(3);
    expect(shown(theirs)).toHaveLength(2);
    expect(shown(watcher)).toHaveLength(2);
    expect(board(theirs).up).toEqual([]);
    // Ni la graine : elle dirait où sont toutes les cartes.
    expect(mine.seed).toBe(0);
  });

  test('the first to find everything wins; then the most pairs, ties for the dice', () => {
    let state = CARD_MEMORY.create(['a', 'b'], { practice: false, seed: 1 });
    const { faces } = board(state);
    const order = faces
      .map((face, card) => ({ face, card }))
      .sort((x, y) => x.face - y.face)
      .map(({ card }) => card);
    state = flipAll(state, order);
    expect(board(state).finishedAt).not.toBeNull();
    expect(CARD_MEMORY.isOver(state)).toBe(false);
    expect(CARD_MEMORY.ranking(state)).toEqual([['a'], ['b']]);
    // Deux grilles inachevées au même nombre de paires : ex aequo, quelle que soit l'heure.
    const unfinished = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, pairs: 4, finishedAt: null })),
    };
    expect(CARD_MEMORY.ranking(unfinished)).toEqual([['a', 'b']]);
    while (!CARD_MEMORY.isOver(state)) state = CARD_MEMORY.step(state, {});
    expect(state.tick * ARENA_STEP).toBeCloseTo(MEMORY_TIME_LIMIT, 1);
  });

  test('an aimed card is only trusted within bounds', () => {
    expect(sanitizeInput({ target: 3 }).target).toBe(3);
    expect(sanitizeInput({ target: -2 }).target).toBeNull();
    expect(sanitizeInput({ target: 2.5 }).target).toBeNull();
    expect(sanitizeInput({ target: 'x' }).target).toBeNull();
    // Une visée au-delà de la grille ne retourne rien.
    const state = CARD_MEMORY.create(['a'], { practice: false, seed: 1 });
    expect(board(CARD_MEMORY.step(state, { a: aim(200) })).up).toEqual([]);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const players = ['a', 'b', 'c', 'd'];
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = CARD_MEMORY.create(players, { practice: false, seed });
      while (!CARD_MEMORY.isOver(state)) {
        const inputs = Object.fromEntries(
          players.map((id, index) => [
            id,
            CARD_MEMORY.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = CARD_MEMORY.step(state, inputs);
      }
      const ranking = CARD_MEMORY.ranking(state);
      expect(ranking.flat().sort()).toEqual([...players].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
