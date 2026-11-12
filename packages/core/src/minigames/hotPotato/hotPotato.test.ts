import { describe, expect, test } from 'bun:test';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  BLAST_RADIUS,
  BOMB_FALL,
  bombOf,
  HOT_POTATO,
  PASS_SHIELD,
  type PotatoState,
  SCRAMBLE,
  shownFuse,
} from './hotPotato';
import { clearanceAt, isClearLine, keepInOffice, pathDistance, ROOM_HALF_X } from './office';

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

function run(
  state: PotatoState,
  until: (state: PotatoState) => boolean,
  inputs: (state: PotatoState) => Partial<Record<string, ArenaInput>> = () => ({}),
): PotatoState {
  let current = state;
  for (let tick = 0; tick < steps(200) && !until(current); tick++) {
    current = HOT_POTATO.step(current, inputs(current));
  }
  return current;
}

const hasBomb = (state: PotatoState) => state.bombs.some((bomb) => bomb.explodedAt === null);

/** Deux joueurs côte à côte, la bombe tombée et prête à passer. */
function besideEachOther(seed: number): PotatoState {
  let state = run(HOT_POTATO.create(['a', 'b', 'c'], { practice: false, seed }), hasBomb);
  state = run(state, (s) => s.tick >= (s.bombs[0]?.droppedAt ?? 0) + steps(BOMB_FALL) + 1);
  const holder = state.bombs[0]?.holder;
  const others = state.fighters.filter((fighter) => fighter.id !== holder);
  return {
    ...state,
    fighters: state.fighters.map((fighter) =>
      fighter.id === holder
        ? { ...fighter, x: -9, z: -1 }
        : fighter === others[0]
          ? { ...fighter, x: -9, z: 0.1 }
          : { ...fighter, x: 9, z: 0 },
    ),
  };
}

