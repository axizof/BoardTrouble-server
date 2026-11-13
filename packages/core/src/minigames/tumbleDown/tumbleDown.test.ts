import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  RAIL_X,
  RAMP_HALF,
  RAMP_LENGTH,
  RUBBLE,
  type Rubble,
  rubbleAt,
  rubbleSchedule,
} from './rubble';
import {
  FINISH_GRACE,
  TUMBLE_DOWN,
  TUMBLE_TIME_LIMIT,
  type TumbleRunner,
  type TumbleState,
  tumbleWorld,
} from './tumbleDown';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const up: ArenaInput = { move: { x: 0, z: -1 }, primary: false, secondary: false };

function run(
  state: TumbleState,
  until: (state: TumbleState) => boolean,
  inputs: (state: TumbleState) => Partial<Record<string, ArenaInput>> = () => ({}),
): TumbleState {
  let current = state;
  for (let tick = 0; tick < steps(TUMBLE_TIME_LIMIT + 5) && !until(current); tick++) {
    current = TUMBLE_DOWN.step(current, inputs(current));
  }
  return current;
}

const runner = (state: TumbleState, index = 0) => state.fighters[index] as TumbleRunner;

/**
 * Un objet de cette sorte, et un coureur placé sur sa route, 0,5 s avant qu'il n'arrive sur lui :
 * le premier dont rien d'autre ne le touche avant.
 */
function facing(kind: Rubble['kind'], seed = 3) {
  for (const rubble of rubbleSchedule(seed, false).filter((one) => one.kind === kind)) {
    const meetAt = rubble.spawnAt + steps(4);
    const at = rubbleAt(rubble, meetAt);
    if (!at) continue;
    const start = TUMBLE_DOWN.create(['a'], { practice: false, seed });
    const placed: TumbleState = {
      ...start,
      tick: meetAt - steps(0.5),
      fighters: [{ ...runner(start), s: at.s - 2.2, x: at.x, best: at.s - 2.2 }],
    };
    const standing = run(placed, (s) => s.tick >= meetAt + steps(0.5) || runner(s).knock !== null);
    if (runner(standing).knock?.kind === kind) return { placed, meetAt };
  }
  throw new Error(`pas de ${kind} seul sur sa route`);
}

