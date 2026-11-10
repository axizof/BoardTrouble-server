import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  FALLING_PLATES,
  nearestPlate,
  PLATE_DEPTH,
  PLATES_ROUNDS,
  type PlatesState,
  plateCenters,
  platesTimeline,
} from './fallingPlates';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Avance jusqu'au pas `tick` depuis le début de la manche, chacun suivant `inputs`. */
function runTo(
  state: PlatesState,
  tick: number,
  inputs: (s: PlatesState) => Partial<Record<PlayerId, ArenaInput>> = () => ({}),
): PlatesState {
  let current = state;
  while (current.tick - current.roundAt < tick)
    current = FALLING_PLATES.step(current, inputs(current));
  return current;
}

/** Fait marcher chaque joueur vers sa plaque, à `x` donné. */
function walkTo(targets: Record<PlayerId, number>) {
  return (state: PlatesState) =>
    Object.fromEntries(
      state.fighters.map((fighter) => {
        const dx = (targets[fighter.id] ?? fighter.x) - fighter.x;
        const move = Math.abs(dx) < 0.2 ? { x: 0, z: 0 } : { x: Math.sign(dx), z: 0 };
        return [fighter.id, { ...IDLE_INPUT, move }];
      }),
    );
}

/** La fin de la manche en cours (juste avant la suivante). */
function endOfRound(state: PlatesState, inputs?: Parameters<typeof runTo>[2]) {
  return runTo(state, steps(platesTimeline(state.round).end) - 1, inputs);
}

