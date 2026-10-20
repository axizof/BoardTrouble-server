import { describe, expect, test } from 'bun:test';
import { prepareBoard, type SpaceKind } from '../board/board';
import type { Context } from '../game/context';
import { applyIntent, createGame } from '../game/engine';
import type { Actor, GameState, Intent, PlayerId, PlayerState } from '../game/types';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { TROUBLE_CATEGORY } from '../trouble/events';
import { MINIGAME_IDS, type MinigameId, minigameCandidates } from './catalog';
import { drawMinigame, drawMinigameOptions } from './selection';

const SYSTEM: Actor = { type: 'system' };
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

/** Dan joue le dernier tour de la manche avec un 1 : la manche se termine. */
function endRound(board: Board, state: GameState, rngState = rngStateRolling(1)) {
  const last: GameState = {
    ...state,
    turnIndex: 3,
    phase: { type: 'turn', playerId: 'dan', step: { type: 'awaitRoll' } },
    rngState,
  };
  return act(board, last, player('dan'), { type: 'roll' });
}

function contextFor(state: GameState, seed: number): Context {
  const { board } = setup();
  return {
    board,
    state,
    rng: new Rng(seed),
    events: [],
    resume: 'endTurn',
    pendingItemChoices: [],
    eruptionChain: 0,
  };
}

describe('the minigame catalog', () => {
  test('offers each occasion its own minigames, and finales by number of finalists', () => {
    expect(minigameCandidates('round', 4)).toHaveLength(9);
    expect(minigameCandidates('duel', 2)).toEqual(['highNoon']);
    expect(minigameCandidates('oneVsAll', 4)).toEqual(['bigDie', 'rampart']);
    expect(minigameCandidates('solo', 1)).toEqual(['perfectGauge', 'combination']);
    expect(minigameCandidates('finale', 2)).toEqual(['pawnSumo', 'highNoon', 'lastRoll']);
    expect(minigameCandidates('finale', 3)).toEqual(['pawnSumo', 'lastRoll']);
  });
});

describe('the minigame wheel', () => {
  test('avoids the minigame played just before', () => {
    const { state } = setup();
    for (let seed = 0; seed < 300; seed++) {
      const fresh = structuredClone(state);
      fresh.minigames.last = 'stacker';
      expect(drawMinigame(contextFor(fresh, seed), 'round', 4)).not.toBe('stacker');
    }
  });

  test('favours the minigames played least, without making them certain', () => {
    const { state } = setup();
    const played = Object.fromEntries(MINIGAME_IDS.map((id) => [id, 3]));
    let fresh = 0;
    for (let seed = 0; seed < 600; seed++) {
      const counted = structuredClone(state);
      counted.minigames.played = { ...played, cardMemory: 0 };
      if (drawMinigame(contextFor(counted, seed), 'round', 4) === 'cardMemory') fresh++;
    }
    // Poids 1 contre 0,25 pour chacun des 8 autres : environ une fois sur trois.
    expect(fresh / 600).toBeGreaterThan(0.25);
    expect(fresh / 600).toBeLessThan(0.42);
  });

  test('offers three different minigames to choose from', () => {
    const { state } = setup();
    for (let seed = 0; seed < 50; seed++) {
      const options = drawMinigameOptions(contextFor(structuredClone(state), seed), 'round', 4);
      expect(new Set(options).size).toBe(3);
    }
  });

  test('draws the round minigame when the round ends, and records it', () => {
    const { board, state } = setup();
    const { state: after, events } = endRound(board, state);
    if (after.phase.type !== 'minigame') throw new Error('Mini-jeu attendu');
    const { minigame } = after.phase;
    expect(minigameCandidates('round', 4)).toContain(minigame);
    expect(events).toContainEqual({ type: 'minigameDrawn', occasion: 'round', minigame });
    expect(after.minigames).toMatchObject({ last: minigame, played: { [minigame]: 1 } });
  });

  test('draws the minigame of duels, finales and skill gates', () => {
    const duel = setup([...emptySpaces(2), { type: 'duel' }, ...emptySpaces(20)]);
    const target = act(duel.board, { ...duel.state, rngState: rngStateRolling(3) }, player('ana'), {
      type: 'roll',
    }).state;
    const fighting = act(duel.board, target, player('ana'), {
      type: 'chooseTarget',
      playerId: 'bob',
    }).state;
    expect(fighting.phase).toMatchObject({
      step: { type: 'awaitDuelResult', minigame: 'highNoon' },
    });

    const gate = setup([...emptySpaces(2), { type: 'skillGate' }, ...emptySpaces(20)]);
    const testing = act(
      gate.board,
      { ...gate.state, rngState: rngStateRolling(3) },
      player('ana'),
      { type: 'roll' },
    ).state;
    if (testing.phase.type !== 'turn' || testing.phase.step.type !== 'awaitSkillGate') {
      throw new Error('Porte d adresse attendue');
    }
    expect(minigameCandidates('solo', 1)).toContain(testing.phase.step.minigame);

    const { board, state } = setup();
    const { state: finale } = endRound(board, { ...state, finalGateOpenedBy: ['ana', 'bob'] });
    if (finale.phase.type !== 'finale') throw new Error('Finale attendue');
    expect(minigameCandidates('finale', 2)).toContain(finale.phase.minigame);
  });
});

