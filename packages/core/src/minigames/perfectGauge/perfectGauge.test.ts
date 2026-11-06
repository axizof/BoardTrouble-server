import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  GAUGE_LOCKS,
  type GaugeState,
  LOCK_TIME,
  PERFECT_GAUGE,
  ZONE_HALVES,
} from './perfectGauge';

const press: ArenaInput = { ...IDLE_INPUT, primary: true };
const start = (practice = false) => PERFECT_GAUGE.create(['p'], { practice, seed: 1 });
/** Avance jusqu'à ce que l'aiguille du verrou en cours soit (ou ne soit pas) dans sa zone. */
function until(state: GaugeState, inside: boolean): GaugeState {
  let current = PERFECT_GAUGE.step(state, {});
  for (let i = 0; i < 500; i++) {
    const lock = current.locks[current.current];
    const next = PERFECT_GAUGE.step(current, {});
    const gap = Math.abs(next.needle.position - (lock?.center ?? 0));
    const isInside = gap <= (lock?.half ?? 0) * 0.5;
    const isOut = gap > (lock?.half ?? 0) * 1.5;
    if (next.tick >= next.lockStartAt && (inside ? isInside : isOut)) return current;
    current = next;
  }
  throw new Error('Aiguille jamais au bon endroit');
}

describe('the perfect gauge', () => {
  test('three locks, each green zone narrower than the one before', () => {
    const state = start();
    expect(state.locks).toHaveLength(GAUGE_LOCKS);
    expect(ZONE_HALVES[2]).toBeLessThan(ZONE_HALVES[0]);
  });

  test('the needle keeps changing pace, and bounces at the ends of the dial', () => {
    let state = start();
    const speeds = new Set<number>();
    for (let i = 0; i < 90; i++) {
      state = PERFECT_GAUGE.step(state, {});
      speeds.add(Math.round(state.needle.speed * 100));
      expect(state.needle.position).toBeGreaterThanOrEqual(0);
      expect(state.needle.position).toBeLessThanOrEqual(1);
    }
    expect(speeds.size).toBeGreaterThan(3);
  });

  test('stopping each needle in its zone opens the three locks: the gate opens', () => {
    let state = start();
    for (let lock = 0; lock < GAUGE_LOCKS; lock++) {
      state = PERFECT_GAUGE.step(until(state, true), { p: press });
      expect(state.locks[lock]?.openedAt).not.toBeNull();
    }
    while (!PERFECT_GAUGE.isOver(state)) state = PERFECT_GAUGE.step(state, {});
    expect(PERFECT_GAUGE.succeeded?.(state)).toBe(true);
  });

  test('a press outside the zone keeps the gate shut', () => {
    const state = PERFECT_GAUGE.step(until(start(), false), { p: press });
    expect(state.failure).toBe('missed');
    expect(PERFECT_GAUGE.succeeded?.(state)).toBe(false);
  });

  test('waiting too long on a lock keeps it shut too', () => {
    let state = start();
    for (let i = 0; i < Math.ceil(LOCK_TIME / ARENA_STEP) + 30; i++)
      state = PERFECT_GAUGE.step(state, {});
    expect(state.failure).toBe('slow');
  });

  test('at practice, a new try starts once the last one is shown', () => {
    let state = PERFECT_GAUGE.step(until(start(true), false), { p: press });
    for (let i = 0; i < 90; i++) state = PERFECT_GAUGE.step(state, {});
    expect(state.attempt).toBe(1);
    expect(state.failure).toBeNull();
    expect(PERFECT_GAUGE.isOver(state)).toBe(false);
  });

  test('bots open the gate more often the better they are', () => {
    const opened = (level: 'easy' | 'expert') => {
      let count = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const rng = new Rng(seed);
        let state = PERFECT_GAUGE.create(['p'], { practice: false, seed });
        while (!PERFECT_GAUGE.isOver(state)) {
          state = PERFECT_GAUGE.step(state, { p: PERFECT_GAUGE.botInput(state, 'p', level, rng) });
        }
        if (PERFECT_GAUGE.succeeded?.(state)) count += 1;
      }
      return count;
    };
    expect(opened('expert')).toBeGreaterThan(opened('easy'));
  });
});
