import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { BLANK, cellAt, cellsAround, PAINTABLE_CELLS } from './atelier';
import {
  areScoresHidden,
  BOMB_RADIUS,
  FRESH_PAINT,
  OTHER_SPEED,
  OWN_SPEED,
  PAINT_TIME,
  type PaintState,
  paintShare,
  SPONGE_RADIUS,
  speedFactor,
} from './freshPaint';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const walk = (x: number, z: number, extra: Partial<ArenaInput> = {}): ArenaInput => ({
  ...IDLE_INPUT,
  move: { x, z },
  ...extra,
});

/** Les joueurs a, b... posés là où on le dit, toile vierge, sans bonus. */
function placed(spots: { x: number; z: number }[]): PaintState {
  const ids = spots.map((_, index) => String.fromCharCode(97 + index));
  const state = FRESH_PAINT.create(ids, { practice: false, seed: 1 });
  return {
    ...state,
    nextBonusAt: Number.POSITIVE_INFINITY,
    fighters: state.fighters.map((one, index) => ({ ...one, ...spots[index] })),
  };
}

function paintAround(state: PaintState, x: number, z: number, radius: number, color: string) {
  const chars = state.paint.split('');
  for (const cell of cellsAround(x, z, radius)) chars[cell] = color;
  return { ...state, paint: chars.join('') };
}

const painter = (state: PaintState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`no painter ${id}`);
  return found;
};

describe('Peinture fraîche', () => {
  test('walking leaves a trail of your color', () => {
    let state = placed([{ x: -8, z: -6 }]);
    for (let k = 0; k < steps(2); k++) state = FRESH_PAINT.step(state, { a: walk(1, 0) });
    expect(state.paint[cellAt(-6, -6)]).toBe('1');
    expect(state.paint[cellAt(-8, 0)]).toBe(BLANK);
    expect(paintShare(state, 'a')).toBeGreaterThan(0);
  });

  test('the paint sticks: faster on your color, slower on another', () => {
    let state = placed([
      { x: -8, z: -6 },
      { x: 8, z: 6 },
    ]);
    expect(speedFactor(state.paint, painter(state, 'a'))).toBe(1);
    state = paintAround(state, -8, -6, 1, '1');
    expect(speedFactor(state.paint, painter(state, 'a'))).toBe(OWN_SPEED);
    state = paintAround(state, -8, -6, 1, '2');
    expect(speedFactor(state.paint, painter(state, 'a'))).toBe(OTHER_SPEED);
  });

  test('a dash trips the one in front, who drops a puddle of the dasher color', () => {
    let state = placed([
      { x: -1.2, z: 5 },
      { x: 0, z: 5 },
    ]);
    state = FRESH_PAINT.step(state, { a: walk(1, 0, { primary: true }) });
    state = FRESH_PAINT.step(state, {});
    const tripped = painter(state, 'b');
    expect(tripped.trippedAt).not.toBeNull();
    expect(tripped.downed).toBeGreaterThan(0);
    expect(state.paint[cellAt(tripped.x, tripped.z)]).toBe('1');
  });

  test('the bomb is thrown ahead and repaints a wide area; the sponge wipes the others around', () => {
    let state = placed([
      { x: -6, z: 6 },
      { x: 8, z: -6 },
    ]);
    state = {
      ...state,
      fighters: state.fighters.map((one) =>
        one.id === 'a' ? { ...one, bombSince: 0, facing: Math.PI / 2 } : one,
      ),
    };
    state = FRESH_PAINT.step(state, { a: { ...IDLE_INPUT, secondary: true } });
    for (let k = 0; k < steps(1); k++) state = FRESH_PAINT.step(state, {});
    expect(state.effects.some((one) => one.kind === 'bomb' && one.doneAt !== null)).toBe(true);
    expect(cellsAround(-1, 6, BOMB_RADIUS - 0.5).every((cell) => state.paint[cell] === '1')).toBe(
      true,
    );
    // b ramasse une éponge au milieu du rond de a : tout ce qui n'est pas à lui autour s'efface.
    state = {
      ...state,
      fighters: state.fighters.map((one) => (one.id === 'b' ? { ...one, x: -1, z: 6 } : one)),
      bonuses: [{ id: 9, kind: 'sponge', x: -1, z: 6, spawnedAt: state.tick }],
    };
    state = FRESH_PAINT.step(state, {});
    state = FRESH_PAINT.step(state, {});
    const wiped = cellsAround(-1, 6, SPONGE_RADIUS - 0.2);
    expect(wiped.every((cell) => state.paint[cell] !== '1')).toBe(true);
  });

  test('the roller paints a wider trail for a while', () => {
    let state = placed([{ x: -8, z: 0 }]);
    state = { ...state, bonuses: [{ id: 0, kind: 'roller', x: -8, z: 0, spawnedAt: 0 }] };
    for (let k = 0; k < steps(1); k++) state = FRESH_PAINT.step(state, { a: walk(1, 0) });
    expect(state.paint[cellAt(-6.5, 1)]).toBe('1');
  });

  test('the scores hide in the last seconds, and the biggest surface wins', () => {
    let state = placed([
      { x: -8, z: -6 },
      { x: 8, z: 6 },
    ]);
    state = paintAround(state, 0, 6, 3, '2');
    state = paintAround(state, 0, -6, 2, '1');
    expect(areScoresHidden(state)).toBe(false);
    state = { ...state, tick: steps(PAINT_TIME - 5) };
    expect(areScoresHidden(state)).toBe(true);
    expect(FRESH_PAINT.ranking(state)).toEqual([['b'], ['a']]);
    expect(FRESH_PAINT.reveal?.score(state, 'b')).toBeCloseTo(
      (cellsAround(0, 6, 3).length / PAINTABLE_CELLS) * 100,
      5,
    );
  });

  test('between bots, the game lasts PAINT_TIME and covers most of the canvas', () => {
    const ids = ['a', 'b', 'c', 'd'];
    let state = FRESH_PAINT.create(ids, { practice: false, seed: 2 });
    const rng = new Rng(2);
    while (!FRESH_PAINT.isOver(state)) {
      const current = state;
      state = FRESH_PAINT.step(
        current,
        Object.fromEntries(ids.map((id) => [id, FRESH_PAINT.botInput(current, id, 'normal', rng)])),
      );
    }
    expect(state.tick).toBe(steps(PAINT_TIME));
    const total = ids.reduce((sum, id) => sum + paintShare(state, id), 0);
    expect(total).toBeGreaterThan(40);
  });
});
