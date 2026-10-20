import { describe, expect, test } from 'bun:test';
import { type BoardDefinition, prepareBoard, type SpaceKind } from '../board/board';
import { applyIntent, createGame } from '../game/engine';
import type { Actor, GameEvent, GameState, Intent, PlayerId, PlayerState } from '../game/types';
import { viewEvents, viewState } from '../game/views';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { catchUpFactor, drawItem, ITEMS, type ItemId } from './catalog';

const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

function setup(definition: BoardDefinition = linearBoard(emptySpaces(60))) {
  const board = prepareBoard(definition);
  const { state } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1 });
  // Ordre fixe pour des scénarios lisibles : ana joue, puis bob, cam, dan.
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
  return {
    ...state,
    players: state.players.map((p) => (p.id === id ? { ...p, ...changes } : p)),
  };
}

function get(state: GameState, id: PlayerId): PlayerState {
  const found = state.players.find((p) => p.id === id);
  if (!found) throw new Error(id);
  return found;
}

function types(events: GameEvent[]) {
  return events.map((event) => event.type);
}

/** Place un joueur sur la case `sN` du plateau linéaire, avec le chemin parcouru. */
function at(n: number): Partial<PlayerState> {
  return {
    position: `s${n}`,
    trail: ['start', ...Array.from({ length: n - 1 }, (_, i) => `s${i + 1}`)],
  };
}

describe('drawItem and catchUpFactor', () => {
  test('gives better items to players far behind, without guaranteeing them', () => {
    const rareShare = (catchUp: number) => {
      const rng = new Rng(5);
      let rare = 0;
      for (let i = 0; i < 4000; i++) {
        const { rarity } = ITEMS[drawItem(rng, catchUp)];
        if (rarity === 'rare' || rarity === 'veryRare') rare++;
      }
      return rare / 4000;
    };
    expect(rareShare(0)).toBeGreaterThan(0.1);
    expect(rareShare(1)).toBeGreaterThan(rareShare(0) + 0.1);
    expect(rareShare(1)).toBeLessThan(0.6);
  });

  test('only draws rare or better items from a chest', () => {
    const rng = new Rng(2);
    for (let i = 0; i < 500; i++) {
      expect(['rare', 'veryRare', 'legendary']).toContain(ITEMS[drawItem(rng, 0, 'rare')].rarity);
    }
  });

  test('gives no catch-up to the leader, and full catch-up to a distant last player', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', at(50));
    state = patch(state, 'bob', at(45));
    state = patch(state, 'cam', at(40));
    expect(catchUpFactor(board, state, 'ana')).toBe(0);
    expect(catchUpFactor(board, state, 'dan')).toBe(1);
    expect(catchUpFactor(board, state, 'bob')).toBeLessThan(0.2);
  });
});

