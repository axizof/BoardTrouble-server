import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CLASH_TIME,
  clashScore,
  PAWN_SUMO,
  SUMO_RADIUS,
  SUMO_TIME_LIMIT,
  type SumoState,
  sumoRadius,
} from './pawnSumo';

const PLAYERS = ['a', 'b', 'c', 'd'];
const run = (state: SumoState, inputs: Record<string, ArenaInput>, steps: number) => {
  let current = state;
  for (let i = 0; i < steps; i++) current = PAWN_SUMO.step(current, inputs);
  return current;
};
const fighter = (state: SumoState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Combattant attendu : ${id}`);
  return found;
};

describe('pawn sumo', () => {
  test('starts everyone on a ring around the center, facing it', () => {
    const state = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    for (const { x, z } of state.fighters) {
      expect(Math.hypot(x, z)).toBeCloseTo(SUMO_RADIUS * 0.45);
    }
  });

  test('walks off the edge and falls, then the board shrinks to nothing', () => {
    const start = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    const out = { move: { x: 0, z: 1 }, primary: false, secondary: false };
    const walked = run(start, { a: out }, 60);
    expect(fighter(walked, 'a').fellAt).not.toBeNull();
    expect(fighter(walked, 'b').fellAt).toBeNull();
    // Personne ne bouge : le plateau finit par disparaître sous tout le monde.
    let state = start;
    while (!PAWN_SUMO.isOver(state)) state = PAWN_SUMO.step(state, {});
    expect(sumoRadius(state)).toBeLessThan(SUMO_RADIUS * 0.6);
    expect(state.tick * ARENA_STEP).toBeLessThan(SUMO_TIME_LIMIT);
  });

  /** a regarde b, à 2 m ; b regarde dans la direction `bFacing`. */
  const facingOff = (bFacing: number) => {
    const state = PAWN_SUMO.create(['a', 'b'], { practice: false, seed: 1 });
    return {
      ...state,
      fighters: state.fighters.map((f) =>
        f.id === 'a' ? { ...f, x: 0, z: -1, facing: 0 } : { ...f, x: 0, z: 1, facing: bFacing },
      ),
    };
  };
  const charging = { move: { x: 0, z: 1 }, primary: true, secondary: false };

  test('a charge from the side knocks the target down, a parried one knocks the attacker down', () => {
    const fromSide = (parry: boolean) => {
      const state = PAWN_SUMO.step(facingOff(Math.PI / 2), {
        a: charging,
        b: parry ? { ...IDLE_INPUT, secondary: true } : IDLE_INPUT,
      });
      return run(state, {}, 5);
    };
    const hit = fromSide(false);
    expect(fighter(hit, 'b').vz).toBeGreaterThan(3);
    expect(fighter(hit, 'b').downed).toBeGreaterThan(0);
    expect(fighter(hit, 'a').vz).toBeLessThan(fighter(hit, 'b').vz);
    const parried = fromSide(true);
    expect(fighter(parried, 'a').vz).toBeLessThan(-3);
    expect(fighter(parried, 'a').downed).toBeGreaterThan(0);
    expect(Math.abs(fighter(parried, 'b').vz)).toBeLessThan(1);
  });

  test('knocked down, a player can neither move nor charge back right away', () => {
    let state = run(PAWN_SUMO.step(facingOff(Math.PI / 2), { a: charging }), {}, 3);
    const z = fighter(state, 'b').z;
    // b essaie de revenir et de charger : rien tant qu'il est à terre.
    state = run(state, { b: { move: { x: 0, z: -1 }, primary: true, secondary: false } }, 10);
    expect(fighter(state, 'b').z).toBeGreaterThan(z);
    expect(fighter(state, 'b').charging).toBe(0);
  });

  test('a charge on someone facing you starts a timing clash that freezes both', () => {
    const state = run(PAWN_SUMO.step(facingOff(Math.PI), { a: charging }), {}, 5);
    expect(state.clashes).toHaveLength(1);
    expect(state.clashes[0]?.result).toBeNull();
    expect(fighter(state, 'a').vz).toBe(0);
    expect(fighter(state, 'b').vz).toBe(0);
  });

  /** Lance un duel, puis a et b appuient quand l'aiguille passe à `pressA` / `pressB`. */
  const clash = (pressA: number | null, pressB: number | null) => {
    // La charge met quelques pas à arriver sur b.
    let state = run(PAWN_SUMO.step(facingOff(Math.PI), { a: charging }), {}, 4);
    const duel = state.clashes[0];
    if (!duel) throw new Error('Duel attendu');
    // On place la zone au milieu du tour, pour viser juste.
    state = { ...state, clashes: [{ ...duel, zone: 0.5 }] };
    const press = (at: number | null, needle: number) =>
      at !== null && needle >= at ? { ...IDLE_INPUT, primary: true } : IDLE_INPUT;
    for (let i = 0; i < CLASH_TIME / ARENA_STEP + 2; i++) {
      const needle = ((state.tick + 1 - duel.startTick) * ARENA_STEP) / CLASH_TIME;
      state = PAWN_SUMO.step(state, { a: press(pressA, needle), b: press(pressB, needle) });
    }
    return state;
  };

  test('the better timing wins the clash and throws the other down', () => {
    const won = clash(0.5, 0.58);
    expect(won.clashes[0]?.result?.scores).toEqual({ a: 3, b: 1 });
    expect(fighter(won, 'b').downed).toBeGreaterThan(0);
    expect(fighter(won, 'a').downed).toBe(0);
    // Ne pas appuyer avant la fin du tour, c'est perdre.
    const late = clash(null, 0.55);
    expect(fighter(late, 'a').downed).toBeGreaterThan(0);
    // À égalité, ils rebondissent tous les deux, sans tomber.
    const tie = clash(0.5, 0.5);
    expect(fighter(tie, 'a').downed + fighter(tie, 'b').downed).toBe(0);
    expect(fighter(tie, 'b').z - fighter(tie, 'a').z).toBeGreaterThan(1.5);
  });

  test('scores a press by how close it is to the zone', () => {
    expect(clashScore(0.5, 0.51)).toBe(3);
    expect(clashScore(0.5, 0.46)).toBe(2);
    expect(clashScore(0.5, 0.58)).toBe(1);
    expect(clashScore(0.5, 0.7)).toBe(0);
    expect(clashScore(0.5, undefined)).toBe(0);
  });

  test('ranks the last one standing first, then the fallen from last to first', () => {
    const state = PAWN_SUMO.create(PLAYERS, { practice: false, seed: 1 });
    const ranked: SumoState = {
      ...state,
      fighters: state.fighters.map((f) => ({
        ...f,
        fellAt: { a: null, b: 30, c: 10, d: 30 }[f.id] ?? null,
      })),
    };
    expect(PAWN_SUMO.isOver(ranked)).toBe(true);
    expect(PAWN_SUMO.ranking(ranked)).toEqual([['a'], ['b', 'd'], ['c']]);
  });

  test('never ends the practice board, and brings back whoever falls', () => {
    const out = { move: { x: 0, z: 1 }, primary: false, secondary: false };
    const state = run(PAWN_SUMO.create(['a'], { practice: true, seed: 1 }), { a: out }, 30 * 90);
    expect(PAWN_SUMO.isOver(state)).toBe(false);
    expect(fighter(state, 'a').fellAt).toBeNull();
  });

  test('plays a whole match between bots, always with a winner', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = PAWN_SUMO.create(PLAYERS, { practice: false, seed });
      while (!PAWN_SUMO.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            PAWN_SUMO.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = PAWN_SUMO.step(state, inputs);
      }
      const ranking = PAWN_SUMO.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      // Le premier est seul : jamais de victoire au temps de sécurité.
      expect(state.tick * ARENA_STEP).toBeLessThan(SUMO_TIME_LIMIT);
      const winner = ranking[0]?.[0] ?? '';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    // Des bots qui jouent vraiment : la partie ne dure pas jusqu'à l'effondrement à chaque fois,
    // et l'Expert gagne plus souvent que le Facile.
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});

describe('pushing in pawn sumo', () => {
  const pair = (bInput: ArenaInput) => {
    let state = PAWN_SUMO.create(['a', 'b'], { practice: true, seed: 1 });
    state = {
      ...state,
      fighters: state.fighters.map((f) =>
        f.id === 'a' ? { ...f, x: 0, z: -1.5 } : { ...f, x: 0, z: -0.5 },
      ),
    };
    const push = { move: { x: 0, z: 1 }, primary: false, secondary: false };
    return run(state, { a: push, b: bInput }, 45);
  };

  test('walking into someone standing still barely moves them', () => {
    const state = pair(IDLE_INPUT);
    const [a, b] = [fighter(state, 'a'), fighter(state, 'b')];
    // En 1,5 s, b recule à peine (seul, a aurait fait plus de 6 m), sans à-coups ni rebond.
    expect(b.z - -0.5).toBeGreaterThan(0.1);
    expect(b.z - -0.5).toBeLessThan(1);
    expect(b.z - a.z).toBeLessThan(1.15);
  });

  test('two players pushing against each other hold each other', () => {
    const state = pair({ move: { x: 0, z: -1 }, primary: false, secondary: false });
    expect(Math.abs(fighter(state, 'b').z - -0.5)).toBeLessThan(0.3);
  });
});
