import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  developPhoto,
  isInSky,
  MAX_PHOTO_POINTS,
  PHOTO_FRAME,
  PHOTO_PASSES,
  photoPoints,
  SHOWCASE_TIME,
  SKY_PHOTO,
  type SkyPhotoState,
  type SkySubject,
  subjectPosition,
  twinOf,
} from './skyPhoto';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

function run(
  state: SkyPhotoState,
  until: (s: SkyPhotoState) => boolean,
  inputs: (s: SkyPhotoState) => Partial<Record<PlayerId, ArenaInput>> = () => ({}),
): SkyPhotoState {
  let current = state;
  while (!until(current)) {
    current = SKY_PHOTO.step(current, inputs(current));
    if (current.tick > steps(120)) throw new Error('partie sans fin');
  }
  return current;
}

/** Le passage `pass` de la cible, en vol. */
const passOf = (state: SkyPhotoState, pass: number) =>
  state.subjects.find((subject) => subject.role === 'target' && subject.pass === pass);

/** Cadre `player` sur `subject` au pas suivant, et déclenche. */
function snap(
  state: SkyPhotoState,
  player: PlayerId,
  subject: SkySubject,
  offset = { x: 0, y: 0 },
) {
  const at = subjectPosition(subject, state.tick + 1);
  const point = { x: at.x + offset.x, z: at.y + offset.y };
  return SKY_PHOTO.step(state, { [player]: { ...IDLE_INPUT, point, primary: true } });
}

/** Attend que ce passage de la cible soit bien dans le ciel (le cadre peut le centrer). */
function untilPassInView(pass: number) {
  return (state: SkyPhotoState) => {
    const subject = passOf(state, pass);
    if (!subject) return false;
    return Math.abs(subjectPosition(subject, state.tick + 1).x) < 5;
  };
}

