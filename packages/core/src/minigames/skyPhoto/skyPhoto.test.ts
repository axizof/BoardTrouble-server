import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import { Rng } from '../../random/rng';
import { ARENA_STEP, IDLE_INPUT } from '../arena/arena';
import {
  developPhoto,
  isInSky,
  MAX_PHOTO_POINTS,
  PHOTO_PASSES,
  photoPoints,
  SHOWCASE_TIME,
  SKY_PHOTO,
  type SkyPhotoState,
  type SkySubject,
  subjectPosition,
  twinOf,
  VIEW,
} from './skyPhoto';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);
const press = (...players: PlayerId[]) =>
  Object.fromEntries(players.map((id) => [id, { ...IDLE_INPUT, primary: true }]));

function run(
  state: SkyPhotoState,
  until: (s: SkyPhotoState) => boolean,
  inputs: (s: SkyPhotoState) => ReturnType<typeof press> = () => ({}),
): SkyPhotoState {
  let current = state;
  while (!until(current)) {
    current = SKY_PHOTO.step(current, inputs(current));
    if (current.tick > steps(120)) throw new Error('partie sans fin');
  }
  return current;
}

/** Le passage `pass` de la cible. */
const passOf = (state: SkyPhotoState, pass: number) =>
  state.subjects.find((subject) => subject.role === 'target' && subject.pass === pass);

/** Le pas où ce sujet est le plus près du centre du viseur. */
function closestTick(subject: SkySubject): number {
  let best = subject.launchAt;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let tick = subject.launchAt; tick < subject.launchAt + steps(10); tick++) {
    const at = subjectPosition(subject, tick);
    const distance = Math.hypot(at.x - VIEW.center.x, at.y - VIEW.center.y);
    if (distance < bestDistance) {
      best = tick;
      bestDistance = distance;
    }
  }
  return best;
}

/** Joue jusqu'au passage `pass` de la cible, puis jusqu'au pas qui précède son meilleur moment (plus `offset` pas). */
function untilBest(state: SkyPhotoState, pass: number, offset = 0): SkyPhotoState {
  const arrived = run(state, (s) => passOf(s, pass) !== undefined);
  const target = passOf(arrived, pass);
  if (!target) throw new Error('pas de passage');
  return run(arrived, (s) => s.tick >= closestTick(target) + offset - 1);
}

