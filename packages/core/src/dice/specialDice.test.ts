import { describe, expect, test } from 'bun:test';
import { prepareBoard, type SpaceKind } from '../board/board';
import { applyIntent, createGame } from '../game/engine';
import type { Actor, GameState, Intent, PlayerId, PlayerState } from '../game/types';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { rollDice } from './dice';

const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

function setup(kinds: SpaceKind[] = emptySpaces(60)) {
  const board = prepareBoard(linearBoard(kinds));
  const { state } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 });
  const ordered: GameState = {
    ...state,
    turnOrder: ['ana', 'bob', 'cam', 'dan'],
    phase: { type: 'turn', playerId: 'ana', step: { type: 'awaitRoll' } },
  };
  return { board, state: ordered };
}

type Board = ReturnType<typeof setup>['board'];

function act(board: Board, state: GameState, actor: Actor, intent: Intent) {
  const result = applyIntent(board, state, actor, intent);
  if (!result.ok) throw new Error(`Intention refusée : ${result.error}`);
  return result;
}

function patch(state: GameState, id: PlayerId, changes: Partial<PlayerState>): GameState {
  return { ...state, players: state.players.map((p) => (p.id === id ? { ...p, ...changes } : p)) };
}

function get(state: GameState, id: PlayerId): PlayerState {
  const found = state.players.find((p) => p.id === id);
  if (!found) throw new Error(id);
  return found;
}

describe('special dice faces', () => {
  test('stable only rolls 2 or 3, all or nothing only 0 or 8, and neither makes a double', () => {
    const rng = new Rng(3);
    const gold = { kind: 'gold' as const, faces: 6 };
    for (let i = 0; i < 500; i++) {
      const stable = rollDice(rng, gold, { special: { kind: 'stable', call: null } });
      expect([2, 3]).toContain(stable.normal);
      expect(stable.extra).toBeNull();
      const gamble = rollDice(rng, null, { special: { kind: 'allOrNothing', call: null } });
      expect([0, 8]).toContain(gamble.normal);
    }
  });

  test('trapped hits the called value 2 times in 6, and otherwise moves nothing', () => {
    const rng = new Rng(8);
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      const roll = rollDice(
        rng,
        { kind: 'gold', faces: 6 },
        { special: { kind: 'trapped', call: 5 } },
      );
      if (roll.trapped) expect(roll.total).toBe(0);
      else {
        hits++;
        expect(roll.normal).toBe(5);
      }
    }
    expect(hits / 3000).toBeGreaterThan(0.29);
    expect(hits / 3000).toBeLessThan(0.38);
  });
});

describe('playing a special die', () => {
  test('replaces the normal die and is used up; only owned dice, with a call for the trapped one', () => {
    const { board, state: initial } = setup();
    const state = patch(initial, 'ana', { specialDice: ['stable', 'trapped'] });
    expect(
      applyIntent(board, state, player('ana'), { type: 'roll', specialDie: 'allOrNothing' }),
    ).toEqual({
      ok: false,
      error: 'itemNotOwned',
    });
    expect(
      applyIntent(board, state, player('ana'), { type: 'roll', specialDie: 'trapped' }),
    ).toEqual({
      ok: false,
      error: 'invalidChoice',
    });
    expect(
      applyIntent(board, state, player('ana'), { type: 'roll', specialDie: 'stable', call: 3 }),
    ).toEqual({
      ok: false,
      error: 'invalidChoice',
    });
    const { state: after, events } = act(board, state, player('ana'), {
      type: 'roll',
      specialDie: 'stable',
    });
    const rolled = events.find((event) => event.type === 'diceRolled');
    expect(rolled?.type === 'diceRolled' && rolled.roll.special).toBe('stable');
    expect(get(after, 'ana').specialDice).toEqual(['trapped']);
  });

  test('a trapped die that misses moves nothing and wakes the Board for a small event', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { board, state: initial } = setup();
      const state = {
        ...patch(initial, 'ana', { specialDice: ['trapped'] }),
        rngState: new Rng(seed).state,
      };
      const { state: after, events } = act(board, state, player('ana'), {
        type: 'roll',
        specialDie: 'trapped',
        call: 4,
      });
      const rolled = events.find((event) => event.type === 'diceRolled');
      if (rolled?.type !== 'diceRolled' || !rolled.roll.trapped) continue;
      expect(events.map((event) => event.type)).toContain('specialDieTrapped');
      expect(events.map((event) => event.type)).toContain('troubleApplied');
      expect(after.phase).toMatchObject({ playerId: 'bob' });
      return;
    }
    throw new Error('Aucun Dé Piégé raté sur 30 graines');
  });

  test('a reroll uses the same special die again', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { specialDice: ['allOrNothing'], inventory: ['reroll'] });
    state = act(board, state, player('ana'), { type: 'useItem', item: 'reroll' }).state;
    state = act(board, state, player('ana'), { type: 'roll', specialDie: 'allOrNothing' }).state;
    const { events } = act(board, state, player('ana'), { type: 'reroll' });
    const rerolled = events.find((event) => event.type === 'rerolled');
    expect(rerolled?.type === 'rerolled' && rerolled.roll.special).toBe('allOrNothing');
  });
});

describe('the special die space', () => {
  test('gives a die, and a full pouch asks which one to throw away', () => {
    const { board, state: initial } = setup([
      ...emptySpaces(2),
      { type: 'specialDie' },
      ...emptySpaces(20),
    ]);
    const empty = { ...initial, rngState: rngStateRolling(3) };
    expect(
      get(act(board, empty, player('ana'), { type: 'roll' }).state, 'ana').specialDice,
    ).toHaveLength(1);

    const full = {
      ...patch(initial, 'ana', { specialDice: ['stable', 'stable', 'stable'] }),
      rngState: rngStateRolling(3),
    };
    const paused = act(board, full, player('ana'), { type: 'roll' }).state;
    if (paused.phase.type !== 'turn' || paused.phase.step.type !== 'awaitSpecialDieSwap') {
      throw new Error('Choix attendu');
    }
    const { offered } = paused.phase.step;
    const refused = act(board, paused, player('ana'), {
      type: 'resolveSpecialDieSwap',
      discard: offered,
    }).state;
    expect(get(refused, 'ana').specialDice).toEqual(['stable', 'stable', 'stable']);
    expect(refused.phase).toMatchObject({ playerId: 'bob' });
    if (offered !== 'stable') {
      const swapped = act(board, paused, player('ana'), {
        type: 'resolveSpecialDieSwap',
        discard: 'stable',
      }).state;
      expect(get(swapped, 'ana').specialDice).toEqual(['stable', 'stable', offered]);
    }
  });
});
