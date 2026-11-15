import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CANNON_TIME,
  CANNONEER,
  type CannonState,
  cannoneerWins,
  eliminationsToWin,
  flightTime,
  JAM_TIME,
  LEVERS_TO_WIN,
  leverTime,
  RUNNER_LIVES,
  SPECIAL_EVERY,
} from './cannoneer';
import { DECK_FRONT, DECK_HALF_X } from './fort';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const fireAt = (x: number, z: number, special = false): ArenaInput => ({
  ...IDLE_INPUT,
  point: { x, z },
  primary: !special,
  secondary: special,
});

/** Le canonnier `s`, les coureurs a, b, c posés là où on le dit. */
function placed(spots: { x: number; z: number }[]): CannonState {
  const ids = ['s', ...spots.map((_, index) => String.fromCharCode(97 + index))];
  const state = CANNONEER.create(ids, { practice: false, seed: 1, solo: 's' });
  return {
    ...state,
    fighters: state.fighters.map((one, index) => ({ ...one, ...spots[index] })),
  };
}

const runner = (state: CannonState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`no runner ${id}`);
  return found;
};

function wait(state: CannonState, seconds: number, inputs = {}): CannonState {
  let current = state;
  for (let k = 0; k < steps(seconds); k++) current = CANNONEER.step(current, inputs);
  return current;
}