describe('choosing the next minigame', () => {
  test('a joker lets its owner choose the next round minigame among 3', () => {
    const { board, state: initial } = setup();
    const state = patch(patch(initial, 'ana', { inventory: ['joker'] }), 'bob', {
      inventory: ['joker'],
    });
    const granted = act(board, state, player('ana'), { type: 'useItem', item: 'joker' });
    expect(granted.events).toContainEqual({ type: 'minigameChoiceGranted', playerId: 'ana' });
    // Un seul droit à la fois : le Joker de Bob attendra.
    const bobTurn: GameState = {
      ...granted.state,
      turn: { ...granted.state.turn, itemUsed: false },
      phase: { type: 'turn', playerId: 'bob', step: { type: 'awaitRoll' } },
    };
    expect(applyIntent(board, bobTurn, player('bob'), { type: 'useItem', item: 'joker' })).toEqual({
      ok: false,
      error: 'itemNotUsable',
    });

    const { state: choosing } = endRound(board, granted.state);
    if (choosing.phase.type !== 'minigameChoice') throw new Error('Choix attendu');
    const { options } = choosing.phase;
    expect(choosing.phase.chooser).toBe('ana');
    expect(options).toHaveLength(3);
    const [chosen] = options as [MinigameId];
    expect(
      applyIntent(board, choosing, player('bob'), { type: 'chooseMinigame', minigame: chosen }),
    ).toEqual({ ok: false, error: 'notYourTurn' });
    const { state: after } = act(board, choosing, player('ana'), {
      type: 'chooseMinigame',
      minigame: chosen,
    });
    expect(after.phase).toEqual({ type: 'minigame', minigame: chosen });
    expect(after.minigames).toMatchObject({ nextChooser: null, last: chosen });
    const started = act(board, after, SYSTEM, {
      type: 'submitMinigameResult',
      ranking: [['ana'], ['bob'], ['cam'], ['dan']],
    }).state;
    expect(started.phase).toMatchObject({ type: 'turn', playerId: 'ana' });
  });

  test('a round event sometimes gives a player the choice of the next minigame', () => {
    for (let seed = 0; seed < 400; seed++) {
      const { board, state } = setup();
      const { state: after, events } = endRound(board, state, new Rng(seed).state);
      const event = events.find(
        (candidate) => candidate.type === 'roundEvent' && candidate.event === 'minigameChoice',
      );
      if (event?.type !== 'roundEvent') continue;
      expect(after.phase).toMatchObject({ type: 'minigameChoice', chooser: event.playerId });
      return;
    }
    throw new Error('Aucun événement de choix du mini-jeu sur 400 graines');
  });
});

describe('the mystery box', () => {
  test('gives an item most of the time, and otherwise a small TROUBLE on its owner', () => {
    let items = 0;
    let troubles = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { board, state: initial } = setup();
      const state = { ...patch(initial, 'ana', { inventory: ['mysteryBox'] }), rngState: seed };
      const { state: after, events } = act(board, state, player('ana'), {
        type: 'useItem',
        item: 'mysteryBox',
      });
      const opened = events.find((event) => event.type === 'mysteryBoxOpened');
      if (opened?.type !== 'mysteryBoxOpened') throw new Error('Boîte non ouverte');
      if (opened.outcome === 'item') {
        items++;
        expect(after.players.find((p) => p.id === 'ana')?.inventory).toHaveLength(1);
      } else {
        troubles++;
        const applied = events.find((event) => event.type === 'troubleApplied');
        expect(applied?.type === 'troubleApplied' && TROUBLE_CATEGORY[applied.event]).toMatch(
          /small|mild/,
        );
      }
      expect(after.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
    }
    expect(items / 200).toBeGreaterThan(0.5);
    expect(items / 200).toBeLessThan(0.7);
    expect(troubles).toBeGreaterThan(0);
  });
});

describe('the board seal', () => {
  test('lets its owner trigger a TROUBLE event chosen among one of each violence', () => {
    const { board, state: initial } = setup();
    const state = patch(initial, 'ana', { inventory: ['boardSeal'] });
    const choosing = act(board, state, player('ana'), { type: 'useItem', item: 'boardSeal' }).state;
    if (choosing.phase.type !== 'turn' || choosing.phase.step.type !== 'awaitTroubleChoice') {
      throw new Error('Choix du TROUBLE attendu');
    }
    const { options } = choosing.phase.step;
    expect(options.map((event) => TROUBLE_CATEGORY[event])).toEqual(['mild', 'medium', 'violent']);
    expect(options).not.toContain('bonusMinigame');

    const [event] = options as [(typeof options)[number]];
    const { state: after, events } = act(board, choosing, player('ana'), {
      type: 'chooseTrouble',
      event,
    });
    expect(events).toContainEqual({ type: 'troubleApplied', event, chooser: 'ana' });
    expect(after.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
    expect(after.trouble.gauge).toBe(state.trouble.gauge);
  });
});
