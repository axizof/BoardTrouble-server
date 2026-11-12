import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput } from '../arena/arena';
import {
  isSuddenDeath,
  PILE_TIME_LIMIT,
  PILE_UP,
  type PileState,
  pileDrop,
  pileHeight,
  restingLean,
  SUDDEN_DEATH,
  TEETER,
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

/** Une pile qui part, au seuil du sauvetage. */
function teetering(seed: number, players: string[]): PileState {
  const state = PILE_UP.create(players, { practice: false, seed });
  return {
    ...state,
    fighters: state.fighters.map((stacker, index) =>
      index === 0
        ? {
            ...stacker,
            tilt: TEETER + 0.01,
            spin: 0.5,
            items: [...stacker.items, { kind: 'crate', offset: 0 }],
          }
        : stacker,
    ),
  };
}

describe('Gare à la pile !', () => {
  test('the same objects fall for everyone, near the middle, faster and faster', () => {
    expect(pileDrop(5, 0)).toMatchObject({ kind: 'crate', x: 0 });
    expect(pileDrop(5, 3)).toEqual(pileDrop(5, 3));
    let id = 1;
    for (; pileDrop(5, id).landAt * ARENA_STEP < SUDDEN_DEATH; id++) {
      expect(Math.abs(pileDrop(5, id).x)).toBeLessThanOrEqual(0.75);
    }
    const early = pileDrop(5, 2).landAt - pileDrop(5, 1).landAt;
    const sudden = pileDrop(5, id + 2).landAt - pileDrop(5, id + 1).landAt;
    expect(sudden).toBeLessThan(early / 2);
  });

  test('an object always lands on the pile: at worst on its very edge', () => {
    const state = PILE_UP.create(['under', 'far'], { practice: false, seed: 2 });
    const placed: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) =>
        stacker.id === 'far' ? { ...stacker, x: 1.2 } : stacker,
      ),
    };
    const landed = run(
      placed,
      (s) => s.nextDrop > 0,
      () => ({ under: still, far: still }),
    );
    const [under, far] = landed.fighters;
    expect(under?.items).toHaveLength(2);
    expect(under?.last?.isEdge).toBe(false);
    expect(far?.items).toHaveLength(2);
    expect(far?.last?.isEdge).toBe(true);
    // Sur le bord gauche de son plateau (l'objet tombait à sa gauche), pas à côté.
    expect(far?.items[1]?.offset).toBeLessThan(-0.5);
    expect(far?.items[1]?.offset).toBeGreaterThan(-0.7);
  });

  test('a small pile held still stays steady: no rescue, it settles', () => {
    const state = PILE_UP.create(['a'], { practice: false, seed: 3 });
    const later = run(
      state,
      (s) => s.tick > steps(12),
      () => ({ a: still }),
    );
    const a = later.fighters[0];
    expect(a?.fellAt).toBeNull();
    expect(a?.rescue).toBeNull();
    expect(Math.abs(a?.tilt ?? 1)).toBeLessThan(TEETER / 2);
  });

  test('weight set off to one side leans the pile that way, more when it is high', () => {
    const tray = { kind: 'tray' as const, offset: 0 };
    const low = [tray, { kind: 'brick' as const, offset: 0.3 }];
    const high = [
      tray,
      { kind: 'crate' as const, offset: 0.3 },
      { kind: 'crate' as const, offset: 0.3 },
      { kind: 'crate' as const, offset: 0.3 },
      { kind: 'brick' as const, offset: 0.3 },
    ];
    expect(restingLean(low)).toBeGreaterThan(0);
    expect(restingLean(high)).toBeGreaterThan(restingLean(low));
    expect(pileHeight(high)).toBeGreaterThan(pileHeight(low));
    expect(restingLean([tray, { kind: 'brick', offset: -0.3 }])).toBeLessThan(0);
  });

  test('a pile that tips starts a rescue: mash Action enough and it swings back', () => {
    const start = PILE_UP.step(teetering(4, ['a']), { a: still });
    const rescue = start.fighters[0]?.rescue;
    if (!rescue) throw new Error('pas de sauvetage');
    expect(rescue.side).toBe(1);
    let state = start;
    for (let k = 0; k < rescue.needed * 2 + 2; k++) {
      state = PILE_UP.step(state, { a: { ...still, primary: k % 2 === 0 } });
    }
    const saved = state.fighters[0];
    expect(saved?.rescue).toBeNull();
    expect(saved?.savedAt).not.toBeNull();
    expect(saved?.spin).toBeLessThan(0);
    expect(saved?.fellAt).toBeNull();
  });

  test('each rescue tires you: the next one asks for more presses', () => {
    const first = PILE_UP.step(teetering(4, ['a']), { a: still });
    const needed = first.fighters[0]?.rescue?.needed ?? 0;
    const tired: PileState = {
      ...first,
      fighters: first.fighters.map((stacker) => ({ ...stacker, rescue: null })),
    };
    const again = PILE_UP.step(
      {
        ...tired,
        fighters: tired.fighters.map((stacker) => ({ ...stacker, tilt: TEETER + 0.01, spin: 0.5 })),
      },
      { a: still },
    );
    expect(again.fighters[0]?.rescue?.needed).toBeGreaterThan(needed);
  });

  test('without mashing, the rescue runs out and the pile falls: its holder is out', () => {
    const state = PILE_UP.step(teetering(4, ['a', 'b']), { a: still, b: still });
    const fallen = run(
      state,
      (s) => s.fighters[0]?.fellAt !== null,
      () => ({ a: still, b: still }),
    );
    expect(fallen.fighters[0]?.fellAt).not.toBeNull();
    expect(PILE_UP.isOver(fallen)).toBe(true);
    expect(PILE_UP.ranking(fallen)).toEqual([['b'], ['a']]);
  });

  test('after the clock comes sudden death; at the very end, those standing tie', () => {
    const state = PILE_UP.create(['a', 'b'], { practice: false, seed: 6 });
    const late: PileState = { ...state, tick: steps(SUDDEN_DEATH) + 1, nextDrop: 1000 };
    expect(isSuddenDeath(late)).toBe(true);
    expect(PILE_UP.timeLeft(late)).toBeNull();
    expect(PILE_UP.timeLeft(state)).toBe(SUDDEN_DEATH);
    const ended: PileState = { ...late, tick: steps(PILE_TIME_LIMIT + 2) };
    expect(PILE_UP.isOver(ended)).toBe(true);
    expect(PILE_UP.ranking(ended)).toEqual([['a', 'b']]);
  });

  test('bots play it out: the expert lasts longer than the easy one', () => {
    let lasted = { easy: 0, expert: 0 };
    for (let seed = 1; seed <= 8; seed++) {
      let state = PILE_UP.create(['easy', 'expert'], { practice: false, seed });
      const rng = new Rng(seed);
      state = run(
        state,
        (s) => s.fighters.every((stacker) => stacker.fellAt !== null),
        (s) => ({
          easy: PILE_UP.botInput(s, 'easy', 'easy', rng),
          expert: PILE_UP.botInput(s, 'expert', 'expert', rng),
        }),
      );
      for (const stacker of state.fighters) {
        const level = stacker.id as 'easy' | 'expert';
        lasted = { ...lasted, [level]: lasted[level] + (stacker.fellAt ?? state.tick) };
      }
    }
    expect(lasted.expert).toBeGreaterThan(lasted.easy);
  });

  test('in the sandbox, a failed rescue brings back a fresh pile', () => {
    const state = PILE_UP.create(['you'], { practice: true, seed: 1 });
    const tipping: PileState = {
      ...state,
      fighters: state.fighters.map((stacker) => ({ ...stacker, tilt: TEETER + 0.01, spin: 1 })),
    };
    const later = run(
      tipping,
      (s) => s.tick > steps(3),
      () => ({ you: still }),
    );
    expect(later.fighters[0]?.fellAt).toBeNull();
    expect(later.fighters[0]?.falls).toBe(1);
    expect(PILE_UP.isOver(later)).toBe(false);
  });
});
