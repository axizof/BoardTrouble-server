import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CROSSING_TIME_LIMIT,
  type Crosser,
  type CrossingState,
  DOWN_TIME,
  GREAT_CROSSING,
  HOP_TICKS,
} from './greatCrossing';
import {
  COLUMNS_HALF,
  isCovered,
  isOn,
  isTrainNear,
  type Lane,
  laneAt,
  passageColumn,
  zoneOf,
} from './lanes';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const UP: ArenaInput = { ...IDLE_INPUT, move: { x: 0, z: -1 } };
const LEFT: ArenaInput = { ...IDLE_INPUT, move: { x: -1, z: 0 } };
const DOWN: ArenaInput = { ...IDLE_INPUT, move: { x: 0, z: 1 } };

function run(
  state: CrossingState,
  until: (s: CrossingState) => boolean,
  inputs: (s: CrossingState) => Partial<Record<PlayerId, ArenaInput>> = () => ({}),
): CrossingState {
  let current = state;
  while (!until(current)) {
    current = GREAT_CROSSING.step(current, inputs(current));
    if (current.tick > steps(CROSSING_TIME_LIMIT + 10)) throw new Error('traversée sans fin');
  }
  return current;
}

/** Un état où `a` se tient sur cette rangée, à cette place, à ce pas. */
function standing(seed: number, row: number, x: number, tick = 0): CrossingState {
  const state = GREAT_CROSSING.create(['a'], { practice: true, seed });
  const fighters = state.fighters.map((crosser): Crosser => ({ ...crosser, row, x, best: row }));
  return { ...state, tick, fighters };
}

/** La première rangée de ce type, après `from`. */
function firstLane(seed: number, type: Lane['type'], from = 3): number {
  for (let row = from; row < 400; row++) if (laneAt(seed, row).type === type) return row;
  throw new Error(`pas de ${type}`);
}

describe('the lanes of La grande traversée', () => {
  test('the same for a seed, grass at the start, and the floors of the mountain', () => {
    expect(laneAt(4, 30)).toEqual(laneAt(4, 30));
    for (let row = 0; row < 3; row++) expect(laneAt(4, row).type).toBe('grass');
    expect(zoneOf(0)).toBe('prairie');
    expect(zoneOf(45)).toBe('marsh');
    expect(zoneOf(90)).toBe('workshops');
    expect(zoneOf(500)).toBe('glacier');
    const types = new Set(Array.from({ length: 200 }, (_, row) => laneAt(4, row).type));
    expect(types).toEqual(new Set(['grass', 'road', 'river', 'rail']));
  });

  test('grass never walls you in: the passage column stays free and moves one column at most', () => {
    for (let seed = 1; seed <= 20; seed++) {
      let before = passageColumn(seed, 0);
      for (let row = 0; row < 400; row++) {
        const passage = passageColumn(seed, row);
        expect(Math.abs(passage - before)).toBeLessThanOrEqual(1);
        expect(Math.abs(passage)).toBeLessThanOrEqual(COLUMNS_HALF);
        before = passage;
        const lane = laneAt(seed, row);
        if (lane.type !== 'grass') continue;
        expect(lane.blocked).not.toContain(passage);
        expect(lane.blocked.length).toBeLessThanOrEqual(4);
      }
    }
  });

  test('a vehicle hits exactly where it is: a near miss is a miss', () => {
    // Un véhicule de 2 cases de 0 à 2, le suivant à 10.
    const traffic = { dir: 1 as const, speed: 2, length: 2, spacing: 10, offset: 0, kind: 0 };
    // Juste devant lui, sans le toucher : rien (il arrivera bientôt).
    expect(isCovered(traffic, 2.4, 0.3, 0)).toBe(false);
    expect(isCovered(traffic, 2.25, 0.3, 0)).toBe(true);
    // Juste derrière lui, il est passé : rien.
    expect(isCovered(traffic, -0.4, 0.3, 0)).toBe(false);
    // Le suivant arrive sur nous : touché.
    expect(isCovered(traffic, 9.8, 0.3, 0)).toBe(true);
    // En plein dessus : touché.
    expect(isCovered(traffic, 1, 0.3, 0)).toBe(true);
  });

  test('rafts come back often, and the train is announced before it passes', () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (let row = 3; row < 300; row++) {
        const lane = laneAt(seed, row);
        if (lane.type !== 'river') continue;
        // Au plus quelques secondes sans radeau sous une case.
        const gap = lane.traffic.spacing - lane.traffic.length;
        expect(gap / lane.traffic.speed).toBeLessThan(3.5);
      }
    }
    const row = firstLane(3, 'rail');
    const lane = laneAt(3, row);
    if (lane.type !== 'rail') throw new Error('pas de rail');
    // Le premier moment où le convoi couvre le milieu : l'annonce était allumée juste avant.
    let time = 0;
    while (!isCovered(lane.traffic, 0, 0.3, time)) time += 0.01;
    expect(isTrainNear(lane.traffic, time - 0.6)).toBe(true);
  });
});

