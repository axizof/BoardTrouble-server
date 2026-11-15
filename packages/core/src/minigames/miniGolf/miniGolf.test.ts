import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { advanceBall, type BallMotion } from './golfPhysics';
import { GOLF_HOLES, type GolfHole } from './holes';
import {
  FULL_SWING_SPEED,
  GOLF_COURSE,
  GOLF_TIME,
  type GolfState,
  golfCourseOf,
  golfScore,
  holeOffset,
  MAX_STROKES,
  MINI_GOLF,
} from './miniGolf';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const hole = (id: string) => GOLF_HOLES.find((one) => one.id === id) as GolfHole;

/** Une partie où tout le parcours est ce trou-là. */
function onHole(id: string, players = ['a']): GolfState {
  const index = GOLF_HOLES.findIndex((one) => one.id === id);
  let state = MINI_GOLF.create(players, { practice: false, seed: 1 });
  state = { ...state, course: Array.from({ length: GOLF_COURSE }, () => index) };
  const tee = hole(id).tee;
  return {
    ...state,
    fighters: state.fighters.map((ball, i) => ({
      ...ball,
      x: tee.x + i * 0.4,
      z: tee.z,
      restX: tee.x,
      restZ: tee.z,
    })),
  };
}

/** Un coup à la souris : viser `aim`, reculer, puis avancer à cette vitesse (m/s au sol). */
function swing(state: GolfState, id: string, aim: number, speed: number): GolfState {
  const ball = state.fighters.find((one) => one.id === id);
  if (!ball) throw new Error('no ball');
  const offset = holeOffset(ball.hole);
  const at = (along: number) => ({
    x: offset.x + ball.x + Math.sin(aim) * along,
    z: offset.z + ball.z + Math.cos(aim) * along,
  });
  const input = (along: number, primary: boolean): ArenaInput => ({
    ...IDLE_INPUT,
    point: at(along),
    primary,
  });
  let current = MINI_GOLF.step(state, { [id]: input(2, false) });
  current = MINI_GOLF.step(current, { [id]: input(2, true) });
  let along = -0.6;
  for (let k = 0; k < 60 && current.fighters.find((one) => one.id === id)?.phase === 'ready'; k++) {
    current = MINI_GOLF.step(current, { [id]: input(along, true) });
    along += speed * ARENA_STEP;
  }
  return current;
}

function rollOut(state: GolfState, seconds = 8): GolfState {
  let current = state;
  for (let k = 0; k < steps(seconds); k++) {
    current = MINI_GOLF.step(current, {});
    if (current.fighters.every((ball) => ball.phase !== 'rolling')) break;
  }
  return current;
}

