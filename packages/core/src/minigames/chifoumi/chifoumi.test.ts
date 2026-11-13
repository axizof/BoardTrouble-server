import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  CHIFOUMI,
  CHIFOUMI_ANNOUNCE,
  type ChifoumiState,
  duel,
  FINAL_POINTS,
  GESTURES,
  type Gesture,
  isFinal,
  isInMatch,
} from './chifoumi';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const pick = (gesture: Gesture): ArenaInput => ({
  ...IDLE_INPUT,
  target: GESTURES.indexOf(gesture),
});

/** Une finale à deux, passé l'annonce du duel : on en est à annoncer. */
function fresh(): ChifoumiState {
  let state = CHIFOUMI.create(['a', 'b'], { practice: false, seed: 1 });
  while (state.round.phase === 'match') state = CHIFOUMI.step(state, {});
  return state;
}

/** Joue une manche : les annonces de chacun, puis leurs gestes (validés d'un clic). */
function playRound(
  state: ChifoumiState,
  announce: Record<string, Gesture>,
  gesture: Record<string, Gesture>,
): ChifoumiState {
  let current = state;
  const index = current.round.index;
  for (let k = 0; k < steps(30) && current.round.index === index && current.winner === null; k++) {
    const { phase } = current.round;
    const inputs: Record<string, ArenaInput> = {};
    for (const id of ['a', 'b']) {
      const wanted =
        phase === 'announce' ? announce[id] : phase === 'choose' ? gesture[id] : undefined;
      inputs[id] = wanted ? pick(wanted) : IDLE_INPUT;
    }
    current = CHIFOUMI.step(current, inputs);
  }
  return current;
}

const points = (state: ChifoumiState, id: string) =>
  state.fighters.find((one) => one.id === id)?.points ?? 0;

