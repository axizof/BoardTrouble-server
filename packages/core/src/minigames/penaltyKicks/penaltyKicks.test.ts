import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, IDLE_INPUT } from '../arena/arena';
import {
  areNeighbours,
  KICK_WINDOW,
  PENALTY_KICKS,
  type PenaltyState,
  type ShotOutcome,
  WALK_TIME,
  winnerOf,
} from './penaltyKicks';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const players = ['keeper', 'a', 'b', 'c'];
/** Les zones : 0, 1, 2 en bas (gauche, milieu, droite), 3, 4, 5 en haut. */
const ZONE = { lowLeft: 0, lowMiddle: 1, lowRight: 2, topLeft: 3, topMiddle: 4, topRight: 5 };

function fresh(seed = 1): PenaltyState {
  return PENALTY_KICKS.create(players, { practice: false, seed, solo: 'keeper' });
}

/**
 * Joue le tir en cours : le tireur choisit sa zone, le gardien la sienne (en cliquant, ce qui
 * verrouille), puis le tireur frappe `late` secondes après l'arrivée du ballon (null : pas du tout).
 */
function shoot(state: PenaltyState, aim: number, guard: number, late: number | null): PenaltyState {
  let current = state;
  const index = current.shot.index;
  const ready = current.shot.startAt + steps(WALK_TIME);
  for (let k = 0; k < steps(10) && current.shot.index === index && current.winner === null; k++) {
    if (current.shot.outcome !== null) return current;
    const { shot, tick } = current;
    const shooter = shot.shooter;
    const isChoosing = shot.rollAt === null && tick + 1 >= ready;
    const kickAt =
      late === null || shot.arriveAt === null
        ? null
        : shot.arriveAt + Math.round(late / ARENA_STEP);
    current = PENALTY_KICKS.step(current, {
      [shooter]: isChoosing
        ? { ...IDLE_INPUT, primary: true, target: aim }
        : { ...IDLE_INPUT, primary: tick + 1 === kickAt },
      keeper: isChoosing ? { ...IDLE_INPUT, primary: true, target: guard } : IDLE_INPUT,
    });
  }
  return current;
}

const outcomes = (list: ShotOutcome[]) => list.map((outcome) => ({ outcome }));

