import { describe, expect, test } from 'bun:test';
import { Rng } from './rng';

describe('Rng', () => {
  test('replays the same sequence from the same state', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const first = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(first);
  });

  test('resumes exactly from a saved state', () => {
    const rng = new Rng(7);
    rng.next();
    const resumed = new Rng(rng.state);
    expect(resumed.next()).toBe(rng.next());
  });

  test('keeps integers within inclusive bounds and reaches both ends', () => {
    const rng = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('shuffles without losing or duplicating items', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const shuffled = new Rng(3).shuffle(items);
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
