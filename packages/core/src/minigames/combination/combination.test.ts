import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  COMBINATION,
  type ComboState,
  INPUT_TIME,
  RUNES,
  SEQUENCE_LENGTH,
  shownRune,
} from './combination';

const start = (practice = false) => COMBINATION.create(['p'], { practice, seed: 1 });
const run = (state: ComboState, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = COMBINATION.step(current, {});
  return current;
};
const toInput = (rune: number): ArenaInput => {
  const name = RUNES[rune];
  if (name === 'center') return { ...IDLE_INPUT, primary: true };
  const move = {
    up: { x: 0, z: -1 },
    down: { x: 0, z: 1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 },
  }[name ?? 'up'];
  return { ...IDLE_INPUT, move };
};
/** Rejoue ces runes, une par appui (relâché entre deux), une fois la suite montrée. */
function playRunes(state: ComboState, runes: number[]): ComboState {
  let current = state;
  while (current.tick + 1 < current.inputAt) current = COMBINATION.step(current, {});
  for (const rune of runes) {
    current = COMBINATION.step(current, { p: toInput(rune) });
    current = COMBINATION.step(current, {});
  }
  return current;
}

describe('the combination', () => {
  test('the runes light up one after the other, as long as the sequence', () => {
    const state = start();
    const seen: number[] = [];
    let last: number | null = null;
    for (let tick = 0; tick < state.inputAt; tick++) {
      const rune = shownRune(state, tick);
      if (rune !== null && rune !== last) seen.push(rune);
      last = rune;
    }
    expect(seen).toEqual(state.sequence);
    expect(state.sequence).toHaveLength(SEQUENCE_LENGTH);
  });

  test('the sequence played back opens the gate', () => {
    let state = playRunes(start(), start().sequence);
    while (!COMBINATION.isOver(state)) state = COMBINATION.step(state, {});
    expect(COMBINATION.succeeded?.(state)).toBe(true);
  });

  test('a click on a rune counts like its key', () => {
    let state = start();
    while (state.tick + 1 < state.inputAt) state = COMBINATION.step(state, {});
    for (const rune of state.sequence) {
      state = COMBINATION.step(state, { p: { ...IDLE_INPUT, target: rune } });
    }
    expect(state.doneAt).not.toBeNull();
  });

  test('one wrong rune keeps the gate shut; so does running out of time', () => {
    const sequence = start().sequence;
    const wrong = [...sequence];
    wrong[2] = ((sequence[2] ?? 0) + 1) % RUNES.length;
    expect(playRunes(start(), wrong).failure).toBe('wrong');
    const slow = run(start(), start().inputAt + Math.ceil(INPUT_TIME / ARENA_STEP) + 1);
    expect(slow.failure).toBe('slow');
  });

  test('pressing while the runes are still shown does nothing', () => {
    const state = COMBINATION.step(run(start(), 30), { p: toInput(0) });
    expect(state.entered).toEqual([]);
    expect(state.failure).toBeNull();
  });

  test('at practice, a new sequence comes once the last try is shown', () => {
    let state = playRunes(start(true), [((start().sequence[0] ?? 0) + 1) % RUNES.length]);
    state = run(state, 60);
    expect(state.attempt).toBe(1);
    expect(COMBINATION.isOver(state)).toBe(false);
  });

  test('bots open the gate more often the better they are', () => {
    const opened = (level: 'easy' | 'expert') => {
      let count = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const rng = new Rng(seed);
        let state = COMBINATION.create(['p'], { practice: false, seed });
        while (!COMBINATION.isOver(state)) {
          state = COMBINATION.step(state, { p: COMBINATION.botInput(state, 'p', level, rng) });
        }
        if (COMBINATION.succeeded?.(state)) count += 1;
      }
      return count;
    };
    expect(opened('expert')).toBeGreaterThan(opened('easy'));
  });
});
