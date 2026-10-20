import { describe, expect, test } from 'bun:test';
import {
  type BoardDefinition,
  type FloorRules,
  prepareBoard,
  type Space,
  type SpaceKind,
  validateBoard,
} from '../board/board';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { isApplicable } from '../trouble/events';
import { applyIntent, createGame } from './engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from './types';

const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });
const JAILED: Partial<PlayerState> = { jail: { turns: 0, progress: 0 } };

const FLOOR_ONE = Array.from({ length: 12 }, (_, index) => `a${index + 1}`);
const FLOOR_TWO = Array.from({ length: 12 }, (_, index) => `b${index + 1}`);
const PATH = ['start', ...FLOOR_ONE, ...FLOOR_TWO, 'goal'];
/** Cases de bord de l'étage 2 : bN tombe sur aN. */
const EDGES = ['b5', 'b6', 'b7', 'b8'];

/** Deux étages de 12 cases vides : start -> a1..a12 -> b1..b12 -> goal. */
function floorsBoard(
  kinds: Record<string, SpaceKind> = {},
  floors?: Record<number, FloorRules>,
): BoardDefinition {
  const spaces = PATH.map((id, index): Space => {
    const next = PATH[index + 1];
    const space: Space = {
      id,
      kind: kinds[id] ?? { type: 'empty' },
      floor: id.startsWith('b') || id === 'goal' ? 2 : id === 'start' ? 0 : 1,
      next: next ? [next] : [],
    };
    if (EDGES.includes(id)) space.fallsTo = id.replace('b', 'a');
    return space;
  });
  const start = spaces[0];
  const goal = spaces.at(-1);
  if (start) start.kind = { type: 'start' };
  if (goal) goal.kind = { type: 'finalGate', threshold: 6 };
  return {
    id: 'floors',
    name: 'Deux étages',
    start: 'start',
    spaces: Object.fromEntries(spaces.map((space) => [space.id, space])),
    ...(floors ? { floors } : {}),
  };
}

