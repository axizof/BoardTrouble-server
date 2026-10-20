import { describe, expect, test } from 'bun:test';
import { prepareBoard, type SpaceKind, validateBoard } from '../board/board';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { applyIntent, createGame, whoMustAct } from './engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from './types';

const SYSTEM: Actor = { type: 'system' };
const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

function setup(kinds: SpaceKind[]) {
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

function at(n: number): Partial<PlayerState> {
  return {
    position: `s${n}`,
    trail: ['start', ...Array.from({ length: n - 1 }, (_, i) => `s${i + 1}`)],
  };
}

function types(events: GameEvent[]) {
  return events.map((event) => event.type);
}

/** Ana lance `values` (premier tour : pas de dé bonus). */
function roll(board: Board, state: GameState, ...values: number[]) {
  return act(board, { ...state, rngState: rngStateRolling(...values) }, player('ana'), {
    type: 'roll',
  });
}

/** Une porte en s5, puis un long chemin. */
function gateBoard(gate: SpaceKind) {
  return setup([...emptySpaces(4), gate, ...emptySpaces(40)]);
}

describe('twin gate', () => {
  test('stops the move to choose a door; the trapped one is drawn after the choice', () => {
    let passed = 0;
    let trapped = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { board, state } = gateBoard({ type: 'twinGate' });
      const paused = roll(board, state, 6).state;
      expect(paused.phase).toMatchObject({ step: { type: 'awaitDoor', remaining: 1 } });
      const { state: after } = act(
        board,
        { ...paused, rngState: new Rng(seed).state },
        player('ana'),
        {
          type: 'chooseDoor',
          door: 0,
        },
      );
      if (get(after, 'ana').position === 's6') passed++;
      else {
        trapped++;
        expect(get(after, 'ana').position).toBe('start');
      }
      expect(after.phase).toMatchObject({ playerId: 'bob' });
    }
    expect(passed).toBeGreaterThan(8);
    expect(trapped).toBeGreaterThan(8);
  });

  test('a player stopped in front chooses a door with the whole roll still to move', () => {
    const { board, state } = gateBoard({ type: 'twinGate' });
    const waiting = patch(state, 'ana', { ...at(5), atGate: true });
    expect(roll(board, waiting, 4).state.phase).toMatchObject({
      step: { type: 'awaitDoor', remaining: 4 },
    });
  });
});

describe('skill gate', () => {
  test('waits for the server; success passes with 3 more spaces, failure stays in front', () => {
    const { board, state } = gateBoard({ type: 'skillGate' });
    const paused = roll(board, state, 6).state;
    expect(whoMustAct(paused)).toEqual(SYSTEM);
    expect(
      applyIntent(board, paused, player('ana'), { type: 'submitSkillGateResult', success: true }),
    ).toEqual({
      ok: false,
      error: 'notAllowed',
    });
    const success = act(board, paused, SYSTEM, {
      type: 'submitSkillGateResult',
      success: true,
    }).state;
    expect(get(success, 'ana').position).toBe('s9');
    const failure = act(board, paused, SYSTEM, {
      type: 'submitSkillGateResult',
      success: false,
    }).state;
    expect(get(failure, 'ana')).toMatchObject({ position: 's5', atGate: true });
  });
});

describe('toll gate', () => {
  test('lets a player pay an item to pass, or try the threshold', () => {
    const { board, state } = gateBoard({ type: 'tollGate', threshold: 13 });
    const paused = roll(board, patch(state, 'ana', { inventory: ['turboDie'] }), 6).state;
    expect(paused.phase).toMatchObject({ step: { type: 'awaitToll', remaining: 1, roll: null } });
    expect(applyIntent(board, paused, player('ana'), { type: 'payToll', item: 'key' })).toEqual({
      ok: false,
      error: 'itemNotOwned',
    });
    const paid = act(board, paused, player('ana'), { type: 'payToll', item: 'turboDie' }).state;
    expect(get(paid, 'ana')).toMatchObject({ position: 's6', inventory: [] });
    const tried = act(board, paused, player('ana'), { type: 'payToll', item: null }).state;
    expect(get(tried, 'ana')).toMatchObject({
      position: 's5',
      atGate: true,
      inventory: ['turboDie'],
    });
  });

  test('goes straight to the threshold for a player without items', () => {
    const { board, state } = gateBoard({ type: 'tollGate', threshold: 1 });
    const { events } = roll(board, state, 6);
    expect(types(events)).toContain('gateTested');
  });
});

