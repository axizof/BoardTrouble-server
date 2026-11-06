import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  aimOf,
  DUEL_ANSWER_TIME,
  DUEL_SCORED_TIME,
  DUEL_TARGET,
  type DuelDirection,
  type DuelState,
  duelShown,
  HIGH_NOON,
} from './highNoon';

const aim = (direction: DuelDirection): ArenaInput => ({
  ...IDLE_INPUT,
  move: direction === 'up' ? { x: 0, z: -1 } : { x: direction === 'left' ? -1 : 1, z: 0 },
});
const wrongOf = (direction: DuelDirection): DuelDirection => (direction === 'up' ? 'left' : 'up');
const duel = () => HIGH_NOON.create(['a', 'b'], { practice: false, seed: 1 });
const run = (state: DuelState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = HIGH_NOON.step(current, inputs);
  return current;
};
const duelist = (state: DuelState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Duelliste attendu : ${id}`);
  return found;
};
/** Avance jusqu'au signal de la manche en cours (sans tirer). */
const toSignal = (state: DuelState) => {
  let current = state;
  while (current.tick < current.round.signalAt) current = HIGH_NOON.step(current, {});
  return current;
};

describe('high noon', () => {
  test('a round waits 2 to 6 s, its feints come before the signal, then the target shows', () => {
    const state = duel();
    const wait = (state.round.signalAt - state.round.startAt) * ARENA_STEP;
    expect(wait).toBeGreaterThanOrEqual(2);
    expect(wait).toBeLessThanOrEqual(6);
    for (const feint of state.round.feints) expect(feint.at).toBeLessThan(state.round.signalAt);
    expect(duelShown(toSignal(state))).toEqual({ type: 'signal', target: state.round.target });
  });

  test('aiming reads left, right and up; down shoots nowhere', () => {
    expect(aimOf(aim('left'))).toBe('left');
    expect(aimOf(aim('right'))).toBe('right');
    expect(aimOf(aim('up'))).toBe('up');
    expect(aimOf({ ...IDLE_INPUT, move: { x: 0, z: 1 } })).toBeNull();
  });

  test('the first to shoot the right way wins the round', () => {
    const signal = toSignal(duel());
    const state = HIGH_NOON.step(signal, { a: aim(signal.round.target) });
    expect(state.round.winner).toBe('a');
    expect(duelist(state, 'a').points).toBe(1);
  });

  test('a wrong way jams the gun for the round: the other can still win it', () => {
    const signal = toSignal(duel());
    let state = HIGH_NOON.step(signal, { a: aim(wrongOf(signal.round.target)) });
    expect(state.round.closedAt).toBeNull();
    // Il a beau retirer dans la bonne direction : son arme est enrayée.
    state = HIGH_NOON.step(HIGH_NOON.step(state, {}), { a: aim(signal.round.target) });
    expect(state.round.closedAt).toBeNull();
    state = HIGH_NOON.step(state, { b: aim(signal.round.target) });
    expect(state.round.winner).toBe('b');
  });

  test('shooting before the signal gives the round to the other', () => {
    const state = HIGH_NOON.step(duel(), { a: aim('up') });
    expect(state.round.winner).toBe('b');
    expect(duelist(state, 'b').points).toBe(1);
  });

  test('nobody right in time: the round goes to nobody', () => {
    const signal = toSignal(duel());
    let state = signal;
    for (let i = 0; i <= Math.ceil(DUEL_ANSWER_TIME / ARENA_STEP); i++) {
      state = HIGH_NOON.step(state, {});
    }
    expect(state.round.closedAt).not.toBeNull();
    expect(state.round.winner).toBeNull();
  });

  test('three rounds won end the duel', () => {
    let state = duel();
    for (let round = 0; round < DUEL_TARGET; round++) {
      state = toSignal(state);
      state = HIGH_NOON.step(state, { a: aim(state.round.target) });
      while (state.round.index === round && !HIGH_NOON.isOver(state)) {
        state = HIGH_NOON.step(state, {});
      }
    }
    expect(duelist(state, 'a').points).toBe(DUEL_TARGET);
    expect(HIGH_NOON.isOver(state)).toBe(true);
    expect(HIGH_NOON.ranking(state)).toEqual([['a'], ['b']]);
  });

  test('a direction pressed during the result and still held is no false start next round', () => {
    const signal = toSignal(duel());
    let state = HIGH_NOON.step(signal, { a: aim(signal.round.target) });
    // Pendant le résultat, il appuie une autre flèche et la garde jusqu'à la manche suivante.
    const held = aim(wrongOf(signal.round.target));
    const scored = Math.ceil(DUEL_SCORED_TIME / ARENA_STEP) + 5;
    state = run(state, { a: held }, scored);
    expect(state.round.index).toBe(1);
    expect(duelist(state, 'a').falseStart).toBe(false);
    expect(state.round.closedAt).toBeNull();
  });

  test('at practice, the rounds never end', () => {
    let state = HIGH_NOON.create(['a', 'dummy'], { practice: true, seed: 1 });
    for (let i = 0; i < 30 * 60; i++) {
      const target = state.round.target;
      state = HIGH_NOON.step(state, {
        a: state.tick >= state.round.signalAt ? aim(target) : IDLE_INPUT,
      });
    }
    expect(duelist(state, 'a').points).toBeGreaterThan(DUEL_TARGET);
    expect(HIGH_NOON.isOver(state)).toBe(false);
  });

  test('bots duel to the end, the expert winning more often than the easy one', () => {
    let expertWins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      let state = HIGH_NOON.create(['e', 'x'], { practice: false, seed });
      while (!HIGH_NOON.isOver(state)) {
        state = HIGH_NOON.step(state, {
          e: HIGH_NOON.botInput(state, 'e', 'easy', rng),
          x: HIGH_NOON.botInput(state, 'x', 'expert', rng),
        });
      }
      if (HIGH_NOON.ranking(state)[0]?.includes('x')) expertWins += 1;
    }
    expect(expertWins).toBeGreaterThan(18);
  });
});
