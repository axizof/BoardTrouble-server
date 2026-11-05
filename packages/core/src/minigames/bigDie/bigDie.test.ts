import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BIG_DIE,
  type BigDieState,
  cellCenter,
  DIE_TIME_LIMIT,
  FIRE_THROWS,
  FIRE_WINDUP_TICKS,
  fireLanes,
  LEAN_TICKS,
  ROLL_TICKS,
  SLAM_COOLDOWN,
  SLAM_RECOVER_TICKS,
  SLAM_TICKS,
} from './bigDie';

const PLAYERS = ['die', 'b', 'c', 'd'];
const push = (x: number, z: number): ArenaInput => ({ ...IDLE_INPUT, move: { x, z } });
const SLAM: ArenaInput = { ...IDLE_INPUT, primary: true };
const FIRE: ArenaInput = { ...IDLE_INPUT, secondary: true };

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

  test('the slam leaps two cells ahead, crushes the 3 x 3 cells around, then must wait', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    // Sans direction, il saute vers le bas de l'écran : de (3, 3) à (3, 5).
    state = place(state, 'b', 4, 6);
    state = place(state, 'c', 3, 2);
    state = steps(state, SLAM_TICKS.start + 1, { die: SLAM });
    expect([state.die.col, state.die.row]).toEqual([3, 5]);
    expect(runner(state, 'b').fellAt).not.toBeNull();
    expect(runner(state, 'c').fellAt).toBeNull();
    const landed = state.tick;
    state = steps(state, 60, { die: SLAM });
    expect(state.die.motion.type).not.toBe('slam');
    while (state.die.motion.type !== 'slam') state = BIG_DIE.step(state, { die: SLAM });
    // Un peu moins que l'attente du début : le dé presse déjà, d'un rien.
    const waited = (state.tick - landed) * ARENA_STEP;
    expect(waited).toBeLessThanOrEqual(SLAM_COOLDOWN.start);
    expect(waited).toBeGreaterThan(SLAM_COOLDOWN.start - 0.2);
  });

  test('the slam gets quicker as the clock runs out', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, Math.round((DIE_TIME_LIMIT - 1) / ARENA_STEP));
    state = steps(state, 1, { die: SLAM });
    const slam = state.die.motion;
    if (slam.type !== 'slam') throw new Error('Saut attendu');
    expect(slam.ticks).toBe(SLAM_TICKS.end);
  });

  test('the slam goes where you push, or the way it last rolled, and stays on the board', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, 1, { die: { ...SLAM, move: { x: 1, z: 0 } } });
    expect(state.die.motion).toMatchObject({ type: 'slam', col: 5, row: 3 });
    state = steps(state, SLAM_TICKS.start + SLAM_RECOVER_TICKS);
    state = steps(state, Math.round(SLAM_COOLDOWN.start / ARENA_STEP));
    // Il est à une case du bord est : son saut suivant (sans direction) s'arrête au bord.
    state = steps(state, 1, { die: SLAM });
    expect(state.die.motion).toMatchObject({ type: 'slam', col: 6, row: 3 });
  });

  test('the die wins only once every runner is crushed', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 4, 5);
    state = place(state, 'c', 4, 6);
    state = steps(state, SLAM_TICKS.start + 1, { die: SLAM });
    expect(BIG_DIE.isOver(state)).toBe(false);
    state = place(state, 'd', 2, 5);
    state = steps(state, SLAM_RECOVER_TICKS);
    state = steps(state, 1 + LEAN_TICKS + ROLL_TICKS, { die: push(-1, 0) });
    expect(BIG_DIE.isOver(state)).toBe(true);
    expect(BIG_DIE.ranking(state)).toEqual([['die'], ['b', 'c', 'd']]);
  });

  test('fire dice light their lanes, then roll out four ways and burn the first runner hit', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    // Deux coureurs à l'est, l'un derrière l'autre ; le troisième hors des lignes.
    state = place(state, 'b', 5, 3);
    state = place(state, 'c', 6, 3);
    state = place(state, 'd', 1, 1);
    state = steps(state, 1, { die: FIRE });
    expect(state.die.motion.type).toBe('fire');
    expect(fireLanes(state)).toHaveLength(4);
    state = steps(state, FIRE_WINDUP_TICKS);
    expect(state.fires).toHaveLength(4);
    state = steps(state, 30);
    expect(runner(state, 'b').fellAt).not.toBeNull();
    // Le mini-dé s'est arrêté sur le premier : le second est sauf.
    expect(runner(state, 'c').fellAt).toBeNull();
    expect(runner(state, 'd').fellAt).toBeNull();
    expect(state.fires.every((fire) => fire.endedAt !== null)).toBe(true);
    expect(fireLanes(state)).toHaveLength(0);
  });

  test('only two throws per match, one per press', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, 60, { die: FIRE });
    expect(state.die.throwsLeft).toBe(FIRE_THROWS - 1);
    for (let i = 0; i < 4; i++) {
      state = steps(state, 1);
      state = steps(state, FIRE_WINDUP_TICKS + 1, { die: FIRE });
    }
    expect(state.die.throwsLeft).toBe(0);
    state = steps(state, 1);
    state = steps(state, 1, { die: FIRE });
    expect(state.die.motion.type).not.toBe('fire');
  });

  test('a press while the die rolls acts as soon as it lands, even if released', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = steps(state, 1, { die: push(1, 0) });
    state = steps(state, 2, { die: FIRE });
    state = steps(state, LEAN_TICKS + ROLL_TICKS);
    expect(state.die.motion.type).toBe('fire');
    state = steps(state, FIRE_WINDUP_TICKS);
    state = steps(state, 1, { die: push(1, 0) });
    state = steps(state, 2, { die: SLAM });
    state = steps(state, LEAN_TICKS + ROLL_TICKS);
    expect(state.die.motion.type).toBe('slam');
  });

  test('a runner leaps only once per match', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    const leap = { b: { ...IDLE_INPUT, primary: true } };
    state = steps(state, 1, leap);
    expect(runner(state, 'b').onGround).toBe(false);
    expect(runner(state, 'b').leapsLeft).toBe(0);
    state = steps(state, 40);
    state = steps(state, 1, leap);
    expect(runner(state, 'b').onGround).toBe(true);
  });

  test('a well-timed leap clears a fire die', () => {
    let state = BIG_DIE.create(PLAYERS, { practice: false, seed: 1, solo: 'die' });
    state = place(state, 'b', 6, 3);
    state = steps(state, 1, { die: FIRE });
    state = steps(state, FIRE_WINDUP_TICKS);
    // Il bondit sur place quand le mini-dé arrive.
    while ((state.fires.find((fire) => fire.dx === 1)?.x ?? 0) < runner(state, 'b').x - 2.2) {
      state = steps(state, 1);
    }
    state = steps(state, 1, { b: { ...IDLE_INPUT, primary: true, move: { x: 1, z: 0 } } });
    state = steps(state, 20);
    expect(runner(state, 'b').fellAt).toBeNull();
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
