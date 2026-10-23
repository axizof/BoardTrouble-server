import { describe, expect, test } from 'bun:test';
import { ARENA_STEP } from './arena';
import {
  type ArenaBody,
  type BodyTuning,
  collideBodies,
  createBody,
  jumpBody,
  knockDown,
  moveBodies,
  WALKER,
  walkBody,
} from './body';

type Move = { x: number; z: number };
const STILL: Move = { x: 0, z: 0 };
const FORWARD: Move = { x: 0, z: 1 };

/** Fait avancer des corps `steps` pas, chacun avec sa commande, comme une arène le ferait. */
function simulate(
  bodies: ArenaBody[],
  moves: Move[],
  steps: number,
  tuning: BodyTuning = WALKER,
): void {
  for (let i = 0; i < steps; i++) {
    const braced = new Set<string>();
    bodies.forEach((body, index) => {
      const move = moves[index] ?? STILL;
      walkBody(body, move, tuning, ARENA_STEP);
      if (Math.hypot(move.x, move.z) <= 0.1 && body.downed <= 0) braced.add(body.id);
    });
    collideBodies(i % 2 === 0 ? bodies : [...bodies].reverse(), tuning, braced);
    moveBodies(bodies, tuning, ARENA_STEP);
  }
}

describe('arena bodies', () => {
  test('walk up to their walking speed, and stop soon after letting go', () => {
    const body = createBody('a', 0, 0, 0);
    simulate([body], [FORWARD], 30);
    expect(body.vz).toBeCloseTo(WALKER.walkSpeed, 1);
    simulate([body], [STILL], 8);
    expect(Math.hypot(body.vx, body.vz)).toBe(0);
  });

  test('turn toward where they go with some weight, not at once', () => {
    const body = createBody('a', 0, 0, 0);
    simulate([body], [{ x: 0, z: -1 }], 1);
    expect(Math.abs(body.facing)).toBeGreaterThan(0.2);
    expect(Math.abs(body.facing)).toBeLessThan(Math.PI - 0.5);
    simulate([body], [{ x: 0, z: -1 }], 10);
    expect(Math.abs(body.facing)).toBeCloseTo(Math.PI, 3);
  });

  test('walking into someone standing still barely moves them', () => {
    const a = createBody('a', 0, -1.5, 0);
    const b = createBody('b', 0, -0.5, 0);
    simulate([a, b], [FORWARD, STILL], 45);
    // En 1,5 s, b recule à peine (seul, a aurait fait plus de 6 m), et ils restent collés.
    expect(b.z - -0.5).toBeGreaterThan(0.1);
    expect(b.z - -0.5).toBeLessThan(1);
    expect(b.z - a.z).toBeLessThan(WALKER.radius * 2 + 0.15);
  });

  test('two bodies pushing against each other hold each other', () => {
    const a = createBody('a', 0, -1, 0);
    const b = createBody('b', 0, 1, Math.PI);
    simulate([a, b], [FORWARD, { x: 0, z: -1 }], 60);
    expect(Math.abs(a.z + b.z)).toBeLessThan(0.05);
    expect(a.z).toBeCloseTo(-WALKER.radius, 1);
  });

  test('knocked down, a body slides without control, then gets up', () => {
    const body = createBody('a', 0, 0, 0);
    knockDown(body, 0, 1, 6, 1);
    simulate([body], [{ x: 0, z: -1 }], 10);
    expect(body.vz).toBeGreaterThan(0);
    expect(body.downed).toBeGreaterThan(0);
    simulate([body], [STILL], 25);
    expect(body.downed).toBe(0);
    expect(body.z).toBeGreaterThan(1);
  });

  test('jumps only where the minigame allows it, lands, and jumps over a body', () => {
    const grounded = createBody('a', 0, 0, 0);
    jumpBody(grounded, WALKER);
    expect(grounded.vy).toBe(0);
    const jumper: BodyTuning = { ...WALKER, jumpSpeed: 7 };
    const a = createBody('a', 0, -0.9, 0);
    const b = createBody('b', 0, 0.2, 0);
    jumpBody(a, jumper);
    simulate([a, b], [STILL, STILL], 5, jumper);
    expect(a.y).toBeGreaterThan(0.8);
    // En l'air, il ne heurte pas celui qui est en dessous.
    expect(b.z).toBeCloseTo(0.2);
    simulate([a, b], [STILL, STILL], 60, jumper);
    expect(a.y).toBe(0);
  });
});
