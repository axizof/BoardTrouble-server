import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  PAWN_SUMO,
  STRIKE_COOLDOWN,
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

/** a et b face à face, à `gap` mètres : a regarde b, b regarde dans la direction `bFacing`. */
const facingOff = (gap = 1, aFacing = 0) => {
  const state = PAWN_SUMO.create(['a', 'b'], { practice: false, seed: 1 });
  return {
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === 'a'
        ? { ...f, x: 0, z: -gap / 2, facing: aFacing }
        : { ...f, x: 0, z: gap / 2, facing: Math.PI },
    ),
  };
};
const punch = { ...IDLE_INPUT, primary: true };
const parry = { ...IDLE_INPUT, secondary: true };

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

  test('a punch knocks the target down and away; it gets up after a while', () => {
    const hit = run(PAWN_SUMO.step(facingOff(), { a: punch }), {}, 8);
    expect(fighter(hit, 'b').downed).toBeGreaterThan(0);
    expect(fighter(hit, 'b').z).toBeGreaterThan(1);
    expect(fighter(hit, 'a').downed).toBe(0);
    const later = run(hit, {}, 45);
    expect(fighter(later, 'b').downed).toBe(0);
  });

  test('misses someone out of reach or behind', () => {
    const far = run(PAWN_SUMO.step(facingOff(2.5), { a: punch }), {}, 10);
    expect(fighter(far, 'b').downed).toBe(0);
    const behind = run(PAWN_SUMO.step(facingOff(1, Math.PI), { a: punch }), {}, 10);
    expect(fighter(behind, 'b').downed).toBe(0);
  });

  test('the first to hit wins: a punch still winding up is cut short', () => {
    let state = run(PAWN_SUMO.step(facingOff(), { a: punch }), { a: punch }, 2);
    state = run(PAWN_SUMO.step(state, { b: punch }), {}, 10);
    expect(fighter(state, 'b').downed).toBeGreaterThan(0);
    expect(fighter(state, 'a').downed).toBe(0);
  });

  test('knocked down, a player can neither move nor punch back right away', () => {
    let state = run(PAWN_SUMO.step(facingOff(), { a: punch }), {}, 6);
    const z = fighter(state, 'b').z;
    state = run(state, { b: { move: { x: 0, z: -1 }, primary: true, secondary: false } }, 10);
    expect(fighter(state, 'b').z).toBeGreaterThan(z);
    expect(fighter(state, 'b').winding + fighter(state, 'b').striking).toBe(0);
  });

  test('a parried punch staggers the attacker, and the defender can counter at once', () => {
    let state = run(PAWN_SUMO.step(facingOff(), { a: punch, b: parry }), {}, 6);
    expect(fighter(state, 'a').stunned).toBeGreaterThan(0);
    expect(fighter(state, 'a').downed).toBe(0);
    expect(fighter(state, 'b').downed).toBe(0);
    expect(fighter(state, 'b').strikeReady).toBe(0);
    // b contre-attaque : a titube encore, il ne peut ni parer ni frapper.
    state = run(PAWN_SUMO.step(state, { b: punch, a: parry }), {}, 8);
    expect(fighter(state, 'a').downed).toBeGreaterThan(0);
  });

  test('cannot punch again before the cooldown', () => {
    let state = run(PAWN_SUMO.step(facingOff(4), { a: punch }), {}, 8);
    state = PAWN_SUMO.step(state, { a: punch });
    expect(fighter(state, 'a').winding).toBe(0);
    state = run(state, {}, Math.ceil(STRIKE_COOLDOWN / ARENA_STEP));
    expect(fighter(PAWN_SUMO.step(state, { a: punch }), 'a').winding).toBeGreaterThan(0);
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
