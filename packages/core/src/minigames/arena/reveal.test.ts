import { describe, expect, test } from 'bun:test';
import { planReveal, REVEAL_TIMES, revealDuration, revealShotAt } from './reveal';

const RULES = { close: 1, crushing: 5 };
const scores: Record<string, number> = { a: 12, b: 11, c: 9, d: 2 };
const score = (player: string) => scores[player] ?? 0;

describe('the end reveal', () => {
  test('goes from the last to the first, one place at a time', () => {
    const plan = planReveal([['a'], ['c'], ['d']], score, RULES);
    expect(plan.mood).toBe('normal');
    expect(plan.shots.map(({ kind, players, place }) => ({ kind, players, place }))).toEqual([
      { kind: 'place', players: ['d'], place: 2 },
      { kind: 'place', players: ['c'], place: 1 },
      { kind: 'winner', players: ['a'], place: 0 },
    ]);
  });

  test('hesitates between the first two when they are close, without showing the second alone', () => {
    const plan = planReveal([['a'], ['b'], ['c'], ['d']], score, RULES);
    expect(plan.mood).toBe('close');
    expect(plan.shots.map(({ kind, players }) => [kind, players])).toEqual([
      ['place', ['d']],
      ['place', ['c']],
      ['duel', ['b', 'a']],
      ['winner', ['a']],
    ]);
  });

  test('rushes through the others to a crushing winner', () => {
    const plan = planReveal([['a'], ['d']], score, RULES);
    expect(plan.mood).toBe('crushing');
    expect(plan.shots[0]?.ms).toBe(REVEAL_TIMES.quick);
    expect(plan.shots.at(-1)?.kind).toBe('winner');
  });

  test('shows tied players together, at their shared place', () => {
    const plan = planReveal([['a'], ['c', 'd'], ['b']], score, RULES);
    expect(plan.shots.map(({ players, place }) => [players, place])).toEqual([
      [['b'], 3],
      [['c', 'd'], 1],
      [['a'], 0],
    ]);
  });

  test('tells which shot is on at a given time, and keeps the last one', () => {
    const plan = planReveal([['a'], ['c'], ['d']], score, RULES);
    expect(revealDuration(plan)).toBe(REVEAL_TIMES.place * 2 + REVEAL_TIMES.winner);
    expect(revealShotAt(plan, 0)?.index).toBe(0);
    const second = revealShotAt(plan, REVEAL_TIMES.place * 1.5);
    expect(second?.index).toBe(1);
    expect(second?.progress).toBeCloseTo(0.5);
    expect(revealShotAt(plan, 60_000)?.shot.kind).toBe('winner');
  });
});