describe('Mini-golf', () => {
  test('a course draws three different holes from the seed', () => {
    for (const seed of [1, 2, 3, 4]) {
      const course = golfCourseOf(seed);
      expect(course).toHaveLength(GOLF_COURSE);
      expect(new Set(course).size).toBe(GOLF_COURSE);
    }
  });

  test('the mouse swing: the faster the forward stroke, the harder the shot', () => {
    const soft = swing(onHole('windmill'), 'a', Math.PI, FULL_SWING_SPEED * 0.3);
    const hard = swing(onHole('windmill'), 'a', Math.PI, FULL_SWING_SPEED);
    const speedOf = (state: GolfState) =>
      Math.hypot(state.fighters[0]?.vx ?? 0, state.fighters[0]?.vz ?? 0);
    expect(soft.fighters[0]?.phase).toBe('rolling');
    expect(speedOf(hard)).toBeGreaterThan(speedOf(soft) * 2.5);
    expect(hard.fighters[0]?.strokes[0]).toBe(1);
  });

  test('the keyboard: hold to charge, release to shoot', () => {
    let state = onHole('windmill');
    state = MINI_GOLF.step(state, { a: { ...IDLE_INPUT, primary: true } });
    for (let k = 0; k < steps(0.6); k++)
      state = MINI_GOLF.step(state, { a: { ...IDLE_INPUT, primary: true } });
    state = MINI_GOLF.step(state, { a: IDLE_INPUT });
    expect(state.fighters[0]?.phase).toBe('rolling');
    expect(state.fighters[0]?.strokes[0]).toBe(1);
  });

  test('a ball rolls, bounces off a rail, and drops in the cup only when slow enough', () => {
    const windmill = hole('windmill');
    const ball: BallMotion = {
      x: windmill.cup.x,
      z: windmill.cup.z + 0.5,
      vx: 0,
      vz: -1.5,
      airborne: 0,
      piped: -1,
    };
    let event = null;
    for (let k = 0; k < 30 && event === null; k++)
      event = advanceBall(ball, windmill, 0, k, ARENA_STEP);
    expect(event).toBe('holed');
    const fast: BallMotion = {
      x: windmill.cup.x,
      z: windmill.cup.z + 0.5,
      vx: 0,
      vz: -9,
      airborne: 0,
      piped: -1,
    };
    const first = advanceBall(fast, windmill, 0, 0, ARENA_STEP);
    expect(first).not.toBe('holed');
    const wall: BallMotion = { x: 1.3, z: 3, vx: 3, vz: 0, airborne: 0, piped: -1 };
    for (let k = 0; k < 10; k++) advanceBall(wall, windmill, 0, k, ARENA_STEP);
    expect(wall.vx).toBeLessThan(0);
  });

  test('falling off costs a stroke and brings the ball back where it was', () => {
    let state = onHole('jump');
    // Trop doux pour le tremplin : la balle roule dans le vide.
    state = swing(state, 'a', Math.PI, FULL_SWING_SPEED * 0.62);
    state = rollOut(state);
    for (let k = 0; k < steps(1.5); k++) state = MINI_GOLF.step(state, {});
    const ball = state.fighters[0];
    expect(ball?.strokes[0]).toBe(2);
    expect(ball?.phase).toBe('ready');
    expect(ball?.z).toBeCloseTo(hole('jump').tee.z, 5);
  });

  test('after the last allowed stroke, the hole counts MAX_STROKES + 1 and the next hole starts', () => {
    let state = onHole('windmill');
    state = {
      ...state,
      fighters: state.fighters.map((ball) => ({ ...ball, strokes: [MAX_STROKES - 1, 0, 0] })),
    };
    state = swing(state, 'a', 0, FULL_SWING_SPEED * 0.15);
    state = rollOut(state);
    for (let k = 0; k < steps(2); k++) state = MINI_GOLF.step(state, {});
    expect(state.fighters[0]?.strokes[0]).toBe(MAX_STROKES + 1);
    expect(state.fighters[0]?.hole).toBe(1);
  });

  test('balls not yet struck pass through each other; struck ones collide', () => {
    let state = onHole('windmill', ['a', 'b']);
    state = { ...state, fighters: state.fighters.map((ball) => ({ ...ball, x: 0, z: 5 })) };
    state = MINI_GOLF.step(state, {});
    expect(state.fighters[0]?.x).toBe(state.fighters[1]?.x);
    state = {
      ...state,
      fighters: state.fighters.map((ball, i) =>
        i === 0
          ? { ...ball, x: 0, z: 5, vz: -4, struck: true, phase: 'rolling' as const }
          : { ...ball, x: 0, z: 4.6, struck: true },
      ),
    };
    for (let k = 0; k < 6; k++) state = MINI_GOLF.step(state, {});
    expect(state.fighters[1]?.phase).toBe('rolling');
    expect(state.fighters[1]?.z ?? 0).toBeLessThan(4.5);
  });

  test('fewest strokes wins; on equal strokes, the first to finish; unfinished holes count the max', () => {
    let state = MINI_GOLF.create(['a', 'b', 'c'], { practice: false, seed: 1 });
    state = {
      ...state,
      tick: steps(GOLF_TIME),
      fighters: state.fighters.map((ball, i) => ({
        ...ball,
        hole: i === 2 ? 1 : 2,
        phase: i === 2 ? ('ready' as const) : ('done' as const),
        strokes: i === 2 ? [2, 1, 0] : [3, 3, 3],
        finishedAt: i === 0 ? 900 : i === 1 ? 800 : null,
      })),
    };
    expect(golfScore(state, state.fighters[2] as never)).toBe(2 + (MAX_STROKES + 1) * 2);
    expect(MINI_GOLF.ranking(state)).toEqual([['b'], ['a'], ['c']]);
  });

  test('between bots, the course is played within the time', () => {
    const ids = ['a', 'b'];
    let state = MINI_GOLF.create(ids, { practice: false, seed: 3 });
    const rng = new Rng(3);
    while (!MINI_GOLF.isOver(state)) {
      const current = state;
      state = MINI_GOLF.step(
        current,
        Object.fromEntries(ids.map((id) => [id, MINI_GOLF.botInput(current, id, 'expert', rng)])),
      );
    }
    expect(state.fighters.every((ball) => ball.phase === 'done')).toBe(true);
    for (const ball of state.fighters) expect(golfScore(state, ball)).toBeLessThan(GOLF_COURSE * 5);
  });
});
