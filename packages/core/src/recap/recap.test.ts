import { describe, expect, test } from 'bun:test';
import { prepareBoard } from '../board/board';
import { createGame } from '../game/engine';
import type { GameState } from '../game/types';
import { emptySpaces, FOUR_PLAYERS, linearBoard } from '../testing/fixtures';
import { type GameChronicle, type PlayerChronicle, startChronicle } from './chronicle';
import { recapOf } from './recap';

const board = prepareBoard(linearBoard(emptySpaces(30)));
const start = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 }).state;
const finished: GameState = { ...start, phase: { type: 'finished', winner: 'cam' } };

function chronicleWith(changes: Record<string, Partial<PlayerChronicle>>): GameChronicle {
  const chronicle = startChronicle(board, start);
  for (const [id, change] of Object.entries(changes)) {
    const mine = chronicle.players[id];
    if (mine) Object.assign(mine, change);
  }
  return chronicle;
}

describe('the game recap', () => {
  test('ranks the winner first', () => {
    expect(recapOf(board, finished, chronicleWith({})).ranking[0]).toBe('cam');
  });

  test('gives a title to the single best player, only past its minimum', () => {
    const recap = recapOf(
      board,
      finished,
      chronicleWith({ ana: { minigamesWon: 4 }, bob: { minigamesWon: 2 }, dan: { jailStays: 1 } }),
    );
    expect(recap.titles).toContainEqual({ title: 'minigameKing', playerId: 'ana', value: 4 });
    // Un seul séjour au Cachot ne fait pas un abonné.
    expect(recap.titles.some((one) => one.title === 'jailRegular')).toBe(false);
  });

  test('gives no title when the best are tied', () => {
    const recap = recapOf(
      board,
      finished,
      chronicleWith({ ana: { duelsWon: 3 }, bob: { duelsWon: 3 } }),
    );
    expect(recap.titles.some((one) => one.title === 'duelist')).toBe(false);
  });

  test('rewards a comeback from last place to the podium', () => {
    // Cam gagne : il a été dernier (4e) à la fin d'une manche.
    const recap = recapOf(board, finished, chronicleWith({ cam: { ranks: [1, 4, 2] } }));
    expect(recap.titles).toContainEqual({ title: 'comeback', playerId: 'cam', value: 3 });
  });

  test('scores minigames, duels, progress, harm and items apart from the ranking', () => {
    const recap = recapOf(
      board,
      finished,
      chronicleWith({
        ana: { minigamesWon: 2, duelsWon: 1, spacesGained: 40, spacesInflicted: 5, itemsUsed: 3 },
      }),
    );
    expect(recap.scores.ana).toEqual({
      total: 20 + 6 + 20 + 5 + 6,
      minigames: 20,
      duels: 6,
      progress: 20,
      harm: 5,
      items: 6,
    });
  });
});
