import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { CORRIDORS, corridorX, FOREST_HALF, TREE_REACH, treesBetween, treesInRow } from './forest';
import {
  bestRun,
  CRASH_TIME,
  OFF_PISTE,
  SKI_SPEED_MAX,
  SKI_START,
  SKI_TIME_LIMIT,
  type SkiState,
  slopeSpeed,
} from './offPiste';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const steer = (x: number): ArenaInput => ({ ...IDLE_INPUT, move: { x, z: 0 } });

function run(
  state: SkiState,
  until: (s: SkiState) => boolean,
  inputs: (s: SkiState) => Partial<Record<PlayerId, ArenaInput>> = () => ({}),
): SkiState {
  let current = state;
  while (!until(current)) {
    current = OFF_PISTE.step(current, inputs(current));
    if (current.tick > steps(SKI_TIME_LIMIT + 20)) throw new Error('descente sans fin');
  }
  return current;
}

/** Un skieur qui suit à la lettre un couloir sans sapin (comme un joueur parfait). */
function followCorridor(state: SkiState, id: PlayerId, corridor = 0): ArenaInput {
  const me = state.fighters.find((skier) => skier.id === id);
  if (!me) return IDLE_INPUT;
  // Il prend la direction du couloir un peu devant (les skis mettent un moment à tourner), et
  // corrige son écart au couloir là où il est.
  const lead = me.d + me.speed * 0.1;
  const along = (d: number) => corridorX(state.seed, d, corridor);
  const aim = Math.atan(along(lead + 0.5) - along(lead - 0.5)) + 0.5 * (along(me.d) - me.x);
  // Gauche/droite font tourner les skis : il tourne jusqu'au bon angle.
  return steer(Math.max(-1, Math.min(1, (aim - me.heading) * 5)));
}

describe('the forest of Hors-piste', () => {
  test('the same for a seed, denser further down, and never past the rocks', () => {
    expect(treesInRow(5, 40)).toEqual(treesInRow(5, 40));
    expect(treesInRow(5, 40)).not.toEqual(treesInRow(6, 40));
    for (let seed = 1; seed <= 20; seed++) {
      const top = treesBetween(seed, 30, 130).length;
      const bottom = treesBetween(seed, 900, 1000).length;
      expect(bottom).toBeGreaterThan(top * 1.6);
      expect(treesBetween(seed, 0, 14)).toHaveLength(0);
      for (const tree of treesBetween(seed, 0, 1000)) {
        expect(Math.abs(tree.x)).toBeLessThan(FOREST_HALF);
      }
    }
  });

  test('several ways through always stay open, gentle enough to follow at full speed', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const tree of treesBetween(seed, 0, 1500)) {
        for (let corridor = 0; corridor < CORRIDORS; corridor++) {
          const gap = Math.abs(tree.x - corridorX(seed, tree.d, corridor));
          expect(gap).toBeGreaterThan(TREE_REACH + 0.45);
        }
      }
    }
    // Leur pente reste sous l'angle des skis, leur courbure sous ce qu'ils suivent à pleine
    // vitesse (2,4 radians par seconde), et ils restent entre les rochers.
    for (let corridor = 0; corridor < CORRIDORS; corridor++) {
      const at = (d: number) => corridorX(3, d, corridor);
      for (let d = 0; d < 1500; d += 0.5) {
        const slope = (at(d + 0.5) - at(d)) / 0.5;
        const bend = (at(d + 1) - 2 * at(d + 0.5) + at(d)) / 0.25;
        expect(Math.abs(slope)).toBeLessThan(Math.tan(0.8));
        expect(Math.abs(bend) * SKI_SPEED_MAX).toBeLessThan(2.4 * 0.6);
        expect(Math.abs(at(d))).toBeLessThan(FOREST_HALF - 2);
      }
    }
  });

  test('a skier following that way to the end of the clock never hits a tree', () => {
    for (const seed of [2, 9, 17]) {
      for (let corridor = 0; corridor < CORRIDORS; corridor++) {
        const state = run(
          OFF_PISTE.create(['a'], { practice: false, seed }),
          (s) => OFF_PISTE.isOver(s),
          (s) => ({ a: followCorridor(s, 'a', corridor) }),
        );
        expect(state.fighters[0]?.runs).toBe(0);
        const skier = state.fighters[0];
        if (skier) expect(bestRun(skier)).toBeGreaterThan(3000);
      }
    }
  });
});

