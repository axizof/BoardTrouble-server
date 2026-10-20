import { describe, expect, test } from 'bun:test';
import { type BoardDefinition, prepareBoard } from '../board/board';
import { chooseBoardIntent } from '../bots/boardBot';
import { Rng } from '../random/rng';
import {
  emptySpaces,
  FOUR_PLAYERS,
  forkBoard,
  linearBoard,
  rngStateRolling,
} from '../testing/fixtures';
import { applyIntent, createGame, openGame, whoMustAct } from './engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from './types';

const SYSTEM: Actor = { type: 'system' };
const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

function setup(definition: BoardDefinition = linearBoard(emptySpaces(40))) {
  const board = prepareBoard(definition);
  const { state, events } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 });
  return { board, state, events };
}

function currentPlayer(state: GameState): PlayerId {
  if (state.phase.type !== 'turn') throw new Error(`Pas de tour en cours (${state.phase.type})`);
  return state.phase.playerId;
}

function act(
  board: ReturnType<typeof setup>['board'],
  state: GameState,
  actor: Actor,
  intent: Intent,
) {
  const result = applyIntent(board, state, actor, intent);
  if (!result.ok) throw new Error(`Intention refusée : ${result.error}`);
  return result;
}

function patchPlayer(state: GameState, id: PlayerId, patch: Partial<PlayerState>): GameState {
  return {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === id ? { ...candidate, ...patch } : candidate,
    ),
  };
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T) {
  return events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function positionOf(state: GameState, id: PlayerId) {
  return state.players.find((candidate) => candidate.id === id)?.position;
}

describe('createGame', () => {
  test('draws the turn order and starts the first round without a minigame or bonus dice', () => {
    const { state, events } = setup();
    expect([...state.turnOrder].sort()).toEqual(['ana', 'bob', 'cam', 'dan']);
    expect(events.map((event) => event.type)).toEqual([
      'introEnded',
      'orderRolled',
      'orderRolled',
      'orderRolled',
      'orderRolled',
      'orderDrawn',
      'roundStarted',
      'turnStarted',
    ]);
    expect(state.phase).toEqual({
      type: 'turn',
      playerId: state.turnOrder[0] ?? '',
      step: { type: 'awaitRoll' },
    });
    expect(Object.values(state.bonusDice).every((die) => die === null)).toBe(true);
  });

  test('opens on the intro, then everyone rolls for the order at the same time', () => {
    const board = prepareBoard(linearBoard(emptySpaces(40)));
    let state = openGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 });
    expect(state.phase).toEqual({ type: 'intro', waiting: ['ana', 'bob', 'cam', 'dan'] });
    expect(applyIntent(board, state, player('ana'), { type: 'rollForOrder' })).toEqual({
      ok: false,
      error: 'wrongPhase',
    });

    for (const id of ['dan', 'ana', 'cam']) {
      state = act(board, state, player(id), { type: 'skipIntro' }).state;
    }
    expect(state.phase).toEqual({ type: 'intro', waiting: ['bob'] });
    const introDone = act(board, state, player('bob'), { type: 'skipIntro' });
    expect(introDone.events).toEqual([{ type: 'introEnded' }]);
    state = introDone.state;

    // N'importe qui lance quand il veut, une seule fois.
    state = act(board, state, player('cam'), { type: 'rollForOrder' }).state;
    expect(applyIntent(board, state, player('cam'), { type: 'rollForOrder' })).toEqual({
      ok: false,
      error: 'notYourTurn',
    });
    for (const id of ['ana', 'dan']) {
      state = act(board, state, player(id), { type: 'rollForOrder' }).state;
    }
    const last = act(board, state, player('bob'), { type: 'rollForOrder' });
    expect(ofType(last.events, 'orderDrawn')).toHaveLength(1);
    expect(last.state.phase.type).toBe('turn');
    expect(currentPlayer(last.state)).toBe(last.state.turnOrder[0] ?? '');
  });

  test('rejects a table that is not full or has duplicate players', () => {
    const board = prepareBoard(linearBoard([]));
    expect(() =>
      createGame(board, { players: FOUR_PLAYERS.slice(0, 3), tableSize: 4, seed: 1 }),
    ).toThrow();
    const twice = [...FOUR_PLAYERS.slice(0, 3), FOUR_PLAYERS[0] ?? { id: 'x', name: 'X' }];
    expect(() => createGame(board, { players: twice, tableSize: 4, seed: 1 })).toThrow();
  });
});

