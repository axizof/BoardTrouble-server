import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BIG_DIE,
  type BigDieState,
  cellCenter,
  DIE_TIME_LIMIT,
  LEAN_TICKS,
  ROLL_TICKS,
  SLAM_COOLDOWN,
  SLAM_TICKS,
} from './bigDie';

const PLAYERS = ['die', 'b', 'c', 'd'];
const push = (x: number, z: number): ArenaInput => ({ ...IDLE_INPUT, move: { x, z } });
const SLAM: ArenaInput = { ...IDLE_INPUT, primary: true };

function steps(state: BigDieState, count: number, inputs = {}): BigDieState {
  let next = state;
  for (let i = 0; i < count; i++) next = BIG_DIE.step(next, inputs);
  return next;
}

/** Pose un coureur au centre d'une case (décalé de `dx` mètres vers l'est), à l'arrêt. */
function place(state: BigDieState, id: string, col: number, row: number, dx = 0): BigDieState {
  const { x, z } = cellCenter(col, row);
  return {
    ...state,
    fighters: state.fighters.map((runner) =>
      runner.id === id ? { ...runner, x: x + dx, z, vx: 0, vz: 0 } : runner,
    ),
  };
}

const runner = (state: BigDieState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Coureur attendu : ${id}`);
  return found;
};

describe('big die', () => {
  test('the lone player is the die, in the middle; the others run', () => {
    const state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'c' });
    expect(state.die.id).toBe('c');
    expect(state.die.col).toBe(3);
    expect(state.fighters.map((one) => one.id)).toEqual(['die', 'b', 'd']);
    // À 6, un coureur de plus à écraser : un peu plus de temps.
    const six = BIG_DIE.create([...PLAYERS, 'e', 'f'], { practice: false, seed: 1 });
    expect(BIG_DIE.timeLeft(six)).toBeGreaterThan(DIE_TIME_LIMIT);
  });

  test('it leans, then tumbles onto the next cell and turns its faces', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, LEAN_TICKS + ROLL_TICKS, { die: push(1, 0) });
    expect(state.die.col).toBe(3);
    state = steps(state, 1);
    expect(state.die.col).toBe(4);
    // Le 6 était en haut, le 4 à l'est : le 4 est passé dessous, le 3 (sa face opposée) dessus.
    expect(state.die.top).toBe(3);
    expect(state.die.east).toBe(6);
  });

  test('it never rolls off the grid', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, 10 * (LEAN_TICKS + ROLL_TICKS), { die: push(-1, 0) });
    expect(state.die.col).toBe(0);
  });

  test('whoever is under it when it lands is crushed; a neighbour is only pushed away', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 4, 3);
    // Juste à côté de la case d'arrivée, le corps dedans mais le centre dehors.
    state = place(state, 'c', 4, 3, 1.1);
    state = steps(state, 1, { die: push(1, 0) });
    state = steps(state, LEAN_TICKS + ROLL_TICKS);
    expect(runner(state, 'b').fellAt).toBe(state.tick);
    expect(runner(state, 'c').fellAt).toBeNull();
    // Le voisin touchait la case d'arrivée : il est repoussé.
    expect(runner(state, 'c').vx).toBeGreaterThan(0);
  });

  test('a runner cannot walk through the resting die', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 2, 3);
    state = steps(state, 60, { b: push(1, 0) });
    const center = cellCenter(3, 3);
    expect(runner(state, 'b').x).toBeLessThan(center.x);
  });

  test('the slam crushes the 3 x 3 cells around it, then must wait', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 4, 4);
    state = place(state, 'c', 3, 1);
    state = steps(state, SLAM_TICKS + 1, { die: SLAM });
    expect(runner(state, 'b').fellAt).not.toBeNull();
    expect(runner(state, 'c').fellAt).toBeNull();
    const landed = state.tick;
    state = steps(state, 60, { die: SLAM });
    expect(state.die.motion.type).not.toBe('slam');
    state = steps(state, Math.round(SLAM_COOLDOWN / ARENA_STEP) - 60, { die: SLAM });
    expect(state.die.motion).toEqual({
      type: 'slam',
      at: landed + Math.round(SLAM_COOLDOWN / ARENA_STEP),
    });
  });

  test('crushing more than half of the runners wins for the die', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 4, 3);
    state = place(state, 'c', 4, 4);
    state = steps(state, SLAM_TICKS + 1, { die: SLAM });
    expect(BIG_DIE.isOver(state)).toBe(true);
    expect(BIG_DIE.ranking(state)).toEqual([['die'], ['b', 'c', 'd']]);
  });

  test('the runners win if they hold out until the clock', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 4, 3);
    state = steps(state, 1, { die: push(1, 0) });
    state = steps(state, LEAN_TICKS + ROLL_TICKS);
    expect(BIG_DIE.isOver(state)).toBe(false);
    state = steps(state, Math.round(DIE_TIME_LIMIT / ARENA_STEP));
    expect(BIG_DIE.isOver(state)).toBe(true);
    expect(BIG_DIE.ranking(state)).toEqual([['b', 'c', 'd'], ['die']]);
  });

  test('in the sandbox, a crushed runner comes back', () => {
    let state = BIG_DIE.create(['you', 'dummy'], { practice: true, seed: 1, solo: 'you' });
    state = place(state, 'dummy', 4, 3);
    state = steps(state, 1, { you: push(1, 0) });
    state = steps(state, LEAN_TICKS + ROLL_TICKS);
    expect(runner(state, 'dummy').crushedAt).not.toBeNull();
    expect(BIG_DIE.isOver(state)).toBe(false);
    state = steps(state, 60, { you: IDLE_INPUT });
    expect(runner(state, 'dummy').crushedAt).toBeNull();
  });

  test('bots play a whole match, on either side', () => {
    for (const level of ['easy', 'normal', 'expert'] as BotLevel[]) {
      const rng = new Rng(3);
      let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 3, solo: 'die' });
      while (!BIG_DIE.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id) => [id, BIG_DIE.botInput(state, id, level, rng)]),
        );
        state = BIG_DIE.step(state, inputs);
      }
      expect(state.tick * ARENA_STEP).toBeLessThanOrEqual(DIE_TIME_LIMIT + ARENA_STEP);
    }
  });
});
