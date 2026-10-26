import { describe, expect, test } from 'bun:test';
import { Rng } from '../random/rng';
import { bonusDieForRank, breakTies, rollDice } from './dice';

describe('bonusDieForRank', () => {
  test('gives gold, silver and bronze at a table of 4, nothing to the last', () => {
    expect([0, 1, 2, 3].map((rank) => bonusDieForRank(rank, 4)?.faces ?? 0)).toEqual([6, 3, 2, 0]);
  });

  test('gives gold, silver, bronze and copper at a table of 6, nothing to the last two', () => {
    expect([0, 1, 2, 3, 4, 5].map((rank) => bonusDieForRank(rank, 6)?.faces ?? 0)).toEqual([
      6, 4, 3, 2, 0, 0,
    ]);
  });
});

describe('rollDice', () => {
  test('adds an extra die only on a double, and totals every die', () => {
    const rng = new Rng(9);
    let doubles = 0;
    for (let i = 0; i < 3000; i++) {
      const roll = rollDice(rng, { kind: 'gold', faces: 6 });
      expect(roll.extra !== null).toBe(roll.bonus === roll.normal);
      expect(roll.total).toBe(roll.normal + (roll.bonus ?? 0) + (roll.extra ?? 0));
      expect(roll.turbo).toBeNull();
      if (roll.extra !== null) doubles++;
    }
    // Un double sur six, quel que soit le dé bonus.
    expect(doubles / 3000).toBeGreaterThan(0.13);
    expect(doubles / 3000).toBeLessThan(0.2);
  });

  test('rolls only the normal die without a bonus die', () => {
    const roll = rollDice(new Rng(1), null);
    expect(roll.bonus).toBeNull();
    expect(roll.extra).toBeNull();
    expect(roll.total).toBe(roll.normal);
  });
});

describe('rollDice with item modifiers', () => {
  test('adds the turbo die and limits the normal die after placing glue', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 500; i++) {
      const roll = rollDice(rng, null, { normalFaces: 4, turbo: true });
      expect(roll.normal).toBeLessThanOrEqual(4);
      expect(roll.turbo).toBeGreaterThanOrEqual(1);
      expect(roll.total).toBe(roll.normal + (roll.turbo ?? 0));
    }
  });
});

describe('breakTies', () => {
  test('keeps untied players in place', () => {
    const { order, tieBreaks } = breakTies([['a'], ['b'], ['c']], new Rng(1));
    expect(order).toEqual(['a', 'b', 'c']);
    expect(tieBreaks).toEqual([]);
  });

  test('orders tied players by their two-dice total, and keeps everyone exactly once', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { order, tieBreaks } = breakTies([['a'], ['b', 'c', 'd'], ['e']], new Rng(seed));
      expect(order[0]).toBe('a');
      expect(order[4]).toBe('e');
      expect([...order].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);

      const totals = new Map(
        tieBreaks[0]?.rolls.map(({ playerId, dice }) => [playerId, dice[0] + dice[1]]),
      );
      const middle = order.slice(1, 4).map((id) => totals.get(id) ?? 0);
      expect(middle).toEqual([...middle].sort((x, y) => y - x));
    }
  });

  test('rerolls only the players still tied, for the places they share', () => {
    for (let seed = 0; seed < 300; seed++) {
      const { order, tieBreaks } = breakTies([['a'], ['b', 'c', 'd'], ['e', 'f']], new Rng(seed));
      expect([...order].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      // Les 2e à 4e places restent aux b, c, d ; les deux dernières aux e, f.
      expect(order.slice(1, 4).sort()).toEqual(['b', 'c', 'd']);
      expect(order.slice(4).sort()).toEqual(['e', 'f']);
      for (const { place, rolls } of tieBreaks) {
        // Une relance se joue entre ceux qui étaient à égalité, pour leurs places à eux.
        const shared = order.slice(place, place + rolls.length);
        expect([...shared].sort()).toEqual(rolls.map(({ playerId }) => playerId).sort());
      }
    }
  });

  test('after three tied rolls, the next one is arranged so that nobody is tied any more', () => {
    // Un hasard qui fait toujours 3 : trois lancers loyaux à égalité, puis un lancer arrangé.
    const stuck = Object.assign(new Rng(1), {
      int: (min: number, max: number) => Math.min(max, Math.max(min, 3)),
    });
    const { order, tieBreaks } = breakTies([['a', 'b', 'c']], stuck);
    expect(tieBreaks).toHaveLength(4);
    const last = tieBreaks.at(-1)?.rolls ?? [];
    const totals = last.map(({ dice }) => dice[0] + dice[1]);
    expect(new Set(totals).size).toBe(3);
    for (const { dice } of last) for (const die of dice) expect(die).toBeGreaterThanOrEqual(1);
    for (const { dice } of last) for (const die of dice) expect(die).toBeLessThanOrEqual(6);
    const byTotal = (id: string) => totals[last.findIndex(({ playerId }) => playerId === id)] ?? 0;
    expect(order.map(byTotal)).toEqual([...totals].sort((x, y) => y - x));
  });
});
