import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BEEP_EVERY,
  barAngle,
  boostShown,
  isBeep,
  isReversing,
  reversal,
  SPIN_TIME_LIMIT,
  SPINNING_BAR,
  SPOT_PILLAR_RADIUS,
  SPOT_RADIUS,
  type SpinBar,
  type SpinState,
} from './spinningBar';

const PLAYERS = ['a', 'b', 'c', 'd'];
/** La vitesse des barres au départ (rad/s), une fois lancées. */
const SPIN = 1.1;
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
  // Son pilier est à l'angle 0 ; la barre, lancée à SPIN, doit encore parcourir SPIN × seconds.
  const offset = bar === 'low' ? 0 : state.gap;
  return { ...state, spin: SPIN, angle: offset - SPIN * seconds };
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

/**
 * Les barres seules, sans joueur, pendant toute une partie : chaque état. `boosts` à faux : sans
 * coup de vitesse (le premier est repoussé après la fin).
 */
function barsAlone(seed: number, boosts = true): SpinState[] {
  const created = SPINNING_BAR.create(PLAYERS, { practice: false, seed });
  let state: SpinState = { ...created, fighters: [], ...(boosts ? {} : { boostAt: 1e9 }) };
  const states: SpinState[] = [];
  for (let i = 0; i < SPIN_TIME_LIMIT / ARENA_STEP; i++) {
    state = SPINNING_BAR.step(state, {});
    states.push(state);
  }
  return states;
}