describe('turns', () => {
  test('moves the player by the rolled total, then hands over to the next player', () => {
    const { board, state } = setup();
    const roller = currentPlayer(state);
    const { state: after, events } = act(board, state, player(roller), { type: 'roll' });

    const [rolled] = ofType(events, 'diceRolled');
    const [moved] = ofType(events, 'moved');
    expect(moved?.path).toHaveLength(rolled?.roll.total ?? -1);
    expect(positionOf(after, roller)).toBe(moved?.path.at(-1));
    expect(currentPlayer(after)).toBe(state.turnOrder[1] ?? '');
  });

  test('refuses illegal intents and leaves the state untouched', () => {
    const { board, state } = setup();
    const waiting = state.turnOrder[1] ?? '';
    expect(applyIntent(board, state, player(waiting), { type: 'roll' })).toEqual({
      ok: false,
      error: 'notYourTurn',
    });
    expect(applyIntent(board, state, SYSTEM, { type: 'roll' })).toEqual({
      ok: false,
      error: 'notAllowed',
    });
    expect(
      applyIntent(board, state, player(currentPlayer(state)), {
        type: 'chooseBranch',
        spaceId: 's1',
      }),
    ).toEqual({ ok: false, error: 'wrongPhase' });
    expect(
      applyIntent(board, state, player(currentPlayer(state)), {
        type: 'submitMinigameResult',
        ranking: [['ana']],
      }),
    ).toEqual({ ok: false, error: 'notAllowed' });
  });

  test('starts a new round with a minigame, then gives bonus dice and the order by rank', () => {
    let { board, state } = setup();
    for (let turn = 0; turn < 4; turn++) {
      state = act(board, state, player(currentPlayer(state)), { type: 'roll' }).state;
    }
    expect(state.phase).toMatchObject({ type: 'minigame' });
    expect(state.round).toBe(2);

    expect(
      applyIntent(board, state, SYSTEM, { type: 'submitMinigameResult', ranking: [['ana']] }),
    ).toEqual({
      ok: false,
      error: 'invalidRanking',
    });
    const { state: ranked } = act(board, state, SYSTEM, {
      type: 'submitMinigameResult',
      ranking: [['cam'], ['ana'], ['dan'], ['bob']],
    });
    expect(ranked.turnOrder).toEqual(['cam', 'ana', 'dan', 'bob']);
    expect(ranked.bonusDice.cam?.kind).toBe('gold');
    expect(ranked.bonusDice.ana?.kind).toBe('silver');
    expect(ranked.bonusDice.dan?.kind).toBe('bronze');
    expect(ranked.bonusDice.bob).toBeNull();
    expect(currentPlayer(ranked)).toBe('cam');
  });
});

describe('branches', () => {
  test('stops at a fork, then continues on the chosen lane with the remaining steps', () => {
    const { board, state: initial } = setup(forkBoard());
    const roller = currentPlayer(initial);
    const state = {
      ...patchPlayer(initial, roller, { position: 'fork' }),
      rngState: rngStateRolling(3),
    };

    const paused = act(board, state, player(roller), { type: 'roll' });
    expect(paused.state.phase).toEqual({
      type: 'turn',
      playerId: roller,
      step: {
        type: 'awaitBranch',
        remaining: 3,
        options: ['a1', 'b1'],
        mode: 'dice',
        resume: 'endTurn',
      },
    });
    expect(
      applyIntent(board, paused.state, player(roller), { type: 'chooseBranch', spaceId: 'm1' }),
    ).toEqual({
      ok: false,
      error: 'invalidChoice',
    });

    const chosen = act(board, paused.state, player(roller), {
      type: 'chooseBranch',
      spaceId: 'b1',
    });
    expect(positionOf(chosen.state, roller)).toBe('merge');
    expect(currentPlayer(chosen.state)).not.toBe(roller);
  });
});

