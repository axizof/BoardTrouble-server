import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BASE_WIDTH,
  movingBlockX,
  PERFECT_SNAP,
  STACK_TIME_LIMIT,
  STACKER,
  type StackState,
  specialAt,
  towerHeight,
} from './stacker';

const PRESS: ArenaInput = { ...IDLE_INPUT, primary: true };

const fighter = (state: StackState, id = 'a') => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};

/** Avance jusqu'à ce que le bloc de `a` soit en `x` (à un pas près), puis le lâche. */
function dropAt(state: StackState, x: number): StackState {
  let current = state;
  for (let i = 0; i < 600; i++) {
    const now = movingBlockX(fighter(current), current.tick + 1);
    const next = movingBlockX(fighter(current), current.tick + 2);
    if (now !== null && next !== null && (now - x) * (next - x) <= 0) {
      current = STACKER.step(current, {});
      return STACKER.step(current, { a: PRESS });
    }
    current = STACKER.step(current, {});
  }
  throw new Error(`Le bloc n'est jamais passé en ${x}`);
}

describe('stacker', () => {
  test('a block dropped off-centre is cut to what lies on the block below', () => {
    const state = STACKER.create(['a'], { practice: false, seed: 1 });
    const dropped = dropAt(state, 0.8);
    const a = fighter(dropped);
    expect(towerHeight(a)).toBe(1);
    const top = a.blocks.at(-1);
    // À peu près 0,8 m de moins, et décalé d'autant de moitié vers où on l'a lâché.
    expect(top?.width).toBeCloseTo(BASE_WIDTH - 0.8, 0);
    expect(top?.x).toBeGreaterThan(0.3);
    expect(a.cut?.width).toBeCloseTo(BASE_WIDTH - (top?.width ?? 0));
    expect(a.cut?.x).toBeGreaterThan(BASE_WIDTH / 2);
  });

  test('a block dropped almost right on top lands exactly, without a cut', () => {
    const dropped = dropAt(STACKER.create(['a'], { practice: false, seed: 1 }), PERFECT_SNAP / 3);
    const a = fighter(dropped);
    expect(a.blocks.at(-1)).toEqual({ x: 0, width: BASE_WIDTH });
    expect(a.wasPerfect).toBe(true);
    expect(a.cut).toBeNull();
  });

  test('a block dropped beside the tower ends it, except in practice', () => {
    // Un bloc étroit : deux poses très décalées, puis une à côté.
    let state = STACKER.create(['a'], { practice: false, seed: 1 });
    state = dropAt(state, 1.8);
    state = dropAt(state, 1.6);
    const narrow = fighter(state).blocks.at(-1);
    expect(narrow?.width).toBeLessThan(0.5);
    const ended = dropAt(state, -2);
    expect(fighter(ended).isDone).toBe(true);
    expect(movingBlockX(fighter(ended), ended.tick + 30)).toBeNull();

    const practice = STACKER.create(['a'], { practice: true, seed: 1 });
    const restarted = dropAt(dropAt(dropAt(practice, 1.8), 1.6), -2);
    expect(fighter(restarted).isDone).toBe(false);
    expect(towerHeight(fighter(restarted))).toBe(0);
  });

  test('the tallest tower wins, then the first to reach its height', () => {
    let state = STACKER.create(['a', 'b'], { practice: false, seed: 1 });
    state = {
      ...state,
      fighters: [
        {
          ...fighter(state, 'a'),
          blocks: [
            { x: 0, width: 2 },
            { x: 0, width: 2 },
          ],
          placedAt: 50,
        },
        {
          ...fighter(state, 'b'),
          blocks: [
            { x: 0, width: 2 },
            { x: 0, width: 2 },
          ],
          placedAt: 40,
        },
      ],
    };
    expect(STACKER.ranking(state)).toEqual([['b'], ['a']]);
    const tied = {
      ...state,
      fighters: state.fighters.map((one) => ({ ...one, placedAt: 40 })),
    };
    expect(STACKER.ranking(tied)).toEqual([['a', 'b']]);
  });

  test('blocks get faster as the tower grows, a bit unevenly, but the same for everyone', () => {
    const speeds = () => {
      let state = STACKER.create(['a', 'b'], { practice: false, seed: 3 });
      const seen: number[] = [];
      for (let level = 0; level < 20; level++) {
        seen.push(fighter(state, 'a').speed);
        state = dropAt(state, 0);
        // Le bloc suivant apparaît : on le laisse partir.
        for (let i = 0; i < 15; i++) state = STACKER.step(state, {});
      }
      return seen;
    };
    const a = speeds();
    expect(a.at(-1) ?? 0).toBeGreaterThan((a[0] ?? 0) * 1.8);
    // D'un étage à l'autre, pas toujours le même écart : la vitesse varie un peu.
    const steps = new Set(a.slice(1).map((speed, index) => (speed - (a[index] ?? 0)).toFixed(2)));
    expect(steps.size).toBeGreaterThan(3);
    // Au même étage, le même bloc pour tous : deux tours de 6 blocs dont le suivant apparaît.
    const start = STACKER.create(['a', 'b'], { practice: false, seed: 3 });
    const tower = Array.from({ length: 6 }, () => ({ x: 0, width: BASE_WIDTH }));
    const ready = {
      ...start,
      fighters: start.fighters.map((one) => ({
        ...one,
        blocks: tower,
        movingSince: null,
        spawnAt: 1,
      })),
    };
    const spawned = STACKER.step(ready, {});
    expect(fighter(spawned, 'a').speed).toBe(fighter(spawned, 'b').speed);
    expect(fighter(spawned, 'a').speed).toBeCloseTo(a[5] ?? 0);
  });

  test('some floors are special, every 3 to 5 floors from the 5th, the same for everyone', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const floors = Array.from({ length: 40 }, (_, level) => specialAt(seed, level + 1));
      const special = floors.flatMap((kind, index) => (kind ? [index + 1] : []));
      expect(special[0]).toBe(5);
      special.slice(1).forEach((level, index) => {
        const gap = level - (special[index] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(3);
        expect(gap).toBeLessThanOrEqual(5);
      });
      for (const kind of floors) if (kind) kinds.add(kind);
    }
    expect([...kinds].sort()).toEqual(['fast', 'pulse']);
  });

  test('a fast floor moves faster; a pulsing one goes slow and fast in turn, never stopping', () => {
    const moving = (special: 'fast' | 'pulse' | null, speed = 3) => ({
      ...fighter(STACKER.create(['a'], { practice: false, seed: 1 })),
      movingSince: 0,
      speed,
      special,
    });
    // Sur un quart de seconde, ce qu'il parcourt (avant d'atteindre le bout de sa course).
    const covered = (one: ReturnType<typeof moving>, from: number) =>
      Math.abs((movingBlockX(one, from + 7) ?? 0) - (movingBlockX(one, from) ?? 0));
    const pulse = moving('pulse');
    const stretches = [0, 7, 14, 21].map((from) => covered(pulse, from));
    expect(Math.max(...stretches)).toBeGreaterThan(Math.min(...stretches) * 2);
    expect(Math.min(...stretches)).toBeGreaterThan(0);
    // Le bloc d'un étage rapide est plus vif que celui d'un étage ordinaire.
    let seed = 1;
    while (specialAt(seed, 5) !== 'fast') seed++;
    let state = STACKER.create(['a'], { practice: false, seed });
    const before = fighter(state).speed;
    state = {
      ...state,
      fighters: [
        {
          ...fighter(state),
          blocks: Array.from({ length: 5 }, () => ({ x: 0, width: BASE_WIDTH })),
          movingSince: null,
          spawnAt: 1,
        },
      ],
    };
    state = STACKER.step(state, {});
    expect(fighter(state).special).toBe('fast');
    expect(fighter(state).speed).toBeGreaterThan(before * 1.5);
  });

  test('the clock stops the match after 45 seconds', () => {
    let state = STACKER.create(['a', 'b'], { practice: false, seed: 1 });
    while (!STACKER.isOver(state)) state = STACKER.step(state, {});
    expect(state.tick * ARENA_STEP).toBeCloseTo(STACK_TIME_LIMIT, 1);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const players = ['a', 'b', 'c', 'd'];
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Rng(seed);
      let state = STACKER.create(players, { practice: false, seed });
      while (!STACKER.isOver(state)) {
        const inputs = Object.fromEntries(
          players.map((id, index) => [
            id,
            STACKER.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = STACKER.step(state, inputs);
      }
      const ranking = STACKER.ranking(state);
      expect(ranking.flat().sort()).toEqual([...players].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