describe('boulder gate', () => {
  test('a failure sends everyone on the 15 spaces below the gate to the bottom of the course', () => {
    const { board, state: initial } = setup([
      ...emptySpaces(20),
      { type: 'boulderGate', threshold: 13 },
      ...emptySpaces(10),
    ]);
    let state = patch(initial, 'ana', at(18));
    state = patch(state, 'bob', { ...at(10), inventory: [] });
    state = patch(state, 'cam', at(3));
    state = patch(state, 'dan', at(25));
    const { state: after, events } = roll(board, state, 3);
    const boulder = events.find((event) => event.type === 'boulderRolled');
    expect(boulder).toMatchObject({ to: 's6' });
    expect(get(after, 'ana').position).toBe('s6');
    expect(get(after, 'bob').position).toBe('s6');
    expect(get(after, 'cam').position).toBe('s3');
    expect(get(after, 'dan').position).toBe('s25');
  });

  test('spares players with a shield or in the jail', () => {
    const { board, state: initial } = setup([
      ...emptySpaces(20),
      { type: 'boulderGate', threshold: 13 },
      ...emptySpaces(10),
    ]);
    let state = patch(initial, 'ana', at(18));
    state = patch(state, 'bob', { ...at(10), inventory: ['shield'] });
    state = patch(state, 'cam', { ...at(12), jail: { turns: 1, progress: 0 } });
    const { state: after } = roll(board, state, 3);
    expect(get(after, 'bob')).toMatchObject({ position: 's10', inventory: [] });
    expect(get(after, 'cam').position).toBe('s12');
  });
});

describe('the key', () => {
  test('opens every gate except the final one', () => {
    for (const gate of [
      { type: 'twinGate' },
      { type: 'skillGate' },
      { type: 'tollGate', threshold: 13 },
      { type: 'boulderGate', threshold: 13 },
    ] as SpaceKind[]) {
      const { board, state } = gateBoard(gate);
      const { state: after } = roll(board, patch(state, 'ana', { inventory: ['key'] }), 6);
      expect(get(after, 'ana')).toMatchObject({ position: 's6', inventory: [] });
    }
  });
});

