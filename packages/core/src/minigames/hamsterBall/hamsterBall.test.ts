import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BALL_HALF,
  BALL_RADIUS,
  BALL_TIME_LIMIT,
  type BallEvent,
  type BallRoller,
  type BallState,
  ballEvents,
  HAMSTER_BALL,
  holeRadius,
  RAIL_HALF,
  railsShare,
  tiltOf,
} from './hamsterBall';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const push = (x: number, z: number, primary = false): ArenaInput => ({
  move: { x, z },
  primary,
  secondary: false,
});

function run(
  state: BallState,
  until: (state: BallState) => boolean,
  inputs: (state: BallState) => Partial<Record<string, ArenaInput>> = () => ({}),
): BallState {
  let current = state;
  for (let tick = 0; tick < steps(BALL_TIME_LIMIT + 5) && !until(current); tick++) {
    current = HAMSTER_BALL.step(current, inputs(current));
  }
  return current;
}

/** Une partie à deux sans événement, les boules placées à la main. */
function placed(rollers: Partial<BallRoller>[], events: BallEvent[] = []): BallState {
  const state = HAMSTER_BALL.create(
    rollers.map((_, index) => `p${index}`),
    { practice: false, seed: 1 },
  );
  return {
    ...state,
    events,
    fighters: state.fighters.map((roller, index) => ({ ...roller, ...rollers[index] })),
  };
}

function event(kind: BallEvent['kind'], startAt = 0, endAt: number | null = steps(10)): BallEvent {
  return { id: 0, kind, warnAt: startAt - steps(2), startAt, endAt, angle: Math.PI / 2 };
}

const roller = (state: BallState, index: number) => state.fighters[index] as BallRoller;