describe('branches during effect moves', () => {
  test('lets the active player choose a lane when a rocket goes through a fork', () => {
    const { board, state: initial } = setup(forkBoard());
    const roller = currentPlayer(initial);
    const state = patchPlayer(initial, roller, { inventory: ['rocket'] });

    const paused = act(board, state, player(roller), { type: 'useItem', item: 'rocket' });
    expect(paused.state.phase).toMatchObject({
      step: {
        type: 'awaitBranch',
        remaining: 5,
        options: ['a1', 'b1'],
        mode: 'effect',
        resume: 'roll',
      },
    });
    const chosen = act(board, paused.state, player(roller), {
      type: 'chooseBranch',
      spaceId: 'b1',
    });
    expect(positionOf(chosen.state, roller)).toBe('m2');
    expect(chosen.state.phase).toMatchObject({ playerId: roller, step: { type: 'awaitRoll' } });
  });
});

describe('gates', () => {
  test('stops the move at a failed gate, and lowers its threshold for that player', () => {
    const { board, state: initial } = setup(
      linearBoard([{ type: 'gate', threshold: 13 }, ...emptySpaces(5)]),
    );
    const roller = currentPlayer(initial);
    const state = { ...initial, rngState: rngStateRolling(5) };

    const { state: after, events } = act(board, state, player(roller), { type: 'roll' });
    const [test] = ofType(events, 'gateTested');
    expect(test).toMatchObject({ spaceId: 's1', threshold: 13, success: false });
    const stuck = after.players.find((candidate) => candidate.id === roller);
    expect(stuck).toMatchObject({ position: 's1', atGate: true, gateFailures: { s1: 1 } });

    // Au tour suivant, le lancer sert à retenter la porte, avec un seuil plus bas.
    const nextTry = {
      ...after,
      phase: { type: 'turn' as const, playerId: roller, step: { type: 'awaitRoll' as const } },
    };
    const retry = act(board, nextTry, player(roller), { type: 'roll' });
    expect(ofType(retry.events, 'gateTested')[0]?.threshold).toBe(12);
  });

  test('lets the move continue past a passed gate', () => {
    const { board, state: initial } = setup(
      linearBoard([{ type: 'gate', threshold: 1 }, ...emptySpaces(10)]),
    );
    const roller = currentPlayer(initial);
    const state = { ...initial, rngState: rngStateRolling(4) };
    const { state: after } = act(board, state, player(roller), { type: 'roll' });
    expect(positionOf(after, roller)).toBe('s4');
  });
});

describe('spaces', () => {
  test('applies a space reached with the dice, then flips one coin for a space reached by an effect', () => {
    const bonuses = Array.from({ length: 30 }, () => ({ type: 'bonus' as const, amount: 1 }));
    for (let seed = 0; seed < 40; seed++) {
      const { board, state: initial } = setup(linearBoard(bonuses));
      const roller = currentPlayer(initial);
      const state = { ...initial, rngState: new Rng(seed).state };
      const { state: after, events } = act(board, state, player(roller), { type: 'roll' });

      const total = ofType(events, 'diceRolled')[0]?.roll.total ?? 0;
      const flips = ofType(events, 'coinFlipped');
      expect(flips).toHaveLength(1);
      const extra = flips[0]?.heads ? 2 : 1;
      expect(positionOf(after, roller)).toBe(`s${total + extra}`);
    }
  });

  test('moves back along the lane the player actually took', () => {
    const { board, state: initial } = setup(forkBoard({ type: 'malus', amount: 2 }));
    const roller = currentPlayer(initial);
    const state = {
      ...patchPlayer(initial, roller, { position: 'b2', trail: ['start', 'fork', 'b1'] }),
      rngState: rngStateRolling(1),
    };
    const { state: after, events } = act(board, state, player(roller), { type: 'roll' });
    expect(ofType(events, 'moved').map((event) => event.path)).toEqual([['merge'], ['b2', 'b1']]);
    expect(positionOf(after, roller)).toBe('b1');
  });

  test('never pushes a player through a gate with an effect', () => {
    const { board, state: initial } = setup(
      linearBoard([
        { type: 'bonus', amount: 5 },
        { type: 'empty' },
        { type: 'gate', threshold: 1 },
        ...emptySpaces(5),
      ]),
    );
    const roller = currentPlayer(initial);
    const state = { ...initial, rngState: rngStateRolling(1) };
    const { state: after } = act(board, state, player(roller), { type: 'roll' });
    expect(after.players.find((candidate) => candidate.id === roller)).toMatchObject({
      position: 's3',
      atGate: true,
    });
  });
});

