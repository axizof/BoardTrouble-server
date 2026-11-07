import { describe, expect, test } from 'bun:test';
import { prepareBoard } from '../board/board';
import { createGame } from '../game/engine';
import type { GameEvent, GameState, PlayerId, PlayerState } from '../game/types';
import { emptySpaces, FOUR_PLAYERS, linearBoard } from '../testing/fixtures';
import { recordAction, startChronicle } from './chronicle';

const board = prepareBoard(linearBoard(emptySpaces(30)));
const start = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 }).state;
const ANA = { type: 'player', playerId: 'ana' } as const;

function moved(state: GameState, moves: Record<PlayerId, number>): GameState {
  return {
    ...state,
    players: state.players.map(
      (player): PlayerState =>
        moves[player.id] === undefined ? player : { ...player, position: `s${moves[player.id]}` },
    ),
  };
}

const roll = (normal: number, bonus: number | null, extra: number | null): GameEvent => ({
  type: 'diceRolled',
  playerId: 'ana',
  purpose: 'move',
  roll: {
    normal,
    special: null,
    trapped: false,
    call: null,
    bonus,
    extra,
    turbo: null,
    total: normal + (bonus ?? 0) + (extra ?? 0),
  },
});

describe('the game chronicle', () => {
  test('counts the move rolls, their total and the doubles', () => {
    const chronicle = recordAction(startChronicle(board, start), board, ANA, start, start, [
      roll(3, 3, 5),
      roll(2, null, null),
    ]);
    expect(chronicle.players.ana).toMatchObject({ rolls: 2, rollTotal: 13, doubles: 1 });
  });

  test('blames a loss on the player who caused it, or on bad luck', () => {
    const before = moved(start, { ana: 10, bob: 12 });
    const after = moved(before, { bob: 8 });
    const chronicle = startChronicle(board, before);
    const attacked = recordAction(chronicle, board, ANA, before, after, [
      { type: 'targetChosen', playerId: 'ana', target: 'bob', interaction: 'magnet' },
    ]);
    expect(attacked.players.bob).toMatchObject({ spacesLostToOthers: 4, spacesLostToLuck: 0 });
    expect(attacked.players.ana?.spacesInflicted).toBe(4);

    const unlucky = recordAction(chronicle, board, ANA, before, after, [
      { type: 'fell', playerId: 'bob', from: 's12', to: 's8' },
    ]);
    expect(unlucky.players.bob).toMatchObject({ spacesLostToLuck: 4, biggestFall: 4 });
    expect(unlucky.players.ana?.spacesInflicted).toBe(0);
  });

  test('puts a lost duel on its winner, even when the challenger loses', () => {
    const before = moved(start, { ana: 10, bob: 12 });
    const after = moved(before, { ana: 4, bob: 18 });
    const chronicle = recordAction(
      startChronicle(board, before),
      board,
      { type: 'system' },
      { ...before, phase: { type: 'turn', playerId: 'ana', step: { type: 'awaitRoll' } } },
      after,
      [{ type: 'duelEnded', winner: 'bob' }],
    );
    expect(chronicle.players.ana?.spacesLostToOthers).toBe(6);
    expect(chronicle.players.bob).toMatchObject({ spacesInflicted: 6, duelsWon: 1 });
  });

  test('records everyone progress and place at the end of each round', () => {
    const after = moved(start, { ana: 5, bob: 9 });
    const chronicle = recordAction(startChronicle(board, start), board, ANA, start, after, [
      { type: 'roundEnded', round: 1 },
    ]);
    expect(chronicle.players.bob?.progress).toEqual([0, 9]);
    expect(chronicle.players.bob?.ranks.at(-1)).toBe(1);
    expect(chronicle.players.ana?.ranks.at(-1)).toBe(2);
  });
});
