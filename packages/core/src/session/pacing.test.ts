import { describe, expect, test } from 'bun:test';
import { TIE_ROLL_TIME } from '../dice/dice';
import type { GameEvent } from '../game/types';
import { animationTime } from './pacing';

describe('animationTime', () => {
  test('gives the order draw the time to show each tie-break roll', () => {
    const drawn: Extract<GameEvent, { type: 'orderDrawn' }> = {
      type: 'orderDrawn',
      rolls: [],
      order: ['a', 'b'],
      tieBreaks: [],
    };
    const plain = animationTime([drawn]);
    const tied = animationTime([
      {
        ...drawn,
        tieBreaks: [
          { place: 0, rolls: [] },
          { place: 0, rolls: [] },
        ],
      },
    ]);
    expect(tied - plain).toBe(2 * TIE_ROLL_TIME);
  });
});
