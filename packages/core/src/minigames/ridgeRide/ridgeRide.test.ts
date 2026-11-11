import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { COURSE_SAMPLE, courseOf, sampleAt } from './course';
import { isInverted, RIDE_TIME_LIMIT, RIDGE_RIDE, type RidgeState } from './ridgeRide';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const hold = (move: { x: number; z: number }, primary = false): ArenaInput => ({
  ...IDLE_INPUT,
  move,
  primary,
});

function run(
  state: RidgeState,
  until: (s: RidgeState) => boolean,
  inputs: (s: RidgeState) => Partial<Record<PlayerId, ArenaInput>> = () => ({}),
): RidgeState {
  let current = state;
  while (!until(current)) {
    current = RIDGE_RIDE.step(current, inputs(current));
    if (current.tick > steps(200)) throw new Error('course sans fin');
  }
  return current;
}

/** Des bots pour tout le monde (pour amener un joueur quelque part sans tomber). */
function bots(levels: Record<PlayerId, BotLevel>, seed: number) {
  const rng = new Rng(seed);
  return (state: RidgeState) =>
    Object.fromEntries(
      Object.entries(levels).map(([id, level]) => [id, RIDGE_RIDE.botInput(state, id, level, rng)]),
    );
}

describe('the ridge of Sur le fil', () => {
  test('always heads down the canyon, never back over itself, the same for a seed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const course = courseOf(seed);
      for (const [index, point] of course.samples.entries()) {
        expect(Math.abs(point.heading)).toBeLessThanOrEqual((70 * Math.PI) / 180 + 1e-9);
        const before = course.samples[index - 1];
        if (before) expect(point.z).toBeLessThan(before.z);
        expect(point.width).toBeGreaterThan(1.4);
      }
      expect(course.finish).toBeGreaterThan(250);
      expect(courseOf(seed)).toBe(course);
    }
    expect(courseOf(1).samples.at(-1)?.x).not.toBe(courseOf(2).samples.at(-1)?.x);
  });

  test('the portal is halfway, on a straight line', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const course = courseOf(seed);
      expect(course.portal / course.finish).toBeGreaterThan(0.4);
      expect(course.portal / course.finish).toBeLessThan(0.65);
      for (let d = -5; d <= 5; d += COURSE_SAMPLE) {
        expect(sampleAt(course, course.portal + d).curvature).toBe(0);
      }
    }
  });
});