describe('Clic-clac', () => {
  test('the target is shown first, and the shutter only opens after', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 3 });
    const [showcase] = state.subjects;
    expect(showcase?.kind).toBe(state.target);
    expect(showcase?.role).toBe('showcase');
    const press = { a: { ...IDLE_INPUT, point: { x: 0, z: 5.8 }, primary: true } };
    state = SKY_PHOTO.step(state, press);
    expect(state.fighters[0]?.photo).toBeNull();
    // Le sujet montré s'en va : il ne compte jamais.
    state = run(state, (s) => s.tick >= steps(SHOWCASE_TIME + 1.5));
    expect(state.subjects.some((subject) => subject.role === 'showcase')).toBe(false);
  });

  test('the closer to the centre the target is, the more points; decoys and empty sky score zero', () => {
    expect(photoPoints(0)).toBe(MAX_PHOTO_POINTS);
    expect(photoPoints(0.4)).toBeLessThan(MAX_PHOTO_POINTS);
    expect(photoPoints(0.4)).toBeGreaterThan(photoPoints(1));
    // Le coin du cadre : encore la cible, le moins de points.
    expect(photoPoints(Math.hypot(PHOTO_FRAME.width, PHOTO_FRAME.height) / 2)).toBe(5);
    // Deux photos qui semblent aussi centrées valent autant (les dés les départagent).
    expect(photoPoints(0.01)).toBe(photoPoints(0.03));

    let state = SKY_PHOTO.create(['a', 'b', 'c'], { practice: false, seed: 11 });
    state = run(state, untilPassInView(0));
    const target = passOf(state, 0);
    if (!target) throw new Error('pas de passage');
    const centered = snap(state, 'a', target);
    expect(centered.fighters[0]?.photo).toMatchObject({ kind: state.target, points: 100 });
    const off = snap(state, 'a', target, { x: 0.9, y: 0.3 });
    expect(off.fighters[0]?.photo?.points).toBeLessThan(100);
  });

  test('a decoy nearer the centre than the target makes the photo worth nothing', () => {
    const state = SKY_PHOTO.create(['a'], { practice: false, seed: 1 });
    const decoy: SkySubject = {
      id: 90,
      kind: twinOf(state.target) ?? 'rocket',
      role: 'decoy',
      pass: -1,
      launchAt: state.tick,
      x0: 0.2,
      y0: 5,
      dir: 1,
      speed: 0,
      slope: 0,
      phase: 0,
    };
    const target: SkySubject = {
      ...decoy,
      id: 91,
      kind: state.target,
      role: 'target',
      pass: 0,
      x0: 1,
    };
    const sky = { ...state, subjects: [target, decoy] };
    const at = subjectPosition(decoy, state.tick);
    expect(developPhoto(sky, at.x, at.y, state.tick)).toMatchObject({ points: 0 });
    // Plus à droite, la cible est la plus proche du centre : elle compte.
    const right = subjectPosition(target, state.tick);
    expect(developPhoto(sky, right.x, right.y, state.tick).points).toBe(100);
    // Rien dans le cadre : du ciel, zéro.
    expect(developPhoto(sky, -6, 7, state.tick)).toMatchObject({ kind: null, points: 0 });
  });

  test('only one photo: a second press does nothing (in the sandbox, it can be retaken)', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 5 });
    state = run(state, (s) => s.tick >= steps(SHOWCASE_TIME));
    state = SKY_PHOTO.step(state, { a: { ...IDLE_INPUT, point: { x: -5, z: 7 }, primary: true } });
    const first = state.fighters[0]?.photo;
    expect(first).not.toBeNull();
    state = SKY_PHOTO.step(state, { a: { ...IDLE_INPUT, point: { x: 5, z: 4 }, primary: false } });
    state = run(state, (s) => s.tick >= (first?.takenAt ?? 0) + steps(2));
    state = SKY_PHOTO.step(state, { a: { ...IDLE_INPUT, point: { x: 5, z: 4 }, primary: true } });
    expect(state.fighters[0]?.photo).toEqual(first ?? null);

    let practice = SKY_PHOTO.create(['a'], { practice: true, seed: 5 });
    practice = run(practice, (s) => s.tick >= steps(SHOWCASE_TIME));
    practice = SKY_PHOTO.step(practice, {
      a: { ...IDLE_INPUT, point: { x: -5, z: 7 }, primary: true },
    });
    practice = run(practice, (s) => s.tick >= steps(SHOWCASE_TIME + 1.2));
    practice = SKY_PHOTO.step(practice, {
      a: { ...IDLE_INPUT, point: { x: 5, z: 4 }, primary: true },
    });
    expect(practice.fighters[0]?.photo?.x).toBe(5);
  });

  test('the target passes three times, each time just after its lookalike, among other decoys', () => {
    for (let seed = 0; seed < 12; seed++) {
      let state = SKY_PHOTO.create(['a'], { practice: false, seed });
      const seen = new Map<number, SkySubject>();
      state = run(state, (s) => {
        for (const subject of s.subjects) seen.set(subject.id, subject);
        return s.passes >= PHOTO_PASSES && s.tick > steps(30);
      });
      const all = [...seen.values()];
      const passes = all.filter((subject) => subject.role === 'target');
      expect(passes.map((subject) => subject.pass)).toEqual([0, 1, 2]);
      expect(all.filter((subject) => subject.role === 'decoy').length).toBeGreaterThan(12);
      expect(all.some((subject) => subject.role === 'decoy' && subject.kind === state.target)).toBe(
        false,
      );
      for (const pass of passes) {
        const before = all.filter(
          (subject) =>
            subject.role === 'decoy' &&
            subject.launchAt < pass.launchAt &&
            subject.launchAt >= pass.launchAt - steps(1.2) &&
            subject.dir === pass.dir,
        );
        const twin = twinOf(state.target);
        expect(before.some((subject) => twin === null || subject.kind === twin)).toBe(true);
      }
    }
  });

  test('ends once everyone has a photo, or after the last pass; ranked by points, zeros last', () => {
    let state = SKY_PHOTO.create(['a', 'b', 'c'], { practice: false, seed: 8 });
    state = run(state, untilPassInView(1));
    const target = passOf(state, 1);
    if (!target) throw new Error('pas de passage');
    state = snap(state, 'a', target);
    state = snap(state, 'b', target, { x: 0.8, y: 0 });
    expect(SKY_PHOTO.isOver(state)).toBe(false);
    // c ne prend rien : la partie attend la fin du dernier passage.
    state = run(state, (s) => SKY_PHOTO.isOver(s));
    const last = passOf(state, PHOTO_PASSES - 1);
    expect(last && isInSky(last, state.tick)).toBe(false);
    expect(SKY_PHOTO.ranking(state)).toEqual([['a'], ['b'], ['c']]);

    let quick = SKY_PHOTO.create(['a', 'b'], { practice: false, seed: 8 });
    quick = run(quick, (s) => s.tick >= steps(SHOWCASE_TIME));
    quick = SKY_PHOTO.step(quick, {
      a: { ...IDLE_INPUT, point: { x: -5, z: 7 }, primary: true },
      b: { ...IDLE_INPUT, point: { x: 5, z: 7 }, primary: true },
    });
    quick = run(quick, (s) => SKY_PHOTO.isOver(s));
    expect(quick.tick).toBeLessThan(steps(SHOWCASE_TIME + 2));
  });

  test('the seed stays with the host: it would tell when the target comes', () => {
    const state = SKY_PHOTO.create(['a'], { practice: false, seed: 42 });
    expect(SKY_PHOTO.viewFor?.(state, { type: 'spectator' }).seed).toBe(0);
  });

  test('bots photograph the target, the expert better than the easy one, and every game ends', () => {
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'easy', 'normal', 'expert'];
    const totals: Record<BotLevel, number[]> = { easy: [], normal: [], expert: [] };
    for (let seed = 0; seed < 40; seed++) {
      const ids = levels.map((_, index) => `p${index}`);
      let state = SKY_PHOTO.create(ids, { practice: false, seed });
      const rng = new Rng(seed);
      state = run(
        state,
        (s) => SKY_PHOTO.isOver(s),
        (s) =>
          Object.fromEntries(
            ids.map((id, index) => [id, SKY_PHOTO.botInput(s, id, levels[index] ?? 'normal', rng)]),
          ),
      );
      state.fighters.forEach((fighter, index) => {
        totals[levels[index] ?? 'normal'].push(fighter.photo?.points ?? 0);
      });
    }
    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const scored = [...totals.easy, ...totals.normal, ...totals.expert].filter(
      (points) => points > 0,
    );
    expect(scored.length / (totals.easy.length * 3)).toBeGreaterThan(0.6);
    expect(average(totals.expert)).toBeGreaterThan(average(totals.easy));
  });
});