describe('victory', () => {
  function nearGoal(openers: PlayerId[]) {
    const { board, state: initial } = setup(linearBoard(emptySpaces(20), 1));
    let state = { ...initial, rngState: rngStateRolling(1, 1, 1, 1) };
    for (const id of openers) state = patchPlayer(state, id, { position: 's20' });
    for (let turn = 0; turn < 4; turn++) {
      state = act(board, state, player(currentPlayer(state)), { type: 'roll' }).state;
    }
    return { board, state };
  }

  test('a single player who opened the final gate wins at the end of the round', () => {
    const { state } = nearGoal(['bob']);
    expect(state.phase).toEqual({ type: 'finished', winner: 'bob' });
  });

  test('several openers play a finale, and its winner wins the game', () => {
    const { board, state } = nearGoal(['bob', 'dan']);
    // Les finalistes sont dans l'ordre où ils ont ouvert la porte.
    expect(state.phase.type).toBe('finale');
    expect(state.phase.type === 'finale' && [...state.phase.contenders].sort()).toEqual([
      'bob',
      'dan',
    ]);

    expect(
      applyIntent(board, state, SYSTEM, {
        type: 'submitFinaleResult',
        ranking: [['bob'], ['ana']],
      }),
    ).toEqual({
      ok: false,
      error: 'invalidRanking',
    });
    const { state: finished } = act(board, state, SYSTEM, {
      type: 'submitFinaleResult',
      ranking: [['dan'], ['bob']],
    });
    expect(finished.phase).toEqual({ type: 'finished', winner: 'dan' });
  });
});

describe('determinism and full games', () => {
  function playWithBots(seed: number) {
    const board = prepareBoard(
      linearBoard([
        ...emptySpaces(8),
        { type: 'bonus', amount: 3 },
        { type: 'gate', threshold: 4 },
        ...emptySpaces(8),
        { type: 'malus', amount: 3 },
        ...emptySpaces(6),
      ]),
    );
    let { state } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed });
    const botRng = new Rng(seed);
    for (let step = 0; step < 3000 && state.phase.type !== 'finished'; step++) {
      const actor = whoMustAct(state);
      if (!actor) break;
      const everyone = FOUR_PLAYERS.map(({ id }) => [id]);
      const { phase } = state;
      const intent: Intent | null =
        actor.type === 'player'
          ? chooseBoardIntent(board, state, actor.playerId, 'normal', botRng)
          : phase.type === 'turn' && phase.step.type === 'awaitDuelResult'
            ? {
                type: 'submitDuelResult',
                winner: botRng.pick([phase.playerId, phase.step.opponent]),
              }
            : phase.type === 'turn'
              ? { type: 'submitOneVsAllResult', soloWon: botRng.chance(0.3) }
              : phase.type === 'finale'
                ? { type: 'submitFinaleResult', ranking: phase.contenders.map((id) => [id]) }
                : phase.type === 'bonusMinigame'
                  ? { type: 'submitBonusMinigameResult', ranking: botRng.shuffle(everyone) }
                  : { type: 'submitMinigameResult', ranking: botRng.shuffle(everyone) };
      if (!intent) throw new Error(`Aucune décision possible (phase ${phase.type})`);
      state = act(board, state, actor, intent).state;
    }
    return state;
  }

  test('bots play complete games to a winner', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(playWithBots(seed).phase.type).toBe('finished');
  });

  test('replays exactly the same game from the same seed', () => {
    expect(playWithBots(11)).toEqual(playWithBots(11));
  });
});
