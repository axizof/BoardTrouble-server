import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput } from '../arena/arena';
import {
  COLLAPSE,
  effectiveLean,
  LANE_HALF,
  PILE_ITEMS,
  PILE_TIME_LIMIT,
  PILE_UP,
  type PileState,
  pileDrop,
  pileHeight,
  topCenter,
} from './pileUp';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const still: ArenaInput = { move: { x: 0, z: 0 }, primary: false, secondary: false };

function run(
  state: PileState,
  until: (state: PileState) => boolean,
  inputs: (state: PileState) => Partial<Record<string, ArenaInput>> = () => ({}),
): PileState {
  let current = state;
  for (let tick = 0; tick < steps(PILE_TIME_LIMIT + 5) && !until(current); tick++) {
    current = PILE_UP.step(current, inputs(current));
  }
  return current;
}

describe('Gare à la pile !', () => {
  test('the same objects fall for everyone, closer and closer together', () => {
    const first = pileDrop(5, 0);
    expect(first.kind).toBe('crate');
    expect(pileDrop(5, 3)).toEqual(pileDrop(5, 3));
    const early = pileDrop(5, 2).landAt - pileDrop(5, 1).landAt;
    let late = 0;
    for (let id = 1; pileDrop(5, id).landAt * ARENA_STEP < PILE_TIME_LIMIT; id++) {
      late = pileDrop(5, id).landAt - pileDrop(5, id - 1).landAt;
      expect(Math.abs(pileDrop(5, id).x)).toBeLessThanOrEqual(1.3);
    }
    expect(late).toBeLessThan(early);
  });

  test('an object right over the pile lands on it; one off to the side misses', () => {
    const state = PILE_UP.create(['under', 'aside'], { practice: false, seed: 2 });
    const drop = pileDrop(2, 0);
    const placed: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) =>
        stacker.id === 'under'
          ? { ...stacker, x: drop.x }
          : { ...stacker, x: drop.x > 0 ? -1.8 : 1.8 },
      ),
    };
    const landed = run(
      placed,
      (s) => s.nextDrop > 0,
      () => ({ under: still, aside: still }),
    );
    const [under, aside] = landed.fighters;
    expect(under?.items).toHaveLength(2);
    expect(under?.last?.result).toBe('caught');
    expect(aside?.items).toHaveLength(1);
    expect(aside?.last?.result).toBe('missed');
  });

  test('an object set down off-centre leans the pile its way', () => {
    const state = PILE_UP.create(['a'], { practice: false, seed: 2 });
    const drop = pileDrop(2, 0);
    const offset: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) => ({ ...stacker, x: drop.x - 0.4 })),
    };
    const landed = run(offset, (s) => s.nextDrop > 0);
    const stacker = landed.fighters[0];
    if (!stacker) throw new Error('pas de joueur');
    expect(stacker.items[1]?.offset).toBeCloseTo(0.4, 1);
    expect(effectiveLean(stacker)).toBeGreaterThan(0);
    expect(topCenter(stacker)).toBeGreaterThan(stacker.x);
  });

  test('left alone, a leaning pile falls: its holder is out', () => {
    const state = PILE_UP.create(['a', 'b'], { practice: false, seed: 4 });
    const pushed: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) =>
        stacker.id === 'a'
          ? { ...stacker, tilt: 0.2, items: [...stacker.items, { kind: 'barrel', offset: 0 }] }
          : stacker,
      ),
    };
    const fallen = run(
      pushed,
      (s) => s.fighters[0]?.fellAt !== null,
      () => ({ a: still, b: still }),
    );
    const a = fallen.fighters[0];
    expect(a?.fellAt).not.toBeNull();
    expect(Math.abs(a?.tilt ?? 0)).toBeGreaterThan(COLLAPSE);
    expect(PILE_UP.isOver(fallen)).toBe(true);
    expect(PILE_UP.ranking(fallen)).toEqual([['b'], ['a']]);
  });

  test('the scaffold rail stops you at the edge of your lane', () => {
    const state = PILE_UP.create(['a'], { practice: true, seed: 1 });
    const right: ArenaInput = { move: { x: 1, z: 0 }, primary: false, secondary: false };
    const moved = run(
      state,
      (s) => s.tick > steps(2),
      () => ({ a: right }),
    );
    expect(moved.fighters[0]?.x).toBeLessThanOrEqual(LANE_HALF);
  });

  test('at the whistle, the piles freeze; those still standing rank by height', () => {
    const state = PILE_UP.create(['short', 'tall'], { practice: false, seed: 6 });
    const stacked: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) =>
        stacker.id === 'tall'
          ? { ...stacker, items: [...stacker.items, { kind: 'cushion', offset: 0 }] }
          : stacker,
      ),
    };
    // Personne ne reçoit plus rien ; des bots tiennent les deux piles jusqu'au coup de sifflet.
    const aside: PileState = { ...stacked, nextDrop: 1000 };
    const rng = new Rng(6);
    const ended = run(
      aside,
      (s) => PILE_UP.isOver(s),
      (s) => ({
        short: PILE_UP.botInput(s, 'short', 'expert', rng),
        tall: PILE_UP.botInput(s, 'tall', 'expert', rng),
      }),
    );
    expect(ended.fighters.every((stacker) => stacker.fellAt === null)).toBe(true);
    expect(PILE_UP.ranking(ended)).toEqual([['tall'], ['short']]);
    expect(pileHeight(ended.fighters[1]?.items ?? [])).toBeCloseTo(
      PILE_ITEMS.tray.height + PILE_ITEMS.cushion.height,
    );
  });

  test('bots play a full game: the expert builds higher and lasts longer than the easy one', () => {
    let lasted = { easy: 0, expert: 0 };
    let built = { easy: 0, expert: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      let state = PILE_UP.create(['easy', 'expert'], { practice: false, seed });
      const rng = new Rng(seed);
      state = run(
        state,
        (s) => s.tick * ARENA_STEP > PILE_TIME_LIMIT,
        (s) => ({
          easy: PILE_UP.botInput(s, 'easy', 'easy', rng),
          expert: PILE_UP.botInput(s, 'expert', 'expert', rng),
        }),
      );
      for (const stacker of state.fighters) {
        const level = stacker.id as 'easy' | 'expert';
        lasted = { ...lasted, [level]: lasted[level] + (stacker.fellAt ?? state.tick) };
        built = { ...built, [level]: built[level] + pileHeight(stacker.items) };
      }
    }
    expect(lasted.expert).toBeGreaterThan(lasted.easy);
    expect(built.expert).toBeGreaterThan(built.easy);
  });

  test('in the sandbox, a fallen pile comes back and nobody is out', () => {
    const state = PILE_UP.create(['you'], { practice: true, seed: 1 });
    const pushed: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) => ({ ...stacker, tilt: 0.65, spin: 2 })),
    };
    const later = run(
      pushed,
      (s) => s.tick > steps(3),
      () => ({ you: still }),
    );
    expect(later.fighters[0]?.fellAt).toBeNull();
    expect(later.fighters[0]?.falls).toBeGreaterThan(0);
    expect(PILE_UP.isOver(later)).toBe(false);
  });
});