function setup(definition: BoardDefinition) {
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

/** Posé sur `id` après avoir suivi le chemin depuis le départ. */
function at(id: string, path: string[] = PATH): Partial<PlayerState> {
  return { position: id, trail: path.slice(0, path.indexOf(id)) };
}

function types(events: GameEvent[]) {
  return events.map((event) => event.type);
}

/** Dan joue le dernier tour de la manche avec un 1 : la manche se termine. */
function endRound(board: Board, state: GameState, seed: number) {
  const last: GameState = {
    ...patch(state, 'dan', at('start')),
    turnIndex: 3,
    phase: { type: 'turn', playerId: 'dan', step: { type: 'awaitRoll' } },
    rngState: seed,
  };
  return act(board, last, player('dan'), { type: 'roll' });
}

describe('edges and falls', () => {
  test('a squall makes a player on an edge fall one floor, without triggering the landing', () => {
    const { board, state: initial } = setup(
      floorsBoard({ a2: { type: 'squall' }, a6: { type: 'bonus', amount: 3 } }),
    );
    let state = patch(initial, 'bob', at('b6'));
    for (const id of ['cam', 'dan']) state = patch(state, id, JAILED);
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(2) },
      player('ana'),
      { type: 'roll' },
    );
    expect(types(events)).toContain('fell');
    expect(get(after, 'bob')).toMatchObject({ position: 'a6', trail: [], atGate: false });
  });

  test('a push away from an edge is a plain recoil', () => {
    const { board, state: initial } = setup(floorsBoard({ a2: { type: 'squall' } }));
    let state = patch(initial, 'bob', at('b4'));
    for (const id of ['cam', 'dan']) state = patch(state, id, JAILED);
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(2) },
      player('ana'),
      { type: 'roll' },
    );
    expect(types(events)).not.toContain('fell');
    expect(['a12', 'a11', 'a10']).toContain(get(after, 'bob').position);
  });

  test('a parachute stops the fall and is used up: the push applies normally', () => {
    const { board, state: initial } = setup(floorsBoard({ a2: { type: 'squall' } }));
    let state = patch(initial, 'bob', { ...at('b6'), inventory: ['parachute'] });
    for (const id of ['cam', 'dan']) state = patch(state, id, JAILED);
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(2) },
      player('ana'),
      { type: 'roll' },
    );
    expect(types(events)).toContain('parachuteOpened');
    expect(types(events)).not.toContain('fell');
    expect(['b2', 'b1', 'a12']).toContain(get(after, 'bob').position);
    expect(get(after, 'bob').inventory).toEqual([]);
  });

  test('a blower makes its target fall and records the spaces lost for the Vendetta', () => {
    const { board, state: initial } = setup(floorsBoard());
    let state = patch(initial, 'ana', { ...at('b3'), inventory: ['blower'] });
    state = patch(state, 'bob', at('b6'));
    const { state: after } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'blower',
      target: 'bob',
    });
    expect(get(after, 'bob')).toMatchObject({
      position: 'a6',
      lastAttack: { by: 'ana', spaces: 12 },
    });
  });

  test('a boulder makes the players on an edge fall instead of rolling them down', () => {
    const { board, state: initial } = setup(
      floorsBoard({ b10: { type: 'boulderGate', threshold: 12 } }),
    );
    let state = patch(initial, 'ana', at('b8'));
    state = patch(state, 'bob', at('b6'));
    state = patch(state, 'cam', at('b3'));
    const { state: after } = act(board, { ...state, rngState: rngStateRolling(2) }, player('ana'), {
      type: 'roll',
    });
    expect(get(after, 'bob').position).toBe('a6');
    expect(get(after, 'cam').position).toBe('a7');
  });

  test('the earthquake drops every player on an edge, and is only offered when someone is on one', () => {
    const { board, state: initial } = setup(floorsBoard());
    expect(isApplicable(board, initial, 'earthquake')).toBe(false);
    let state = patch(initial, 'ana', at('b5'));
    state = patch(state, 'bob', { ...at('b7'), inventory: ['parachute'] });
    state = patch(state, 'cam', at('b2'));
    expect(isApplicable(board, state, 'earthquake')).toBe(true);
    const waking: GameState = {
      ...state,
      phase: { type: 'trouble', chooser: 'dan', options: ['earthquake'] },
    };
    const { state: after } = act(board, waking, player('dan'), {
      type: 'chooseTrouble',
      event: 'earthquake',
    });
    expect(get(after, 'ana').position).toBe('a5');
    expect(get(after, 'bob')).toMatchObject({ position: 'b7', inventory: [] });
    expect(get(after, 'cam').position).toBe('b2');
  });
});

describe('the jostle space', () => {
  test('pushes the opponents within 2 spaces back by one, and makes those on an edge fall', () => {
    const { board, state: initial } = setup(floorsBoard({ b4: { type: 'jostle' } }));
    let state = patch(initial, 'ana', at('b1'));
    state = patch(state, 'bob', at('b6'));
    state = patch(state, 'cam', { ...at('b3'), inventory: ['shield'] });
    state = patch(state, 'dan', at('b9'));
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(3) },
      player('ana'),
      { type: 'roll' },
    );
    expect(events.find((event) => event.type === 'jostled')).toMatchObject({
      players: ['bob', 'cam'],
    });
    expect(get(after, 'bob').position).toBe('a6');
    expect(get(after, 'cam')).toMatchObject({ position: 'b3', inventory: [] });
    expect(get(after, 'dan').position).toBe('b9');
  });
});

describe('mud', () => {
  test('makes every push on its floor go 2 spaces further, but not other recoils', () => {
    const muddy = floorsBoard({ b6: { type: 'malus', amount: 3 } }, { 2: { muddy: true } });
    const { board, state: initial } = setup(muddy);
    const pushed = act(
      board,
      patch(patch(initial, 'ana', { ...at('b2'), inventory: ['blower'] }), 'bob', at('b4')),
      player('ana'),
      { type: 'useItem', item: 'blower', target: 'bob' },
    ).state;
    expect(get(pushed, 'bob').position).toBe('a10');

    const state = { ...patch(initial, 'ana', at('b3')), rngState: rngStateRolling(3) };
    const { state: after } = act(board, state, player('ana'), { type: 'roll' });
    expect(get(after, 'ana').position).toBe('b3');
  });
});

