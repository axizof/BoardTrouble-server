import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CONVEYOR_SORT,
  ITEM_ARRIVE,
  isSignChange,
  itemOf,
  SORT_ITEMS,
  SORT_TIME_LIMIT,
  type SortState,
  sameItem,
  signOf,
  targetOf,
} from './conveyorSort';

const PUSH: ArenaInput = { ...IDLE_INPUT, primary: true };
const PASS: ArenaInput = { ...IDLE_INPUT, secondary: true };

function stepMany(state: SortState, count: number, input: (s: SortState) => ArenaInput) {
  let current = state;
  for (let k = 0; k < count; k++) current = CONVEYOR_SORT.step(current, { a: input(current) });
  return current;
}

/** Une décision, puis on relâche le temps que l'article suivant arrive. */
function decide(state: SortState, input: ArenaInput): SortState {
  const pressed = CONVEYOR_SORT.step(state, { a: input });
  return stepMany(pressed, Math.ceil(ITEM_ARRIVE / ARENA_STEP) + 1, () => IDLE_INPUT);
}

describe('Tapis express', () => {
  test('the same roll for everyone: items and signs only depend on the seed', () => {
    for (let index = 0; index < 60; index++) {
      expect(itemOf(7, index)).toEqual(itemOf(7, index));
      expect(targetOf(7, index)).toEqual(targetOf(7, index));
    }
    expect(Array.from({ length: 40 }, (_, i) => itemOf(7, i))).not.toEqual(
      Array.from({ length: 40 }, (_, i) => itemOf(8, i)),
    );
  });

  test('the sign changes from time to time, never to the same item', () => {
    const changes = Array.from({ length: SORT_ITEMS }, (_, i) => i).filter((i) =>
      isSignChange(3, i),
    );
    expect(changes.length).toBeGreaterThan(10);
    expect(changes[0]).toBeGreaterThanOrEqual(14);
    for (const at of changes) {
      expect(sameItem(targetOf(3, at), targetOf(3, at - 1))).toBe(false);
      expect(signOf(3, at)).toBe(signOf(3, at - 1) + 1);
    }
  });

  test('about half the items are the target, many others look like it', () => {
    let targets = 0;
    let near = 0;
    for (let index = 0; index < SORT_ITEMS; index++) {
      const item = itemOf(5, index);
      const target = targetOf(5, index);
      if (sameItem(item, target)) targets++;
      else if (item.shape === target.shape || item.color === target.color) near++;
    }
    expect(targets / SORT_ITEMS).toBeGreaterThan(0.38);
    expect(targets / SORT_ITEMS).toBeLessThan(0.52);
    expect(near / (SORT_ITEMS - targets)).toBeGreaterThan(0.55);
  });

  test('pushing the target scores, pushing another item costs a point, passing scores nothing', () => {
    let state = CONVEYOR_SORT.create(['a'], { practice: false, seed: 2 });
    let expected = 0;
    for (let k = 0; k < 20; k++) {
      const fighter = state.fighters[0];
      if (!fighter) throw new Error('joueur');
      const isTarget = sameItem(itemOf(2, fighter.index), targetOf(2, fighter.index));
      // Un sur trois : on pousse au hasard ; sinon on passe.
      const push = k % 3 === 0;
      if (push) expected += isTarget ? 1 : -1;
      state = decide(state, push ? PUSH : PASS);
    }
    expect(state.fighters[0]?.score).toBe(expected);
    expect(state.fighters[0]?.index).toBe(20);
  });

  test('one decision per item: a held key, or a press while the next item arrives, does nothing', () => {
    let state = CONVEYOR_SORT.create(['a'], { practice: false, seed: 2 });
    state = stepMany(state, 30, () => PUSH);
    expect(state.fighters[0]?.index).toBe(1);
    // Relâché, puis appuyé aussitôt après une décision : l'article suivant n'est pas encore là.
    state = decide(state, IDLE_INPUT);
    state = CONVEYOR_SORT.step(state, { a: PASS });
    expect(state.fighters[0]?.index).toBe(2);
    state = CONVEYOR_SORT.step(state, { a: IDLE_INPUT });
    state = CONVEYOR_SORT.step(state, { a: PUSH });
    expect(state.fighters[0]?.index).toBe(2);
  });

  test('ends after 60 s, ranked by score, ties grouped', () => {
    let state = CONVEYOR_SORT.create(['a', 'b'], { practice: false, seed: 4 });
    const rng = new Rng(1);
    while (!CONVEYOR_SORT.isOver(state)) {
      state = CONVEYOR_SORT.step(state, {
        a: CONVEYOR_SORT.botInput(state, 'a', 'expert', rng),
        b: CONVEYOR_SORT.botInput(state, 'b', 'easy', rng),
      });
    }
    expect(state.tick * ARENA_STEP).toBeGreaterThanOrEqual(SORT_TIME_LIMIT - ARENA_STEP);
    const [first] = CONVEYOR_SORT.ranking(state);
    expect(first).toEqual(['a']);
  });

  test('bots: the expert sorts more and better than the easy one', () => {
    const play = (level: BotLevel, seed: number) => {
      let state = CONVEYOR_SORT.create(['a'], { practice: false, seed });
      const rng = new Rng(seed);
      while (!CONVEYOR_SORT.isOver(state)) {
        state = CONVEYOR_SORT.step(state, { a: CONVEYOR_SORT.botInput(state, 'a', level, rng) });
      }
      return state.fighters[0]?.score ?? 0;
    };
    const average = (level: BotLevel) =>
      Array.from({ length: 8 }, (_, seed) => play(level, seed + 1)).reduce((a, b) => a + b, 0) / 8;
    const [easy, normal, expert] = [average('easy'), average('normal'), average('expert')];
    expect(easy).toBeLessThan(normal);
    expect(normal).toBeLessThan(expert);
    // Bien en dessous de la fin du rouleau, même pour l'Expert.
    expect(expert).toBeLessThan(SORT_ITEMS / 4);
  });

  test('the practice never ends and loops the roll', () => {
    let state = CONVEYOR_SORT.create(['a'], { practice: true, seed: 1 });
    state = stepMany(state, Math.ceil(SORT_TIME_LIMIT / ARENA_STEP) + 30, () => IDLE_INPUT);
    expect(CONVEYOR_SORT.isOver(state)).toBe(false);
    expect(CONVEYOR_SORT.timeLeft(state)).toBeNull();
  });
});
