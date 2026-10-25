import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  barAngle,
  isReversing,
  SPIN_TIME_LIMIT,
  SPINNING_BAR,
  SPOT_RADIUS,
  type SpinBar,
  type SpinState,
} from './spinningBar';

const PLAYERS = ['a', 'b', 'c', 'd'];
const JUMP: ArenaInput = { ...IDLE_INPUT, primary: true };
const DUCK: ArenaInput = { ...IDLE_INPUT, secondary: true };

const fighter = (state: SpinState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};

/** Un joueur seul, et la barre `bar` à `seconds` de lui (elle tourne vers lui). */
function barComing(bar: SpinBar, seconds: number, practice = false): SpinState {
  const state = SPINNING_BAR.create(['a'], { practice, seed: 1 });
  // Sa place est à l'angle 0 ; la barre doit encore parcourir spin × seconds pour l'atteindre.
  const offset = bar === 'low' ? 0 : state.gap;
  return { ...state, angle: offset - state.spin * seconds };
}

/** Joue `seconds` secondes, `input` sur les premiers `holdFor` pas, rien ensuite. */
function play(state: SpinState, seconds: number, input: ArenaInput, holdFor = Infinity) {
  let current = state;
  const steps = Math.round(seconds / ARENA_STEP);
  for (let i = 0; i < steps; i++) {
    current = SPINNING_BAR.step(current, { a: i < holdFor ? input : IDLE_INPUT });
  }
  return current;
}

describe('spinning bar', () => {
  test('the low bar sweeps whoever stays on the ground, not whoever jumps over it', () => {
    expect(fighter(play(barComing('low', 0.5), 1, IDLE_INPUT), 'a').fellAt).not.toBeNull();
    // Il saute un tiers de seconde avant qu'elle arrive : elle passe sous lui.
    const jumped = play(play(barComing('low', 0.65), 0.32, IDLE_INPUT), 1, JUMP, 1);
    expect(fighter(jumped, 'a').fellAt).toBeNull();
    // Baissé, la basse le balaie quand même.
    expect(fighter(play(barComing('low', 0.5), 1, DUCK), 'a').fellAt).not.toBeNull();
  });

  test('the high bar sweeps whoever stands or jumps, not whoever ducks under it', () => {
    expect(fighter(play(barComing('high', 0.5), 1, IDLE_INPUT), 'a').fellAt).not.toBeNull();
    expect(fighter(play(barComing('high', 0.5), 1, DUCK), 'a').fellAt).toBeNull();
    const jumped = play(play(barComing('high', 0.65), 0.32, IDLE_INPUT), 1, JUMP, 1);
    expect(fighter(jumped, 'a').fellAt).not.toBeNull();
  });

  test('a swept player flies off the platform, along the bar', () => {
    const swept = play(barComing('low', 0.2), 1.5, IDLE_INPUT);
    const a = fighter(swept, 'a');
    expect(Math.hypot(a.x, a.z)).toBeGreaterThan(SPOT_RADIUS + 3);
  });

  test('in practice the bar only knocks you down', () => {
    const knocked = play(barComing('low', 0.2, true), 0.5, IDLE_INPUT);
    expect(fighter(knocked, 'a').fellAt).toBeNull();
    expect(fighter(knocked, 'a').downed).toBeGreaterThan(0);
    expect(SPINNING_BAR.isOver(play(knocked, 10, IDLE_INPUT))).toBe(false);
  });

  test('moves stay around your own spot, in the frame of your camera', () => {
    const state = SPINNING_BAR.create(PLAYERS, { practice: true, seed: 1 });
    // "Haut" mène vers le pilier, quelle que soit la place.
    const inputs = Object.fromEntries(
      PLAYERS.map((id) => [id, { ...IDLE_INPUT, move: { x: 0, z: -1 } }]),
    );
    let current = state;
    for (let i = 0; i < 60; i++) current = SPINNING_BAR.step(current, inputs);
    for (const one of current.fighters) {
      const before = fighter(state, one.id);
      expect(Math.hypot(one.x, one.z)).toBeLessThan(Math.hypot(before.x, before.z) - 0.5);
      expect(Math.hypot(one.x - before.x, one.z - before.z)).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  test('the bars speed up, get closer and sometimes reverse, but always leave time to react', () => {
    let state = SPINNING_BAR.create(PLAYERS, { practice: false, seed: 3 });
    let reversals = 0;
    let wasReversing = false;
    let shortestGap = Number.POSITIVE_INFINITY;
    const idle = Object.fromEntries(PLAYERS.map((id) => [id, IDLE_INPUT]));
    // Personne ne bouge : on arrête dès que tout le monde est balayé, on suit donc les barres
    // seules sur un état sans joueur.
    state = { ...state, fighters: [] };
    for (let i = 0; i < SPIN_TIME_LIMIT / ARENA_STEP; i++) {
      state = SPINNING_BAR.step(state, idle);
      if (isReversing(state) && !wasReversing) reversals++;
      wasReversing = isReversing(state);
      const between = Math.abs(barAngle(state, 'low') - barAngle(state, 'high'));
      const seconds =
        Math.min(between, Math.PI * 2 - between) / Math.max(0.01, Math.abs(state.spin));
      shortestGap = Math.min(shortestGap, seconds);
    }
    expect(Math.abs(state.spin)).toBeGreaterThan(3);
    expect(reversals).toBeGreaterThanOrEqual(4);
    // Le temps de retomber d'un saut (0,7 s) puis de se baisser.
    expect(shortestGap).toBeGreaterThan(0.75);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = SPINNING_BAR.create(PLAYERS, { practice: false, seed });
      while (!SPINNING_BAR.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            SPINNING_BAR.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = SPINNING_BAR.step(state, inputs);
      }
      const ranking = SPINNING_BAR.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      const winner = ranking[0]?.length === 1 ? (ranking[0][0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