describe('La grande traversée', () => {
  test('one hop per press; holding the direction keeps hopping, more slowly', () => {
    const start = GREAT_CROSSING.create(['a', 'b'], { practice: true, seed: 2 });
    const tapped = run(
      start,
      (s) => s.tick >= HOP_TICKS * 2 + 2,
      (s) => ({ a: s.tick % 2 === 0 ? UP : IDLE_INPUT, b: s.tick < 1 ? UP : IDLE_INPUT }),
    );
    expect(tapped.fighters[1]?.row).toBe(1);
    expect(tapped.fighters[1]?.facing).toBe('up');
    const held = run(
      start,
      (s) => s.tick >= steps(1),
      () => ({ a: UP }),
    );
    expect(held.fighters[0]?.row).toBeGreaterThan(2);
    expect(held.fighters[0]?.row).toBeLessThan(8);
  });

  test('no hop behind the start, out of the crossing, or into a tree', () => {
    const start = GREAT_CROSSING.create(['a'], { practice: true, seed: 2 });
    const back = run(
      start,
      (s) => s.tick >= HOP_TICKS * 2,
      () => ({ a: DOWN }),
    );
    expect(back.fighters[0]?.row).toBe(0);
    const edge = run(
      { ...start, fighters: start.fighters.map((c) => ({ ...c, x: -COLUMNS_HALF })) },
      (s) => s.tick >= HOP_TICKS * 2,
      () => ({ a: LEFT }),
    );
    expect(edge.fighters[0]?.x).toBe(-COLUMNS_HALF);
    for (let row = 3; row < 200; row++) {
      const lane = laneAt(2, row);
      const tree = lane.type === 'grass' ? lane.blocked[0] : undefined;
      if (tree === undefined || laneAt(2, row - 1).type !== 'grass') continue;
      const blocked = run(
        standing(2, row - 1, tree),
        (s) => s.tick >= HOP_TICKS * 2,
        () => ({ a: UP }),
      );
      expect(blocked.fighters[0]?.row).toBe(row - 1);
      return;
    }
    throw new Error('pas d’arbre devant une bande d’herbe');
  });

  test('a vehicle runs you over; the water drowns you unless you land on a raft, which carries you', () => {
    const road = firstLane(5, 'road');
    // Sur la route, il attend : le prochain véhicule le renverse.
    const hit = run(standing(5, road, 0), (s) => s.fighters[0]?.downAt !== null);
    expect(hit.fighters[0]?.cause).toBe('road');
    const river = firstLane(5, 'river');
    const riverLane = laneAt(5, river);
    if (riverLane.type !== 'river') throw new Error('pas de rivière');
    // Un moment où un radeau est sous la case du milieu, et un où l'eau est loin de tout radeau.
    let afloat = 0;
    while (!isOn(riverLane.traffic, 0, 0.3, afloat * ARENA_STEP)) afloat++;
    let dry = 0;
    while (isOn(riverLane.traffic, 0, -0.35, dry * ARENA_STEP)) dry++;
    // Le radeau et le sauteur dérivent ensemble : ce qui compte est la place au pas de départ.
    const sunk = GREAT_CROSSING.step(standing(5, river, 0, dry), {});
    expect(sunk.fighters[0]?.cause).toBe('river');
    const carried = GREAT_CROSSING.step(GREAT_CROSSING.step(standing(5, river, 0, afloat), {}), {});
    expect(carried.fighters[0]?.downAt).toBeNull();
    expect(carried.fighters[0]?.x).not.toBe(0);
    expect(Math.sign(carried.fighters[0]?.x ?? 0)).toBe(riverLane.traffic.dir);
  });

  test('landing at the very edge of a raft still holds you; a side step on a raft drifts with it', () => {
    const river = firstLane(5, 'river');
    const lane = laneAt(5, river);
    if (lane.type !== 'river') throw new Error('pas de rivière');
    // Le premier moment où le bord arrière d'un radeau arrive juste après la case du milieu.
    let tick = 0;
    while (
      !isOn(lane.traffic, 0.15, 0, tick * ARENA_STEP) ||
      isOn(lane.traffic, 0, 0, tick * ARENA_STEP)
    ) {
      tick++;
      if (tick > 10_000) throw new Error('pas de bord de radeau');
    }
    const edge = GREAT_CROSSING.step(standing(5, river, 0, tick), {});
    expect(edge.fighters[0]?.downAt).toBeNull();
    // Un pas de côté sur un long radeau : il arrive sur le radeau, qui a dérivé pendant le bond.
    let long = firstLane(5, 'river');
    while (true) {
      const candidate = laneAt(5, long);
      if (candidate.type === 'river' && candidate.traffic.length >= 3) break;
      long = firstLane(5, 'river', long + 1);
    }
    const longLane = laneAt(5, long);
    if (longLane.type !== 'river') throw new Error('pas de radeau long');
    let start = 0;
    while (!isOn(longLane.traffic, 0, 1.2, start * ARENA_STEP)) start++;
    const side = longLane.traffic.dir > 0 ? LEFT : { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    const stepped = run(
      standing(5, long, 0, start),
      (s) => s.tick >= start + HOP_TICKS + 2,
      (s) => ({ a: s.tick === start ? side : IDLE_INPUT }),
    );
    expect(stepped.fighters[0]?.downAt).toBeNull();
    expect(stepped.fighters[0]?.facing).toBe(longLane.traffic.dir > 0 ? 'left' : 'right');
  });

  test('an accident puts you back at the start; your furthest row stays, and the clock alone ends the game', () => {
    const road = firstLane(5, 'road');
    let state: CrossingState = { ...standing(5, road, 0), practice: false };
    state = run(state, (s) => s.fighters[0]?.downAt !== null);
    const down = state.fighters[0];
    state = run(state, (s) => s.tick >= (down?.downAt ?? 0) + steps(DOWN_TIME));
    const back = state.fighters[0];
    expect(back?.downAt).toBeNull();
    expect(back?.row).toBe(0);
    expect(back?.runs).toBe(1);
    expect(back?.best).toBe(road);
    expect(GREAT_CROSSING.isOver(state)).toBe(false);
    const waiting = run(GREAT_CROSSING.create(['a'], { practice: false, seed: 3 }), (s) =>
      GREAT_CROSSING.isOver(s),
    );
    expect(waiting.tick * ARENA_STEP).toBeGreaterThanOrEqual(CROSSING_TIME_LIMIT);
    expect(waiting.fighters[0]?.downAt).toBeNull();
  });

  test('the furthest row wins; reached first breaks the tie', () => {
    const state = GREAT_CROSSING.create(['a', 'b', 'c'], { practice: false, seed: 1 });
    const fighters = state.fighters.map((crosser, index): Crosser => {
      const reached = [
        { best: 20, bestAt: 400 },
        { best: 20, bestAt: 300 },
        { best: 25, bestAt: 900 },
      ][index] ?? { best: 0, bestAt: 0 };
      return { ...crosser, ...reached };
    });
    expect(GREAT_CROSSING.ranking({ ...state, fighters })).toEqual([['c'], ['b'], ['a']]);
  });

  test('bots cross: the expert goes further than the easy one, and every game ends', () => {
    const levels: BotLevel[] = ['easy', 'expert'];
    const best: Record<BotLevel, number[]> = { easy: [], normal: [], expert: [] };
    for (let seed = 1; seed <= 12; seed++) {
      const ids = ['p0', 'p1'];
      const rng = new Rng(seed);
      const state = run(
        GREAT_CROSSING.create(ids, { practice: false, seed: seed * 7919 }),
        (s) => GREAT_CROSSING.isOver(s),
        (s) =>
          Object.fromEntries(
            ids.map((id, index) => [
              id,
              GREAT_CROSSING.botInput(s, id, levels[index] ?? 'normal', rng),
            ]),
          ),
      );
      state.fighters.forEach((crosser, index) => {
        best[levels[index] ?? 'normal'].push(crosser.best);
      });
    }
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
    expect(total(best.expert)).toBeGreaterThan(total(best.easy));
    expect(total(best.easy) / best.easy.length).toBeGreaterThan(15);
  });
});