describe('Bille en tête', () => {
  test('the board events are announced, never the same twice in a row, and the rails go for good', () => {
    expect(ballEvents(7, false)).toEqual(ballEvents(7, false));
    for (let seed = 0; seed < 200; seed++) {
      const events = ballEvents(seed, false);
      expect(events[0]?.kind).not.toBe('rails');
      for (let i = 1; i < events.length; i++) {
        const [before, now] = [events[i - 1] as BallEvent, events[i] as BallEvent];
        expect(now.kind).not.toBe(before.kind);
        expect(now.warnAt).toBeGreaterThan(before.endAt ?? before.startAt);
        expect(now.startAt - now.warnAt).toBe(steps(2));
      }
      const gone = events.findIndex((one) => one.endAt === null);
      expect(events[gone]?.kind).toBe('rails');
      expect(events.slice(gone + 1).every((one) => one.kind !== 'rails')).toBe(true);
    }
    const state = HAMSTER_BALL.create(['a', 'b'], { practice: false, seed: 7 });
    expect(railsShare({ ...state, tick: steps(BALL_TIME_LIMIT) })).toBe(0);
  });

  test('a ball rolls up to speed slowly, and glides on once let go', () => {
    let state = placed([
      { x: -5, z: 0 },
      { x: 5, z: 5 },
    ]);
    state = run(
      state,
      (s) => s.tick >= steps(0.5),
      () => ({ p0: push(1, 0) }),
    );
    expect(roller(state, 0).vx).toBeGreaterThan(2);
    expect(roller(state, 0).vx).toBeLessThan(4);
    const moving = roller(state, 0).vx;
    state = run(state, (s) => s.tick >= steps(1));
    expect(roller(state, 0).vx).toBeGreaterThan(moving * 0.6);
  });

  test('a ball hitting a still one stops, and the other carries on in its place', () => {
    const state = run(
      placed([
        { x: -1.6, z: 0, vx: 7 },
        { x: 0, z: 0 },
      ]),
      (s) => roller(s, 1).vx > 0,
    );
    expect(roller(state, 0).vx).toBeLessThan(0.5);
    expect(roller(state, 1).vx).toBeGreaterThan(6);
    expect(roller(state, 1).knock?.by).toBe('ball');
  });

  test('a full charge launches harder than a tap', () => {
    const tap = run(
      placed([
        { x: 0, z: -5 },
        { x: 5, z: 5 },
      ]),
      (s) => roller(s, 0).boosting > 0,
      (s) => ({ p0: push(0, 1, s.tick < 1) }),
    );
    const full = run(
      placed([
        { x: 0, z: -5 },
        { x: 5, z: 5 },
      ]),
      (s) => roller(s, 0).boosting > 0,
      () => ({ p0: push(0, 1, true) }),
    );
    expect(roller(tap, 0).vz).toBeGreaterThan(9);
    expect(roller(full, 0).vz).toBeGreaterThan(roller(tap, 0).vz + 4);
    // Puis il faut attendre pour relancer.
    expect(roller(full, 0).boostReady).toBeGreaterThan(1.5);
  });

  test('rolling off the edge is out; the rail in the middle of an edge holds, until it is lowered', () => {
    const corner = run(
      placed([
        { x: 6, z: 6, vx: 6 },
        { x: -5, z: -5 },
      ]),
      (s) => roller(s, 0).fellAt !== null,
    );
    expect(roller(corner, 0).fall).toBe('edge');
    expect(HAMSTER_BALL.isOver(corner)).toBe(true);
    expect(HAMSTER_BALL.ranking(corner)).toEqual([['p1'], ['p0']]);
    const railed = run(
      placed([
        { x: 6, z: 0, vx: 8 },
        { x: -5, z: -5 },
      ]),
      (s) => s.tick >= steps(1),
    );
    expect(roller(railed, 0).fellAt).toBeNull();
    expect(roller(railed, 0).x).toBeLessThanOrEqual(BALL_HALF - BALL_RADIUS + 1e-6);
    expect(roller(railed, 0).knock?.by).toBe('rail');
    const lowered = run(
      placed(
        [
          { x: 6, z: RAIL_HALF - 1, vx: 8 },
          { x: -5, z: -5 },
        ],
        [event('rails', -steps(1))],
      ),
      (s) => roller(s, 0).fellAt !== null,
    );
    expect(roller(lowered, 0).fall).toBe('edge');
  });

  test('the open hole swallows the ball at the centre; the mushroom throws it out', () => {
    const holed = placed(
      [
        { x: 0.3, z: 0 },
        { x: 5, z: 5 },
      ],
      [event('hole')],
    );
    const swallowed = run(holed, (s) => roller(s, 0).fellAt !== null);
    expect(roller(swallowed, 0).fall).toBe('hole');
    expect(holeRadius(swallowed)).toBeGreaterThan(BALL_RADIUS);
    const mushroom = run(
      placed(
        [
          { x: 0.3, z: 0 },
          { x: 5, z: 5 },
        ],
        [event('mushroom')],
      ),
      (s) => roller(s, 0).knock !== null,
    );
    expect(roller(mushroom, 0).knock?.by).toBe('mushroom');
    expect(roller(mushroom, 0).vx).toBeGreaterThan(10);
  });

  test('the tilted board drags the balls down its slope', () => {
    const state = run(
      placed(
        [
          { x: 0, z: -3 },
          { x: 0, z: 3 },
        ],
        [event('tilt')],
      ),
      (s) => s.tick >= steps(1.5),
    );
    // Le côté qui descend : +x (angle de 90 degrés).
    expect(tiltOf(state).x).toBeCloseTo(1);
    expect(roller(state, 0).vx).toBeGreaterThan(2);
    expect(roller(state, 1).vx).toBeGreaterThan(2);
  });

  test('between bots, the game ends with a full ranking, in under a minute and a half', () => {
    for (const players of [2, 4, 6]) {
      const ids = Array.from({ length: players }, (_, index) => `p${index}`);
      const rng = new Rng(players);
      const state = run(
        HAMSTER_BALL.create(ids, { practice: false, seed: players }),
        (s) => HAMSTER_BALL.isOver(s),
        (s) =>
          Object.fromEntries(ids.map((id) => [id, HAMSTER_BALL.botInput(s, id, 'normal', rng)])),
      );
      expect(HAMSTER_BALL.isOver(state)).toBe(true);
      expect(state.tick * ARENA_STEP).toBeLessThanOrEqual(BALL_TIME_LIMIT);
      expect(HAMSTER_BALL.ranking(state).flat().sort()).toEqual([...ids].sort());
    }
  });

  test('in the sandbox, a fallen ball comes back and the game never ends', () => {
    const state = HAMSTER_BALL.create(['you', 'dummy'], { practice: true, seed: 1 });
    const later = run(
      {
        ...state,
        fighters: state.fighters.map((one, i) => (i === 0 ? { ...one, x: 7, vx: 9 } : one)),
      },
      (s) => s.tick >= steps(20),
      () => ({ you: IDLE_INPUT }),
    );
    expect(later.fighters.every((one) => one.fellAt === null)).toBe(true);
    expect(HAMSTER_BALL.isOver(later)).toBe(false);
  });
});
