import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  DIE_CYCLE,
  faceAt,
  LAST_ROLL,
  landingPhase,
  ROLL_TRIES,
  ROLL_TRY_TIME,
  type RollState,
  rollPhase,
  totalOf,
} from './lastRoll';

const press: ArenaInput = { ...IDLE_INPUT, primary: true };
const final = (players = ['a', 'b']) => LAST_ROLL.create(players, { practice: false, seed: 1 });
const roller = (state: RollState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Finaliste attendu : ${id}`);
  return found;
};
/** Avance jusqu'à ce que le dé roule, puis encore `extra` pas. */
const spinning = (state: RollState, extra = 0) => {
  let current = state;
  while (current.tick < current.round.spinAt + extra) current = LAST_ROLL.step(current, {});
  return current;
};
/** Le premier pas où le dé, arrêté là, se poserait sur cette face. */
function tickFor(state: RollState, face: number): number {
  let tick = state.tick + 1;
  while (faceAt(landingPhase(state.round, tick)) !== face) tick += 1;
  return tick;
}
/** Chacun arrête son dé au pas qui donne cette face, et on attend la fin du lancer. */
function throwAll(state: RollState, faces: Record<string, number>): RollState {
  const at = Object.fromEntries(
    Object.entries(faces).map(([id, face]) => [id, tickFor(state, face)]),
  );
  let current = state;
  const index = state.round.index;
  while (current.round.index === index && !LAST_ROLL.isOver(current)) {
    const tick = current.tick + 1;
    const inputs = Object.fromEntries(
      Object.entries(at).map(([id, when]) => [id, tick === when ? press : IDLE_INPUT]),
    );
    current = LAST_ROLL.step(current, inputs);
  }
  return current;
}

describe('the last roll', () => {
  test('the die rolls through its six faces, each next to the one before on a real die', () => {
    expect([...DIE_CYCLE].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    DIE_CYCLE.forEach((face, index) => {
      const next = DIE_CYCLE[(index + 1) % DIE_CYCLE.length] ?? 0;
      expect(face + next).not.toBe(7);
    });
  });

  test('it speeds up during a throw, and pressing lets it roll on a bit before it lands', () => {
    const state = spinning(final());
    const early = rollPhase(state.round, state.tick + 10) - rollPhase(state.round, state.tick);
    const late = rollPhase(state.round, state.tick + 70) - rollPhase(state.round, state.tick + 60);
    expect(late).toBeGreaterThan(early);
    // Arrêté là, il se pose plus loin dans la suite que la face qu'il montre.
    const tick = state.tick + 20;
    expect(landingPhase(state.round, tick)).toBeGreaterThan(
      Math.floor(rollPhase(state.round, tick)),
    );
    const at = tickFor(state, 6);
    let current = state;
    while (current.tick + 1 < at) current = LAST_ROLL.step(current, {});
    current = LAST_ROLL.step(current, { a: press });
    expect(roller(current, 'a').face).toBe(6);
    expect(roller(current, 'a').rolls).toEqual([6]);
  });

  test('a die nobody stops stops by itself, its face still counts', () => {
    let state = spinning(final());
    state = LAST_ROLL.step(state, { a: press });
    while (state.round.endedAt === null) state = LAST_ROLL.step(state, {});
    expect(roller(state, 'b').rolls).toHaveLength(1);
    expect(state.tick).toBeGreaterThanOrEqual(state.round.spinAt + ROLL_TRY_TIME / ARENA_STEP);
  });

  test('three throws, and the best total wins', () => {
    let state = final();
    for (let k = 0; k < ROLL_TRIES; k++) state = throwAll(spinning(state), { a: 6, b: 5 });
    while (!LAST_ROLL.isOver(state)) state = LAST_ROLL.step(state, {});
    expect(totalOf(roller(state, 'a'))).toBe(18);
    expect(totalOf(roller(state, 'b'))).toBe(15);
    expect(LAST_ROLL.ranking(state)).toEqual([['a'], ['b']]);
  });

  test('a tie at the top goes to sudden death between the leaders only', () => {
    let state = final(['a', 'b', 'c']);
    for (let k = 0; k < ROLL_TRIES; k++) state = throwAll(spinning(state), { a: 6, b: 6, c: 3 });
    expect(state.round.index).toBe(ROLL_TRIES);
    expect(state.round.throwers.sort()).toEqual(['a', 'b']);
    state = throwAll(spinning(state), { a: 4, b: 6 });
    while (!LAST_ROLL.isOver(state)) state = LAST_ROLL.step(state, {});
    expect(roller(state, 'c').sudden).toEqual([]);
    expect(LAST_ROLL.ranking(state)).toEqual([['b'], ['a'], ['c']]);
  });

  test('at practice, the throws never end', () => {
    let state = LAST_ROLL.create(['a'], { practice: true, seed: 1 });
    for (let k = 0; k < ROLL_TRIES + 2; k++) state = throwAll(spinning(state), { a: 6 });
    expect(state.round.index).toBe(ROLL_TRIES + 2);
    expect(LAST_ROLL.isOver(state)).toBe(false);
  });

  test('bots play whole finals, the expert winning more often than the easy one', () => {
    let expert = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      let state = LAST_ROLL.create(['e', 'x'], { practice: false, seed });
      while (!LAST_ROLL.isOver(state)) {
        state = LAST_ROLL.step(state, {
          e: LAST_ROLL.botInput(state, 'e', 'easy', rng),
          x: LAST_ROLL.botInput(state, 'x', 'expert', rng),
        });
      }
      if (LAST_ROLL.ranking(state)[0]?.includes('x')) expert += 1;
    }
    expect(expert).toBeGreaterThan(18);
  });
});
