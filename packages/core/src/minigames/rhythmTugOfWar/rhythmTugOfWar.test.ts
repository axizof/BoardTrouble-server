import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { FALL_TIME, GOOD_WINDOW, RHYTHM_TUG, type TugState, WIN_DISTANCE } from './rhythmTugOfWar';

const PLAYERS = ['a', 'b', 'c', 'd'];
const ARROWS = [
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
];
const press = (direction: number): ArenaInput => ({
  ...IDLE_INPUT,
  move: ARROWS[direction] ?? { x: 0, z: 0 },
});
const puller = (state: TugState, id: string) => {
  const found = state.fighters.find((one) => one.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};
const teamOf = (state: TugState, team: number) =>
  state.fighters.filter((one) => one.team === team).map((one) => one.id);

/** Avance jusqu'au pas où tombe la première note (le pas suivant la joue pile). */
function untilNote(state: TugState, index: number): TugState {
  let next = state;
  const at = state.notes[index]?.at ?? 0;
  while ((next.tick + 1 - next.songAt) * ARENA_STEP < at - ARENA_STEP / 2) {
    next = RHYTHM_TUG.step(next, {});
  }
  return next;
}

describe('rhythm tug of war', () => {
  test('two even teams drawn by the match, and the beat speeds up', () => {
    const four = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    expect(teamOf(four, 0)).toHaveLength(2);
    const six = RHYTHM_TUG.create([...PLAYERS, 'e', 'f'], { practice: false, seed: 1 });
    expect(teamOf(six, 1)).toHaveLength(3);
    const draws = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        teamOf(RHYTHM_TUG.create(PLAYERS, { practice: false, seed }), 0)
          .sort()
          .join(),
      ),
    );
    expect(draws.size).toBeGreaterThan(1);
    const gaps = four.notes.slice(1).map((note, index) => note.at - (four.notes[index]?.at ?? 0));
    expect(gaps.at(-1) ?? 0).toBeLessThan(gaps[0] ?? 0);
  });

  test('the right arrow on the beat pulls the rope your way', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    const [left] = teamOf(state, 0);
    if (!left) throw new Error('Équipe attendue');
    state = untilNote(state, 0);
    state = RHYTHM_TUG.step(state, { [left]: press(state.notes[0]?.direction ?? 0) });
    expect(puller(state, left).judge).toBe('perfect');
    expect(state.rope).toBeLessThan(0);
  });

  test('a wrong arrow spoils the note and slides your team back; mashing loses', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    const [left] = teamOf(state, 0);
    if (!left) throw new Error('Équipe attendue');
    state = untilNote(state, 0);
    const wrong = ((state.notes[0]?.direction ?? 0) + 1) % 4;
    state = RHYTHM_TUG.step(state, { [left]: press(wrong) });
    expect(puller(state, left).judge).toBe('slip');
    expect(puller(state, left).next).toBe(1);
    expect(state.rope).toBeGreaterThan(0);
    // Marteler toutes les flèches, pas après pas : la corde part de l'autre côté.
    let mashed = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    for (let i = 0; i < 300; i++) {
      mashed = RHYTHM_TUG.step(mashed, { [left]: i % 2 === 0 ? press(i % 4) : IDLE_INPUT });
    }
    expect(mashed.rope).toBeGreaterThan(0);
  });

  test('a note let through is a miss, and pressing far from any note is a slip', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    const [left] = teamOf(state, 0);
    if (!left) throw new Error('Équipe attendue');
    state = RHYTHM_TUG.step(state, { [left]: press(0) });
    expect(puller(state, left).judge).toBe('slip');
    expect(puller(state, left).next).toBe(0);
    state = untilNote(state, 0);
    for (let i = 0; i < Math.ceil(GOOD_WINDOW / ARENA_STEP) + 2; i++)
      state = RHYTHM_TUG.step(state, {});
    expect(puller(state, left).judge).toBe('miss');
    expect(puller(state, left).next).toBe(1);
  });

  test('notes come in calm, steady and rushed stretches, some of them back to back', () => {
    const state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 3 });
    const paces = new Set(state.sections.map((section) => section.pace));
    expect([...paces].sort()).toEqual(['calm', 'rush', 'steady']);
    const gaps = state.notes.slice(1).map((note, index) => note.at - (state.notes[index]?.at ?? 0));
    expect(Math.min(...gaps)).toBeLessThan(0.3);
    expect(state.notes.length).toBeGreaterThan(90);
  });

  test('pressing the next arrow while the skipped one is still close hits the next one', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    const [left] = teamOf(state, 0);
    if (!left) throw new Error('Équipe attendue');
    // Deux notes serrées, de flèches différentes : on joue la seconde, la première est ratée.
    state = {
      ...state,
      notes: [
        { at: 1, direction: 0 },
        { at: 1.2, direction: 1 },
      ],
    };
    state = untilNote(state, 1);
    state = RHYTHM_TUG.step(state, { [left]: press(1) });
    expect(puller(state, left).judge).toBe('perfect');
    expect(puller(state, left).misses).toBe(1);
    expect(puller(state, left).next).toBe(2);
  });

  test('the new arrow counts when the previous one is still held', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    const [left] = teamOf(state, 0);
    if (!left) throw new Error('Équipe attendue');
    state = {
      ...state,
      notes: [
        { at: 1, direction: 0 },
        { at: 1.3, direction: 1 },
      ],
    };
    state = untilNote(state, 0);
    // Gauche reste tenue jusqu'à la note suivante.
    while ((state.tick + 1 - state.songAt) * ARENA_STEP < 1.3 - ARENA_STEP / 2) {
      state = RHYTHM_TUG.step(state, { [left]: press(0) });
    }
    // Gauche toujours tenue, et haut en plus : c'est haut qui compte.
    state = RHYTHM_TUG.step(state, { [left]: { ...IDLE_INPUT, move: { x: -0.7, z: -0.7 } } });
    expect(puller(state, left).perfect).toBe(2);
  });

  test('the whole team on the same note pulls more than its parts', () => {
    const base = untilNote(RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 }), 0);
    const team = teamOf(base, 0);
    const arrow = press(base.notes[0]?.direction ?? 0);
    const one = RHYTHM_TUG.step(base, { [team[0] ?? '']: arrow });
    const both = RHYTHM_TUG.step(base, Object.fromEntries(team.map((id) => [id, arrow])));
    expect(both.syncAt[0]).toBe(both.tick);
    expect(Math.abs(both.rope)).toBeGreaterThan(2 * Math.abs(one.rope));
  });

  test('pulled past the line, the other team falls; winners first, by precision', () => {
    let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed: 1 });
    state = untilNote({ ...state, rope: -(WIN_DISTANCE - 0.01) }, 0);
    const [first, second] = teamOf(state, 0);
    if (!first || !second) throw new Error('Équipe attendue');
    state = RHYTHM_TUG.step(state, { [first]: press(state.notes[0]?.direction ?? 0) });
    expect(state.phase).toBe('won');
    expect(state.winner).toBe(0);
    for (const id of teamOf(state, 1)) expect(puller(state, id).fellAt).toBe(state.tick);
    expect(RHYTHM_TUG.isOver(state)).toBe(false);
    for (let i = 0; i < Math.round(FALL_TIME / ARENA_STEP); i++) state = RHYTHM_TUG.step(state, {});
    expect(RHYTHM_TUG.isOver(state)).toBe(true);
    const ranking = RHYTHM_TUG.ranking(state);
    expect(ranking[0]).toEqual([first]);
    expect(ranking[1]).toEqual([second]);
  });

  test('plays whole matches between bots: the expert team ahead of the easy one', () => {
    const wins = { expert: 0, easy: 0, tie: 0 };
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      let state = RHYTHM_TUG.create(PLAYERS, { practice: false, seed });
      const level = (id: string): BotLevel => (puller(state, id).team === 0 ? 'expert' : 'easy');
      while (!RHYTHM_TUG.isOver(state)) {
        const inputs = Object.fromEntries(
          PLAYERS.map((id) => [id, RHYTHM_TUG.botInput(state, id, level(id), rng)]),
        );
        state = RHYTHM_TUG.step(state, inputs);
      }
      expect(RHYTHM_TUG.ranking(state).flat().sort()).toEqual([...PLAYERS].sort());
      if (state.winner === 0) wins.expert++;
      else if (state.winner === 1) wins.easy++;
      else wins.tie++;
    }
    expect(wins.expert).toBeGreaterThan(wins.easy);
  });
});
