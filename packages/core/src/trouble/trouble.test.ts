import { describe, expect, test } from 'bun:test';
import { type BoardDefinition, prepareBoard, type Space, type SpaceKind } from '../board/board';
import { applyIntent, createGame } from '../game/engine';
import type {
  Actor,
  ChaosLevel,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  PlayerState,
} from '../game/types';
import { viewState } from '../game/views';
import { Rng } from '../random/rng';
import { emptySpaces, FOUR_PLAYERS, linearBoard, rngStateRolling } from '../testing/fixtures';
import { drawTroubleOptions, TROUBLE_CATEGORY, type TroubleEventId } from './events';
import { effectiveKind } from './overlays';

const SYSTEM: Actor = { type: 'system' };
const player = (playerId: PlayerId): Actor => ({ type: 'player', playerId });

function setup(
  definition: BoardDefinition = linearBoard(emptySpaces(80)),
  chaos: ChaosLevel = 'normal',
) {
  const board = prepareBoard(definition);
  const { state } = createGame(board, { players: FOUR_PLAYERS, tableSize: 4, seed: 1, chaos });
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

/** Fait jouer les 4 tours de la manche (lancers simples) et renvoie la fin de manche. */
function finishRound(board: Board, initial: GameState) {
  let state = initial;
  const events: GameEvent[] = [];
  while (state.phase.type === 'turn') {
    const result = act(board, state, player(state.phase.playerId), { type: 'roll' });
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

/** Le Plateau propose un seul événement, choisi par `chooser`. */
function troubleChosen(board: Board, state: GameState, event: TroubleEventId, chooser = 'dan') {
  const waking = { ...state, phase: { type: 'trouble' as const, chooser, options: [event] } };
  return act(board, waking, player(chooser), { type: 'chooseTrouble', event });
}

describe('the TROUBLE gauge', () => {
  test('rises at the end of each round, faster with more chaos', () => {
    const gain = (chaos: ChaosLevel) => {
      const { board, state } = setup(undefined, chaos);
      const { events } = finishRound(board, { ...state, rngState: rngStateRolling(2, 2, 2, 2) });
      return events.find((event) => event.type === 'troubleGauge' && event.reason === 'round');
    };
    expect(gain('calm')).toMatchObject({ added: 9 });
    expect(gain('normal')).toMatchObject({ added: 15 });
    expect(gain('trouble')).toMatchObject({ added: 23 });
  });

  test('rises faster when the gap between the first and the last is large', () => {
    const { board, state: initial } = setup();
    const state = patch({ ...initial, rngState: rngStateRolling(1, 1, 1, 1) }, 'ana', at(40));
    const { events } = finishRound(board, state);
    expect(events).toContainEqual(expect.objectContaining({ type: 'troubleGauge', reason: 'gap' }));
  });

  test('rises on a double', () => {
    const { board, state: initial } = setup();
    const state = {
      ...initial,
      bonusDice: { ...initial.bonusDice, ana: { kind: 'gold' as const, faces: 6 } },
    };
    const doubled = { ...state, rngState: rngStateRolling(4, 4) };
    const { events } = act(board, doubled, player('ana'), { type: 'roll' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'troubleGauge', reason: 'double' }),
    );
  });

  test('wakes the Board when full: the last player chooses among options of different violence', () => {
    const { board, state: initial } = setup();
    let state = {
      ...initial,
      trouble: { ...initial.trouble, gauge: 95 },
      rngState: rngStateRolling(1, 1, 1, 1),
    };
    state = patch(state, 'ana', at(30));
    state = patch(state, 'bob', at(20));
    state = patch(state, 'cam', at(10));
    const { state: after } = finishRound(board, state);

    if (after.phase.type !== 'trouble')
      throw new Error(`TROUBLE attendu, phase ${after.phase.type}`);
    expect(after.phase.chooser).toBe('dan');
    expect(after.trouble.gauge).toBe(0);
    const categories = after.phase.options.map((event) => TROUBLE_CATEGORY[event]);
    expect(new Set(categories).size).toBe(categories.length);
    // La Taxe n'a rien à prendre au premier : elle n'est jamais proposée.
    expect(after.phase.options).not.toContain('tax');

    const [option] = after.phase.options;
    if (!option) throw new Error('Option attendue');
    expect(
      applyIntent(board, after, player('ana'), { type: 'chooseTrouble', event: option }),
    ).toEqual({
      ok: false,
      error: 'notYourTurn',
    });
    const chosen = act(board, after, player('dan'), { type: 'chooseTrouble', event: option });
    expect(['minigame', 'bonusMinigame', 'itemChoices']).toContain(chosen.state.phase.type);
  });

  test('only offers applicable events', () => {
    const { board, state } = setup();
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      const options = drawTroubleOptions(board, state, rng);
      expect(options).not.toContain('tax');
      expect(options.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('TROUBLE events', () => {
  function ranked() {
    const { board, state: initial } = setup();
    let state = patch(initial, 'ana', at(40));
    state = patch(state, 'bob', at(30));
    state = patch(state, 'cam', at(20));
    state = patch(state, 'dan', at(10));
    return { board, state };
  }

  test('Grand Exchange swaps the first and the last', () => {
    const { board, state } = ranked();
    const { state: after } = troubleChosen(board, state, 'grandExchange');
    expect(get(after, 'ana').position).toBe('s10');
    expect(get(after, 'dan').position).toBe('s40');
  });

  test('Express elevator lifts the last player to the next floor', () => {
    const floors: Space[] = [
      { id: 'start', kind: { type: 'start' }, floor: 0, next: ['a1'] },
      { id: 'a1', kind: { type: 'empty' }, floor: 1, next: ['a2'] },
      { id: 'a2', kind: { type: 'empty' }, floor: 1, next: ['gate'] },
      { id: 'gate', kind: { type: 'gate', threshold: 4 }, floor: 1, next: ['b1'] },
      { id: 'b1', kind: { type: 'empty' }, floor: 2, next: ['b2'] },
      { id: 'b2', kind: { type: 'empty' }, floor: 2, next: ['goal'] },
      { id: 'goal', kind: { type: 'finalGate', threshold: 6 }, floor: 2, next: [] },
    ];
    const { board, state: initial } = setup({
      id: 'floors',
      name: 'Étages',
      start: 'start',
      spaces: Object.fromEntries(floors.map((space) => [space.id, space])),
    });
    let state = patch(initial, 'dan', { position: 'a1', trail: ['start'] });
    for (const id of ['ana', 'bob', 'cam']) state = patch(state, id, { position: 'b2' });
    const { state: after } = troubleChosen(board, state, 'expressElevator');
    expect(get(after, 'dan')).toMatchObject({ position: 'b1', atGate: false });
  });

  test('Inversion turns bonuses into maluses for two rounds, then ends', () => {
    const { board, state } = setup(
      linearBoard([{ type: 'bonus', amount: 3 }, ...emptySpaces(120)]),
    );
    const inverted = troubleChosen(board, state, 'inversion').state;
    expect(effectiveKind(board, inverted, 's1')).toEqual({ type: 'malus', amount: 3 });

    let current = inverted;
    const ended: GameEvent[] = [];
    for (let round = 0; round < 3; round++) {
      current = act(board, current, SYSTEM, {
        type: 'submitMinigameResult',
        ranking: [['ana'], ['bob'], ['cam'], ['dan']],
      }).state;
      const result = finishRound(board, current);
      current = result.state;
      ended.push(...result.events.filter((event) => event.type === 'overlayEnded'));
      if (current.phase.type !== 'minigame') break;
    }
    expect(ended).toEqual([{ type: 'overlayEnded', overlay: 'inversion' }]);
    expect(effectiveKind(board, current, 's1')).toEqual({ type: 'bonus', amount: 3 });
  });

  test('Eruption turns special spaces into -3 that chain, three times at most', () => {
    const malusEverywhere: SpaceKind[] = Array.from({ length: 30 }, () => ({ type: 'item' }));
    const { board, state: initial } = setup(linearBoard(malusEverywhere));
    const erupting = troubleChosen(board, initial, 'eruption').state;
    let state = act(board, erupting, SYSTEM, {
      type: 'submitMinigameResult',
      ranking: [['ana'], ['bob'], ['cam'], ['dan']],
    }).state;
    state = patch(state, 'ana', at(20));
    state = {
      ...state,
      bonusDice: { ...state.bonusDice, ana: null },
      rngState: rngStateRolling(2),
    };
    const { state: after } = act(board, state, player('ana'), { type: 'roll' });
    // s22 (dés), puis -3 enchaîné trois fois : 22 -> 19 -> 16 -> 13 -> 10.
    expect(get(after, 'ana').position).toBe('s10');
  });

  test('Fog secretly shuffles special spaces, and clients never receive the shuffle', () => {
    const kinds: SpaceKind[] = [
      { type: 'bonus', amount: 3 },
      { type: 'malus', amount: 3 },
      { type: 'item' },
      { type: 'chest' },
      ...emptySpaces(5),
    ];
    const { board, state } = setup(linearBoard(kinds));
    const fogged = troubleChosen(board, state, 'fog').state;
    const fog = fogged.overlays.fog;
    if (!fog) throw new Error('Brouillard attendu');
    expect(Object.keys(fog.kinds).sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(
      Object.values(fog.kinds)
        .map((kind) => kind.type)
        .sort(),
    ).toEqual(['bonus', 'chest', 'item', 'malus']);
    expect(viewState(fogged, { type: 'player', playerId: 'ana' }).overlays.fog?.kinds).toEqual({});
  });

  test('Rotation moves every player forward or back', () => {
    const { board, state } = ranked();
    const { state: after } = troubleChosen(board, state, 'rotation');
    for (const id of ['ana', 'bob', 'cam', 'dan']) {
      expect(get(after, id).position).not.toBe(get(state, id).position);
    }
  });

  test('Tax gives the best item of the first player to the last', () => {
    const { board, state: initial } = ranked();
    const state = patch(initial, 'ana', { inventory: ['turboDie', 'key'] });
    const { state: after } = troubleChosen(board, state, 'tax');
    expect(get(after, 'ana').inventory).toEqual(['turboDie']);
    expect(get(after, 'dan').inventory).toEqual(['key']);
  });

  test('Item rain gives everyone an item, and players with a full inventory choose in turn', () => {
    const { board, state: initial } = ranked();
    let state = patch(initial, 'bob', { inventory: ['turboDie', 'rocket', 'glue'] });
    state = patch(state, 'cam', { inventory: ['turboDie', 'rocket', 'glue'] });
    const rained = troubleChosen(board, state, 'itemRain').state;
    expect(get(rained, 'ana').inventory).toHaveLength(1);
    expect(get(rained, 'dan').inventory).toHaveLength(1);
    if (rained.phase.type !== 'itemChoices') throw new Error('Choix attendus');
    expect(rained.phase.queue.map((choice) => choice.playerId)).toEqual(['cam', 'bob']);

    const camChoice = rained.phase.queue[0];
    if (!camChoice) throw new Error('Choix de Cam attendu');
    expect(
      applyIntent(board, rained, player('bob'), { type: 'resolveItemSwap', discard: 'rocket' }),
    ).toEqual({ ok: false, error: 'notYourTurn' });
    // Chacun refuse l'objet proposé : la file se vide, puis la manche suivante commence.
    const afterCam = act(board, rained, player('cam'), {
      type: 'resolveItemSwap',
      discard: camChoice.offered,
    }).state;
    if (afterCam.phase.type !== 'itemChoices') throw new Error('Choix de Bob attendu');
    const bobChoice = afterCam.phase.queue[0];
    if (!bobChoice) throw new Error('Choix de Bob attendu');
    const afterBob = act(board, afterCam, player('bob'), {
      type: 'resolveItemSwap',
      discard: bobChoice.offered,
    }).state;
    expect(afterBob.phase).toEqual({ type: 'minigame' });
    expect(get(afterBob, 'bob').inventory).toEqual(['turboDie', 'rocket', 'glue']);
  });

  test('Bonus minigame: its winner moves forward 8 spaces', () => {
    const { board, state } = ranked();
    const started = troubleChosen(board, state, 'bonusMinigame').state;
    expect(started.phase).toEqual({ type: 'bonusMinigame' });
    const { state: after } = act(board, started, SYSTEM, {
      type: 'submitBonusMinigameResult',
      ranking: [['cam'], ['ana'], ['bob'], ['dan']],
    });
    expect(get(after, 'cam').position).toBe('s28');
    expect(after.phase).toEqual({ type: 'minigame' });
  });
});

describe('TROUBLE space and round events', () => {
  test('a TROUBLE space wakes the Board for a small event right away', () => {
    const { board, state: initial } = setup(
      linearBoard([...emptySpaces(2), { type: 'trouble' }, ...emptySpaces(20)]),
    );
    const state = { ...initial, rngState: rngStateRolling(3) };
    const { events } = act(board, state, player('ana'), { type: 'roll' });
    const applied = events.find((event) => event.type === 'troubleApplied');
    expect(applied?.type === 'troubleApplied' && TROUBLE_CATEGORY[applied.event]).toMatch(
      /small|mild/,
    );
  });

  test('a small event lands on a random player at the end of about one round in seven', () => {
    let rounds = 0;
    let withEvent = 0;
    for (let seed = 0; seed < 300; seed++) {
      const { board, state } = setup();
      const { events } = finishRound(board, { ...state, rngState: new Rng(seed).state });
      rounds++;
      if (events.some((event) => event.type === 'roundEvent')) withEvent++;
    }
    expect(withEvent / rounds).toBeGreaterThan(0.08);
    expect(withEvent / rounds).toBeLessThan(0.24);
  });
});
