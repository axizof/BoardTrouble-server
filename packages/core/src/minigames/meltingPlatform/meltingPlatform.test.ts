import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput } from '../arena/arena';
import {
  CRACK_TIME,
  HURRY_AT,
  isFallen,
  LEVEL_HEIGHT,
  levelHeight,
  MELT_LEVELS,
  MELT_TIME_LIMIT,
  MELTING_PLATFORM,
  type MeltState,
  tileAt,
  tileCenter,
} from './meltingPlatform';

const PLAYERS = ['a', 'b', 'c', 'd'];
const run = (state: MeltState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = MELTING_PLATFORM.step(current, inputs);
  return current;
};
const fighter = (state: MeltState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};
const tile = (state: MeltState, level: number, q: number, r: number) => {
  const found = state.levels[level]?.find((candidate) => candidate.q === q && candidate.r === r);
  if (!found) throw new Error(`Tuile attendue : ${q},${r}`);
  return found;
};
/** Un seul joueur, posé au centre du niveau du haut. */
const alone = (practice = false) => {
  const state = MELTING_PLATFORM.create(['a'], { practice, seed: 1 });
  return {
    ...state,
    fighters: state.fighters.map((f) => ({ ...f, x: 0, z: 0, y: levelHeight(0) })),
  };
};
const crackSteps = Math.ceil(CRACK_TIME / ARENA_STEP);

describe('melting platform', () => {
  test('finds the tile under any point of the plane', () => {
    for (const [q, r] of [
      [0, 0],
      [2, -1],
      [-3, 1],
    ] as const) {
      const { x, z } = tileCenter(q, r);
      expect(tileAt(x + 0.3, z - 0.2)).toEqual({ q, r });
    }
  });

  test('standing on a tile cracks it; it falls a second later, and so does the player', () => {
    let state = run(alone(), {}, 1);
    expect(tile(state, 0, 0, 0).crackedAt).not.toBeNull();
    state = run(state, {}, crackSteps - 2);
    expect(fighter(state, 'a').y).toBe(levelHeight(0));
    expect(isFallen(tile(state, 0, 0, 0), state.tick)).toBe(false);
    // La tuile tombe : il tombe jusqu'au niveau du dessous, et s'y pose.
    state = run(state, {}, 40);
    expect(fighter(state, 'a').y).toBe(levelHeight(1));
    expect(fighter(state, 'a').onGround).toBe(true);
  });

  test('falling at the edge of a hole, one catches the intact tile next to it', () => {
    // Juste sous le dessus du niveau, en train de tomber, au-dessus d'une tuile intacte.
    const falling: MeltState = {
      ...alone(),
      fighters: alone().fighters.map((f) => ({
        ...f,
        y: levelHeight(0) - 0.2,
        vy: -2,
        onGround: false,
      })),
    };
    const state = MELTING_PLATFORM.step(falling, {});
    expect(fighter(state, 'a').y).toBe(levelHeight(0));
    expect(fighter(state, 'a').onGround).toBe(true);
  });

  test('a short jump clears a fallen tile', () => {
    let state = alone();
    // Les tuiles entre le joueur et sa destination sont déjà tombées.
    state = {
      ...state,
      levels: state.levels.map((tiles, level) =>
        tiles.map((t) => (level === 0 && t.r === 0 && t.q === 1 ? { ...t, crackedAt: -1000 } : t)),
      ),
    };
    const right = { move: { x: 1, z: 0 }, primary: false, secondary: false };
    state = run(state, { a: right }, 5);
    state = run(state, { a: { ...right, primary: true } }, 1);
    state = run(state, { a: right }, 25);
    expect(fighter(state, 'a').x).toBeGreaterThan(tileCenter(2, 0).x - 1);
    expect(fighter(state, 'a').y).toBe(levelHeight(0));
  });

  test('falling from the bottom level is out; the last one standing ranks first', () => {
    const state = MELTING_PLATFORM.create(PLAYERS, { practice: false, seed: 1 });
    const ranked: MeltState = {
      ...state,
      fighters: state.fighters.map((f) => ({
        ...f,
        fellAt: { a: null, b: 30, c: 10, d: 30 }[f.id] ?? null,
      })),
    };
    expect(MELTING_PLATFORM.isOver(ranked)).toBe(true);
    expect(MELTING_PLATFORM.ranking(ranked)).toEqual([['a'], ['b', 'd'], ['c']]);
    // Personne ne bouge : chacun finit par passer à travers les trois niveaux.
    let still = state;
    while (!MELTING_PLATFORM.isOver(still)) still = MELTING_PLATFORM.step(still, {});
    expect(still.fighters.every((f) => f.fellAt !== null)).toBe(true);
  });

  test('when the clock runs out, the higher level ranks first, ties for the dice', () => {
    const state = MELTING_PLATFORM.create(PLAYERS, { practice: false, seed: 1 });
    const late: MeltState = {
      ...state,
      tick: Math.ceil(MELT_TIME_LIMIT / ARENA_STEP),
      fighters: state.fighters.map((f) => ({
        ...f,
        y:
          { a: levelHeight(1), b: levelHeight(1), c: levelHeight(0), d: levelHeight(2) }[f.id] ?? 0,
      })),
    };
    expect(MELTING_PLATFORM.timeLeft(late)).toBe(0);
    expect(MELTING_PLATFORM.isOver(late)).toBe(true);
    expect(MELTING_PLATFORM.ranking(late)).toEqual([['c'], ['a', 'b'], ['d']]);
  });

  test('tiles crack faster near the end, to make sure the game ends', () => {
    const state = alone();
    const lateTile = { q: 0, r: 0, crackedAt: Math.ceil(HURRY_AT / ARENA_STEP) };
    expect(isFallen(lateTile, lateTile.crackedAt + Math.ceil(crackSteps / 2) + 1)).toBe(true);
    expect(isFallen({ ...lateTile, crackedAt: 0 }, Math.ceil(crackSteps / 2) + 1)).toBe(false);
    expect(state.levels).toHaveLength(MELT_LEVELS);
  });

  test('the practice board grows back and brings back whoever falls', () => {
    const state = run(alone(true), {}, 30 * 20);
    expect(MELTING_PLATFORM.isOver(state)).toBe(false);
    expect(fighter(state, 'a').fellAt).toBeNull();
    expect(fighter(state, 'a').y).toBeGreaterThan(-LEVEL_HEIGHT);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = MELTING_PLATFORM.create(PLAYERS, { practice: false, seed });
      while (!MELTING_PLATFORM.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            MELTING_PLATFORM.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = MELTING_PLATFORM.step(state, inputs);
      }
      const ranking = MELTING_PLATFORM.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      const winner = ranking[0]?.length === 1 ? (ranking[0][0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
