import { describe, expect, test } from 'bun:test';
import { prepareBoard, type SpaceKind } from '../board/board';
import { applyIntent, createGame } from '../game/engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from '../game/types';
import { interactionTargets } from '../interactions/interactions';
import { validTargets } from '../items/useItem';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { troubleRanking } from '../trouble/events';
import { AUTOMATIC_EXIT_TURN, JAIL_LENGTH } from './jail';

const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

/** Case des Filous en s3, sur un long chemin. `extra` remplace les cases suivantes. */
function setup(extra: SpaceKind[] = emptySpaces(60)) {
  const board = prepareBoard(linearBoard([...emptySpaces(2), { type: 'filous' }, ...extra]));
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

function types(events: GameEvent[]) {
  return events.map((event) => event.type);
}

/** Ana au Cachot (enlevée en s3), au début de son tour. */
function jailedAna(board: Board, state: GameState, jail = { turns: 0, progress: 0 }): GameState {
  const jailed = patch(state, 'ana', { position: 's3', trail: ['start', 's1', 's2'], jail });
  return act(
    board,
    { ...jailed, phase: { type: 'minigame', minigame: 'stacker' } },
    { type: 'system' },
    {
      type: 'submitMinigameResult',
      ranking: [['ana'], ['bob'], ['cam'], ['dan']],
    },
  ).state;
}

describe('the Filous', () => {
  test('kidnap the player who stops on their space, which ends the turn', () => {
    const { board, state } = setup();
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(3) },
      player('ana'),
      {
        type: 'roll',
      },
    );
    expect(types(events)).toContain('kidnapped');
    expect(get(after, 'ana')).toMatchObject({ position: 's3', jail: { turns: 0, progress: 0 } });
    expect(after.phase).toMatchObject({ playerId: 'bob' });
  });

  test('cannot kidnap a player with a shield', () => {
    const { board, state } = setup();
    const shielded = {
      ...patch(state, 'ana', { inventory: ['shield'] }),
      rngState: rngStateRolling(3),
    };
    const { state: after } = act(board, shielded, player('ana'), { type: 'roll' });
    expect(get(after, 'ana').jail).toBeNull();
  });

  test('a rocket that lands on the Filous ends the turn: no roll from the jail', () => {
    const board = prepareBoard(
      linearBoard([...emptySpaces(5), { type: 'filous' }, ...emptySpaces(20)]),
    );
    const { state: created } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 });
    const base: GameState = {
      ...patch(created, 'ana', { inventory: ['rocket'] }),
      turnOrder: ['ana', 'bob', 'cam', 'dan'],
      phase: { type: 'turn', playerId: 'ana', step: { type: 'awaitRoll' } },
    };
    let kidnappings = 0;
    for (let seed = 0; seed < 30; seed++) {
      // Arrivée par un effet : le pile ou face décide si les Filous agissent.
      const { state: after } = act(
        board,
        { ...base, rngState: new Rng(seed).state },
        player('ana'),
        {
          type: 'useItem',
          item: 'rocket',
        },
      );
      if (get(after, 'ana').jail) {
        kidnappings++;
        expect(after.phase).toMatchObject({ playerId: 'bob' });
      } else {
        expect(after.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
      }
    }
    expect(kidnappings).toBeGreaterThan(5);
  });
});

