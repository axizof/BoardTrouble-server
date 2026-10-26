import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  ANSWER_TIME,
  BOARD_REFLEX,
  REFLEX_MAX_ROUNDS,
  REFLEX_TARGET,
  type ReflexState,
  reactionOf,
  reflexShown,
} from './boardReflex';

const PLAYERS = ['a', 'b', 'c', 'd'];
const PRESS: ArenaInput = { ...IDLE_INPUT, primary: true };

const fighter = (state: ReflexState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};

/** Avance jusqu'au pas `tick`, chacun appuyant au pas donné (un appui, puis relâché). */
function playUntil(state: ReflexState, tick: number, pressAt: Record<string, number>) {
  let current = state;
  while (current.tick < tick) {
    const next = current.tick + 1;
    const inputs = Object.fromEntries(
      Object.entries(pressAt).map(([id, at]) => [id, next === at ? PRESS : IDLE_INPUT]),
    );
    current = BOARD_REFLEX.step(current, inputs);
  }
  return current;
}

describe('board reflex', () => {
  test('the fastest after the signal scores, whoever pressed before it loses the round', () => {
    const state = BOARD_REFLEX.create(PLAYERS, { practice: false, seed: 1 });
    const { signalAt } = state.round;
    const played = playUntil(state, signalAt + 20, {
      a: signalAt + 9,
      b: signalAt + 7,
      c: signalAt - 3,
      d: signalAt + 7,
    });
    expect(played.round.closedAt).not.toBeNull();
    // b et d au même pas : ex aequo, ils marquent tous les deux.
    expect(PLAYERS.map((id) => fighter(played, id).points)).toEqual([0, 1, 0, 1]);
    expect(fighter(played, 'c').falseStart).toBe(true);
    expect(reactionOf(played, fighter(played, 'b'))).toBeCloseTo(7 * ARENA_STEP);
    expect(reflexShown(played)).toEqual({ type: 'scored', best: 7 * ARENA_STEP });
  });

  test('pressing on a feint is a false start', () => {
    // Une partie dont la première manche a une feinte.
    let seed = 1;
    let state = BOARD_REFLEX.create(['a'], { practice: false, seed });
    while (state.round.feints.length === 0) {
      seed++;
      state = BOARD_REFLEX.create(['a'], { practice: false, seed });
    }
    const feint = state.round.feints[0];
    if (!feint) throw new Error('Feinte attendue');
    const fooled = playUntil(state, feint.at + 2, { a: feint.at + 2 });
    expect(reflexShown(playUntil(state, feint.at, {}))).toEqual({
      type: 'feint',
      kind: feint.kind,
    });
    expect(fighter(fooled, 'a').falseStart).toBe(true);
    // Le vrai signal ensuite n'y change rien : la manche est perdue.
    const after = playUntil(fooled, state.round.signalAt + 5, { a: state.round.signalAt + 2 });
    expect(fighter(after, 'a').points).toBe(0);
  });

  test('the round ends when the answer time is over, and the next one starts after the results', () => {
    const state = BOARD_REFLEX.create(PLAYERS, { practice: false, seed: 2 });
    const answer = Math.round(ANSWER_TIME / ARENA_STEP);
    const played = playUntil(state, state.round.signalAt + answer, {});
    expect(played.round.closedAt).toBe(state.round.signalAt + answer);
    expect(reflexShown(played)).toEqual({ type: 'scored', best: null });
    const next = playUntil(played, played.tick + 100, {});
    expect(next.round.index).toBe(1);
    expect(fighter(next, 'a').pressedAt).toBeNull();
  });

  test('signals and feints change from round to round and from match to match', () => {
    const waits = new Set<number>();
    for (let seed = 1; seed <= 5; seed++) {
      const { round } = BOARD_REFLEX.create(PLAYERS, { practice: false, seed });
      waits.add(round.signalAt - round.startAt);
      // Les feintes passent toutes avant le signal, sans le toucher.
      for (const feint of round.feints) expect(feint.at).toBeLessThan(round.signalAt);
    }
    expect(waits.size).toBeGreaterThan(3);
  });

  test('the first to three points wins: the match stops there, ranked by points', () => {
    let state = BOARD_REFLEX.create(['a', 'b', 'c'], { practice: false, seed: 4 });
    // a toujours le plus rapide, b toujours deuxième, c n'appuie jamais.
    while (!BOARD_REFLEX.isOver(state)) {
      const { signalAt } = state.round;
      state = playUntil(state, state.tick + 1, { a: signalAt + 5, b: signalAt + 8 });
    }
    expect(state.round.index).toBe(REFLEX_TARGET - 1);
    expect(fighter(state, 'a').points).toBe(REFLEX_TARGET);
    expect(BOARD_REFLEX.ranking(state)).toEqual([['a'], ['b', 'c']]);
  });

  test('plays whole matches between bots, until someone has three points', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      let state = BOARD_REFLEX.create(PLAYERS, { practice: false, seed });
      while (!BOARD_REFLEX.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id, index) => [
            id,
            BOARD_REFLEX.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = BOARD_REFLEX.step(state, inputs);
      }
      const best = Math.max(...state.fighters.map((one) => one.points));
      expect(best >= REFLEX_TARGET || state.round.index === REFLEX_MAX_ROUNDS - 1).toBe(true);
      const ranking = BOARD_REFLEX.ranking(state);
      expect(ranking.flat().sort()).toEqual([...PLAYERS].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