describe('Tirs au but', () => {
  test('six shots: the keeper wins on four misses, the shooters on four goals, a seventh breaks 3-3', () => {
    expect(winnerOf(outcomes(['save', 'goal', 'wide', 'fluff']))).toBeNull();
    expect(winnerOf(outcomes(['save', 'goal', 'wide', 'fluff', 'save']))).toBe('keeper');
    expect(winnerOf(outcomes(['goal', 'goal', 'save', 'goal', 'goal']))).toBe('shooters');
    const tied = outcomes(['goal', 'save', 'goal', 'save', 'goal', 'save']);
    expect(winnerOf(tied)).toBeNull();
    expect(winnerOf([...tied, { outcome: 'goal' }])).toBe('shooters');
    expect(winnerOf([...tied, { outcome: 'save' }])).toBe('keeper');
  });

  test('a strong kick scores anywhere but in the keeper zone', () => {
    const goal = shoot(fresh(), ZONE.lowLeft, ZONE.lowMiddle, 0);
    expect(goal.shot.power).toBe('strong');
    expect(goal.shot.outcome).toBe('goal');
    expect(shoot(fresh(), ZONE.lowLeft, ZONE.lowLeft, 0).shot.outcome).toBe('save');
  });

  test('a weak kick is also saved from a neighbouring zone, not from far away', () => {
    expect(areNeighbours(ZONE.lowLeft, ZONE.lowMiddle)).toBe(true);
    expect(areNeighbours(ZONE.lowLeft, ZONE.topLeft)).toBe(true);
    expect(areNeighbours(ZONE.lowLeft, ZONE.topMiddle)).toBe(false);
    const late = KICK_WINDOW * 0.6;
    const near = shoot(fresh(), ZONE.lowLeft, ZONE.lowMiddle, late);
    expect(near.shot.power).toBe('weak');
    expect(near.shot.outcome).toBe('save');
    expect(shoot(fresh(), ZONE.lowLeft, ZONE.lowRight, late).shot.outcome).toBe('goal');
  });

  test('a top corner needs an almost perfect kick, or it goes over; too late or none, no shot', () => {
    expect(shoot(fresh(), ZONE.topRight, ZONE.lowLeft, 0).shot.outcome).toBe('goal');
    expect(shoot(fresh(), ZONE.topRight, ZONE.lowLeft, 0.12).shot.outcome).toBe('wide');
    expect(shoot(fresh(), ZONE.lowMiddle, ZONE.lowLeft, KICK_WINDOW + 0.1).shot.outcome).toBe(
      'fluff',
    );
    expect(shoot(fresh(), ZONE.lowMiddle, ZONE.lowLeft, null).shot.outcome).toBe('fluff');
  });

  test('the choices stay hidden from the other side until the kick', () => {
    let state = fresh();
    while (state.shot.rollAt === null) {
      const ready = state.tick + 1 >= state.shot.startAt + steps(WALK_TIME);
      state = PENALTY_KICKS.step(state, {
        a: ready ? { ...IDLE_INPUT, primary: true, target: ZONE.topLeft } : IDLE_INPUT,
        keeper: ready ? { ...IDLE_INPUT, primary: true, target: ZONE.lowRight } : IDLE_INPUT,
      });
    }
    const keeperView = PENALTY_KICKS.viewFor?.(state, { type: 'player', playerId: 'keeper' });
    const shooterView = PENALTY_KICKS.viewFor?.(state, { type: 'player', playerId: 'a' });
    const benchView = PENALTY_KICKS.viewFor?.(state, { type: 'player', playerId: 'b' });
    expect(keeperView?.shot.aim).toBeNull();
    expect(keeperView?.keeper.zone).toBe(ZONE.lowRight);
    expect(shooterView?.shot.aim).toBe(ZONE.topLeft);
    expect(shooterView?.keeper.zone).toBeNull();
    expect(benchView?.keeper.zone).toBeNull();
  });

  test('arrows move the choice one zone per push', () => {
    let state = fresh();
    while (state.tick < state.shot.startAt + steps(WALK_TIME))
      state = PENALTY_KICKS.step(state, {});
    const right = { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    const up = { ...IDLE_INPUT, move: { x: 0, z: -1 } };
    // Tenir à droite ne déplace que d'un cran ; relâcher puis pousser vers le haut monte.
    state = PENALTY_KICKS.step(state, { a: right });
    state = PENALTY_KICKS.step(state, { a: right });
    state = PENALTY_KICKS.step(state, { a: IDLE_INPUT });
    state = PENALTY_KICKS.step(state, { a: up });
    expect(state.shot.aim).toBe(ZONE.topRight);
  });

  test('between bots, the shootout ends with the keeper on one side and the shooters on the other', () => {
    for (const count of [3, 4, 6]) {
      const ids = ['keeper', 'p1', 'p2', 'p3', 'p4', 'p5'].slice(0, count);
      let state = PENALTY_KICKS.create(ids, { practice: false, seed: count, solo: 'keeper' });
      const rng = new Rng(count);
      for (let k = 0; k < steps(150) && !PENALTY_KICKS.isOver(state); k++) {
        const current = state;
        state = PENALTY_KICKS.step(
          current,
          Object.fromEntries(
            ids.map((id) => [id, PENALTY_KICKS.botInput(current, id, 'normal', rng)]),
          ),
        );
      }
      expect(PENALTY_KICKS.isOver(state)).toBe(true);
      expect(PENALTY_KICKS.ranking(state)).toHaveLength(2);
      expect(PENALTY_KICKS.ranking(state).flat().sort()).toEqual([...ids].sort());
      expect(state.history.length).toBeGreaterThanOrEqual(4);
      expect(state.history.length).toBeLessThanOrEqual(7);
    }
  });

  test('in the sandbox as the keeper, the dummy keeps shooting and the shootout never ends', () => {
    let state = PENALTY_KICKS.create(['you', 'mannequin'], {
      practice: true,
      seed: 2,
      solo: 'you',
    });
    for (let k = 0; k < steps(60); k++) state = PENALTY_KICKS.step(state, {});
    expect(state.history.length).toBeGreaterThan(4);
    expect(state.history.some(({ outcome }) => outcome !== 'fluff')).toBe(true);
    expect(PENALTY_KICKS.isOver(state)).toBe(false);
  });
});