describe('Sur le fil', () => {
  test('pedalling speeds up, braking slows down, and the slope alone keeps the bike rolling', () => {
    const start = RIDGE_RIDE.create(['a'], { practice: false, seed: 3 });
    const coasting = run(start, (s) => s.tick >= steps(2));
    expect(coasting.fighters[0]?.speed).toBeGreaterThan(0.5);
    const pedalled = run(
      start,
      (s) => s.tick >= steps(2),
      () => ({ a: hold({ x: 0, z: -1 }) }),
    );
    expect(pedalled.fighters[0]?.speed).toBeGreaterThan((coasting.fighters[0]?.speed ?? 0) + 5);
    const braked = RIDGE_RIDE.step(RIDGE_RIDE.step(pedalled, { a: hold({ x: 0, z: 1 }) }), {
      a: hold({ x: 0, z: 1 }),
    });
    expect(braked.fighters[0]?.speed).toBeLessThan(pedalled.fighters[0]?.speed ?? 0);
  });

  test('the faster it goes, the wider it turns', () => {
    const turn = (pedal: boolean) => {
      let state = RIDGE_RIDE.create(['a'], { practice: true, seed: 3 });
      state = run(
        state,
        (s) => s.tick >= steps(1.5),
        () => ({ a: hold({ x: 0, z: pedal ? -1 : 0 }) }),
      );
      const before = state.fighters[0]?.heading ?? 0;
      const after = RIDGE_RIDE.step(
        run(
          state,
          (s) => s.tick >= steps(1.8),
          () => ({ a: hold({ x: 1, z: 0 }) }),
        ),
        {},
      );
      return (after.fighters[0]?.heading ?? 0) - before;
    };
    expect(turn(false)).toBeGreaterThan(turn(true));
  });

  test('right turns right; after the portal, right turns left', () => {
    const steerFrom = (state: RidgeState) => {
      const me = state.fighters[0];
      if (!me) throw new Error('pas de vélo');
      const turned = RIDGE_RIDE.step(
        RIDGE_RIDE.step({ ...state, fighters: [{ ...me, steer: 0 }] }, { a: hold({ x: 1, z: 0 }) }),
        { a: hold({ x: 1, z: 0 }) },
      );
      return (turned.fighters[0]?.heading ?? 0) - me.heading;
    };
    const course = courseOf(4);
    let state = RIDGE_RIDE.create(['a'], { practice: false, seed: 4 });
    state = run(state, (s) => s.tick >= steps(1), bots({ a: 'expert' }, 4));
    expect(steerFrom(state)).toBeGreaterThan(0);
    state = run(
      state,
      (s) => (s.fighters[0]?.s ?? 0) > course.portal + 2,
      bots({ a: 'expert' }, 4),
    );
    expect(state.fighters[0]?.fellAt).toBeNull();
    expect(isInverted(course, state.fighters[0] ?? { s: 0 })).toBe(true);
    expect(steerFrom(state)).toBeLessThan(0);
  });

  test('leaving the edge drops you; finishers rank by time, the fallen by distance', () => {
    let state = RIDGE_RIDE.create(['a', 'b', 'c'], { practice: false, seed: 6 });
    // a tombe tout de suite (il braque à fond), b un peu plus loin, c arrive.
    state = run(
      state,
      (s) => RIDGE_RIDE.isOver(s),
      (s) => ({
        ...bots({ c: 'expert' }, 6)(s),
        a: hold({ x: 1, z: -1 }),
        b:
          s.tick < steps(4)
            ? RIDGE_RIDE.botInput(s, 'b', 'expert', new Rng(1))
            : hold({ x: -1, z: -1 }),
      }),
    );
    const [a, b, c] = state.fighters;
    expect(a?.fellAt).not.toBeNull();
    expect(b?.fellAt).not.toBeNull();
    expect(c?.finishedAt).not.toBeNull();
    expect(RIDGE_RIDE.ranking(state)).toEqual([['c'], ['b'], ['a']]);
  });

  test('the race stops at the time limit; those still riding rank by distance', () => {
    let state = RIDGE_RIDE.create(['a', 'b'], { practice: false, seed: 2 });
    // a avance un peu puis freine ; b reste freiné : personne n'arrive.
    state = run(
      state,
      (s) => RIDGE_RIDE.isOver(s),
      (s) => ({
        a: s.tick < steps(0.6) ? hold({ x: 0, z: -1 }) : hold({ x: 0, z: 1 }),
        b: hold({ x: 0, z: 1 }),
      }),
    );
    expect(state.tick).toBeLessThanOrEqual(steps(RIDE_TIME_LIMIT + 2));
    expect(RIDGE_RIDE.timeLeft(state)).toBe(0);
    const [first] = RIDGE_RIDE.ranking(state);
    expect(first).toEqual(['a']);
  });

  test('in the sandbox, a fall puts you back on the ridge, a bit before', () => {
    let state = RIDGE_RIDE.create(['a'], { practice: true, seed: 5 });
    state = run(
      state,
      (s) => s.fighters[0]?.fellAt !== null,
      () => ({ a: hold({ x: 1, z: -1 }) }),
    );
    const fallS = state.fighters[0]?.s ?? 0;
    state = run(state, (s) => s.fighters[0]?.fellAt === null);
    expect(state.fighters[0]?.s).toBeLessThan(fallS);
    expect(state.fighters[0]?.speed).toBeLessThan(0.5);
    expect(RIDGE_RIDE.isOver(state)).toBe(false);
  });

  test('bots ride down: most finish, the expert faster than the easy one, and every race ends', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const finished: Record<BotLevel, number[]> = { easy: [], normal: [], expert: [] };
    let total = 0;
    let arrived = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const ids = levels.map((_, index) => `p${index}`);
      const state = run(
        RIDGE_RIDE.create(ids, { practice: false, seed }),
        (s) => RIDGE_RIDE.isOver(s),
        bots(Object.fromEntries(ids.map((id, index) => [id, levels[index] ?? 'normal'])), seed),
      );
      state.fighters.forEach((rider, index) => {
        total++;
        if (rider.finishedAt === null) return;
        arrived++;
        finished[levels[index] ?? 'normal'].push(rider.finishedAt);
      });
    }
    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(arrived / total).toBeGreaterThan(0.6);
    expect(average(finished.expert)).toBeLessThan(average(finished.easy));
  });
});