describe('Patate explosive', () => {
  test('a bomb falls on someone, shows its countdown, and hides when it really blows', () => {
    const state = run(
      HOT_POTATO.create(['a', 'b', 'c', 'd'], { practice: false, seed: 3 }),
      hasBomb,
    );
    expect(state.bombs).toHaveLength(1);
    const bomb = state.bombs[0];
    if (!bomb) throw new Error('pas de bombe');
    expect(bombOf(state, bomb.holder)).toBe(bomb);
    expect(shownFuse(bomb, state.tick)).toBe(20 + Math.ceil(BOMB_FALL));
    // Le brouillage, à SCRAMBLE secondes du zéro.
    expect(shownFuse(bomb, bomb.zeroAt - steps(SCRAMBLE) - 1)).toBe(SCRAMBLE + 1);
    expect(shownFuse(bomb, bomb.zeroAt - steps(SCRAMBLE) + 1)).toBeNull();
    // Les joueurs n'ont pas l'heure exacte.
    const view = HOT_POTATO.viewFor?.(state, { kind: 'spectator' } as never);
    expect(bomb.explodeAt).not.toBeNull();
    expect(view?.bombs[0]?.explodeAt).toBeNull();
  });

  test('it blows between 2 s before and 1 s after its zero, whatever the seed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const state = run(HOT_POTATO.create(['a', 'b'], { practice: false, seed }), hasBomb);
      const bomb = state.bombs[0];
      if (!bomb || bomb.explodeAt === null) throw new Error('pas de bombe');
      const offset = (bomb.explodeAt - bomb.zeroAt) * ARENA_STEP;
      expect(offset).toBeGreaterThanOrEqual(-2.01);
      expect(offset).toBeLessThanOrEqual(1.01);
    }
  });

  test('a touch passes it on, and the one who passed it cannot get it straight back', () => {
    const state = besideEachOther(5);
    const giver = state.bombs[0]?.holder;
    const passed = HOT_POTATO.step(state, {});
    const taker = passed.bombs[0]?.holder;
    expect(taker).not.toBe(giver);
    expect(passed.bombs[0]?.passedFrom).toBe(giver);
    // Toujours au contact : elle ne revient pas pendant PASS_SHIELD.
    const held = run(passed, (s) => s.tick >= passed.tick + steps(PASS_SHIELD) - 2);
    expect(held.bombs[0]?.holder).toBe(taker);
  });

  test('when it blows, its holder is out, the ones nearby are thrown down, and a shorter one falls', () => {
    const state = besideEachOther(7);
    const blown = run(state, (s) => s.bombs[0]?.explodedAt !== null);
    const loser = blown.bombs[0]?.holder;
    const out = blown.fighters.find((fighter) => fighter.id === loser);
    expect(out?.fellAt).toBe(blown.tick);
    for (const fighter of blown.fighters) {
      if (fighter.id === loser || !out) continue;
      const gap = Math.hypot(fighter.x - out.x, fighter.z - out.z);
      if (gap < BLAST_RADIUS - 0.5) expect(fighter.downed).toBeGreaterThan(0);
    }
    const next = run(blown, (s) => s.bombs.some((bomb) => bomb.id === 1));
    const second = next.bombs.find((bomb) => bomb.id === 1);
    if (!second) throw new Error('pas de deuxième bombe');
    expect(second.holder).not.toBe(loser);
    expect(shownFuse(second, next.tick)).toBe(Math.ceil(17.5 + BOMB_FALL));
  });

  test('two bombs at once from five players, one below', () => {
    const six = run(
      HOT_POTATO.create(['a', 'b', 'c', 'd', 'e', 'f'], { practice: false, seed: 2 }),
      hasBomb,
    );
    const holders = six.bombs.map((bomb) => bomb.holder);
    expect(new Set(holders).size).toBe(2);
    const four = run(
      HOT_POTATO.create(['a', 'b', 'c', 'd'], { practice: false, seed: 2 }),
      hasBomb,
    );
    expect(four.bombs).toHaveLength(1);
  });

  test('nobody walks through the furniture or the walls', () => {
    const body = {
      id: 'a',
      x: 0.3,
      y: 0,
      z: 0.2,
      vx: 3,
      vy: 0,
      vz: 0,
      facing: 0,
      stunned: 0,
      downed: 0,
      onGround: true,
    };
    keepInOffice(body, 0.5);
    expect(clearanceAt(body.x, body.z)).toBeGreaterThanOrEqual(0.5 - 1e-6);
    const wall = { ...body, x: ROOM_HALF_X + 2, z: 4, vx: 3 };
    keepInOffice(wall, 0.5);
    expect(wall.x).toBe(ROOM_HALF_X - 0.5);
    expect(wall.vx).toBe(0);
    // La table de réunion barre la ligne droite ; le chemin la contourne.
    expect(isClearLine({ x: -3, z: 0 }, { x: 3, z: 0 })).toBe(false);
    expect(pathDistance({ x: -3, z: 0 }, { x: 3, z: 0 })).toBeLessThan(10);
  });

  test('between bots, the game ends with a full ranking, in a minute or so', () => {
    for (const players of [3, 4, 6]) {
      const ids = Array.from({ length: players }, (_, index) => `p${index}`);
      let state = HOT_POTATO.create(ids, { practice: false, seed: players });
      const rng = new Rng(players);
      state = run(
        state,
        (s) => HOT_POTATO.isOver(s),
        (s) => Object.fromEntries(ids.map((id) => [id, HOT_POTATO.botInput(s, id, 'normal', rng)])),
      );
      expect(HOT_POTATO.isOver(state)).toBe(true);
      expect(state.tick * ARENA_STEP).toBeLessThan(100);
      expect(HOT_POTATO.ranking(state).flat().sort()).toEqual([...ids].sort());
    }
  });

  test('in the sandbox, the first bomb falls on you and nobody is ever out', () => {
    const state = run(HOT_POTATO.create(['you', 'dummy'], { practice: true, seed: 1 }), hasBomb);
    expect(state.bombs[0]?.holder).toBe('you');
    const later = run(
      state,
      (s) => s.tick > steps(30),
      () => ({ you: IDLE_INPUT }),
    );
    expect(later.fighters.every((fighter) => fighter.fellAt === null)).toBe(true);
    expect(HOT_POTATO.isOver(later)).toBe(false);
  });
});
