import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  HILL_POINT_STEPS,
  HILL_TIME,
  type HillFighter,
  type HillState,
  hillPoints,
  KING_OF_HILL,
  PREVIEW,
  ZONE_TIME,
} from './kingOfHill';
import { distanceToSpot, HILL_SPOTS, HILL_STARTS, nodeAt, ruinGround } from './ruins';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const walk = (x: number, z: number, extra: Partial<ArenaInput> = {}): ArenaInput => ({
  ...IDLE_INPUT,
  move: { x, z },
  ...extra,
});

/** Une partie où les joueurs sont posés là où on le dit (au sol, sans élan). */
function placed(spots: { x: number; z: number; y?: number }[]): HillState {
  const ids = spots.map((_, index) => `p${index}`);
  const state = KING_OF_HILL.create(ids, { practice: false, seed: 1 });
  return {
    ...state,
    fighters: state.fighters.map((one, index) => {
      const spot = spots[index] ?? { x: 0, z: 0 };
      return { ...one, x: spot.x, z: spot.z, y: spot.y ?? 0 };
    }),
  };
}

const fighter = (state: HillState, id: string) =>
  state.fighters.find((one) => one.id === id) as HillFighter;

describe('Roi de la colline', () => {
  test('alone in the zone you score a point a second; two inside, nobody scores', () => {
    const court = HILL_SPOTS[0];
    if (!court) throw new Error('no court');
    let alone = placed([
      { x: court.x, z: court.z },
      { x: -9, z: 8.5 },
    ]);
    for (let k = 0; k < steps(3); k++) alone = KING_OF_HILL.step(alone, {});
    expect(hillPoints(fighter(alone, 'p0'))).toBe(3);
    expect(alone.king).toBe('p0');
    let crowded = placed([
      { x: court.x - 0.6, z: court.z },
      { x: court.x + 0.6, z: court.z },
    ]);
    for (let k = 0; k < steps(3); k++) crowded = KING_OF_HILL.step(crowded, {});
    expect(crowded.king).toBeNull();
    expect(crowded.fighters.every((one) => one.score === 0)).toBe(true);
    expect(HILL_POINT_STEPS).toBe(30);
  });

  test('a shoulder charge sends the other sliding about 2.5 m, out of the zone', () => {
    let state = placed([
      { x: -0.9, z: 7 },
      { x: 0, z: 7 },
    ]);
    state = KING_OF_HILL.step(state, { p0: walk(1, 0, { primary: true }) });
    for (let k = 0; k < steps(1.5); k++) state = KING_OF_HILL.step(state, {});
    const pushed = fighter(state, 'p1');
    expect(pushed.hitAt).not.toBeNull();
    expect(pushed.x).toBeGreaterThan(2);
    expect(pushed.x).toBeLessThan(3.5);
    // Celui qui saute au bon moment laisse passer le coup sous lui.
    let dodged = placed([
      { x: -0.9, z: 7 },
      { x: 0, z: 7 },
    ]);
    dodged = KING_OF_HILL.step(dodged, { p1: walk(0, 0, { secondary: true }) });
    for (let k = 0; k < 3; k++) dodged = KING_OF_HILL.step(dodged, {});
    dodged = KING_OF_HILL.step(dodged, { p0: walk(1, 0, { primary: true }) });
    for (let k = 0; k < steps(0.5); k++) dodged = KING_OF_HILL.step(dodged, {});
    expect(fighter(dodged, 'p1').hitAt).toBeNull();
  });

  test('the stairs lead to the top of the pyramid; a one-metre tier is jumped, not walked', () => {
    let climber = placed([{ x: 0, z: 5 }]);
    for (let k = 0; k < steps(1.4); k++) climber = KING_OF_HILL.step(climber, { p0: walk(0, -1) });
    expect(fighter(climber, 'p0').y).toBeCloseTo(3, 5);
    // Contre le premier gradin (de côté), on bute ; en sautant, on monte dessus.
    let walker = placed([{ x: 5.5, z: -1 }]);
    for (let k = 0; k < steps(1.5); k++) walker = KING_OF_HILL.step(walker, { p0: walk(-1, 0) });
    expect(fighter(walker, 'p0').y).toBe(0);
    expect(fighter(walker, 'p0').x).toBeGreaterThan(3.9);
    walker = KING_OF_HILL.step(walker, { p0: walk(-1, 0, { secondary: true }) });
    for (let k = 0; k < steps(1.5); k++) walker = KING_OF_HILL.step(walker, { p0: walk(-1, 0) });
    expect(fighter(walker, 'p0').y).toBeGreaterThanOrEqual(1);
  });

  test('you walk under the vine bridge, and onto it from a terrace', () => {
    expect(ruinGround(0, -8.65, 0)).toBe(0);
    expect(ruinGround(0, -8.65, 1.6)).toBeCloseTo(1.6, 5);
    let state = placed([{ x: 2, z: -6.5 }]);
    for (let k = 0; k < steps(2); k++) state = KING_OF_HILL.step(state, { p0: walk(0, -1) });
    expect(fighter(state, 'p0').z).toBeLessThan(-9);
    expect(fighter(state, 'p0').y).toBe(0);
  });

  test('every zone can be reached from every start', () => {
    for (const start of HILL_STARTS) {
      const node = nodeAt(start.x, start.z, 0);
      expect(node).not.toBeNull();
      for (let spot = 0; spot < HILL_SPOTS.length; spot++) {
        expect(distanceToSpot(node ?? 0, spot)).toBeLessThan(40);
      }
    }
  });

  test('the zone is announced PREVIEW seconds ahead, then hops there', () => {
    let state = KING_OF_HILL.create(['a', 'b'], { practice: false, seed: 4 });
    const first = state.zone;
    while (state.tick < first.endAt - 1) state = KING_OF_HILL.step(state, {});
    expect(state.zone.spot).toBe(first.spot);
    expect(first.next).not.toBe(first.spot);
    state = KING_OF_HILL.step(state, {});
    expect(state.zone.spot).toBe(first.next);
    expect(state.zone.endAt - state.zone.startAt).toBe(steps(ZONE_TIME));
    expect(PREVIEW).toBeLessThan(ZONE_TIME);
  });

  test('between bots, the game lasts HILL_TIME and ranks by points', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const levels = ['easy', 'normal', 'expert', 'normal'] as const;
    let state = KING_OF_HILL.create(ids, { practice: false, seed: 2 });
    const rng = new Rng(2);
    while (!KING_OF_HILL.isOver(state)) {
      const current = state;
      state = KING_OF_HILL.step(
        current,
        Object.fromEntries(
          ids.map((id, index) => [
            id,
            KING_OF_HILL.botInput(current, id, levels[index] ?? 'easy', rng),
          ]),
        ),
      );
    }
    expect(state.tick).toBe(steps(HILL_TIME));
    const total = state.fighters.reduce((sum, one) => sum + hillPoints(one), 0);
    expect(total).toBeGreaterThan(10);
    const ranking = KING_OF_HILL.ranking(state);
    const points = ranking.map((group) => hillPoints(fighter(state, group[0] ?? '')));
    expect([...points].sort((a, b) => b - a)).toEqual(points);
  });

  test('in the sandbox, the dummy waits in the zone and the game never ends', () => {
    let state = KING_OF_HILL.create(['you', 'mannequin'], { practice: true, seed: 1 });
    expect(state.inside).toEqual([]);
    for (let k = 0; k < steps(HILL_TIME + 5); k++) state = KING_OF_HILL.step(state, {});
    expect(KING_OF_HILL.isOver(state)).toBe(false);
    expect(KING_OF_HILL.timeLeft(state)).toBeNull();
    expect(fighter(state, 'mannequin').score).toBeGreaterThan(0);
  });
});