describe('Le Canonnier', () => {
  test('a ball falls where it was aimed after its flight, and takes a life from who stands there', () => {
    let state = placed([
      { x: 0, z: 2 },
      { x: 6, z: 2 },
    ]);
    state = CANNONEER.step(state, { s: fireAt(0, 2) });
    expect(state.balls).toHaveLength(1);
    const flight = flightTime('ball', 0, 2);
    expect(flight).toBeGreaterThan(0.6);
    state = wait(state, flight + 0.1);
    expect(runner(state, 'a').lives).toBe(RUNNER_LIVES - 1);
    expect(runner(state, 'b').lives).toBe(RUNNER_LIVES);
    // Touché, il est intouchable un moment : un second boulet au même endroit ne prend rien.
    state = CANNONEER.step(state, { s: fireAt(runner(state, 'a').x, runner(state, 'a').z) });
    state = wait(state, flight + 0.1);
    expect(runner(state, 'a').lives).toBe(RUNNER_LIVES - 1);
  });

  test('the cluster drops three balls around the aim; the giant falls slower and wider', () => {
    let state = placed([{ x: 0, z: 2 }]);
    state = { ...state, solo: { ...state.solo, special: 'cluster' } };
    state = CANNONEER.step(state, { s: fireAt(0, 2, true) });
    expect(state.balls).toHaveLength(3);
    expect(state.solo.special).toBeNull();
    expect(state.solo.specialAt - state.tick).toBe(steps(SPECIAL_EVERY));
    expect(flightTime('giant', 0, 2)).toBeGreaterThan(flightTime('ball', 0, 2));
  });

  test('the bouncing ball bounces twice further from the tower', () => {
    let state = placed([{ x: 8, z: 6 }]);
    state = { ...state, solo: { ...state.solo, special: 'bouncer' } };
    state = CANNONEER.step(state, { s: fireAt(0, 0, true) });
    const seen = new Map<number, number>();
    for (let k = 0; k < steps(3); k++) {
      state = CANNONEER.step(state, {});
      for (const ball of state.balls) seen.set(ball.id, ball.z);
    }
    // Le tir, puis deux rebonds, chacun plus loin de la tour.
    const landings = [...seen.values()];
    expect(landings).toHaveLength(3);
    expect(landings[2] ?? 0).toBeGreaterThan((landings[0] ?? 0) + 4);
  });

  test('the aim is kept on the deck', () => {
    let state = placed([{ x: 0, z: 2 }]);
    state = CANNONEER.step(state, { s: { ...IDLE_INPUT, point: { x: 40, z: 40 } } });
    expect(state.solo.aim).toEqual({ x: DECK_HALF_X, z: DECK_FRONT });
  });

  test('standing on a lever pulls it and jams the cannon; the last lever brings the tower down', () => {
    let state = placed([{ x: 0, z: 2 }]);
    while (state.lever === null) state = CANNONEER.step(state, {});
    const lever = state.lever;
    state = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, x: lever.x, z: lever.z })),
    };
    state = wait(state, leverTime(state) + 0.1);
    expect(state.levers).toBe(1);
    expect(state.solo.jammedUntil - state.tick).toBeGreaterThan(steps(JAM_TIME) - 5);
    // Enrayé, le canon ne tire pas.
    state = CANNONEER.step(state, { s: fireAt(0, 2) });
    expect(state.balls).toHaveLength(0);
    state = { ...state, levers: LEVERS_TO_WIN - 1 };
    while (state.lever?.pulledAt !== null || state.lever === null)
      state = CANNONEER.step(state, {});
    const last = state.lever;
    state = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, x: last.x, z: last.z })),
    };
    state = wait(state, leverTime(state) + 0.1);
    expect(state.fallenAt).not.toBeNull();
    expect(CANNONEER.isOver(state)).toBe(true);
    expect(cannoneerWins(state)).toBe(false);
  });

  test('the cannoneer wins once half the runners are out', () => {
    let state = placed([
      { x: 0, z: 2 },
      { x: 6, z: 2 },
      { x: -6, z: 2 },
    ]);
    expect(eliminationsToWin(state)).toBe(2);
    state = {
      ...state,
      fighters: state.fighters.map((one, index) => (index < 2 ? { ...one, lives: 1 } : one)),
    };
    for (const target of [
      { x: 0, z: 2 },
      { x: 6, z: 2 },
    ]) {
      state = CANNONEER.step(state, { s: fireAt(target.x, target.z) });
      state = wait(state, 1.2);
    }
    expect(cannoneerWins(state)).toBe(true);
    expect(CANNONEER.isOver(state)).toBe(true);
    expect(CANNONEER.ranking(state)).toEqual([['s'], ['a', 'b', 'c']]);
  });

  test('the runners do not see the aim', () => {
    let state = placed([{ x: 0, z: 2 }]);
    state = CANNONEER.step(state, { s: { ...IDLE_INPUT, point: { x: 3, z: 4 } } });
    expect(CANNONEER.viewFor?.(state, { type: 'player', playerId: 'a' })?.solo.aim).toEqual({
      x: 0,
      z: 0,
    });
    expect(CANNONEER.viewFor?.(state, { type: 'player', playerId: 's' })?.solo.aim).toEqual({
      x: 3,
      z: 4,
    });
  });

  test('between bots, the game ends with a winner side within the time', () => {
    for (const seed of [1, 2, 3]) {
      const ids = ['s', 'a', 'b', 'c'];
      let state = CANNONEER.create(ids, { practice: false, seed, solo: 's' });
      const rng = new Rng(seed);
      while (!CANNONEER.isOver(state)) {
        const current = state;
        state = CANNONEER.step(
          current,
          Object.fromEntries(ids.map((id) => [id, CANNONEER.botInput(current, id, 'normal', rng)])),
        );
      }
      expect(state.tick).toBeLessThanOrEqual(steps(CANNON_TIME));
      expect(CANNONEER.ranking(state)).toHaveLength(2);
    }
  });

  test('in the sandbox, the dummy cannoneer fires at you and you never run out of lives', () => {
    let state = CANNONEER.create(['you', 'mannequin'], {
      practice: true,
      seed: 1,
      solo: 'mannequin',
    });
    state = wait(state, 20, { you: IDLE_INPUT });
    expect(state.solo.shots).toBeGreaterThan(3);
    expect(runner(state, 'you').lives).toBe(RUNNER_LIVES);
    expect(CANNONEER.isOver(state)).toBe(false);
  });
});