describe('in the jail', () => {
  test('the player chooses between advancing and the wheel; rolling or using items is refused', () => {
    const { board, state } = setup();
    const jailed = jailedAna(board, state);
    expect(jailed.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitJailChoice' } });
    expect(applyIntent(board, jailed, player('ana'), { type: 'roll' })).toEqual({
      ok: false,
      error: 'wrongPhase',
    });
  });

  test('advancing moves along the inner path, and its end leads to the trapdoors', () => {
    const { board, state } = setup();
    const jailed = jailedAna(board, state);
    const short = act(board, { ...jailed, rngState: rngStateRolling(2, 1) }, player('ana'), {
      type: 'chooseJailAction',
      action: 'advance',
    });
    expect(get(short.state, 'ana').jail?.progress).toBeGreaterThan(0);
    expect(get(short.state, 'ana').jail?.progress).toBeLessThan(JAIL_LENGTH);
    expect(short.state.phase).toMatchObject({ playerId: 'bob' });

    const nearEnd = jailedAna(board, state, { turns: 0, progress: 7 });
    const out = act(board, nearEnd, player('ana'), { type: 'chooseJailAction', action: 'advance' });
    expect(out.state.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitTrapdoor' } });
  });

  test('the wheel frees about 30 % of the time, 60 % with a lucky charm that is then used up', () => {
    const { board, state } = setup();
    const rate = (inventory: PlayerState['inventory']) => {
      let freed = 0;
      for (let seed = 0; seed < 400; seed++) {
        const jailed = patch(jailedAna(board, state), 'ana', { inventory });
        const { state: after } = act(
          board,
          { ...jailed, rngState: new Rng(seed).state },
          player('ana'),
          {
            type: 'chooseJailAction',
            action: 'wheel',
          },
        );
        if (after.phase.type === 'turn' && after.phase.step.type === 'awaitTrapdoor') freed++;
        expect(get(after, 'ana').inventory).not.toContain('luckyCharm');
      }
      return freed / 400;
    };
    expect(rate([])).toBeGreaterThan(0.24);
    expect(rate([])).toBeLessThan(0.36);
    expect(rate(['luckyCharm'])).toBeGreaterThan(0.53);
    expect(rate(['luckyCharm'])).toBeLessThan(0.67);
  });

  test('opens automatically on the third turn in the jail', () => {
    const { board, state } = setup();
    const third = jailedAna(board, state, { turns: AUTOMATIC_EXIT_TURN - 1, progress: 0 });
    expect(third.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitTrapdoor' } });
  });

  test('a trapdoor brings the player back near the kidnapping spot, without triggering the space', () => {
    const offsets = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      // s8 est une case Bonus : y revenir par une trappe ne la déclenche pas.
      const { board, state } = setup([
        ...emptySpaces(4),
        { type: 'bonus', amount: 5 },
        ...emptySpaces(40),
      ]);
      const atTrapdoors = jailedAna(board, state, { turns: AUTOMATIC_EXIT_TURN - 1, progress: 0 });
      const { state: after, events } = act(
        board,
        { ...atTrapdoors, rngState: new Rng(seed).state },
        player('ana'),
        {
          type: 'chooseTrapdoor',
          trapdoor: 1,
        },
      );
      const opened = events.find((event) => event.type === 'trapdoorOpened');
      if (opened?.type !== 'trapdoorOpened') throw new Error('Trappe attendue');
      offsets.add(opened.offset);
      const expected = { [-5]: 'start', 0: 's3', 5: 's8' }[opened.offset];
      expect(get(after, 'ana')).toMatchObject({ position: expected, jail: null });
      expect(types(events)).not.toContain('spaceTriggered');
    }
    expect([...offsets].sort((a, b) => a - b)).toEqual([-5, 0, 5]);
  });
});

describe('a jailed player is untouchable', () => {
  test('by items, interactions and positional TROUBLE, but still gets an item rain', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'bob', {
      position: 's3',
      jail: { turns: 1, progress: 0 },
      inventory: ['key'],
    });
    state = patch(state, 'ana', { position: 's5' });
    expect(validTargets(board, state, 'ana', 'blower')).not.toContain('bob');
    expect(validTargets(board, state, 'ana', 'pickpocket')).not.toContain('bob');
    expect(interactionTargets(board, state, 'ana', 'duel')).not.toContain('bob');
    expect(troubleRanking(board, state)).not.toContain('bob');

    const rain = act(
      board,
      { ...state, phase: { type: 'trouble', chooser: 'dan', options: ['itemRain'] } },
      player('dan'),
      {
        type: 'chooseTrouble',
        event: 'itemRain',
      },
    ).state;
    expect(get(rain, 'bob').inventory).toHaveLength(2);
  });
});
