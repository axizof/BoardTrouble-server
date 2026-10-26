import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BASE_WIDTH,
  movingBlockX,
  PERFECT_SNAP,
  STACK_TIME_LIMIT,
  STACKER,
  type StackState,
  towerHeight,
} from './stacker';

const PRESS: ArenaInput = { ...IDLE_INPUT, primary: true };

const fighter = (state: StackState, id = 'a') => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};

/** Avance jusqu'à ce que le bloc de `a` soit en `x` (à un pas près), puis le lâche. */
function dropAt(state: StackState, x: number): StackState {
  let current = state;
  for (let i = 0; i < 600; i++) {
    const now = movingBlockX(fighter(current), current.tick + 1);
    const next = movingBlockX(fighter(current), current.tick + 2);
    if (now !== null && next !== null && (now - x) * (next - x) <= 0) {
      current = STACKER.step(current, {});
      return STACKER.step(current, { a: PRESS });
    }
    current = STACKER.step(current, {});
  }
  throw new Error(`Le bloc n'est jamais passé en ${x}`);
}

describe('stacker', () => {
  test('a block dropped off-centre is cut to what lies on the block below', () => {
    const state = STACKER.create(['a'], { practice: false, seed: 1 });
    const dropped = dropAt(state, 0.8);
    const a = fighter(dropped);
    expect(towerHeight(a)).toBe(1);
    const top = a.blocks.at(-1);
    // À peu près 0,8 m de moins, et décalé d'autant de moitié vers où on l'a lâché.
    expect(top?.width).toBeCloseTo(BASE_WIDTH - 0.8, 0);
    expect(top?.x).toBeGreaterThan(0.3);
    expect(a.cut?.width).toBeCloseTo(BASE_WIDTH - (top?.width ?? 0));
    expect(a.cut?.x).toBeGreaterThan(BASE_WIDTH / 2);
  });

  test('a block dropped almost right on top lands exactly, without a cut', () => {
    const dropped = dropAt(STACKER.create(['a'], { practice: false, seed: 1 }), PERFECT_SNAP / 3);
    const a = fighter(dropped);
    expect(a.blocks.at(-1)).toEqual({ x: 0, width: BASE_WIDTH });
    expect(a.wasPerfect).toBe(true);
    expect(a.cut).toBeNull();
  });

  test('a block dropped beside the tower ends it, except in practice', () => {
    // Un bloc étroit : deux poses très décalées, puis une à côté.
    let state = STACKER.create(['a'], { practice: false, seed: 1 });
    state = dropAt(state, 1.8);
    state = dropAt(state, 1.6);
    const narrow = fighter(state).blocks.at(-1);
    expect(narrow?.width).toBeLessThan(0.5);
    const ended = dropAt(state, -2);
    expect(fighter(ended).isDone).toBe(true);
    expect(movingBlockX(fighter(ended), ended.tick + 30)).toBeNull();

    const practice = STACKER.create(['a'], { practice: true, seed: 1 });
    const restarted = dropAt(dropAt(dropAt(practice, 1.8), 1.6), -2);
    expect(fighter(restarted).isDone).toBe(false);
    expect(towerHeight(fighter(restarted))).toBe(0);
  });

  test('the tallest tower wins, then the first to reach its height', () => {
    let state = STACKER.create(['a', 'b'], { practice: false, seed: 1 });
    state = {
      ...state,
      fighters: [
        {
          ...fighter(state, 'a'),
          blocks: [
            { x: 0, width: 2 },
            { x: 0, width: 2 },
          ],
          placedAt: 50,
        },
        {
          ...fighter(state, 'b'),
          blocks: [
            { x: 0, width: 2 },
            { x: 0, width: 2 },
          ],
          placedAt: 40,
        },
      ],
    };
    expect(STACKER.ranking(state)).toEqual([['b'], ['a']]);
    const tied = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, placedAt: 40 })),
    };
    expect(STACKER.ranking(tied)).toEqual([['a', 'b']]);
  });

  test('the clock stops the match after 45 seconds', () => {
    let state = STACKER.create(['a', 'b'], { practice: false, seed: 1 });
    while (!STACKER.isOver(state)) state = STACKER.step(state, {});
    expect(state.tick * ARENA_STEP).toBeCloseTo(STACK_TIME_LIMIT, 1);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const players = ['a', 'b', 'c', 'd'];
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = STACKER.create(players, { practice: false, seed });
      while (!STACKER.isOver(state)) {
        const inputs = Object.fromEntries(
          players.map((id, index) => [
            id,
            STACKER.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = STACKER.step(state, inputs);
      }
      const ranking = STACKER.ranking(state);
      expect(ranking.flat().sort()).toEqual([...players].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
