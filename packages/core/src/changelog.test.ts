import { describe, expect, test } from 'bun:test';
import { CHANGELOG } from './changelog';
import { GAME_VERSION } from './version';

describe('the changelog', () => {
  test('opens on the current game version (no update published without its news)', () => {
    expect(CHANGELOG[0]?.version).toBe(GAME_VERSION);
    expect(CHANGELOG[0]?.items.length).toBeGreaterThan(0);
  });
});