describe('wind', () => {
  test('sometimes blows at the end of a round and pushes everyone on a windy floor', () => {
    const windy = floorsBoard({}, { 2: { windy: true } });
    let rounds = 0;
    let gusts = 0;
    let checked = false;
    for (let seed = 0; seed < 300; seed++) {
      const { board, state: initial } = setup(windy);
      let state = patch(initial, 'ana', at('b3'));
      state = patch(state, 'bob', at('b10'));
      state = patch(state, 'cam', at('a6'));
      const { state: after, events } = endRound(board, state, new Rng(seed).state);
      rounds++;
      const wind = events.find((event) => event.type === 'windBlew');
      if (wind?.type !== 'windBlew') continue;
      gusts++;
      expect(wind.pushed).toEqual(['ana', 'bob']);
      if (checked || types(events).includes('roundEvent')) continue;
      const back = (from: string) => PATH[PATH.indexOf(from) - wind.strength];
      expect(get(after, 'ana').position).toBe(back('b3') ?? '');
      expect(get(after, 'bob').position).toBe(back('b10') ?? '');
      expect(get(after, 'cam').position).toBe('a6');
      checked = true;
    }
    expect(checked).toBe(true);
    expect(gusts / rounds).toBeGreaterThan(0.15);
    expect(gusts / rounds).toBeLessThan(0.35);
  });
});

describe('conveyors', () => {
  test('move the players standing on them at the end of the round, never on arrival', () => {
    const { board, state: initial } = setup(
      linearBoard([
        ...emptySpaces(2),
        { type: 'conveyor', direction: 'forward', amount: 3 },
        ...emptySpaces(6),
        { type: 'conveyor', direction: 'backward', amount: 2 },
        ...emptySpaces(20),
      ]),
    );
    const landed = act(board, { ...initial, rngState: rngStateRolling(3) }, player('ana'), {
      type: 'roll',
    });
    expect(get(landed.state, 'ana').position).toBe('s3');
    expect(types(landed.events)).not.toContain('conveyorMoved');

    const linear = ['start', ...Array.from({ length: 30 }, (_, index) => `s${index + 1}`)];
    let state = patch(initial, 'ana', at('s3', linear));
    state = patch(state, 'bob', at('s10', linear));
    state = patch(state, 'cam', { ...at('s3', linear), ...JAILED });
    const { state: after, events } = endRound(board, state, rngStateRolling(1));
    expect(types(events)).toContain('conveyorMoved');
    expect(get(after, 'ana').position).toBe('s6');
    expect(get(after, 'bob').position).toBe('s8');
    expect(get(after, 'cam').position).toBe('s3');
  });
});

describe('drawbridges', () => {
  /** start -> fork -> (m1 -> m2 -> m3 -> m4) ou (pont-levis) -> join -> t1..t10 -> goal. */
  function bridgeBoard(): BoardDefinition {
    const tail = Array.from({ length: 10 }, (_, index) => `t${index + 1}`);
    const spaces: Space[] = [
      { id: 'start', kind: { type: 'start' }, floor: 0, next: ['fork'] },
      { id: 'fork', kind: { type: 'empty' }, floor: 0, next: ['m1', 'bridge'] },
      { id: 'm1', kind: { type: 'empty' }, floor: 0, next: ['m2'] },
      { id: 'm2', kind: { type: 'empty' }, floor: 0, next: ['m3'] },
      { id: 'm3', kind: { type: 'empty' }, floor: 0, next: ['m4'] },
      { id: 'm4', kind: { type: 'empty' }, floor: 0, next: ['join'] },
      { id: 'bridge', kind: { type: 'drawbridge' }, floor: 0, next: ['join'] },
      { id: 'join', kind: { type: 'empty' }, floor: 0, next: ['t1'] },
      ...tail.map((id, index) => ({
        id,
        kind: { type: 'empty' } as const,
        floor: 0,
        next: [tail[index + 1] ?? 'goal'],
      })),
      { id: 'goal', kind: { type: 'finalGate', threshold: 6 }, floor: 0, next: [] },
    ];
    return {
      id: 'bridge',
      name: 'Pont-levis',
      start: 'start',
      spaces: Object.fromEntries(spaces.map((space) => [space.id, space])),
    };
  }

  test('are only offered at a fork on odd rounds', () => {
    const { board, state: initial } = setup(bridgeBoard());
    const state = { ...patch(initial, 'ana', at('fork', ['start', 'fork'])), rngState: 0 };
    const open = act(board, { ...state, rngState: rngStateRolling(3) }, player('ana'), {
      type: 'roll',
    }).state;
    expect(open.phase).toMatchObject({ step: { type: 'awaitBranch', options: ['m1', 'bridge'] } });

    const closed = act(board, { ...state, round: 2, rngState: rngStateRolling(3) }, player('ana'), {
      type: 'roll',
    }).state;
    expect(get(closed, 'ana').position).toBe('m3');
  });
});

