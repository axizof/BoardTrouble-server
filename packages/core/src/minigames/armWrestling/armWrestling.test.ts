import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  ARM_WRESTLING,
  clashAt,
  WRESTLE_READY,
  WRESTLE_TIME,
  WRESTLE_ZONES,
  type WrestleState,
  wrestleNeedle,
  wrestleScore,
} from './armWrestling';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const side = (x: number): ArenaInput => ({ ...IDLE_INPUT, move: { x, z: 0 } });

/** Un duel prêt à forcer (la mise en place passée). */
function started(): WrestleState {
  let state = ARM_WRESTLING.create(['a', 'b'], { practice: false, seed: 1 });
  for (let k = 0; k < steps(WRESTLE_READY) + 1; k++) state = ARM_WRESTLING.step(state, {});
  expect(state.phase).toBe('force');
  return state;
}

/** `a` alterne gauche et droite tous les `every` pas ; `b` tient un côté (ça ne compte pas). */
function wrestle(state: WrestleState, seconds: number, every: number): WrestleState {
  let current = state;
  for (let k = 0; k < steps(seconds) && current.phase === 'force'; k++) {
    const beat = Math.floor(k / every) % 2 === 0 ? -1 : 1;
    current = ARM_WRESTLING.step(current, { a: side(beat), b: side(1) });
  }
  return current;
}

describe('Bras de fer', () => {
  test('only alternating counts: the arm leans toward the one who alternates', () => {
    const state = wrestle(started(), 3, 4);
    expect(state.fighters[0]?.taps).toBeGreaterThan(15);
    expect(state.fighters[1]?.taps).toBeLessThanOrEqual(1);
    expect(state.arm).toBeGreaterThan(0.1);
  });

  test('a decisive clash stops the force; a perfect press pushes hard, a miss pushes for the other', () => {
    let state = started();
    state = { ...state, forceTime: clashAt(state, 0) - ARENA_STEP };
    state = ARM_WRESTLING.step(state, {});
    expect(state.phase).toBe('clash');
    const clash = state.clash;
    if (!clash) throw new Error('no clash');
    const before = state.arm;
    while (state.phase === 'clash') {
      const needle = wrestleNeedle(clash, state.tick + 1);
      const isOnZone = Math.abs(needle - clash.zone) < 0.01;
      state = ARM_WRESTLING.step(state, { a: { ...IDLE_INPUT, primary: isOnZone } });
    }
    expect(state.clash?.scores).toEqual({ a: 3, b: 0 });
    expect(state.arm - before).toBeCloseTo(0.3 + 0.15, 5);
    expect(state.phase).toBe('result');
  });

  test('presses are graded by how close they land to the zone', () => {
    expect(wrestleScore(0.5, 0.5)).toBe(3);
    expect(wrestleScore(0.5, 0.5 + WRESTLE_ZONES[1] - 0.001)).toBe(2);
    expect(wrestleScore(0.5, 0.5 + WRESTLE_ZONES[2] - 0.001)).toBe(1);
    expect(wrestleScore(0.5, 0.9)).toBe(0);
    expect(wrestleScore(0.5, undefined)).toBe(0);
  });

  test('pinning the arm wins at once; at the end of time, the one who leads wins', () => {
    let pinned = { ...started(), arm: 0.999 };
    pinned = wrestle(pinned, 0.5, 2);
    expect(ARM_WRESTLING.isOver(pinned)).toBe(true);
    expect(ARM_WRESTLING.ranking(pinned)).toEqual([['a'], ['b']]);
    let timed = { ...started(), arm: -0.2, forceTime: WRESTLE_TIME - ARENA_STEP, clashes: 3 };
    timed = ARM_WRESTLING.step(timed, {});
    expect(ARM_WRESTLING.isOver(timed)).toBe(true);
    expect(timed.winner).toBe('b');
  });

  test('between bots, the duel ends with a winner', () => {
    for (const seed of [1, 2, 3]) {
      let state = ARM_WRESTLING.create(['a', 'b'], { practice: false, seed });
      const rng = new Rng(seed);
      while (!ARM_WRESTLING.isOver(state)) {
        const current = state;
        state = ARM_WRESTLING.step(current, {
          a: ARM_WRESTLING.botInput(current, 'a', 'expert', rng),
          b: ARM_WRESTLING.botInput(current, 'b', 'easy', rng),
        });
      }
      expect(state.clashes).toBeGreaterThan(0);
      expect(ARM_WRESTLING.ranking(state)).toHaveLength(state.winner ? 2 : 1);
    }
  });

  test('in the sandbox, the dummy wrestles back and the bout starts over', () => {
    let state = ARM_WRESTLING.create(['you', 'mannequin'], { practice: true, seed: 1 });
    for (let k = 0; k < steps(60); k++) state = ARM_WRESTLING.step(state, {});
    expect(ARM_WRESTLING.isOver(state)).toBe(false);
    expect(state.fighters[1]?.taps).toBeGreaterThan(50);
  });
});
