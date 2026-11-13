import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  GOAL_HALF,
  HINT_LEAD,
  KICK_WINDOW,
  PENALTY_KICKS,
  type PenaltyState,
  type ShotOutcome,
  WALK_TIME,
  winnerOf,
} from './penaltyKicks';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const players = ['keeper', 'a', 'b', 'c'];

function fresh(seed = 1): PenaltyState {
  return PENALTY_KICKS.create(players, { practice: false, seed, solo: 'keeper' });
}

/** Joue le tir en cours : le tireur vise (x, y), frappe `late` secondes après l'arrivée du ballon. */
function shoot(
  state: PenaltyState,
  aim: { x: number; y: number },
  late: number | null,
  keeper: (state: PenaltyState) => ArenaInput = () => IDLE_INPUT,
): PenaltyState {
  // La mire au bon endroit, d'un coup (elle se déplace sinon au stick).
  let current: PenaltyState = { ...state, shot: { ...state.shot, aim } };
  const kickAt = late === null ? null : current.shot.arriveAt + Math.round(late / ARENA_STEP);
  const index = current.shot.index;
  for (let k = 0; k < steps(8) && current.shot.index === index && current.winner === null; k++) {
    if (current.shot.outcome !== null) return current;
    const shooter = current.shot.shooter;
    current = PENALTY_KICKS.step(current, {
      [shooter]: { ...IDLE_INPUT, primary: current.tick + 1 === kickAt },
      keeper: keeper(current),
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
    expect(winnerOf(outcomes(['goal', 'save', 'goal', 'save', 'goal', 'save']))).toBeNull();
    const tied = outcomes(['goal', 'save', 'goal', 'save', 'goal', 'save']);
    expect(winnerOf([...tied, { outcome: 'goal' }])).toBe('shooters');
    expect(winnerOf([...tied, { outcome: 'save' }])).toBe('keeper');
  });

  test('a kick right on time into a corner beats a keeper who stays put', () => {
    const shot = shoot(fresh(), { x: 2.5, y: 0.4 }, 0);
    expect(shot.shot.quality).toBe(1);
    expect(shot.shot.outcome).toBe('goal');
  });

  test('the keeper who dives the right way in time saves it', () => {
    const state = fresh();
    const diveAt = state.shot.arriveAt - 2;
    // Il attend au milieu, et plonge à droite et un peu vers le bas juste avant la frappe.
    const shot = shoot(state, { x: 2.5, y: 0.4 }, 0, (s) => {
      const isNow = s.tick + 1 === diveAt;
      return { move: isNow ? { x: 1, z: 0.3 } : { x: 0, z: 0 }, primary: isNow, secondary: false };
    });
    expect(shot.shot.outcome).toBe('save');
  });

  test('aimed outside the frame it goes wide; kicked too late or not at all, no shot', () => {
    expect(shoot(fresh(), { x: GOAL_HALF + 0.6, y: 1 }, 0).shot.outcome).toBe('wide');
    expect(shoot(fresh(), { x: 1, y: 1 }, KICK_WINDOW + 0.1).shot.outcome).toBe('fluff');
    expect(shoot(fresh(), { x: 1, y: 1 }, null).shot.outcome).toBe('fluff');
    // Un peu en retard : la frappe part moins vite et moins juste.
    const late = shoot(fresh(), { x: 1, y: 1 }, KICK_WINDOW / 2);
    expect(late.shot.quality).toBeGreaterThan(0);
    expect(late.shot.quality).toBeLessThan(0.7);
  });

  test('the keeper does not see the aim before the kick, but sees the shooter lean just before', () => {
    let state = fresh();
    state = { ...state, shot: { ...state.shot, aim: { x: 2.4, y: 1 } } };
    while (state.tick < state.shot.arriveAt - steps(HINT_LEAD) - 1) {
      state = PENALTY_KICKS.step(state, {});
    }
    const keeperView = PENALTY_KICKS.viewFor?.(state, { type: 'player', playerId: 'keeper' });
    const shooterView = PENALTY_KICKS.viewFor?.(state, { type: 'player', playerId: 'a' });
    expect(keeperView?.shot.aim).toBeNull();
    expect(shooterView?.shot.aim).toEqual({ x: 2.4, y: 1 });
    expect(state.shot.lean).toBeNull();
    state = PENALTY_KICKS.step(PENALTY_KICKS.step(state, {}), {});
    expect(state.shot.lean).toBe(1);
    expect(state.tick).toBeGreaterThan(steps(WALK_TIME));
  });

  test('between bots, the shootout ends with the keeper on one side and the shooters on the other', () => {
    for (const count of [3, 4, 6]) {
      const ids = players.slice(0, 1).concat(['p1', 'p2', 'p3', 'p4', 'p5'].slice(0, count - 1));
      let state = PENALTY_KICKS.create(ids, { practice: false, seed: count, solo: 'keeper' });
      const rng = new Rng(count);
      for (let k = 0; k < steps(120) && !PENALTY_KICKS.isOver(state); k++) {
        const current = state;
        state = PENALTY_KICKS.step(
          current,
          Object.fromEntries(
            ids.map((id) => [id, PENALTY_KICKS.botInput(current, id, 'normal', rng)]),
          ),
        );
      }
      expect(PENALTY_KICKS.isOver(state)).toBe(true);
      const ranking = PENALTY_KICKS.ranking(state);
      expect(ranking).toHaveLength(2);
      expect(ranking.flat().sort()).toEqual([...ids].sort());
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
    for (let k = 0; k < steps(40); k++) state = PENALTY_KICKS.step(state, {});
    expect(state.history.length).toBeGreaterThan(4);
    expect(state.history.some(({ outcome }) => outcome !== 'fluff')).toBe(true);
    expect(PENALTY_KICKS.isOver(state)).toBe(false);
  });
});
