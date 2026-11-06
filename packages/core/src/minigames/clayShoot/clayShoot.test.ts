import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CLAY_SHOOT,
  CLAY_VOLLEYS,
  type ClayDisc,
  type ClayState,
  type ClayZone,
  clayAimOf,
  discPosition,
  isInZone,
  SHELLS,
  SILVER_POINTS,
  zoneCrossing,
} from './clayShoot';

const fire: ArenaInput = { ...IDLE_INPUT, primary: true };
const toward = (zone: ClayZone): ArenaInput => ({
  ...IDLE_INPUT,
  move: zone === 'up' ? { x: 0, z: -1 } : { x: zone === 'left' ? -1 : 1, z: 0 },
});
const duel = (practice = false) => CLAY_SHOOT.create(['a', 'b'], { practice, seed: 1 });
const shooter = (state: ClayState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Tireur attendu : ${id}`);
  return found;
};
const run = (state: ClayState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = CLAY_SHOOT.step(current, inputs);
  return current;
};
/** Avance jusqu'à la première volée. */
const firstVolley = () => {
  let state = duel();
  while (state.volley === 0) state = CLAY_SHOOT.step(state, {});
  return state;
};
const discOf = (state: ClayState, owner: string | null) => {
  const found = state.discs.find((disc) => disc.owner === owner && disc.brokenAt === null);
  if (!found) throw new Error(`Plateau attendu : ${owner}`);
  return found;
};
/** Une zone que le plateau traverse, et le pas où il y passe au plus près. */
function crossing(disc: ClayDisc): { zone: ClayZone; at: number } {
  for (const zone of ['left', 'up', 'right'] as const) {
    const at = zoneCrossing(disc, zone);
    if (at !== null) return { zone, at };
  }
  throw new Error('Plateau qui ne traverse aucune zone');
}
/** Vise la zone, attend le passage au plus près, et tire. */
function shootAt(state: ClayState, id: string, disc: ClayDisc): ClayState {
  const { zone, at } = crossing(disc);
  let current = CLAY_SHOOT.step(state, { [id]: toward(zone) });
  while (current.tick + 1 < at) current = CLAY_SHOOT.step(current, {});
  return CLAY_SHOOT.step(current, { [id]: fire });
}

describe('the clay shoot', () => {
  test('each volley throws both discs at once, mirrored, each through at least one zone', () => {
    const state = firstVolley();
    const mine = discOf(state, 'a');
    const theirs = discOf(state, 'b');
    expect(mine.launchAt).toBe(theirs.launchAt);
    expect(mine.x0).toBe(-theirs.x0);
    expect(mine.vx).toBe(-theirs.vx);
    expect(() => crossing(mine)).not.toThrow();
  });

  test('a shot breaks your disc when it is in your zone; the shells refill at the next volley', () => {
    const start = firstVolley();
    const state = shootAt(start, 'a', discOf(start, 'a'));
    expect(state.discs.find((disc) => disc.owner === 'a')?.brokenBy).toEqual(['a']);
    expect(shooter(state, 'a').points).toBe(1);
    expect(shooter(state, 'a').shells).toBe(SHELLS - 1);
    let next = state;
    while (next.volley === 1) next = CLAY_SHOOT.step(next, {});
    expect(shooter(next, 'a').shells).toBe(SHELLS);
  });

  test('a shot outside the disc wastes a shell; with none left, nothing happens', () => {
    const start = firstVolley();
    let state = CLAY_SHOOT.step(start, { a: fire });
    state = CLAY_SHOOT.step(CLAY_SHOOT.step(state, {}), { a: fire });
    expect(shooter(state, 'a').shells).toBe(0);
    state = CLAY_SHOOT.step(CLAY_SHOOT.step(state, {}), { a: fire });
    expect(shooter(state, 'a').shells).toBe(0);
    expect(shooter(state, 'a').points).toBe(0);
  });

  test("the other's disc cannot be broken, the silver one goes to the first", () => {
    const start = firstVolley();
    // b tire sur le passage du plateau de a : rien.
    const state = shootAt(start, 'b', discOf(start, 'a'));
    expect(discOf(state, 'a').brokenAt).toBeNull();
    const silver: ClayDisc = { ...discOf(start, 'a'), id: 99, owner: null };
    const withSilver = { ...start, discs: [...start.discs, silver] };
    const won = shootAt(withSilver, 'b', silver);
    expect(won.discs.find((disc) => disc.id === 99)?.brokenBy).toEqual(['b']);
    expect(shooter(won, 'b').points).toBe(SILVER_POINTS);
  });

  test('both on the silver one at the same moment: one point each', () => {
    const start = firstVolley();
    const silver: ClayDisc = { ...discOf(start, 'a'), id: 99, owner: null };
    const { zone, at } = crossing(silver);
    let state: ClayState = { ...start, discs: [silver] };
    state = CLAY_SHOOT.step(state, { a: toward(zone), b: toward(zone) });
    while (state.tick + 1 < at) state = CLAY_SHOOT.step(state, {});
    expect(isInZone(discPosition(silver, at), zone)).toBe(true);
    state = CLAY_SHOOT.step(state, { a: fire, b: fire });
    expect(state.fighters.map((one) => one.points)).toEqual([1, 1]);
  });

  test('a direction picks the zone, down keeps it, the mouse picks the nearest one', () => {
    expect(clayAimOf(toward('left'), 'up')).toBe('left');
    expect(clayAimOf(toward('right'), 'up')).toBe('right');
    expect(clayAimOf({ ...IDLE_INPUT, move: { x: 0, z: 1 } }, 'left')).toBe('left');
    // La souris : le point du ciel, sa hauteur dans `z`.
    expect(clayAimOf({ ...IDLE_INPUT, point: { x: 3, z: 4.5 } }, 'up')).toBe('right');
    expect(clayAimOf({ ...IDLE_INPUT, point: { x: 30, z: 30 } }, 'up')).toBe('up');
  });

  test('the match ends after the last volley; the most points wins', () => {
    let state = duel();
    while (!CLAY_SHOOT.isOver(state)) {
      const mine = state.discs.find((disc) => disc.owner === 'a' && disc.brokenAt === null);
      state =
        mine && state.tick >= mine.launchAt
          ? shootAt(state, 'a', mine)
          : CLAY_SHOOT.step(state, {});
    }
    expect(state.volley).toBe(CLAY_VOLLEYS);
    expect(shooter(state, 'a').points).toBeGreaterThanOrEqual(CLAY_VOLLEYS);
    expect(CLAY_SHOOT.ranking(state)).toEqual([['a'], ['b']]);
  });

  test('at practice, the volleys never end', () => {
    const state = run(duel(true), {}, 30 * 60);
    expect(state.volley).toBeGreaterThan(CLAY_VOLLEYS);
    expect(CLAY_SHOOT.isOver(state)).toBe(false);
  });

  test('bots shoot whole matches, the expert scoring more than the easy one', () => {
    let easy = 0;
    let expert = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = CLAY_SHOOT.create(['e', 'x'], { practice: false, seed });
      while (!CLAY_SHOOT.isOver(state)) {
        state = CLAY_SHOOT.step(state, {
          e: CLAY_SHOOT.botInput(state, 'e', 'easy', rng),
          x: CLAY_SHOOT.botInput(state, 'x', 'expert', rng),
        });
      }
      easy += shooter(state, 'e').points;
      expert += shooter(state, 'x').points;
    }
    expect(expert).toBeGreaterThan(easy);
  });
});