describe('movement spaces', () => {
  /** La case spéciale en s3. */
  function spaceAt3(kind: SpaceKind, after: SpaceKind[] = emptySpaces(40)) {
    return setup([...emptySpaces(2), kind, ...after]);
  }

  test('a springboard throws forward; a statue throws back unless a shield blocks it', () => {
    const spring = spaceAt3({ type: 'springboard', amount: 8 });
    expect(get(roll(spring.board, spring.state, 3).state, 'ana').position).toBe('s11');

    const statue = setup([...emptySpaces(11), { type: 'statue', amount: 10 }, ...emptySpaces(20)]);
    const ana = patch(statue.state, 'ana', at(9));
    expect(get(roll(statue.board, ana, 3).state, 'ana').position).toBe('s2');
    const shielded = patch(ana, 'ana', { inventory: ['shield'] });
    expect(get(roll(statue.board, shielded, 3).state, 'ana').position).toBe('s12');
  });

  test('elevators, slides and teleporters carry the player without triggering the arrival space', () => {
    const kinds: SpaceKind[] = [
      ...emptySpaces(2),
      { type: 'elevator', to: 's10' },
      ...emptySpaces(6),
      { type: 'bonus', amount: 5 },
      ...emptySpaces(20),
    ];
    const { board, state } = setup(kinds);
    const { state: after, events } = roll(board, state, 3);
    expect(get(after, 'ana')).toMatchObject({ position: 's10', trail: [] });
    // Seul l'ascenseur (s3) s'est déclenché, pas la case Bonus d'arrivée (s10).
    const triggered = events.flatMap((event) =>
      event.type === 'spaceTriggered' ? [event.spaceId] : [],
    );
    expect(triggered).toEqual(['s3']);

    const slide = setup([...emptySpaces(7), { type: 'slide', to: 's2' }, ...emptySpaces(20)]);
    expect(get(roll(slide.board, patch(slide.state, 'ana', at(5)), 3).state, 'ana').position).toBe(
      's2',
    );
  });

  test('a freight lift only works on even rounds', () => {
    const { board, state } = spaceAt3({ type: 'freightLift', to: 's20' });
    expect(get(roll(board, state, 3).state, 'ana').position).toBe('s3');
    expect(get(roll(board, { ...state, round: 2 }, 3).state, 'ana').position).toBe('s20');
  });

  test('a seesaw launches the players on the other end 4 spaces forward', () => {
    const kinds: SpaceKind[] = [
      ...emptySpaces(2),
      { type: 'seesaw', partner: 's6' },
      ...emptySpaces(2),
      { type: 'seesaw', partner: 's3' },
      ...emptySpaces(20),
    ];
    const { board, state } = setup(kinds);
    const { state: after } = roll(board, patch(state, 'bob', at(6)), 3);
    expect(get(after, 'bob').position).toBe('s10');
  });

  test('the giant die shows all its faces', () => {
    const faces = new Set<string>();
    const { board, state } = setup(
      Array.from({ length: 40 }, () => ({ type: 'giantDie' }) as SpaceKind),
    );
    for (let seed = 0; seed < 80; seed++) {
      const { events } = act(board, { ...state, rngState: new Rng(seed).state }, player('ana'), {
        type: 'roll',
      });
      for (const event of events) if (event.type === 'giantDieRolled') faces.add(event.face);
    }
    expect([...faces].sort()).toEqual(['bird', 'item', 'monster', 'nothing', 'squall', 'trouble']);
  });

  test('the wheel waits for the server, then applies the segment it stopped on', () => {
    const segments = [
      { type: 'advance', amount: 4 },
      { type: 'recoil', amount: 2 },
      { type: 'nothing' },
    ] as const;
    const { board, state } = spaceAt3({ type: 'wheel', segments: [...segments] });
    const paused = roll(board, state, 3).state;
    expect(whoMustAct(paused)).toEqual(SYSTEM);
    expect(applyIntent(board, paused, SYSTEM, { type: 'submitWheelResult', segment: 9 })).toEqual({
      ok: false,
      error: 'invalidChoice',
    });
    expect(
      get(act(board, paused, SYSTEM, { type: 'submitWheelResult', segment: 0 }).state, 'ana')
        .position,
    ).toBe('s7');
    expect(
      get(act(board, paused, SYSTEM, { type: 'submitWheelResult', segment: 1 }).state, 'ana')
        .position,
    ).toBe('s1');
  });

  test('a bet is settled by the next minigame: won, the stake is gained; lost, it is lost', () => {
    const { board, state } = spaceAt3({ type: 'bet' });
    const paused = roll(board, state, 3).state;
    expect(
      applyIntent(board, paused, player('ana'), { type: 'placeBet', on: 'bob', stake: 7 }),
    ).toEqual({
      ok: false,
      error: 'invalidChoice',
    });
    const placed = act(board, paused, player('ana'), {
      type: 'placeBet',
      on: 'bob',
      stake: 3,
    }).state;
    expect(placed.bets).toEqual([{ playerId: 'ana', on: 'bob', stake: 3 }]);

    const minigame = { ...placed, phase: { type: 'minigame' as const } };
    const won = act(board, minigame, SYSTEM, {
      type: 'submitMinigameResult',
      ranking: [['bob'], ['ana'], ['cam'], ['dan']],
    });
    expect(get(won.state, 'ana').position).toBe('s6');
    expect(won.state.bets).toEqual([]);
    const lost = act(board, minigame, SYSTEM, {
      type: 'submitMinigameResult',
      ranking: [['cam'], ['ana'], ['bob'], ['dan']],
    });
    expect(get(lost.state, 'ana').position).toBe('start');
  });
});

describe('board validation of linked spaces', () => {
  test('reports missing destinations, unpaired seesaws and empty wheels', () => {
    const board = linearBoard([
      { type: 'elevator', to: 'nowhere' },
      { type: 'seesaw', partner: 's1' },
      { type: 'wheel', segments: [] },
    ]);
    const errors = validateBoard(board).join('\n');
    expect(errors).toContain('nowhere');
    expect(errors).toContain('bascule');
    expect(errors).toContain('roue');
  });
});
