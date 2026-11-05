import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CHOICE_TIME,
  HIDDEN_CHOICE,
  STAIRS_CONFIRM,
  STAIRS_REVEAL_TIME,
  STAIRS_ROUNDS,
  type StairsState,
  stairsOptions,
  stairsTop,
  UNIQUE_STAIRS,
} from './uniqueStairs';

const PLAYERS = ['a', 'b', 'c', 'd'];
const climber = (state: StairsState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};
const aim = (target: number): ArenaInput => ({ ...IDLE_INPUT, target });

/** Chacun choisit son nombre (au clic) puis valide. */
function chooseAll(state: StairsState, choices: Record<string, number>): StairsState {
  const pick = Object.fromEntries(
    Object.entries(choices).map(([id, choice]) => [id, aim(state.options.indexOf(choice))]),
  );
  const confirm = Object.fromEntries(Object.keys(choices).map((id) => [id, aim(STAIRS_CONFIRM)]));
  return UNIQUE_STAIRS.step(UNIQUE_STAIRS.step(state, pick), confirm);
}

const wait = (state: StairsState, seconds: number) => {
  let next = state;
  for (let i = 0; i < Math.round(seconds / ARENA_STEP); i++) next = UNIQUE_STAIRS.step(next, {});
  return next;
};

describe('unique stairs', () => {
  test('1, 3 or 5 at four, and 1, 3, 4 or 5 at six; a lower top for a bigger table', () => {
    expect(stairsOptions(4)).toEqual([1, 3, 5]);
    expect(stairsOptions(6)).toEqual([1, 3, 4, 5]);
    expect(stairsTop(6)).toBeLessThan(stairsTop(4));
  });

  test('only who is alone on his number climbs', () => {
    const state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed: 1 });
    const revealed = chooseAll(state, { a: 5, b: 5, c: 3, d: 1 });
    expect(revealed.phase).toBe('reveal');
    expect(PLAYERS.map((id) => climber(revealed, id).height)).toEqual([0, 0, 3, 1]);
    expect(climber(revealed, 'c').climbed).toBe(true);
    expect(climber(revealed, 'a').lastChoice).toBe(5);
  });

  test('time up: a number picked counts, no number stays put', () => {
    let state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed: 1 });
    state = UNIQUE_STAIRS.step(state, { a: aim(2) });
    state = wait(state, CHOICE_TIME);
    expect(state.phase).toBe('reveal');
    expect(climber(state, 'a').height).toBe(5);
    expect(climber(state, 'b').height).toBe(0);
  });

  test('choices stay hidden from the others until they are revealed', () => {
    let state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed: 1 });
    state = UNIQUE_STAIRS.step(state, { a: aim(1), b: aim(2) });
    const forB = UNIQUE_STAIRS.viewFor?.(state, { type: 'player', playerId: 'b' });
    const forWatcher = UNIQUE_STAIRS.viewFor?.(state, { type: 'spectator' });
    if (!forB || !forWatcher) throw new Error('Vue attendue');
    expect(climber(forB, 'a').choice).toBe(HIDDEN_CHOICE);
    expect(climber(forB, 'b').choice).toBe(5);
    expect(climber(forWatcher, 'b').choice).toBe(HIDDEN_CHOICE);
  });

  test('the first at the top wins, and the match ends after that round', () => {
    let state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed: 1 });
    state = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, height: one.id === 'c' ? 12 : 0 })),
    };
    state = chooseAll(state, { a: 1, b: 1, c: 5, d: 3 });
    // Le sommet au plus (15), et la partie finit une fois la révélation montrée.
    expect(climber(state, 'c').height).toBe(stairsTop(4));
    expect(UNIQUE_STAIRS.isOver(state)).toBe(false);
    state = wait(state, STAIRS_REVEAL_TIME);
    expect(UNIQUE_STAIRS.isOver(state)).toBe(true);
    expect(UNIQUE_STAIRS.ranking(state)).toEqual([['c'], ['d'], ['a', 'b']]);
  });

  test('otherwise the highest after the last round', () => {
    let state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed: 1 });
    for (let round = 0; round < STAIRS_ROUNDS; round++) {
      state = wait(state, CHOICE_TIME + STAIRS_REVEAL_TIME + 0.1);
    }
    expect(UNIQUE_STAIRS.isOver(state)).toBe(true);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(seed);
      let state = UNIQUE_STAIRS.create(PLAYERS, { practice: false, seed });
      while (!UNIQUE_STAIRS.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            UNIQUE_STAIRS.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = UNIQUE_STAIRS.step(state, inputs);
      }
      const ranking = UNIQUE_STAIRS.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