describe('Pile ou chute', () => {
  test('when time is up, everyone is put back on the nearest plate, then all but one fall', () => {
    const [left, right] = plateCenters(2);
    let state = FALLING_PLATES.create(['a', 'b', 'c'], { practice: false, seed: 4 });
    // c reste au milieu, sur les planches : il est rendu à la plaque la plus proche.
    const inputs = walkTo({ a: left ?? 0, b: right ?? 0, c: 0.3 });
    state = runTo(state, steps(platesTimeline(1).drop) - 1, inputs);
    expect(state.safe).not.toBeNull();
    for (const fighter of state.fighters) {
      expect(fighter.plate).toBe(nearestPlate(2, fighter.x));
      expect(Math.abs(fighter.x - (plateCenters(2)[fighter.plate ?? 0] ?? 0))).toBeLessThan(1.5);
    }
    expect(state.fighters.find((one) => one.id === 'c')?.plate).toBe(1);
    state = FALLING_PLATES.step(state, {});
    for (const fighter of state.fighters) {
      expect(fighter.fellAt === null).toBe(fighter.plate === state.safe);
    }
  });

  test('the plate that holds stays unknown until everyone is put back on a plate', () => {
    let state = FALLING_PLATES.create(['a', 'b'], { practice: false, seed: 9 });
    state = runTo(state, steps(platesTimeline(1).reveal) - 1);
    expect(state.safe).toBeNull();
    state = FALLING_PLATES.step(state, {});
    expect(state.safe).not.toBeNull();
    // Trop tard pour changer : on ne marche plus, chacun a sa plaque.
    expect(state.fighters.every((one) => one.plate !== null)).toBe(true);
    const moved = FALLING_PLATES.step(state, { a: { ...IDLE_INPUT, move: { x: 1, z: 0 } } });
    expect(moved.fighters[0]?.plate).toBe(state.fighters[0]?.plate);
    // Chez les joueurs, la graine (qui le dirait d'avance) n'est pas envoyée.
    expect(FALLING_PLATES.viewFor?.(state, { type: 'spectator' }).seed).toBe(0);
  });

  test('both plates are drawn over many games, and three plates from round 6', () => {
    const safes = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      let state = FALLING_PLATES.create(['a'], { practice: true, seed });
      for (let round = 1; round <= 7; round++) {
        expect(state.count).toBe(round >= 6 ? 3 : 2);
        state = endOfRound(state);
        if (round === 1) safes.add(state.safe ?? -1);
        state = FALLING_PLATES.step(state, {});
      }
    }
    expect([...safes].sort()).toEqual([0, 1]);
  });

  test('nobody walks off the sides or the front', () => {
    let state = FALLING_PLATES.create(['a'], { practice: false, seed: 1 });
    state = runTo(state, steps(3), () => ({ a: { ...IDLE_INPUT, move: { x: -0.7, z: 0.7 } } }));
    const [me] = state.fighters;
    const [left] = plateCenters(2);
    expect(me?.x).toBeGreaterThan((left ?? 0) - 2.2);
    expect(me?.z).toBeLessThan(PLATE_DEPTH / 2);
  });

  test('ranked by fall order; those falling together are tied, the last ones standing win', () => {
    const [left, right] = plateCenters(2);
    let state = FALLING_PLATES.create(['a', 'b', 'c', 'd'], { practice: false, seed: 2 });
    // a et b ensemble, c et d sur l'autre plaque.
    state = endOfRound(state, walkTo({ a: left ?? 0, b: left ?? 0, c: right ?? 0, d: right ?? 0 }));
    const fallen = state.fighters.filter((one) => one.fellAt !== null).map((one) => one.id);
    expect(fallen).toHaveLength(2);
    const alive = state.fighters.filter((one) => one.fellAt === null).map((one) => one.id);
    expect(FALLING_PLATES.isOver(state)).toBe(false);
    expect(FALLING_PLATES.ranking(state)).toEqual([alive, fallen]);
  });

  test('ends once a single player is left, after the fall is seen', () => {
    const [left, right] = plateCenters(2);
    let state = FALLING_PLATES.create(['a', 'b'], { practice: false, seed: 3 });
    const inputs = walkTo({ a: left ?? 0, b: right ?? 0 });
    state = runTo(state, steps(platesTimeline(1).refill) - 1, inputs);
    expect(FALLING_PLATES.isOver(state)).toBe(false);
    state = FALLING_PLATES.step(state, {});
    expect(FALLING_PLATES.isOver(state)).toBe(true);
    expect(FALLING_PLATES.ranking(state)).toHaveLength(2);
  });

  test('everyone falling in the same round are tied, for the dice', () => {
    const [left] = plateCenters(2);
    for (let seed = 0; seed < 20; seed++) {
      let state = FALLING_PLATES.create(['a', 'b', 'c'], { practice: false, seed });
      state = endOfRound(state, walkTo({ a: left ?? 0, b: left ?? 0, c: left ?? 0 }));
      if (state.safe === 0) continue;
      expect(FALLING_PLATES.isOver(state)).toBe(true);
      expect(FALLING_PLATES.ranking(state)).toEqual([['a', 'b', 'c']]);
      return;
    }
    throw new Error('aucune graine où la plaque de gauche tombe');
  });

  test('several still standing after round 10 all win, tied', () => {
    // On lit la plaque qui tient dans une partie d'essai : tous deux y vont, à chaque manche.
    let state = FALLING_PLATES.create(['a', 'b'], { practice: false, seed: 5 });
    for (let round = 1; round <= PLATES_ROUNDS; round++) {
      const probe = runTo(state, steps(platesTimeline(round).reveal));
      const center = plateCenters(state.count)[probe.safe ?? 0] ?? 0;
      state = endOfRound(state, walkTo({ a: center - 0.8, b: center + 0.8 }));
      expect(state.fighters.every((one) => one.fellAt === null)).toBe(true);
      if (round < PLATES_ROUNDS) {
        expect(FALLING_PLATES.isOver(state)).toBe(false);
        state = FALLING_PLATES.step(state, {});
      }
    }
    expect(FALLING_PLATES.isOver(state)).toBe(true);
    expect(FALLING_PLATES.ranking(state)).toEqual([['a', 'b']]);
  });

  test('in the sandbox, you come back on the plate that held', () => {
    const [left, right] = plateCenters(2);
    let state = FALLING_PLATES.create(['a'], { practice: true, seed: 1 });
    const probe = runTo(state, steps(platesTimeline(1).reveal));
    const doomed = probe.safe === 0 ? right : left;
    state = endOfRound(state, walkTo({ a: doomed ?? 0 }));
    expect(state.fighters[0]?.fellAt).not.toBeNull();
    state = runTo(FALLING_PLATES.step(state, {}), steps(1.5));
    const [me] = state.fighters;
    expect(me?.fellAt).toBeNull();
    expect(me?.onGround).toBe(true);
    expect(nearestPlate(2, me?.x ?? 0)).toBe(probe.safe ?? -1);
  });

  test('bots spread over the plates and every game ends', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal', 'easy', 'expert'];
    let total = 0;
    const games = 60;
    for (let seed = 0; seed < games; seed++) {
      const ids = levels.map((_, index) => `p${index}`);
      let state = FALLING_PLATES.create(ids, { practice: false, seed });
      const rng = new Rng(seed);
      let firstSplit: number[] | null = null;
      while (!FALLING_PLATES.isOver(state)) {
        const inputs = Object.fromEntries(
          ids.map((id, index) => [
            id,
            FALLING_PLATES.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = FALLING_PLATES.step(state, inputs);
        if (!firstSplit && state.fighters.every((one) => one.plate !== null)) {
          firstSplit = [0, 1].map(
            (plate) => state.fighters.filter((one) => one.plate === plate).length,
          );
        }
        expect(state.tick).toBeLessThan(steps(200));
      }
      // Personne n'attend sur place : au premier choix, les deux plaques ont du monde (presque toujours).
      if (firstSplit?.every((people) => people > 0)) total++;
    }
    expect(total / games).toBeGreaterThan(0.9);
  });
});