describe('spinning bar', () => {
  test('the low bar pushes whoever stays on the ground off his pillar, not whoever jumps', () => {
    expect(fighter(play(barComing('low', 0.5), 2.5, IDLE_INPUT), 'a').fellAt).not.toBeNull();
    // Il saute un tiers de seconde avant qu'elle arrive : elle passe sous lui.
    const jumped = play(play(barComing('low', 0.65), 0.32, IDLE_INPUT), 2.5, JUMP, 1);
    expect(fighter(jumped, 'a').fellAt).toBeNull();
    // Baissé, la basse le pousse quand même.
    expect(fighter(play(barComing('low', 0.5), 2.5, DUCK), 'a').fellAt).not.toBeNull();
  });

  test('the high bar pushes whoever stands or jumps, not whoever ducks under it', () => {
    expect(fighter(play(barComing('high', 0.5), 2.5, IDLE_INPUT), 'a').fellAt).not.toBeNull();
    expect(fighter(play(barComing('high', 0.5), 2.5, DUCK), 'a').fellAt).toBeNull();
    const jumped = play(play(barComing('high', 0.65), 0.32, IDLE_INPUT), 2.5, JUMP, 1);
    expect(fighter(jumped, 'a').fellAt).not.toBeNull();
  });

  test('pushed, he slides along the bar off his pillar and falls into the void', () => {
    const pushed = play(barComing('low', 0.2), 0.6, IDLE_INPUT);
    const a = fighter(pushed, 'a');
    expect(a.downed).toBeGreaterThan(0);
    expect(Math.hypot(a.x, a.z - SPOT_RADIUS)).toBeGreaterThan(SPOT_PILLAR_RADIUS);
    expect(a.y).toBeLessThan(0);
  });

  test('in practice, who falls comes back on his pillar', () => {
    const back = play(barComing('low', 0.2, true), 2, IDLE_INPUT);
    expect(fighter(back, 'a').fellAt).toBeNull();
    expect(fighter(back, 'a').y).toBe(0);
    expect(SPINNING_BAR.isOver(back)).toBe(false);
  });

  test('moves stay around your own pillar, in the frame of your camera', () => {
    const state = SPINNING_BAR.create(PLAYERS, { practice: true, seed: 1 });
    // "Haut" mène vers le pilier du centre, quelle que soit la place.
    const inputs = Object.fromEntries(
      PLAYERS.map((id) => [id, { ...IDLE_INPUT, move: { x: 0, z: -1 } }]),
    );
    let current = { ...state, angle: 100 };
    // Les barres loin de tout le monde : on les fige pendant l'essai.
    for (let i = 0; i < 60; i++) current = { ...SPINNING_BAR.step(current, inputs), angle: 100 };
    for (const one of current.fighters) {
      const before = fighter(state, one.id);
      expect(one.fellAt).toBeNull();
      expect(Math.hypot(one.x, one.z)).toBeLessThan(Math.hypot(before.x, before.z) - 0.5);
      expect(Math.hypot(one.x - before.x, one.z - before.z)).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  test('the bars speed up, get closer and reverse, always leaving time to react', () => {
    const states = barsAlone(3);
    const last = states.at(-1);
    expect(Math.abs(last?.spin ?? 0)).toBeGreaterThan(3);
    let reversals = 0;
    let shortestGap = Number.POSITIVE_INFINITY;
    states.forEach((state, index) => {
      if (isReversing(state) && !isReversing(states[index - 1] ?? state)) reversals++;
      const between = Math.abs(barAngle(state, 'low') - barAngle(state, 'high'));
      const seconds = Math.min(between, Math.PI * 2 - between) / Math.abs(state.spin || 0.01);
      shortestGap = Math.min(shortestGap, seconds);
    });
    expect(reversals).toBeGreaterThanOrEqual(4);
    // Le temps de retomber d'un saut (0,7 s) puis de se baisser.
    expect(shortestGap).toBeGreaterThan(0.75);
  });

  test('a reversal is announced by beeps: three at first, then two, then one', () => {
    const states = barsAlone(5, false);
    // Les bips avant chaque changement de sens, et quand il a lieu.
    const beepsBefore: { at: number; beeps: number }[] = [];
    let beeps = 0;
    states.forEach((state, index) => {
      if (isBeep(state)) beeps++;
      const before = states[index - 1];
      if (before && isReversing(state) && !isReversing(before)) {
        beepsBefore.push({ at: state.tick * ARENA_STEP, beeps });
        beeps = 0;
      }
    });
    for (const { at, beeps: count } of beepsBefore) {
      expect(count).toBe(at < 30 ? 3 : at < 60 ? 2 : 1);
    }
    // L'annonce commence au premier bip, et dit le sens où elles repartiront.
    const first = states.findIndex(isBeep);
    const announced = states[first];
    expect(announced && reversal(announced)?.direction).toBe(-1);
    expect(states[first - 1] && reversal(states[first - 1] as SpinState)).toBeNull();
    expect(BEEP_EVERY).toBeGreaterThan(0);
  });

  test('a boost is announced, then slows or speeds the bars for a while, and they come back', () => {
    const seen = { slow: 0, fast: 0, withReverse: 0, lateFast: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const states = barsAlone(seed);
      const plain = barsAlone(seed, false);
      states.forEach((state, index) => {
        const before = states[index - 1];
        // Le début d'un coup de vitesse : annoncé juste avant, par l'icône et des bips.
        if (!before || state.tick !== state.boostAt) return;
        expect(boostShown(before)).toBe(state.boost);
        expect(states.slice(index - 20, index).some(isBeep)).toBe(true);
        seen[state.boost]++;
        if (state.boostAt === before.reverseAt) seen.withReverse++;
        if (state.boost === 'fast' && state.tick * ARENA_STEP > 56) seen.lateFast++;
        // Pendant le coup, plus lent ou plus vite que la même partie sans coup de vitesse ; deux
        // secondes après, revenu comme elle.
        const usual = plain[index + 45];
        const during = states[index + 45];
        if (usual && during && !isReversing(usual) && !isReversing(during)) {
          const ratio = Math.abs(during.spin) / Math.abs(usual.spin);
          if (state.boost === 'slow') expect(ratio).toBeLessThan(0.7);
          else expect(ratio).toBeGreaterThan(1.05);
        }
        const usualAfter = plain[index + 120];
        const after = states[index + 120];
        if (usualAfter && after && !isReversing(after) && !isReversing(usualAfter)) {
          expect(Math.abs(after.spin)).toBeCloseTo(Math.abs(usualAfter.spin), 1);
        }
      });
    }
    expect(seen.slow).toBeGreaterThan(5);
    expect(seen.fast).toBeGreaterThan(5);
    expect(seen.withReverse).toBeGreaterThan(2);
    // En fin de partie, les barres sont déjà au plus vite : plus que des ralentis.
    expect(seen.lateFast).toBe(0);
  });

  test('reversals and the bars start change from one match to another', () => {
    const firstReversal = (seed: number) => barsAlone(seed).findIndex(isReversing);
    const starts = new Set([1, 2, 3, 4, 5, 6].map((seed) => firstReversal(seed)));
    expect(starts.size).toBeGreaterThan(3);
    const angles = new Set(
      [1, 2, 3, 4, 5, 6].map(
        (seed) => SPINNING_BAR.create(PLAYERS, { practice: false, seed }).angle,
      ),
    );
    expect(angles.size).toBeGreaterThan(1);
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
