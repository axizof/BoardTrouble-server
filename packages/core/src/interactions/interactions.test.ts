import { describe, expect, test } from 'bun:test';
import { type BoardDefinition, prepareBoard, type SpaceKind } from '../board/board';
import { applyIntent, createGame, whoMustAct } from '../game/engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from '../game/types';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';

const SYSTEM: Actor = { type: 'system' };
const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

/** La case `kind` est en s(before + 1), sur un long chemin vide. */
function setup(kind: SpaceKind, before = 2) {
  const definition: BoardDefinition = linearBoard([
    ...emptySpaces(before),
    kind,
    ...emptySpaces(60),
  ]);
  const board = prepareBoard(definition);
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

function at(n: number): Partial<PlayerState> {
  return {
    position: `s${n}`,
    trail: ['start', ...Array.from({ length: n - 1 }, (_, i) => `s${i + 1}`)],
  };
}

function types(events: GameEvent[]) {
  return events.map((event) => event.type);
}

/** Ana arrive sur la case spéciale (s3) avec un 3. */
function landAna(board: Board, state: GameState) {
  return act(board, { ...state, rngState: rngStateRolling(3) }, player('ana'), { type: 'roll' });
}

describe('interaction spaces', () => {
  test('only trigger for the player whose turn it is', () => {
    const { board, state: initial } = setup({ type: 'duel' }, 9);
    let state = patch(initial, 'ana', { ...at(12), inventory: ['blower'] });
    state = patch(state, 'bob', at(14));
    // Bob recule de 4 jusqu'à s10, une case Duel, pendant le tour d'Ana : rien ne se passe.
    const { state: after } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'blower',
      target: 'bob',
    });
    expect(get(after, 'bob').position).toBe('s10');
    expect(after.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
  });

  test('squall sends a random opponent back 4 to 6 spaces, unless a shield blocks it', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { board, state: initial } = setup({ type: 'squall' });
      let state = initial;
      for (const id of ['bob', 'cam', 'dan']) state = patch(state, id, at(30));
      const { events } = landAna(board, { ...state, rngState: new Rng(seed).state });
      const hit = events.find((event) => event.type === 'squallHit');
      if (hit?.type !== 'squallHit') continue;
      expect(hit.spaces).toBeGreaterThanOrEqual(4);
      expect(hit.spaces).toBeLessThanOrEqual(6);
    }
    const { board, state: initial } = setup({ type: 'squall' });
    let shielded = initial;
    for (const id of ['bob', 'cam', 'dan'])
      shielded = patch(shielded, id, { ...at(30), inventory: ['shield'] });
    const { state: after } = landAna(board, shielded);
    expect(['bob', 'cam', 'dan'].map((id) => get(after, id).position)).toEqual([
      's30',
      's30',
      's30',
    ]);
  });

  test('swap exchanges places with a random opponent; a shield only protects a player it would send back', () => {
    const { board, state: initial } = setup({ type: 'swap' });
    let state = initial;
    for (const id of ['bob', 'cam', 'dan'])
      state = patch(state, id, { ...at(30), inventory: ['shield'] });
    const blocked = landAna(board, state).state;
    expect(get(blocked, 'ana').position).toBe('s3');

    // Ana en tête tombe sur un Échange : le joueur désigné y gagne, son Bouclier ne joue pas.
    const ahead = setup({ type: 'swap' }, 22);
    let leading = patch(ahead.state, 'ana', at(20));
    for (const id of ['bob', 'cam', 'dan'])
      leading = patch(leading, id, { ...at(1), inventory: ['shield'] });
    const swapped = landAna(ahead.board, leading).state;
    expect(get(swapped, 'ana').position).toBe('s1');
    const winner = ['bob', 'cam', 'dan'].find((id) => get(swapped, id).position === 's23');
    expect(winner && get(swapped, winner).inventory).toEqual(['shield']);
  });

  test('magnet pulls a chosen opponent of the same floor up to 4 spaces towards the player', () => {
    const { board, state: initial } = setup({ type: 'magnet' });
    let state = patch(initial, 'bob', at(20));
    state = patch(state, 'cam', at(5));
    const paused = landAna(board, state).state;
    if (paused.phase.type !== 'turn' || paused.phase.step.type !== 'awaitTarget') {
      throw new Error('Choix de cible attendu');
    }
    expect(paused.phase.step.options.sort()).toEqual(['bob', 'cam', 'dan']);
    expect(
      applyIntent(board, paused, player('ana'), { type: 'chooseTarget', playerId: 'ana' }),
    ).toEqual({
      ok: false,
      error: 'invalidChoice',
    });
    const pulledBack = act(board, paused, player('ana'), {
      type: 'chooseTarget',
      playerId: 'bob',
    }).state;
    expect(get(pulledBack, 'bob')).toMatchObject({
      position: 's16',
      lastAttack: { by: 'ana', spaces: 4 },
    });

    // Cam est juste devant : elle recule jusqu'à Ana, pas plus loin.
    const closeAhead = act(board, paused, player('ana'), {
      type: 'chooseTarget',
      playerId: 'cam',
    }).state;
    expect(get(closeAhead, 'cam').position).toBe('s3');
    // Dan est derrière (au départ) : il est attiré vers l'avant.
    const behind = act(board, paused, player('ana'), {
      type: 'chooseTarget',
      playerId: 'dan',
    }).state;
    expect(get(behind, 'dan').position).toBe('s3');
  });

  test('a mirror sends the magnet back: the attacker is pulled instead', () => {
    const { board, state: initial } = setup({ type: 'magnet' });
    const state = patch(initial, 'bob', { ...at(20), inventory: ['mirror'], mirrorArmed: true });
    const paused = landAna(board, state).state;
    const { state: after, events } = act(board, paused, player('ana'), {
      type: 'chooseTarget',
      playerId: 'bob',
    });
    expect(types(events)).toContain('mirrorReflected');
    expect(get(after, 'bob').position).toBe('s20');
    expect(get(after, 'ana').position).toBe('s7');
  });

  test('steal takes a random item from a chosen opponent who has one', () => {
    const { board, state: initial } = setup({ type: 'steal' });
    const state = patch(initial, 'cam', { inventory: ['key'] });
    const paused = landAna(board, state).state;
    expect(paused.phase).toMatchObject({ step: { type: 'awaitTarget', options: ['cam'] } });
    const { state: after } = act(board, paused, player('ana'), {
      type: 'chooseTarget',
      playerId: 'cam',
    });
    expect(get(after, 'ana').inventory).toEqual(['key']);
    expect(get(after, 'cam').inventory).toEqual([]);
  });

  test('a duel waits for the minigame result: the winner gains 6 spaces and the loser loses 6', () => {
    const { board, state: initial } = setup({ type: 'duel' });
    const state = patch(initial, 'bob', at(20));
    const paused = act(board, landAna(board, state).state, player('ana'), {
      type: 'chooseTarget',
      playerId: 'bob',
    }).state;
    expect(whoMustAct(paused)).toEqual(SYSTEM);
    expect(
      applyIntent(board, paused, player('ana'), { type: 'submitDuelResult', winner: 'ana' }),
    ).toEqual({
      ok: false,
      error: 'notAllowed',
    });
    expect(applyIntent(board, paused, SYSTEM, { type: 'submitDuelResult', winner: 'cam' })).toEqual(
      {
        ok: false,
        error: 'invalidChoice',
      },
    );

    const won = act(board, paused, SYSTEM, { type: 'submitDuelResult', winner: 'ana' }).state;
    expect(get(won, 'ana').position).toBe('s9');
    expect(get(won, 'bob')).toMatchObject({
      position: 's14',
      lastAttack: { by: 'ana', spaces: 6 },
    });
    expect(won.phase).toMatchObject({ playerId: 'bob' });

    for (const winner of ['bob', null]) {
      const other = act(board, paused, SYSTEM, { type: 'submitDuelResult', winner }).state;
      expect(get(other, 'ana').position).toBe('s3');
      expect(get(other, 'bob').position).toBe('s20');
    }
  });

  test('vendetta duels the last player who sent us back, and wins back the lost spaces', () => {
    const { board, state: initial } = setup({ type: 'vendetta' });
    let state = patch(initial, 'ana', { lastAttack: { by: 'dan', spaces: 5 } });
    state = patch(state, 'dan', at(10));
    const paused = landAna(board, state).state;
    expect(paused.phase).toMatchObject({
      step: { type: 'awaitDuelResult', opponent: 'dan', kind: 'vendetta' },
    });
    const won = act(board, paused, SYSTEM, { type: 'submitDuelResult', winner: 'ana' }).state;
    expect(get(won, 'ana')).toMatchObject({ position: 's8', lastAttack: null });

    const peaceful = landAna(board, initial).state;
    expect(peaceful.phase).toMatchObject({ playerId: 'bob' });
  });

  test('one versus all: the solo player gains 10 spaces if they win, nothing otherwise', () => {
    const { board, state } = setup({ type: 'oneVsAll' });
    const paused = landAna(board, state).state;
    expect(paused.phase).toMatchObject({ step: { type: 'awaitOneVsAllResult' } });
    expect(
      get(act(board, paused, SYSTEM, { type: 'submitOneVsAllResult', soloWon: true }).state, 'ana')
        .position,
    ).toBe('s13');
    expect(
      get(act(board, paused, SYSTEM, { type: 'submitOneVsAllResult', soloWon: false }).state, 'ana')
        .position,
    ).toBe('s3');
  });
});
