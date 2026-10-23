import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { PAWN_SUMO, SUMO_RADIUS, SUMO_TIME_LIMIT, type SumoState, sumoRadius } from './pawnSumo';

const PLAYERS = ['a', 'b', 'c', 'd'];
const run = (state: SumoState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = PAWN_SUMO.step(current, inputs);
  return current;
};
const fighter = (state: SumoState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Combattant attendu : ${id}`);
  return found;
};

describe('pawn sumo', () => {
  test('starts everyone on a ring around the center, facing it', () => {
    const state = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    for (const { x, z } of state.fighters) {
      expect(Math.hypot(x, z)).toBeCloseTo(SUMO_RADIUS * 0.45);
    }
  });

  test('walks off the edge and falls, then the board shrinks to nothing', () => {
    const start = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    const out = { move: { x: 0, z: 1 }, primary: false, secondary: false };
    const walked = run(start, { a: out }, 60);
    expect(fighter(walked, 'a').fellAt).not.toBeNull();
    expect(fighter(walked, 'b').fellAt).toBeNull();
    // Personne ne bouge : le plateau finit par disparaître sous tout le monde.
    let state = start;
    while (!PAWN_SUMO.isOver(state)) state = PAWN_SUMO.step(state, {});
    expect(sumoRadius(state)).toBeLessThan(SUMO_RADIUS * 0.6);
    expect(state.tick * ARENA_STEP).toBeLessThan(SUMO_TIME_LIMIT);
  });

  test('a charge pushes the target back, a parried charge pushes the attacker back', () => {
    const duel = (parry: boolean) => {
      let state = PAWN_SUMO.create(['a', 'b'], { practice: false, seed: 1 });
      // a regarde b, à 2 m.
      state = {
        ...state,
        fighters: state.fighters.map((f) =>
          f.id === 'a' ? { ...f, x: 0, z: -1, facing: 0 } : { ...f, x: 0, z: 1, facing: Math.PI },
        ),
      };
      state = PAWN_SUMO.step(state, {
        a: { move: { x: 0, z: 1 }, primary: true, secondary: false },
        b: parry ? { ...IDLE_INPUT, secondary: true } : IDLE_INPUT,
      });
      return run(state, {}, 5);
    };
    const hit = duel(false);
    expect(fighter(hit, 'b').vz).toBeGreaterThan(3);
    expect(fighter(hit, 'a').vz).toBeLessThan(fighter(hit, 'b').vz);
    const parried = duel(true);
    expect(fighter(parried, 'a').vz).toBeLessThan(-3);
    expect(Math.abs(fighter(parried, 'b').vz)).toBeLessThan(1);
  });

  test('ranks the last one standing first, then the fallen from last to first', () => {
    const state = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    const ranked: SumoState = {
      ...state,
      fighters: state.fighters.map((f) => ({
        ...f,
        fellAt: { a: null, b: 30, c: 10, d: 30 }[f.id] ?? null,
      })),
    };
    expect(PAWN_SUMO.isOver(ranked)).toBe(true);
    expect(PAWN_SUMO.ranking(ranked)).toEqual([['a'], ['b', 'd'], ['c']]);
  });

  test('never ends the practice board, and brings back whoever falls', () => {
    const out = { move: { x: 0, z: 1 }, primary: false, secondary: false };
    const state = run(PAWN_SUMO.create(['a'], { practice: true, seed: 1 }), { a: out }, 30 * 90);
    expect(PAWN_SUMO.isOver(state)).toBe(false);
    expect(fighter(state, 'a').fellAt).toBeNull();
  });

  test('plays a whole match between bots, always with a winner', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = PAWN_SUMO.create(PLAYERS, { practice: false, seed });
      while (!PAWN_SUMO.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            PAWN_SUMO.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = PAWN_SUMO.step(state, inputs);
      }
      const ranking = PAWN_SUMO.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      // Le premier est seul : jamais de victoire au temps de sécurité.
      expect(state.tick * ARENA_STEP).toBeLessThan(SUMO_TIME_LIMIT);
      const winner = ranking[0]?.[0] ?? '';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    // Des bots qui jouent vraiment : la partie ne dure pas jusqu'à l'effondrement à chaque fois,
    // et l'Expert gagne plus souvent que le Facile.
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
