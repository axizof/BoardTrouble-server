import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT, sanitizeInput } from '../arena/arena';
import { advanceBall, type BallMotion } from './golfPhysics';
import { GOLF_HOLES, type GolfHole } from './holes';
import {
  FULL_SWING_SPEED,
  GOLF_COURSE,
  type GolfState,
  golfCourseOf,
  golfScore,
  HOLE_TIME,
  holeOffset,
  MAX_BACKSWING,
  MAX_POWER_SPEED,
  MAX_STROKES,
  MINI_GOLF,
  MOUSE_MAX_POWER,
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
function swing(state: GolfState, id: string, aim: number, speed: number, from = -0.6): GolfState {
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
  let along = from;
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

  test('the cup is a real hole: a slow ball drops in, a fast one skips over, one on the rim can lip out', () => {
    const windmill = hole('windmill');
    const run = (ball: BallMotion) => {
      let event = null;
      for (let k = 0; k < 60 && event === null; k++)
        event = advanceBall(ball, windmill, 0, k, ARENA_STEP);
      return event;
    };
    expect(
      run({ x: windmill.cup.x, z: windmill.cup.z + 0.6, vx: 0, vz: -1.2, airborne: 0, piped: -1 }),
    ).toBe('holed');
    // Trop vite, droit dessus : elle passe par-dessus le trou.
    const fast: BallMotion = {
      x: windmill.cup.x,
      z: windmill.cup.z + 0.5,
      vx: 0,
      vz: -7,
      airborne: 0,
      piped: -1,
    };
    for (let k = 0; k < 3; k++)
      expect(advanceBall(fast, windmill, 0, k, ARENA_STEP)).not.toBe('holed');
    expect(fast.z).toBeLessThan(windmill.cup.z);
    // Qui frôle le bord : le trou la fait dévier, sans qu'elle tombe forcément.
    const grazing: BallMotion = {
      x: windmill.cup.x + 0.17,
      z: windmill.cup.z + 0.6,
      vx: 0,
      vz: -2.5,
      airborne: 0,
      piped: -1,
    };
    for (let k = 0; k < 8; k++) advanceBall(grazing, windmill, 0, k, ARENA_STEP);
    expect(grazing.vx).not.toBe(0);
    // Une bordure renvoie la balle.
    const wall: BallMotion = { x: 1.9, z: -0.5, vx: 3, vz: 0, airborne: 0, piped: -1 };
    for (let k = 0; k < 10; k++) advanceBall(wall, windmill, 0, k, ARENA_STEP);
    expect(wall.vx).toBeLessThan(0);
  });

  test('the putter speed is measured over a few steps: commands arriving unevenly do not change the shot', () => {
    const shotSpeed = (alongs: number[]) => {
      let state = onHole('windmill');
      const ball = state.fighters[0];
      if (!ball) throw new Error('no ball');
      const at = (along: number): ArenaInput => ({
        ...IDLE_INPUT,
        point: { x: ball.x + Math.sin(Math.PI) * along, z: ball.z + Math.cos(Math.PI) * along },
        primary: true,
      });
      state = MINI_GOLF.step(state, { a: { ...at(2), primary: false } });
      for (const along of alongs) state = MINI_GOLF.step(state, { a: at(along) });
      return Math.hypot(state.fighters[0]?.vx ?? 0, state.fighters[0]?.vz ?? 0);
    };
    // Le même geste (0,1 m par pas), reçu régulièrement, puis avec un pas sans nouvelle commande.
    const even = shotSpeed([-0.1, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0]);
    const uneven = shotSpeed([-0.1, -0.6, -0.5, -0.4, -0.3, -0.3, -0.1, 0]);
    expect(even).toBeGreaterThan(0);
    expect(uneven).toBeCloseTo(even, 5);
  });

  test('a point aimed on the last hole, far along the world, reaches the game untouched', () => {
    const far = { x: holeOffset(GOLF_COURSE - 1).x + 15, z: -15 };
    expect(sanitizeInput({ ...IDLE_INPUT, point: far }).point).toEqual(far);
  });

  test('a faster swing than full power, after a long backswing, shoots harder; slower swings are unchanged', () => {
    const shotSpeed = (headSpeed: number) => {
      let state = onHole('conveyor');
      state = swing(state, 'a', Math.PI, headSpeed, -MAX_BACKSWING);
      return Math.hypot(state.fighters[0]?.vx ?? 0, state.fighters[0]?.vz ?? 0);
    };
    // (La balle a déjà roulé un pas quand on la mesure : un peu moins que sa vitesse de départ.)
    const near = (speed: number, expected: number) =>
      expect(Math.abs(speed - expected)).toBeLessThan(expected * 0.06);
    near(shotSpeed(FULL_SWING_SPEED), MAX_POWER_SPEED);
    near(shotSpeed(FULL_SWING_SPEED * 0.5), MAX_POWER_SPEED * 0.5);
    near(shotSpeed(FULL_SWING_SPEED * 2), MAX_POWER_SPEED * MOUSE_MAX_POWER);
  });

  test('a ball hitting a mushroom bumper is counted (the client plays a sound)', () => {
    const bumpers = hole('bumpers');
    const mushroom = bumpers.features.find((feature) => feature.kind === 'bumper');
    if (mushroom?.kind !== 'bumper') throw new Error('no bumper');
    const ball: BallMotion = {
      x: mushroom.x,
      z: mushroom.z + 1.2,
      vx: 0,
      vz: -3,
      airborne: 0,
      piped: -1,
    };
    for (let k = 0; k < 20; k++) advanceBall(ball, bumpers, 0, k, ARENA_STEP);
    expect(ball.bumps).toBe(1);
    expect(ball.vz).toBeGreaterThan(0);
  });

  test('a stopped ball keeps the aim of its shot (the camera does not turn by itself)', () => {
    let state = onHole('windmill');
    state = swing(state, 'a', Math.PI + 0.3, FULL_SWING_SPEED * 0.3);
    state = rollOut(state);
    expect(state.fighters[0]?.phase).toBe('ready');
    // (À un tour près.)
    expect(Math.cos((state.fighters[0]?.aim ?? 0) - (Math.PI + 0.3))).toBeCloseTo(1, 6);
  });

  test('falling off costs a stroke and brings the ball back where it was', () => {
    let state = onHole('jump');
    // Trop doux pour le tremplin : la balle roule dans le vide.
    state = swing(state, 'a', Math.PI, FULL_SWING_SPEED * 0.7);
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

  test('a finished player waits for the others; everyone moves to the next hole together', () => {
    let state = onHole('windmill', ['a', 'b']);
    state = {
      ...state,
      fighters: state.fighters.map((ball) =>
        ball.id === 'a' ? { ...ball, phase: 'holed' as const } : ball,
      ),
    };
    for (let k = 0; k < steps(5); k++) state = MINI_GOLF.step(state, {});
    expect(state.hole).toBe(0);
    expect(state.fighters[0]?.phase).toBe('holed');
    // Au bout du temps du trou, qui n'a pas fini compte le maximum, et l'on passe au suivant.
    for (let k = 0; k < steps(HOLE_TIME + 2); k++) state = MINI_GOLF.step(state, {});
    expect(state.fighters[1]?.strokes[0]).toBe(MAX_STROKES + 1);
    expect(state.hole).toBe(1);
    expect(state.fighters.every((ball) => ball.phase === 'ready')).toBe(true);
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

  test('in practice, the dummy who never plays does not hold the next hole', () => {
    let state = MINI_GOLF.create(['a', 'dummy'], { practice: true, seed: 1 });
    state = {
      ...state,
      fighters: state.fighters.map((ball) =>
        ball.id === 'a' ? { ...ball, phase: 'holed' as const, struck: true } : ball,
      ),
    };
    for (let k = 0; k < steps(3); k++) state = MINI_GOLF.step(state, {});
    expect(state.hole).toBe(1);
  });

  test('fewest strokes wins; on equal strokes, the least time spent on the holes', () => {
    let state = MINI_GOLF.create(['a', 'b', 'c'], { practice: false, seed: 1 });
    state = {
      ...state,
      fighters: state.fighters.map((ball, i) => ({
        ...ball,
        phase: 'done' as const,
        strokes: i === 2 ? [4, 4, 3] : [3, 3, 3],
        time: i === 0 ? 40 : i === 1 ? 35 : 20,
      })),
    };
    expect(golfScore(state, state.fighters[2] as never)).toBe(11);
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
    for (const ball of state.fighters)
      expect(golfScore(state, ball)).toBeLessThanOrEqual(GOLF_COURSE * (MAX_STROKES + 1));
  });
});