describe('Chifoumi du sommet', () => {
  test('rock beats scissors, scissors beat paper, paper beats rock', () => {
    expect(duel('rock', 'scissors')).toBe(1);
    expect(duel('scissors', 'paper')).toBe(1);
    expect(duel('paper', 'rock')).toBe(1);
    expect(duel('rock', 'paper')).toBe(-1);
    expect(duel('paper', 'paper')).toBe(0);
  });

  test('a round won is worth 1 point, 2 when won with the announced gesture; a draw is replayed', () => {
    let state = playRound(fresh(), { a: 'paper', b: 'rock' }, { a: 'rock', b: 'scissors' });
    expect(points(state, 'a')).toBe(1);
    state = playRound(state, { a: 'paper', b: 'rock' }, { a: 'paper', b: 'rock' });
    expect(points(state, 'a')).toBe(3);
    expect(FINAL_POINTS).toBe(3);
    expect(CHIFOUMI.isOver(state)).toBe(true);
    expect(CHIFOUMI.ranking(state)).toEqual([['a'], ['b']]);
    const draw = playRound(fresh(), { a: 'rock', b: 'rock' }, { a: 'paper', b: 'paper' });
    expect(points(draw, 'a') + points(draw, 'b')).toBe(0);
    expect(draw.round.index).toBe(1);
  });

  test('each side sees the other announcement only once announcing is over, the gesture only at the reveal', () => {
    let state = fresh();
    state = CHIFOUMI.step(state, { a: pick('rock') });
    const early = CHIFOUMI.viewFor?.(state, { type: 'player', playerId: 'b' });
    expect(early?.fighters.find((one) => one.id === 'a')?.announce).toBeNull();
    expect(
      CHIFOUMI.viewFor?.(state, { type: 'player', playerId: 'a' })?.fighters[0]?.announce,
    ).toBe('rock');
    while (state.round.phase === 'announce') state = CHIFOUMI.step(state, { b: pick('paper') });
    const read = CHIFOUMI.viewFor?.(state, { type: 'player', playerId: 'b' });
    expect(read?.fighters.find((one) => one.id === 'a')?.announce).toBe('rock');
    while (state.round.phase !== 'shake') {
      state = CHIFOUMI.step(state, { a: pick('scissors'), b: pick('rock') });
    }
    const shaking = CHIFOUMI.viewFor?.(state, { type: 'player', playerId: 'b' });
    expect(shaking?.fighters.find((one) => one.id === 'a')?.gesture).toBeNull();
    while (state.round.phase !== 'result') state = CHIFOUMI.step(state, {});
    const revealed = CHIFOUMI.viewFor?.(state, { type: 'player', playerId: 'b' });
    expect(revealed?.fighters.find((one) => one.id === 'a')?.gesture).toBe('scissors');
  });

  test('without a choice in time, no announcement, and a gesture drawn at random', () => {
    let state = fresh();
    for (let k = 0; k < steps(CHIFOUMI_ANNOUNCE + 9); k++) state = CHIFOUMI.step(state, {});
    expect(state.round.phase === 'shake' || state.round.phase === 'result').toBe(true);
    for (const one of state.fighters) {
      expect(one.announce).toBeNull();
      expect(one.gesture === null ? null : GESTURES.includes(one.gesture)).toBe(true);
    }
  });

  test('nothing is shown before the first arrow; arrows turn through the gestures, Action locks', () => {
    let state = fresh();
    state = CHIFOUMI.step(state, { a: { ...IDLE_INPUT, primary: true } });
    expect(state.fighters[0]?.cursor).toBeNull();
    expect(state.fighters[0]?.locked).toBe(false);
    const left = { ...IDLE_INPUT, move: { x: -1, z: 0 } };
    const right = { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    state = CHIFOUMI.step(state, { a: left });
    state = CHIFOUMI.step(state, { a: IDLE_INPUT });
    state = CHIFOUMI.step(state, { a: right });
    state = CHIFOUMI.step(state, { a: { ...IDLE_INPUT, primary: true } });
    expect(state.fighters[0]?.announce).toBe('paper');
    expect(state.fighters[0]?.locked).toBe(true);
  });

  test('not locked in time, the gesture shown with the arrows is the one played', () => {
    let state = fresh();
    while (state.round.phase !== 'choose') state = CHIFOUMI.step(state, {});
    state = CHIFOUMI.step(state, { a: { ...IDLE_INPUT, move: { x: 1, z: 0 } } });
    while (state.round.phase === 'choose') state = CHIFOUMI.step(state, {});
    expect(state.fighters[0]?.gesture).toBe('scissors');
  });

  test('between bots, the final ends with a winner in a few rounds', () => {
    for (const seed of [1, 2, 3, 4]) {
      let state = CHIFOUMI.create(['a', 'b'], { practice: false, seed });
      const rng = new Rng(seed);
      for (let k = 0; k < steps(240) && !CHIFOUMI.isOver(state); k++) {
        const current = state;
        state = CHIFOUMI.step(current, {
          a: CHIFOUMI.botInput(current, 'a', 'expert', rng),
          b: CHIFOUMI.botInput(current, 'b', 'normal', rng),
        });
      }
      expect(CHIFOUMI.isOver(state)).toBe(true);
      expect(CHIFOUMI.ranking(state)).toHaveLength(2);
    }
  });

  test('in the sandbox, the dummy plays and the score starts over once someone wins', () => {
    let state = CHIFOUMI.create(['you', 'mannequin'], { practice: true, seed: 3 });
    for (let k = 0; k < steps(120); k++) state = CHIFOUMI.step(state, {});
    expect(state.history.length).toBeGreaterThan(3);
    expect(CHIFOUMI.isOver(state)).toBe(false);
    expect(Math.max(...state.fighters.map((one) => one.points))).toBeLessThan(FINAL_POINTS);
  });

  test('with more finalists, a bracket: duels one after the other, byes for the first seeds', () => {
    const four = CHIFOUMI.create(['a', 'b', 'c', 'd'], { practice: false, seed: 5 });
    expect(four.match.players).toEqual(['a', 'd']);
    expect(isInMatch(four, 'b')).toBe(false);
    expect(isFinal(four)).toBe(false);
    const three = CHIFOUMI.create(['a', 'b', 'c'], { practice: false, seed: 5 });
    // La tête de série passe d'office : le premier duel oppose les deux autres.
    expect(three.match.players).toEqual(['b', 'c']);
    expect(three.bracket[1]?.[0]).toBe('a');
  });

  test('between bots, a four-player bracket ends with a winner, the finalist, then the semi losers', () => {
    const ids = ['a', 'b', 'c', 'd'];
    let state = CHIFOUMI.create(ids, { practice: false, seed: 9 });
    const rng = new Rng(9);
    let semiTargets = 0;
    for (let k = 0; k < steps(900) && !CHIFOUMI.isOver(state); k++) {
      const current = state;
      if (!isFinal(current)) semiTargets = current.match.target;
      state = CHIFOUMI.step(
        current,
        Object.fromEntries(ids.map((id) => [id, CHIFOUMI.botInput(current, id, 'normal', rng)])),
      );
    }
    expect(CHIFOUMI.isOver(state)).toBe(true);
    expect(semiTargets).toBe(2);
    const ranking = CHIFOUMI.ranking(state);
    expect(ranking.map((group) => group.length)).toEqual([1, 1, 2]);
    expect(ranking.flat().sort()).toEqual(ids);
  });
});