describe('using items', () => {
  test('allows one item per turn, before rolling, and only an owned active item', () => {
    const { board, state: initial } = setup();
    const state = patch(initial, 'ana', { inventory: ['turboDie', 'turboDie', 'shield'] });
    expect(applyIntent(board, state, player('ana'), { type: 'useItem', item: 'rocket' })).toEqual({
      ok: false,
      error: 'itemNotOwned',
    });
    expect(applyIntent(board, state, player('ana'), { type: 'useItem', item: 'shield' })).toEqual({
      ok: false,
      error: 'itemNotUsable',
    });
    const used = act(board, state, player('ana'), { type: 'useItem', item: 'turboDie' }).state;
    expect(used.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
    expect(applyIntent(board, used, player('ana'), { type: 'useItem', item: 'turboDie' })).toEqual({
      ok: false,
      error: 'itemAlreadyUsed',
    });
  });

  test('turbo die adds a die to the roll', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['turboDie'] });
    state = act(board, state, player('ana'), { type: 'useItem', item: 'turboDie' }).state;
    const { events } = act(board, state, player('ana'), { type: 'roll' });
    const rolled = events.find((event) => event.type === 'diceRolled');
    expect(rolled?.type === 'diceRolled' && rolled.roll.turbo).toBeGreaterThan(0);
  });

  test('rocket moves 6 spaces at once and costs the bonus die of the round', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['rocket'] });
    state = { ...state, bonusDice: { ...state.bonusDice, ana: { kind: 'gold', faces: 6 } } };
    const { state: after } = act(board, state, player('ana'), { type: 'useItem', item: 'rocket' });
    expect(get(after, 'ana').position).toBe('s6');
    expect(after.bonusDice.ana).toBeNull();
    expect(after.phase).toMatchObject({ playerId: 'ana', step: { type: 'awaitRoll' } });
  });

  test('glue shortens the die of its owner and stops the next player who passes over it', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { ...at(5), inventory: ['glue'] });
    state = patch(state, 'bob', at(2));
    state = act(board, state, player('ana'), { type: 'useItem', item: 'glue' }).state;
    expect(state.traps.s5).toEqual({ type: 'glue', owner: 'ana' });

    const anaRoll = act(board, state, player('ana'), { type: 'roll' });
    const roll = anaRoll.events.find((event) => event.type === 'diceRolled');
    expect(roll?.type === 'diceRolled' && roll.roll.normal).toBeLessThanOrEqual(4);

    // Bob part de s2 avec un 6 : il traverse s5 et s'y colle.
    const bobTurn = { ...anaRoll.state, rngState: rngStateRolling(6) };
    const { state: after, events } = act(board, bobTurn, player('bob'), { type: 'roll' });
    expect(get(after, 'bob').position).toBe('s5');
    expect(after.traps.s5).toBeUndefined();
    expect(types(events)).toContain('trapTriggered');
  });

  test('firecracker sends back whoever stops on it, except its owner', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', at(7));
    state = { ...state, traps: { s10: { type: 'firecracker', owner: 'cam' } } };
    state = { ...state, rngState: rngStateRolling(3) };
    const { state: after } = act(board, state, player('ana'), { type: 'roll' });
    expect(get(after, 'ana').position).toBe('s5');
    expect(after.traps.s10).toBeUndefined();
  });

  test('a shield cancels the next negative effect, then is used up', () => {
    const { board, state: initial } = setup(
      linearBoard([...emptySpaces(5), { type: 'malus', amount: 3 }, ...emptySpaces(20)]),
    );
    let state = patch(initial, 'ana', { ...at(3), inventory: ['shield'] });
    state = { ...state, rngState: rngStateRolling(3) };
    const { state: after, events } = act(board, state, player('ana'), { type: 'roll' });
    expect(get(after, 'ana')).toMatchObject({ position: 's6', inventory: [] });
    expect(types(events)).toContain('shieldBlocked');
  });

  test('blower pushes a nearby player back', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { ...at(10), inventory: ['blower'] });
    state = patch(state, 'bob', at(14));
    expect(
      applyIntent(board, patch(state, 'cam', at(30)), player('ana'), {
        type: 'useItem',
        item: 'blower',
        target: 'cam',
      }),
    ).toEqual({ ok: false, error: 'invalidTarget' });
    const { state: after } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'blower',
      target: 'bob',
    });
    expect(get(after, 'bob').position).toBe('s10');
  });

  test('a secretly armed mirror sends an attack back to its attacker, then is revealed', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { ...at(10), inventory: ['mirror'] });
    const armed = act(board, state, player('ana'), { type: 'useItem', item: 'mirror' });
    expect(get(armed.state, 'ana')).toMatchObject({ inventory: ['mirror'], mirrorArmed: true });

    // Le secret : les autres ne voient ni l'événement ni l'état activé.
    const bobView = { type: 'player' as const, playerId: 'bob' };
    expect(types(viewEvents(armed.events, bobView))).not.toContain('mirrorArmed');
    expect(get(viewState(armed.state, bobView), 'ana').mirrorArmed).toBe(false);
    expect(viewState(armed.state, bobView).rngState).toBe(0);
    expect(
      get(viewState(armed.state, { type: 'player', playerId: 'ana' }), 'ana').mirrorArmed,
    ).toBe(true);

    state = patch(armed.state, 'bob', { ...at(13), inventory: ['blower'] });
    state = {
      ...state,
      turn: { ...state.turn, itemUsed: false },
      phase: { type: 'turn', playerId: 'bob', step: { type: 'awaitRoll' } },
    };
    const { state: after, events } = act(board, state, player('bob'), {
      type: 'useItem',
      item: 'blower',
      target: 'ana',
    });
    expect(types(events)).toContain('mirrorReflected');
    expect(get(after, 'ana')).toMatchObject({ position: 's10', inventory: [], mirrorArmed: false });
    expect(get(after, 'bob').position).toBe('s9');
  });

  test('an unused mirror expires at the start of its owner next turn', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['mirror'], mirrorArmed: true });
    state = { ...state, phase: { type: 'minigame' } };
    const { state: after, events } = act(
      board,
      state,
      { type: 'system' },
      {
        type: 'submitMinigameResult',
        ranking: [['ana'], ['bob'], ['cam'], ['dan']],
      },
    );
    expect(types(events)).toContain('mirrorExpired');
    expect(get(after, 'ana')).toMatchObject({ inventory: [], mirrorArmed: false });
  });

  test('pickpocket steals a random item from the target', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['pickpocket'] });
    state = patch(state, 'bob', { inventory: ['key'] });
    const { state: after } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'pickpocket',
      target: 'bob',
    });
    expect(get(after, 'ana').inventory).toEqual(['key']);
    expect(get(after, 'bob').inventory).toEqual([]);
  });

  test('a pickpocket reflected onto a thief with no items takes nothing', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['pickpocket'] });
    state = patch(state, 'bob', { inventory: ['mirror', 'key'], mirrorArmed: true });
    const { state: after, events } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'pickpocket',
      target: 'bob',
    });
    expect(types(events)).toContain('mirrorReflected');
    expect(types(events)).not.toContain('itemStolen');
    expect(get(after, 'ana').inventory).toEqual([]);
    expect(get(after, 'bob').inventory).toEqual(['key']);
  });

  test('grapple swaps places with the player just ahead, without triggering spaces', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { ...at(10), inventory: ['grapple'] });
    state = patch(state, 'bob', at(15));
    state = patch(state, 'cam', at(20));
    expect(
      applyIntent(board, state, player('ana'), { type: 'useItem', item: 'grapple', target: 'cam' }),
    ).toEqual({ ok: false, error: 'invalidTarget' });
    const { state: after } = act(board, state, player('ana'), {
      type: 'useItem',
      item: 'grapple',
      target: 'bob',
    });
    expect(get(after, 'ana').position).toBe('s15');
    expect(get(after, 'bob').position).toBe('s10');
  });

  test('hourglass removes the bonus die of a player who has not played yet', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['hourglass', 'hourglass'] });
    state = {
      ...state,
      turnIndex: 1,
      phase: { type: 'turn', playerId: 'bob', step: { type: 'awaitRoll' } },
      bonusDice: { ana: null, bob: null, cam: { kind: 'gold', faces: 6 }, dan: null },
    };
    state = patch(state, 'bob', { inventory: ['hourglass'] });
    expect(
      applyIntent(board, state, player('bob'), {
        type: 'useItem',
        item: 'hourglass',
        target: 'dan',
      }),
    ).toEqual({ ok: false, error: 'invalidTarget' });
    const { state: after } = act(board, state, player('bob'), {
      type: 'useItem',
      item: 'hourglass',
      target: 'cam',
    });
    expect(after.bonusDice.cam).toBeNull();
  });

  test('a key opens a threshold gate without a test', () => {
    const { board, state: initial } = setup(
      linearBoard([{ type: 'empty' }, { type: 'gate', threshold: 13 }, ...emptySpaces(10)]),
    );
    let state = patch(initial, 'ana', { inventory: ['key'] });
    state = { ...state, rngState: rngStateRolling(4) };
    const { state: after, events } = act(board, state, player('ana'), { type: 'roll' });
    expect(types(events)).toContain('keyUsed');
    expect(types(events)).not.toContain('gateTested');
    expect(get(after, 'ana')).toMatchObject({ position: 's4', inventory: [] });
  });

  test('reroll lets the player keep or reroll the dice', () => {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', { inventory: ['reroll'] });
    state = act(board, state, player('ana'), { type: 'useItem', item: 'reroll' }).state;
    const rolled = act(board, state, player('ana'), { type: 'roll' }).state;
    expect(rolled.phase).toMatchObject({ step: { type: 'awaitRerollChoice' } });
    const { events } = act(board, rolled, player('ana'), { type: 'reroll' });
    expect(types(events)).toContain('rerolled');
  });
});