describe('Clic-clac', () => {
  test('the target is shown first, and the shutter only opens after', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 3 });
    const [showcase] = state.subjects;
    expect(showcase?.kind).toBe(state.target);
    expect(showcase?.role).toBe('showcase');
    state = SKY_PHOTO.step(state, press('a'));
    expect(state.fighters[0]?.photo).toBeNull();
    // Le sujet montré s'en va : il ne compte jamais.
    state = run(state, (s) => s.tick >= steps(SHOWCASE_TIME + 1));
    expect(state.subjects.some((subject) => subject.role === 'showcase')).toBe(false);
  });

  test('subjects cross the viewfinder one at a time, with quiet moments in between', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 12 });
    let quietTicks = 0;
    state = run(state, (s) => {
      const flying = s.subjects.filter(
        (subject) => subject.role !== 'showcase' && isInSky(subject, s.tick),
      );
      expect(flying.length).toBeLessThanOrEqual(1);
      if (s.tick > steps(SHOWCASE_TIME) && flying.length === 0) quietTicks++;
      return s.passes >= PHOTO_PASSES;
    });
    expect(quietTicks).toBeGreaterThan(steps(2));
  });

  test('the closer to the centre at the click, the more points; a decoy or empty sky is worth nothing', () => {
    expect(photoPoints(0)).toBe(MAX_PHOTO_POINTS);
    expect(photoPoints(0.3)).toBeGreaterThan(photoPoints(0.8));
    // Deux photos qui semblent aussi centrées valent autant (les dés les départagent).
    expect(photoPoints(0.01)).toBe(photoPoints(0.03));

    const start = () => SKY_PHOTO.create(['a', 'b'], { practice: false, seed: 11 });
    const state = untilBest(start(), 0);
    const best = SKY_PHOTO.step(state, press('a')).fighters[0]?.photo;
    expect(best?.kind).toBe(state.target);
    expect(best?.points).toBeGreaterThanOrEqual(80);
    const late = untilBest(start(), 0, steps(0.15));
    const lateShot = SKY_PHOTO.step(late, press('a')).fighters[0]?.photo;
    expect(lateShot?.points).toBeLessThan(best?.points ?? 0);
    // Entre deux sujets, du ciel vide.
    expect(developPhoto(start(), steps(4))).toMatchObject({ kind: null, points: 0 });
  });

  test('a decoy at the centre makes the photo worth nothing', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 7 });
    state = run(state, (s) => s.subjects.some((subject) => subject.role === 'decoy'));
    const decoy = state.subjects.find((subject) => subject.role === 'decoy');
    if (!decoy) throw new Error('pas de leurre');
    state = run(state, (s) => s.tick >= closestTick(decoy) - 1);
    const photo = SKY_PHOTO.step(state, press('a')).fighters[0]?.photo;
    expect(photo?.kind).toBe(decoy.kind);
    expect(photo?.points).toBe(0);
  });

  test('only one photo: a second press does nothing (in the sandbox, it can be retaken)', () => {
    let state = SKY_PHOTO.create(['a'], { practice: false, seed: 5 });
    state = run(state, (s) => s.tick >= steps(SHOWCASE_TIME));
    state = SKY_PHOTO.step(state, press('a'));
    const first = state.fighters[0]?.photo;
    expect(first).not.toBeNull();
    state = run(state, (s) => s.tick >= (first?.takenAt ?? 0) + steps(2));
    state = SKY_PHOTO.step(state, press('a'));
    expect(state.fighters[0]?.photo).toEqual(first ?? null);

    let practice = SKY_PHOTO.create(['a'], { practice: true, seed: 5 });
    practice = run(practice, (s) => s.tick >= steps(SHOWCASE_TIME));
    practice = SKY_PHOTO.step(practice, press('a'));
    const before = practice.fighters[0]?.photo?.takenAt;
    practice = run(practice, (s) => s.tick >= (before ?? 0) + steps(1.2));
    practice = SKY_PHOTO.step(practice, press('a'));
    expect(practice.fighters[0]?.photo?.takenAt).not.toBe(before);
  });

  test('the target passes twice, each time right after its lookalike', () => {
    for (let seed = 0; seed < 16; seed++) {
      let state = SKY_PHOTO.create(['a'], { practice: false, seed });
      const seen = new Map<number, SkySubject>();
      state = run(state, (s) => {
        for (const subject of s.subjects) seen.set(subject.id, subject);
        return SKY_PHOTO.isOver(s);
      });
      const all = [...seen.values()].filter((subject) => subject.role !== 'showcase');
      const passes = all.filter((subject) => subject.role === 'target');
      expect(passes.map((subject) => subject.pass)).toEqual([0, 1]);
      const isTargetDecoy = all.some(
        (subject) => subject.role === 'decoy' && subject.kind === state.target,
      );
      expect(isTargetDecoy).toBe(false);
      const twin = twinOf(state.target);
      for (const pass of passes) {
        const before = all.find((subject) => subject.id === pass.id - 1);
        expect(before?.role).toBe('decoy');
        if (twin) expect(before?.kind).toBe(twin);
      }
    }
  });

  test('ends once everyone has a photo, or after the last pass; ranked by points, zeros last', () => {
    let state = untilBest(SKY_PHOTO.create(['a', 'b', 'c'], { practice: false, seed: 8 }), 0);
    state = SKY_PHOTO.step(state, press('a'));
    state = run(state, (s) => s.tick >= (s.fighters[0]?.photo?.takenAt ?? 0) + steps(0.2));
    state = SKY_PHOTO.step(state, press('b'));
    expect(SKY_PHOTO.isOver(state)).toBe(false);
    // c ne prend rien : la partie attend la fin du dernier passage.
    state = run(state, (s) => SKY_PHOTO.isOver(s));
    const last = passOf(state, PHOTO_PASSES - 1);
    expect(last && isInSky(last, state.tick)).toBe(false);
    const ranking = SKY_PHOTO.ranking(state);
    expect(ranking[0]).toEqual(['a']);
    expect(ranking.at(-1)).toContain('c');

    let quick = SKY_PHOTO.create(['a', 'b'], { practice: false, seed: 8 });
    quick = run(quick, (s) => s.tick >= steps(SHOWCASE_TIME));
    quick = SKY_PHOTO.step(quick, press('a', 'b'));
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
      const rng = new Rng(seed);
      const state = run(
        SKY_PHOTO.create(ids, { practice: false, seed }),
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
    const all = [...totals.easy, ...totals.normal, ...totals.expert];
    expect(all.filter((points) => points > 0).length / all.length).toBeGreaterThan(0.6);
    expect(average(totals.expert)).toBeGreaterThan(average(totals.easy));
  });
});