describe('La dégringolade', () => {
  test('the same objects for everyone: they come down between the walls, wagons on their rails', () => {
    const schedule = rubbleSchedule(9, false);
    expect(rubbleSchedule(9, false)).toBe(schedule);
    expect(schedule.length).toBeGreaterThan(150);
    for (const rubble of schedule.slice(0, 120)) {
      for (let k = 0; k < steps(20); k += 7) {
        const at = rubbleAt(rubble, rubble.spawnAt + k);
        if (!at) continue;
        expect(Math.abs(at.x)).toBeLessThanOrEqual(RAMP_HALF - RUBBLE[rubble.kind].half + 1e-9);
        if (rubble.kind === 'wagon') expect(Math.abs(at.x)).toBeCloseTo(RAIL_X);
      }
    }
    // Une rangée de tonneaux ou un barrage de piles laisse toujours un trou.
    const rows = new Map<number, number>();
    for (const rubble of schedule) {
      if (rubble.inLine) rows.set(rubble.spawnAt, (rows.get(rubble.spawnAt) ?? 0) + 1);
    }
    expect(rows.size).toBeGreaterThan(3);
    for (const count of rows.values()) expect(count).toBe(6);
    expect(schedule.some((one) => one.kind === 'stack' && one.inLine)).toBe(true);
  });

  test('the ramp is already busy at the start, but the bottom is clear', () => {
    const schedule = rubbleSchedule(9, false);
    const onRamp = schedule.map((rubble) => rubbleAt(rubble, 0)).filter((at) => at !== null);
    expect(onRamp.length).toBeGreaterThan(8);
    for (const at of onRamp) expect(at.s).toBeGreaterThan(15);
    expect(new Set(schedule.map((rubble) => rubble.id)).size).toBe(schedule.length);
    expect(schedule.some((rubble) => rubble.kind === 'plank')).toBe(true);
    expect(schedule.some((rubble) => rubble.kind === 'ball')).toBe(true);
  });

  test('you climb at a steady pace, and reaching the top ends your run', () => {
    const state = TUMBLE_DOWN.create(['a', 'b'], { practice: false, seed: 1 });
    // Intouchable le temps du test : seule compte la course.
    const shielded = (s: TumbleState) => ({
      ...s,
      fighters: s.fighters.map((one) => ({ ...one, safe: 99 })),
    });
    const climbed = run(
      shielded(state),
      (s) => s.tick >= steps(5),
      () => ({ a: up }),
    );
    expect(runner(climbed).s).toBeGreaterThan(18);
    expect(runner(climbed).s).toBeLessThan(23);
    const near = shielded({
      ...climbed,
      fighters: climbed.fighters.map((one, i) => (i === 0 ? { ...one, s: RAMP_LENGTH - 1 } : one)),
    });
    const top = run(
      near,
      (s) => runner(s).finishedAt !== null,
      () => ({ a: up }),
    );
    expect(runner(top).s).toBe(RAMP_LENGTH);
    expect(TUMBLE_DOWN.ranking(top)[0]).toEqual(['a']);
  });

  test('a barrel is cleared with a jump; standing in its way, you are knocked back down the ramp', () => {
    const { placed, meetAt } = facing('barrel');
    const hit = run(placed, (s) => runner(s).knock !== null);
    expect(runner(hit).knock?.kind).toBe('barrel');
    const fallen = run(hit, (s) => runner(s).downed <= 0);
    expect(runner(placed).s - runner(fallen).s).toBeGreaterThan(10);
    expect(runner(fallen).safe).toBeGreaterThan(0);
    let cleared = false;
    for (let lead = 0; lead < steps(0.6) && !cleared; lead++) {
      const jumped = run(
        placed,
        (s) => s.tick >= meetAt + steps(0.3),
        (s) => ({ a: { ...IDLE_INPUT, primary: s.tick === meetAt - lead } }),
      );
      cleared = runner(jumped).knock === null;
    }
    expect(cleared).toBe(true);
  });

  test('wheels, boulders and stacks are too tall to jump: only stepping aside dodges them', () => {
    for (const kind of ['wheel', 'boulder', 'stack'] as const) {
      const { placed, meetAt } = facing(kind);
      for (let lead = 0; lead < steps(0.6); lead += 2) {
        const jumped = run(
          placed,
          (s) => s.tick >= meetAt + steps(0.5) || runner(s).knock !== null,
          (s) => ({ a: { ...IDLE_INPUT, primary: s.tick === meetAt - lead } }),
        );
        expect(runner(jumped).knock?.kind).toBe(kind);
      }
    }
  });

  test('the world comes from the seed: the mine or the swamp, half the time each', () => {
    expect(tumbleWorld(4)).toBe('mine');
    expect(tumbleWorld(5)).toBe('swamp');
    expect(tumbleWorld(-3)).toBe('swamp');
  });

  test('the finishers rank by time, the others by the highest point they reached', () => {
    const state = TUMBLE_DOWN.create(['a', 'b', 'c', 'd'], { practice: false, seed: 1 });
    const ranked: TumbleState = {
      ...state,
      tick: steps(50),
      fighters: [
        { ...runner(state, 0), best: 60, s: 20 },
        { ...runner(state, 1), finishedAt: steps(40), s: RAMP_LENGTH, best: RAMP_LENGTH },
        { ...runner(state, 2), best: 80, s: 80 },
        { ...runner(state, 3), best: 60.2, s: 60 },
      ],
    };
    expect(TUMBLE_DOWN.ranking(ranked)).toEqual([['b'], ['c'], ['a', 'd']]);
    expect(TUMBLE_DOWN.isOver(ranked)).toBe(false);
    expect(TUMBLE_DOWN.isOver({ ...ranked, tick: steps(40 + FINISH_GRACE) })).toBe(true);
  });

  test('between bots, someone reaches the top and the game ends with a full ranking', () => {
    for (const players of [2, 4, 6]) {
      const ids = Array.from({ length: players }, (_, index) => `p${index}`);
      const rng = new Rng(players);
      const state = run(
        TUMBLE_DOWN.create(ids, { practice: false, seed: players }),
        (s) => TUMBLE_DOWN.isOver(s),
        (s) =>
          Object.fromEntries(ids.map((id) => [id, TUMBLE_DOWN.botInput(s, id, 'normal', rng)])),
      );
      expect(TUMBLE_DOWN.isOver(state)).toBe(true);
      expect(state.fighters.some((one) => one.finishedAt !== null)).toBe(true);
      expect(TUMBLE_DOWN.ranking(state).flat().sort()).toEqual([...ids].sort());
    }
  });

  test('in the sandbox, reaching the top brings you back down, and the game never ends', () => {
    const state = TUMBLE_DOWN.create(['you'], { practice: true, seed: 1 });
    const top = run(
      { ...state, fighters: [{ ...runner(state), s: RAMP_LENGTH - 0.5 }] },
      (s) => s.tick >= steps(2),
      () => ({ you: up }),
    );
    expect(runner(top).s).toBeLessThan(5);
    expect(TUMBLE_DOWN.isOver(top)).toBe(false);
  });
});
