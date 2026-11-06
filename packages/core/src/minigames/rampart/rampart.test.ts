import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT, sanitizeInput } from '../arena/arena';
import {
  FAST_STONE,
  HIT_DISTANCE,
  RAMPART,
  RAMPART_LIVES,
  RAMPART_TIME_LIMIT,
  type RampartState,
  type RampartStone,
  RING_RADIUS,
  reloadTime,
  SLOW_STONE,
  THROW_CHARGE_TIME,
} from './rampart';

const PLAYERS = ['s', 'a', 'b', 'c'];
const match = () => RAMPART.create(PLAYERS, { practice: false, seed: 1, solo: 's' });
const run = (state: RampartState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = RAMPART.step(current, inputs);
  return current;
};
const press = { ...IDLE_INPUT, primary: true };
const thrower = (state: RampartState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Lanceur attendu : ${id}`);
  return found;
};

/** Une pierre en vol vers le centre, venant de l'angle `angle`, à `distance` du centre. */
function stone(id: number, angle: number, distance: number, speed = 6): RampartStone {
  const dx = -Math.sin(angle);
  const dz = -Math.cos(angle);
  return {
    id,
    thrower: 'a',
    x: -dx * distance,
    z: -dz * distance,
    dx,
    dz,
    speed,
    thrownAt: 0,
    from: distance,
    endedAt: null,
    end: null,
  };
}
/** La partie avec ces pierres en vol, personne d'autre ne lance. */
const withStones = (...stones: RampartStone[]): RampartState => ({
  ...match(),
  stones,
  nextStone: stones.length,
  fighters: match().fighters.map((one) => ({ ...one, stoneAt: Number.POSITIVE_INFINITY })),
});

describe('the rampart', () => {
  test('puts the lone player in the middle and the throwers around, each with a stone', () => {
    const state = match();
    expect(Math.hypot(state.solo.x, state.solo.z)).toBe(0);
    for (const one of state.fighters) {
      expect(Math.hypot(one.x, one.z)).toBeCloseTo(RING_RADIUS);
      expect(one.stoneAt).toBeLessThanOrEqual(state.tick);
    }
  });

  test('right turns a thrower clockwise around the ring, wherever he stands; up and down do nothing', () => {
    const right = { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    // En haut de l'écran (derrière le joueur seul), droite va vers la droite.
    const top = thrower(run(match(), { a: right }, 15), 'a');
    expect(Math.hypot(top.x, top.z)).toBeCloseTo(RING_RADIUS);
    expect(top.x).toBeGreaterThan(0.5);
    // Sur le côté droit du cercle, droite descend vers le bas de l'écran (sans passer par bas).
    const side = {
      ...match(),
      fighters: match().fighters.map((one) =>
        one.id === 'a' ? { ...one, angle: Math.PI / 2, x: RING_RADIUS, z: 0 } : one,
      ),
    };
    expect(thrower(run(side, { a: right }, 15), 'a').z).toBeGreaterThan(0.5);
    const up = { ...IDLE_INPUT, move: { x: 0, z: -1 } };
    expect(thrower(run(side, { a: up }, 15), 'a').angle).toBeCloseTo(Math.PI / 2);
  });

  test('a tap throws a slow stone, a full hold a fast one; then a new stone must be picked up', () => {
    const tapped = run(RAMPART.step(match(), { a: press }), {}, 1);
    expect(tapped.stones[0]?.speed).toBeCloseTo(SLOW_STONE, 0);
    const held = run(match(), { a: press }, Math.ceil(THROW_CHARGE_TIME / ARENA_STEP) + 1);
    expect(held.stones[0]?.speed).toBeCloseTo(FAST_STONE);
    // Sans pierre en main, l'appui ne fait rien.
    const again = run(run(tapped, { a: IDLE_INPUT }, 2), { a: press }, 3);
    expect(again.stones).toHaveLength(1);
    const reloaded = run(tapped, {}, Math.ceil(reloadTime(tapped) / ARENA_STEP));
    expect(run(RAMPART.step(reloaded, { a: press }), {}, 1).stones).toHaveLength(2);
  });

  test('a stone entering the zone in front of him breaks on its own', () => {
    // Il regarde la caméra (angle 0) : la pierre de face casse, celle de côté le touche.
    const state = run(withStones(stone(0, 0, 4.5), stone(1, Math.PI / 2, 4)), {}, 30);
    expect(state.stones.map((one) => one.end)).toEqual(['struck', 'hit']);
    expect(state.solo.broken).toBe(1);
    expect(state.solo.lives).toBe(RAMPART_LIVES - 1);
  });

  test('turning toward a stone from behind breaks it before it reaches him', () => {
    const back = { ...IDLE_INPUT, move: { x: 0, z: -1 } };
    const state = run(withStones(stone(0, Math.PI, 5)), { s: back }, 30);
    expect(state.stones[0]?.end).toBe('struck');
    expect(state.solo.lives).toBe(RAMPART_LIVES);
  });

  test('pointing the mouse turns him toward it, fast but not at once; keys win over the mouse', () => {
    // La souris derrière lui (en haut de l'écran) : un demi-tour.
    const behind = { ...IDLE_INPUT, point: { x: 0, z: -4 } };
    const first = RAMPART.step(match(), { s: behind });
    expect(Math.abs(first.solo.facing)).toBeGreaterThan(0.1);
    expect(Math.abs(first.solo.facing)).toBeLessThan(1);
    const turned = run(match(), { s: behind }, 10);
    expect(Math.abs(Math.abs(turned.solo.facing) - Math.PI)).toBeLessThan(0.01);
    // Une direction au clavier passe avant la souris : il regarde à droite.
    const keys = { ...behind, move: { x: 1, z: 0 } };
    expect(run(match(), { s: keys }, 10).solo.facing).toBeCloseTo(Math.PI / 2);
  });

  test('an aimed point from a client is kept within bounds', () => {
    expect(sanitizeInput({ point: { x: 2, z: -3 } }).point).toEqual({ x: 2, z: -3 });
    expect(sanitizeInput({ point: { x: 1e9, z: 0 } }).point).toEqual({ x: 50, z: 0 });
    expect(sanitizeInput({ point: { x: Number.NaN, z: 0 } }).point).toBeNull();
    expect(sanitizeInput({ point: 'here' }).point).toBeNull();
  });

  test('a stone from behind hits him; three hits and the throwers win', () => {
    let state = withStones(
      stone(0, Math.PI, 3),
      stone(1, Math.PI + 1, 6),
      stone(2, Math.PI - 1, 9),
    );
    while (!RAMPART.isOver(state)) state = RAMPART.step(state, {});
    expect(state.solo.lives).toBe(0);
    expect(thrower(state, 'a').hits).toBe(3);
    expect(RAMPART.ranking(state)).toEqual([['a', 'b', 'c'], ['s']]);
  });

  test('two stones arriving together smash into each other over his head', () => {
    let state = withStones(stone(0, Math.PI / 2, 4), stone(1, -Math.PI / 2, 4));
    state = run(state, {}, Math.ceil((4 - HIT_DISTANCE) / 6 / ARENA_STEP) + 1);
    expect(state.stones.map((one) => one.end)).toEqual(['clash', 'clash']);
    expect(state.solo.lives).toBe(RAMPART_LIVES);
  });

  test('he wins if he still stands when the clock runs out', () => {
    const state = run(withStones(), {}, Math.ceil(RAMPART_TIME_LIMIT / ARENA_STEP));
    expect(RAMPART.isOver(state)).toBe(true);
    expect(RAMPART.ranking(state)).toEqual([['s'], ['a', 'b', 'c']]);
  });

  test('at practice, the dummy thrower keeps throwing, and nothing ever ends', () => {
    const start = RAMPART.create(['s', 'dummy'], { practice: true, seed: 1, solo: 's' });
    const state = run(start, {}, 30 * 20);
    expect(thrower(state, 'dummy').thrown).toBeGreaterThan(5);
    expect(state.solo.lives).toBe(RAMPART_LIVES);
    expect(RAMPART.isOver(state)).toBe(false);
    expect(RAMPART.timeLeft(state)).toBeNull();
  });

  test('bots play whole matches: the expert lone player holds out more than the easy one', () => {
    const wins = (level: BotLevel) => {
      let count = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const rng = new Rng(seed);
        let state = RAMPART.create(PLAYERS, { practice: false, seed, solo: 's' });
        while (!RAMPART.isOver(state)) {
          const inputs = Object.fromEntries(
            PLAYERS.map((id) => [
              id,
              RAMPART.botInput(state, id, id === 's' ? level : 'normal', rng),
            ]),
          );
          state = RAMPART.step(state, inputs);
        }
        expect(RAMPART.ranking(state).flat().sort()).toEqual([...PLAYERS].sort());
        if (state.solo.lives > 0) count += 1;
      }
      return count;
    };
    expect(wins('expert')).toBeGreaterThan(wins('easy'));
  });
});