describe('Hors-piste !', () => {
  test('the skis glide on their own; turning does not slow them down', () => {
    // Le haut n'a pas de sapin : on y règle les skis sans en toucher.
    const start = OFF_PISTE.create(['a', 'b'], { practice: true, seed: 4 });
    const after = run(
      start,
      (s) => s.tick >= steps(1.4),
      (s) => ({ b: steer(Math.floor(s.tick / 10) % 2 === 0 ? 1 : -1) }),
    );
    const [straight, wavy] = after.fighters;
    // Ça part vite : plus de 40 km/h en moins d'une seconde et demie.
    expect(straight?.speed).toBeGreaterThan(12);
    expect(straight?.crashedAt).toBeNull();
    expect(wavy?.crashedAt).toBeNull();
    expect(wavy?.speed ?? 0).toBeCloseTo(straight?.speed ?? 0, 1);
  });

  test('right turns the skis right; let go and they keep their angle', () => {
    const start = OFF_PISTE.create(['a'], { practice: true, seed: 4 });
    const turned = run(
      start,
      (s) => s.tick >= steps(0.3),
      () => ({ a: steer(1) }),
    );
    const angle = turned.fighters[0]?.heading ?? 0;
    expect(angle).toBeGreaterThan(0.5);
    const released = run(turned, (s) => s.tick >= steps(0.8));
    expect(released.fighters[0]?.heading).toBeCloseTo(angle);
    expect(released.fighters[0]?.x ?? 0).toBeGreaterThan((turned.fighters[0]?.x ?? 0) + 2);
    // Pour revenir dans la pente, on tourne de l'autre côté.
    const back = run(
      released,
      (s) => s.tick >= steps(1.1),
      () => ({ a: steer(-1) }),
    );
    expect(back.fighters[0]?.heading ?? 1).toBeLessThan(0.1);
  });

  test('right goes right, and the rocks keep you in the forest', () => {
    const start = OFF_PISTE.create(['a'], { practice: true, seed: 4 });
    const right = run(
      start,
      (s) => s.tick >= steps(1.5),
      () => ({ a: steer(1) }),
    );
    expect(right.fighters[0]?.x).toBeGreaterThan(1);
    // Tout droit contre le bord, au-dessus des premiers sapins.
    const pressed = run(
      { ...start, fighters: start.fighters.map((skier) => ({ ...skier, x: FOREST_HALF - 2 })) },
      (s) => s.tick >= steps(1.2),
      () => ({ a: steer(1) }),
    );
    expect(pressed.fighters[0]?.crashedAt).toBeNull();
    expect(pressed.fighters[0]?.x).toBeLessThan(FOREST_HALF);
    expect(pressed.fighters[0]?.x).toBeGreaterThan(FOREST_HALF - 1);
  });

  test('the further down, the faster: almost inhuman, but with a ceiling', () => {
    expect(slopeSpeed(800)).toBeGreaterThan(slopeSpeed(0) * 2);
    expect(slopeSpeed(1500)).toBe(SKI_SPEED_MAX);
    expect(slopeSpeed(5000)).toBe(SKI_SPEED_MAX);
  });

  test('a tree stops you; you lie there a moment, then start again from the top', () => {
    let state = OFF_PISTE.create(['a'], { practice: false, seed: 8 });
    state = run(state, (s) => s.fighters[0]?.crashedAt !== null);
    const crashed = state.fighters[0];
    expect(crashed?.speed).toBe(0);
    expect(crashed?.d).toBeGreaterThan(14);
    state = run(state, (s) => s.tick >= (crashed?.crashedAt ?? 0) + steps(CRASH_TIME));
    const back = state.fighters[0];
    expect(back?.crashedAt).toBeNull();
    expect(back?.d).toBe(SKI_START);
    expect(back?.runs).toBe(1);
    expect(back?.best).toBe(crashed?.d ?? 0);
  });

  test('your best run counts, the one in progress too; the clock ends the game', () => {
    let state = OFF_PISTE.create(['a', 'b'], { practice: false, seed: 8 });
    // a fonce tout droit (et tombe), b suit le couloir jusqu'au bout.
    state = run(
      state,
      (s) => OFF_PISTE.isOver(s),
      (s) => ({ b: followCorridor(s, 'b') }),
    );
    expect(state.tick).toBeLessThanOrEqual(steps(SKI_TIME_LIMIT + 2));
    expect(OFF_PISTE.timeLeft(state)).toBe(0);
    const [a, b] = state.fighters;
    expect(a?.runs).toBeGreaterThan(0);
    expect(b?.runs).toBe(0);
    expect(OFF_PISTE.ranking(state)).toEqual([['b'], ['a']]);
  });

  test('bots ski down the forest: the expert goes further than the easy one', () => {
    const levels: BotLevel[] = ['easy', 'expert'];
    const best: Record<BotLevel, number[]> = { easy: [], normal: [], expert: [] };
    for (let seed = 1; seed <= 6; seed++) {
      const ids = ['p0', 'p1'];
      const rng = new Rng(seed);
      const state = run(
        OFF_PISTE.create(ids, { practice: false, seed: seed * 7919 }),
        (s) => OFF_PISTE.isOver(s),
        (s) =>
          Object.fromEntries(
            ids.map((id, index) => [id, OFF_PISTE.botInput(s, id, levels[index] ?? 'normal', rng)]),
          ),
      );
      state.fighters.forEach((skier, index) => {
        best[levels[index] ?? 'normal'].push(bestRun(skier));
      });
    }
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
    expect(total(best.expert)).toBeGreaterThan(total(best.easy));
    expect(Math.min(...best.easy)).toBeGreaterThan(25);
  });
});