describe('ice', () => {
  const kinds: SpaceKind[] = [
    ...emptySpaces(2),
    { type: 'ice' },
    { type: 'ice' },
    { type: 'item' },
    ...emptySpaces(2),
    { type: 'malus', amount: 4 },
    ...emptySpaces(20),
  ];
  const linear = ['start', ...Array.from({ length: 30 }, (_, index) => `s${index + 1}`)];

  test('a die that ends on ice slides to the next space, which triggers as a dice arrival', () => {
    const { board, state } = setup(linearBoard(kinds));
    const { state: after, events } = act(
      board,
      { ...state, rngState: rngStateRolling(3) },
      player('ana'),
      { type: 'roll' },
    );
    expect(events.find((event) => event.type === 'moved')).toMatchObject({
      path: ['s1', 's2', 's3', 's4', 's5'],
    });
    expect(get(after, 'ana').inventory).toHaveLength(1);
  });

  test('passing over ice changes nothing, and a recoil onto ice keeps sliding back', () => {
    const { board, state } = setup(linearBoard(kinds));
    const passed = act(board, { ...state, rngState: rngStateRolling(6) }, player('ana'), {
      type: 'roll',
    }).state;
    expect(get(passed, 'ana').position).toBe('s6');

    const recoiled = act(
      board,
      { ...patch(state, 'ana', at('s6', linear)), rngState: rngStateRolling(2) },
      player('ana'),
      { type: 'roll' },
    ).state;
    expect(get(recoiled, 'ana').position).toBe('s2');
  });

  test('sliding into a gate tries the gate', () => {
    const { board, state } = setup(linearBoard([{ type: 'empty' }, { type: 'ice' }]));
    const { events } = act(board, { ...state, rngState: rngStateRolling(2) }, player('ana'), {
      type: 'roll',
    });
    expect(types(events)).toContain('gateTested');
  });
});

describe('board validation', () => {
  test('rejects edges that do not fall one floor down, and landings or forks on ice', () => {
    const wrongFloor = floorsBoard();
    const b6 = wrongFloor.spaces.b6;
    if (b6) b6.fallsTo = 'b2';
    expect(validateBoard(wrongFloor).join()).toContain("l'étage juste en dessous");

    const onIce = floorsBoard({ a6: { type: 'ice' } });
    expect(validateBoard(onIce).join()).toContain('case gelée');

    const forkOnIce = floorsBoard({ a3: { type: 'ice' } });
    forkOnIce.spaces.a3?.next.push('a5');
    expect(validateBoard(forkOnIce).join()).toContain("qu'une case suivante");

    const teleportOnIce = floorsBoard({
      a2: { type: 'teleporter', to: 'a9' },
      a9: { type: 'ice' },
    });
    expect(validateBoard(teleportOnIce).join()).toContain('case gelée');
  });

  test('rejects a drawbridge on the main path', () => {
    expect(validateBoard(floorsBoard({ a4: { type: 'drawbridge' } })).join()).toContain(
      'voie principale',
    );
  });
});
