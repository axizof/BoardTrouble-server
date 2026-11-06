import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CLAY_RELOAD_TIME,
  CLAY_SHOOT,
  CLAY_VOLLEYS,
  type ClayDisc,
  type ClayState,
  discPosition,
  MIDDLE_REACH,
  SHELLS,
  SHOT_DELAY,
  SILVER_POINTS,
  SKY_HALF_WIDTH,
} from './clayShoot';

const duel = (practice = false) => CLAY_SHOOT.create(['a', 'b'], { practice, seed: 1 });
const shooter = (state: ClayState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Tireur attendu : ${id}`);
  return found;
};
const run = (state: ClayState, inputs: Record<string, ArenaInput>, count: number) => {
  let current = state;
  for (let i = 0; i < count; i++) current = CLAY_SHOOT.step(current, inputs);
  return current;
};
const aimAt = (x: number, y: number, primary = false): ArenaInput => ({
  ...IDLE_INPUT,
  primary,
  point: { x, z: y },
});
const delay = Math.round(SHOT_DELAY / ARENA_STEP);
/** Avance jusqu'à la première volée, puis un peu (les plateaux sont dans le ciel). */
const inFlight = () => {
  let state = duel();
  while (state.volley === 0) state = CLAY_SHOOT.step(state, {});
  return run(state, {}, 10);
};
const discOf = (state: ClayState, owner: string | null) => {
  const found = state.discs.find((disc) => disc.owner === owner);
  if (!found) throw new Error(`Plateau attendu : ${owner}`);
  return found;
};
/** Vise là où le plateau sera quand la gerbe arrivera, puis tire, et laisse la gerbe arriver. */
function leadAndShoot(state: ClayState, id: string, disc: ClayDisc): ClayState {
  const target = discPosition(disc, state.tick + 2 + delay);
  const aimed = CLAY_SHOOT.step(state, { [id]: aimAt(target.x, target.y) });
  return run(CLAY_SHOOT.step(aimed, { [id]: aimAt(target.x, target.y, true) }), {}, delay);
}

describe('the clay shoot', () => {
  test('each volley throws both discs at once, mirrored, one in each half of the sky', () => {
    const state = inFlight();
    const mine = discOf(state, 'a');
    const theirs = discOf(state, 'b');
    expect(mine.launchAt).toBe(theirs.launchAt);
    expect(mine.x0).toBe(-theirs.x0);
    expect(mine.vx).toBe(-theirs.vx);
    expect(discPosition(mine, state.tick).x).toBeLessThan(0);
  });

  test('the sight follows the pointer, but stays in its own half (up to just past the middle)', () => {
    const state = run(duel(), { a: aimAt(6, 4), b: aimAt(-6, 4) }, 1);
    expect(shooter(state, 'a').aimX).toBe(MIDDLE_REACH);
    expect(shooter(state, 'b').aimX).toBe(-MIDDLE_REACH);
    const far = run(duel(), { a: aimAt(-40, 40) }, 1);
    expect(shooter(far, 'a').aimX).toBe(-SKY_HALF_WIDTH);
  });

  test('the shot lands a moment later: leading the disc breaks it, aiming at it misses', () => {
    const start = inFlight();
    const disc = discOf(start, 'a');
    const now = discPosition(disc, start.tick + 2);
    const late = run(
      CLAY_SHOOT.step(CLAY_SHOOT.step(start, { a: aimAt(now.x, now.y) }), {
        a: aimAt(now.x, now.y, true),
      }),
      {},
      delay,
    );
    expect(discOf(late, 'a').brokenAt).toBeNull();
    const led = leadAndShoot(start, 'a', disc);
    expect(discOf(led, 'a').brokenBy).toEqual(['a']);
    expect(shooter(led, 'a').points).toBe(1);
  });

  test('two shells, then a one-second reload; a reload can also be asked for', () => {
    let state = duel();
    state = CLAY_SHOOT.step(state, { a: aimAt(-4, 4, true) });
    state = CLAY_SHOOT.step(CLAY_SHOOT.step(state, {}), { a: aimAt(-4, 4, true) });
    expect(shooter(state, 'a').shells).toBe(0);
    expect(shooter(state, 'a').reloadedAt).not.toBeNull();
    // Pendant la recharge, un tir ne part pas.
    state = CLAY_SHOOT.step(CLAY_SHOOT.step(state, {}), { a: aimAt(-4, 4, true) });
    expect(state.shots).toHaveLength(2);
    state = run(state, {}, Math.round(CLAY_RELOAD_TIME / ARENA_STEP));
    expect(shooter(state, 'a').shells).toBe(SHELLS);
    // Une cartouche tirée, recharger à la demande.
    state = CLAY_SHOOT.step(state, { a: aimAt(-4, 4, true) });
    state = CLAY_SHOOT.step(CLAY_SHOOT.step(state, {}), { a: { ...IDLE_INPUT, secondary: true } });
    expect(shooter(state, 'a').reloadedAt).not.toBeNull();
  });

  test("the other's disc cannot be broken; the silver one goes to the first, 1 each at once", () => {
    const start = inFlight();
    const theirs = discOf(start, 'b');
    // a vise le plateau de b (au milieu, s'il y passe) : rien.
    const state = leadAndShoot(start, 'a', theirs);
    expect(discOf(state, 'b').brokenAt).toBeNull();
    const silver: ClayDisc = {
      ...discOf(start, 'a'),
      id: 99,
      owner: null,
      x0: 0,
      y0: 0.2,
      vx: 0,
      vy: 8,
      launchAt: start.tick,
    };
    const alone = leadAndShoot({ ...start, discs: [silver] }, 'b', silver);
    expect(shooter(alone, 'b').points).toBe(SILVER_POINTS);
    const target = discPosition(silver, start.tick + 2 + delay);
    let both: ClayState = { ...start, discs: [silver] };
    both = CLAY_SHOOT.step(both, { a: aimAt(target.x, target.y), b: aimAt(target.x, target.y) });
    both = CLAY_SHOOT.step(both, {
      a: aimAt(target.x, target.y, true),
      b: aimAt(target.x, target.y, true),
    });
    both = run(both, {}, delay);
    expect(both.fighters.map((one) => one.points)).toEqual([1, 1]);
  });

  test('the match ends after the last volley; at practice, the volleys never end', () => {
    const state = run(duel(), {}, 30 * 60);
    expect(state.volley).toBe(CLAY_VOLLEYS);
    expect(CLAY_SHOOT.isOver(state)).toBe(true);
    expect(CLAY_SHOOT.ranking(state)).toEqual([['a', 'b']]);
    const practice = run(duel(true), {}, 30 * 60);
    expect(practice.volley).toBeGreaterThan(CLAY_VOLLEYS);
    expect(CLAY_SHOOT.isOver(practice)).toBe(false);
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
