import { describe, expect, test } from 'bun:test';
import { CHARACTERS, checkNickname, isCharacter } from './players';

describe('a nickname', () => {
  test('is trimmed and kept between 3 and 16 visible characters', () => {
    expect(checkNickname('  Léa   la  Brave ')).toEqual({ ok: true, nickname: 'Léa la Brave' });
    expect(checkNickname('Al')).toEqual({ ok: false, reason: 'tooShort' });
    expect(checkNickname('x'.repeat(17))).toEqual({ ok: false, reason: 'tooLong' });
    // Un texte très long envoyé à la main est refusé, pas tronqué en silence.
    expect(checkNickname('a'.repeat(100_000))).toEqual({ ok: false, reason: 'tooLong' });
  });

  test('refuses control characters, symbols and anything that is not text', () => {
    expect(checkNickname('Léa\u0000')).toEqual({ ok: false, reason: 'invalidCharacters' });
    expect(checkNickname('<script>')).toEqual({ ok: false, reason: 'invalidCharacters' });
    expect(checkNickname(42)).toEqual({ ok: false, reason: 'invalidCharacters' });
    expect(checkNickname("Jean-Luc O'Neil").ok).toBe(true);
  });
});

describe('the characters', () => {
  test('are the eight animals', () => {
    expect(CHARACTERS).toHaveLength(8);
    expect(isCharacter('fox')).toBe(true);
    expect(isCharacter('dragon')).toBe(false);
  });
});
