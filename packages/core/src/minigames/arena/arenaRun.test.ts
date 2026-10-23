import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_TIMES, ArenaRun } from './arenaRun';

const bots = new Map([
  ['b', 'normal' as const],
  ['c', 'expert' as const],
]);

describe('an arena run', () => {
  test('waits for the human during the intro, then counts down as soon as they are ready', () => {
    const run = new ArenaRun('pawnSumo', ['a', 'b', 'c'], bots, 1, 0);
    expect(run.view(0).ready.sort()).toEqual(['b', 'c']);
    expect(run.nextWakeAt()).toBe(ARENA_TIMES.intro);
    run.setReady('a', 1000);
    expect(run.stage).toBe('countdown');
    expect(run.nextWakeAt()).toBe(1000 + ARENA_TIMES.countdown);
  });

  test('starts anyway when the intro time runs out, plays, then shows the ranking', () => {
    const rng = new Rng(3);
    const run = new ArenaRun('pawnSumo', ['a', 'b', 'c'], bots, 1, 0);
    let now = 0;
    while (!run.isDone(now) && now < 300_000) {
      now = run.nextWakeAt();
      // Le joueur humain ne touche à rien : il finit par tomber avec le plateau.
      run.advance(now, rng);
    }
    expect(run.isDone(now)).toBe(true);
    expect(run.ranking?.flat().sort()).toEqual(['a', 'b', 'c']);
  });

  test('never trusts a client input', () => {
    const run = new ArenaRun('pawnSumo', ['a', 'b'], new Map([['b', 'easy' as const]]), 1, 0);
    run.setInput('a', { move: { x: 50, z: Number.NaN }, primary: 'yes' });
    run.setInput('b', { move: { x: 1, z: 0 }, primary: true, secondary: false });
    run.setReady('a', 0);
    run.advance(ARENA_TIMES.countdown + 200, new Rng(1));
    const a = run.view(0).arena.fighters.find((fighter) => fighter.id === 'a');
    expect(Math.hypot(a?.vx ?? 0, a?.vz ?? 0)).toBeLessThan(5);
    expect(a?.charging).toBe(0);
  });
});
