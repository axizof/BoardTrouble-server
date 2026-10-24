import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  DASH_COOLDOWN,
  PAWN_SUMO,
  SUMO_RADIUS,
  SUMO_TIME_LIMIT,
  type SumoState,
  sumoRadius,
} from './pawnSumo';

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

/** a regarde b, à `gap` mètres ; b regarde a. Plateau d'entraînement : personne ne tombe. */
const facingOff = (gap = 2) => {
  const state = PAWN_SUMO.create(['a', 'b'], { practice: true, seed: 1 });
  return {
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === 'a'
        ? { ...f, x: 0, z: -gap / 2, facing: 0 }
        : { ...f, x: 0, z: gap / 2, facing: Math.PI },
    ),
  };
};
const dash = { ...IDLE_INPUT, primary: true };

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

  test('a dash shoves the one it hits far away; the dasher nearly stops', () => {
    const hit = run(PAWN_SUMO.step(facingOff(), { a: dash }), {}, 40);
    // b glisse sur environ 3 m ; a s'arrête peu après le choc.
    expect(fighter(hit, 'b').z).toBeGreaterThan(3);
    expect(fighter(hit, 'a').z).toBeLessThan(1);
  });

  test('dashing into nobody carries the dasher a few meters, toward where they go', () => {
    const state = PAWN_SUMO.create(['a'], { practice: true, seed: 1 });
    const alone = run(PAWN_SUMO.step(state, { a: { ...dash, move: { x: 1, z: 0 } } }), {}, 30);
    expect(fighter(alone, 'a').x).toBeGreaterThan(2.5);
    expect(fighter(alone, 'a').x).toBeLessThan(5);
  });

  test('two dashes head on bounce both back', () => {
    const state = run(PAWN_SUMO.step(facingOff(3), { a: dash, b: dash }), {}, 30);
    expect(fighter(state, 'a').z).toBeLessThan(-1.5);
    expect(fighter(state, 'b').z).toBeGreaterThan(1.5);
  });

  test('cannot dash again before the cooldown, nor while shoved', () => {
    let state = run(PAWN_SUMO.step(facingOff(8), { a: dash }), {}, 10);
    state = PAWN_SUMO.step(state, { a: dash });
    expect(fighter(state, 'a').dashing).toBe(0);
    state = run(state, {}, Math.ceil(DASH_COOLDOWN / ARENA_STEP));
    expect(fighter(PAWN_SUMO.step(state, { a: dash }), 'a').dashing).toBeGreaterThan(0);
    // b, bousculé, ne peut pas foncer tout de suite.
    const shoved = run(PAWN_SUMO.step(facingOff(), { a: dash }), {}, 3);
    expect(fighter(PAWN_SUMO.step(shoved, { b: dash }), 'b').dashing).toBe(0);
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