describe('item spaces', () => {
  /** La case spéciale est en s(before + 1). */
  function boardWith(kind: SpaceKind, before = 2) {
    return linearBoard([...emptySpaces(before), kind, ...emptySpaces(20)]);
  }

  test('an item space gives an item, and a full inventory asks what to discard', () => {
    const { board, state: initial } = setup(boardWith({ type: 'item' }));
    let state = patch(initial, 'ana', { inventory: ['turboDie', 'rocket', 'glue'] });
    state = { ...state, rngState: rngStateRolling(3) };
    const paused = act(board, state, player('ana'), { type: 'roll' }).state;
    if (paused.phase.type !== 'turn' || paused.phase.step.type !== 'awaitItemSwap') {
      throw new Error('Choix attendu');
    }
    const { offered } = paused.phase.step;
    expect(
      applyIntent(board, paused, player('ana'), { type: 'resolveItemSwap', discard: 'key' }).ok,
    ).toBe(offered === 'key');

    const held: ItemId[] = ['turboDie', 'rocket', 'glue'];
    const discard = held.find((item) => item !== offered) ?? 'turboDie';
    const swapped = act(board, paused, player('ana'), { type: 'resolveItemSwap', discard });
    expect(get(swapped.state, 'ana').inventory).toEqual([
      ...held.filter((item) => item !== discard),
      offered,
    ]);
    expect(swapped.state.phase).toMatchObject({ playerId: 'bob' });

    const refused = act(board, paused, player('ana'), {
      type: 'resolveItemSwap',
      discard: offered,
    });
    expect(get(refused.state, 'ana').inventory).toEqual(['turboDie', 'rocket', 'glue']);
  });

  test('a chest holds either a rare item or a trap, drawn after the choice', () => {
    let items = 0;
    let traps = 0;
    for (let seed = 0; seed < 60; seed++) {
      const { board, state: initial } = setup(boardWith({ type: 'chest' }, 6));
      const state = { ...patch(initial, 'ana', at(4)), rngState: rngStateRolling(3) };
      const paused = act(board, state, player('ana'), { type: 'roll' }).state;
      expect(paused.phase).toMatchObject({ step: { type: 'awaitChest' } });
      const { state: after } = act(
        board,
        { ...paused, rngState: new Rng(seed).state },
        player('ana'),
        {
          type: 'chooseChest',
          chest: 0,
        },
      );
      const ana = get(after, 'ana');
      if (ana.inventory.length === 1) {
        items++;
        expect(['rare', 'veryRare']).toContain(ITEMS[ana.inventory[0] as ItemId].rarity);
      } else {
        traps++;
        expect(ana.position).toBe('s3');
      }
    }
    expect(items).toBeGreaterThan(10);
    expect(traps).toBeGreaterThan(10);
  });

  test('a rest space gives a common item only to a player with none', () => {
    const { board, state: initial } = setup(boardWith({ type: 'rest' }));
    const state = { ...initial, rngState: rngStateRolling(3) };
    const { state: after } = act(board, state, player('ana'), { type: 'roll' });
    const [gained] = get(after, 'ana').inventory;
    expect(ITEMS[gained as ItemId].rarity).toBe('common');

    const full = { ...patch(initial, 'ana', { inventory: ['key'] }), rngState: rngStateRolling(3) };
    expect(get(act(board, full, player('ana'), { type: 'roll' }).state, 'ana').inventory).toEqual([
      'key',
    ]);
  });
});
