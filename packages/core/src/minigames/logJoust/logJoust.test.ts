import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  FALL_ANGLE,
  type JoustState,
  LOG_JOUST,
  READY_TIME,
  WINDUP,
  WINS_NEEDED,
} from './logJoust';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const run = (z: number, extra: Partial<ArenaInput> = {}): ArenaInput => ({
  ...IDLE_INPUT,
  move: { x: 0, z },
  ...extra,
});

/** Un duel prêt à jouter, le tronc lancé à cette allure. */
function rolling(speed: number): JoustState {
  let state = LOG_JOUST.create(['a', 'b'], { practice: false, seed: 1 });
  while (state.round.phase === 'ready') state = LOG_JOUST.step(state, {});
  // Le coup de talon prêt tout de suite (au départ, il faut attendre un peu).
  const fighters = state.fighters.map((one) => ({ ...one, stompReady: 0 }));
  return { ...state, fighters, log: { ...state.log, speed } };
}

/** Une course qui compense exactement le roulis, et corrige le penché. */
function steady(state: JoustState, id: string): ArenaInput {
  const me = state.fighters.find((one) => one.id === id);
  if (!me) return IDLE_INPUT;
  const wanted = -state.log.speed - (1.8 * me.tilt + 0.5 * me.spin) * 2.6;
  return run(Math.max(-1, Math.min(1, wanted / 2.6)));
}

describe('Joute sur le tronc', () => {
  test('standing still on a rolling log, you tip over; running against the roll keeps you up', () => {
    let still = rolling(1.5);
    for (let k = 0; k < steps(3) && still.round.phase === 'play'; k++) {
      still = LOG_JOUST.step(still, { b: steady(still, 'b') });
    }
    expect(still.round.phase).toBe('splash');
    expect(still.round.loser).toBe('a');
    let kept = rolling(1.5);
    for (let k = 0; k < steps(6); k++) {
      kept = LOG_JOUST.step(kept, { a: steady(kept, 'a'), b: steady(kept, 'b') });
    }
    expect(kept.round.phase).toBe('play');
    for (const one of kept.fighters) expect(Math.abs(one.tilt)).toBeLessThan(FALL_ANGLE / 2);
  });

  test('the log follows the feet: if one stops running, the log slows under the other', () => {
    let state = rolling(2);
    for (let k = 0; k < steps(1.5); k++) {
      state = LOG_JOUST.step(state, { a: run(0), b: steady(state, 'b') });
    }
    expect(Math.abs(state.log.speed)).toBeLessThan(1.5);
  });

  test('a stomp is seen coming (the leg rises), shakes the one on the log, not the one in the air', () => {
    const start = rolling(2);
    const stompAt = (jumps: boolean) => {
      let state = start;
      for (let k = 0; k < steps(WINDUP + 0.1); k++) {
        state = LOG_JOUST.step(state, {
          a: { ...steady(state, 'a'), primary: k === 0 },
          b: { ...steady(state, 'b'), secondary: jumps && k === steps(WINDUP / 2) },
        });
        if (k === 1) expect(state.fighters[0]?.windup).not.toBeNull();
      }
      return state;
    };
    const grounded = stompAt(false);
    const jumped = stompAt(true);
    expect(grounded.fighters[0]?.stompAt).not.toBeNull();
    const shaken = Math.abs(grounded.fighters[1]?.tilt ?? 0);
    expect(shaken).toBeGreaterThan(Math.abs(jumped.fighters[1]?.tilt ?? 0) + 0.05);
  });

  test('a fall gives the round to the other; two rounds win the duel', () => {
    let state = rolling(0);
    state = {
      ...state,
      fighters: state.fighters.map((one, i) =>
        i === 0 ? { ...one, tilt: FALL_ANGLE + 0.01 } : one,
      ),
    };
    state = LOG_JOUST.step(state, {});
    expect(state.fighters[1]?.wins).toBe(1);
    expect(state.round.phase).toBe('splash');
    while (state.round.phase !== 'play') state = LOG_JOUST.step(state, {});
    expect(state.fighters[0]?.tilt).toBe(0);
    state = {
      ...state,
      fighters: state.fighters.map((one, i) =>
        i === 0 ? { ...one, tilt: -FALL_ANGLE - 0.01 } : one,
      ),
    };
    while (!LOG_JOUST.isOver(state)) state = LOG_JOUST.step(state, {});
    expect(WINS_NEEDED).toBe(2);
    expect(LOG_JOUST.ranking(state)).toEqual([['b'], ['a']]);
    expect(READY_TIME).toBeGreaterThan(0);
  });

  test('between bots, the duel ends with a winner', () => {
    for (const seed of [1, 2, 3]) {
      let state = LOG_JOUST.create(['a', 'b'], { practice: false, seed });
      const rng = new Rng(seed);
      for (let k = 0; k < steps(300) && !LOG_JOUST.isOver(state); k++) {
        const current = state;
        state = LOG_JOUST.step(current, {
          a: LOG_JOUST.botInput(current, 'a', 'expert', rng),
          b: LOG_JOUST.botInput(current, 'b', 'easy', rng),
        });
      }
      expect(LOG_JOUST.isOver(state)).toBe(true);
    }
  });

  test('in the sandbox, a fall puts you straight back on the log, and the duel never ends', () => {
    let state = LOG_JOUST.create(['you', 'mannequin'], { practice: true, seed: 1 });
    for (let k = 0; k < steps(30); k++) state = LOG_JOUST.step(state, {});
    expect(LOG_JOUST.isOver(state)).toBe(false);
    expect(state.round.phase).toBe('play');
  });
});
