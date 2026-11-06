import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
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
  STUMBLE_TIME,
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

  test('a thrower walks along the ring, never off it', () => {
    const start = match();
    const before = thrower(start, 'a');
    const walked = run(start, { a: { ...IDLE_INPUT, move: { x: 1, z: 0 } } }, 30);
    const after = thrower(walked, 'a');
    expect(Math.hypot(after.x, after.z)).toBeCloseTo(RING_RADIUS);
    expect(Math.abs(after.angle - before.angle)).toBeGreaterThan(0.3);
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

  test('a strike breaks the stone in front, close by, and another can follow at once', () => {
    // Il regarde la caméra (angle 0) : deux pierres arrivent de là, l'une derrière l'autre.
    let state = withStones(stone(0, 0, 2.2), stone(1, 0, 4.5));
    state = RAMPART.step(state, { s: press });
    expect(state.stones[0]?.end).toBe('struck');
    state = run(state, { s: IDLE_INPUT }, 1);
    while ((state.stones[1]?.x ?? 0) ** 2 + (state.stones[1]?.z ?? 0) ** 2 > 2 ** 2) {
      state = RAMPART.step(state, { s: IDLE_INPUT });
    }
    state = RAMPART.step(state, { s: press });
    expect(state.stones[1]?.end).toBe('struck');
    expect(state.solo.broken).toBe(2);
    expect(state.solo.lives).toBe(RAMPART_LIVES);
  });

  test('striking too early misses and trips him up: he cannot strike again for a while', () => {
    let state = withStones(stone(0, 0, 6));
    state = run(state, { s: press }, 1);
    state = run(state, { s: IDLE_INPUT }, 6);
    expect(state.solo.stumbleUntil).not.toBeNull();
    // La pierre arrive pendant qu'il se relève : il a beau frapper, elle le touche.
    for (let i = 0; i < Math.ceil(STUMBLE_TIME / ARENA_STEP) - 8; i++) {
      state = RAMPART.step(state, { s: i % 2 === 0 ? press : IDLE_INPUT });
    }
    expect(state.stones[0]?.end).toBe('hit');
    expect(state.solo.lives).toBe(RAMPART_LIVES - 1);
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
