import { getSpace, type SpaceId, type SpaceKind } from '../board/board';
import { rollDice } from '../dice/dice';
import type { Context } from './context';
import type { PlayerState } from './types';

/** Assez pour revenir sur ses pas lors des plus grands reculs. */
const TRAIL_LENGTH = 64;
/** Une porte à seuil ne descend pas sous ce seuil, quel que soit le nombre d'échecs. */
const MIN_GATE_THRESHOLD = 2;

export type MoveResult = 'turnOver' | 'awaitingBranch';

/**
 * Déplacement aux dés. S'arrête aux embranchements (le joueur choisira) et à chaque porte
 * (test immédiat : réussite, on continue ; échec, le tour s'arrête). `firstStep` est la
 * case choisie à un embranchement.
 */
export function moveWithDice(
  ctx: Context,
  player: PlayerState,
  steps: number,
  firstStep?: SpaceId,
): MoveResult {
  let remaining = steps;
  let forced = firstStep;
  const path: SpaceId[] = [];
  const flush = () => {
    if (path.length === 0) return;
    ctx.events.push({ type: 'moved', playerId: player.id, path: [...path], cause: 'dice' });
    path.length = 0;
  };

  while (remaining > 0) {
    const space = getSpace(ctx.board, player.position);
    if (forced === undefined && space.next.length > 1) {
      flush();
      ctx.events.push({ type: 'branchReached', playerId: player.id, options: [...space.next] });
      ctx.state.phase = {
        type: 'turn',
        playerId: player.id,
        step: { type: 'awaitBranch', remaining, options: [...space.next] },
      };
      return 'awaitingBranch';
    }
    const next = forced ?? space.next[0];
    forced = undefined;
    if (next === undefined) break;

    stepForward(player, next);
    path.push(next);
    remaining--;

    if (isGate(getSpace(ctx.board, next).kind)) {
      flush();
      player.atGate = true;
      const roll = rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null);
      ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'gate', roll });
      if (testGate(ctx, player, roll.total) !== 'passed') return 'turnOver';
    }
  }

  flush();
  resolveArrival(ctx, player, 'dice');
  return 'turnOver';
}

export type GateOutcome = 'passed' | 'failed' | 'opened';

/** Test de la porte devant laquelle se trouve le joueur, avec le total `total`. */
export function testGate(ctx: Context, player: PlayerState, total: number): GateOutcome {
  const space = getSpace(ctx.board, player.position);
  const { kind } = space;
  if (kind.type !== 'gate' && kind.type !== 'finalGate') throw new Error('Pas de porte ici');

  const failures = player.gateFailures[space.id] ?? 0;
  const threshold =
    kind.type === 'gate'
      ? kind.threshold - Math.max(0, Math.min(failures, kind.threshold - MIN_GATE_THRESHOLD))
      : kind.threshold;
  const success = total >= threshold;
  ctx.events.push({
    type: 'gateTested',
    playerId: player.id,
    spaceId: space.id,
    threshold,
    total,
    success,
  });

  if (!success) {
    player.gateFailures[space.id] = failures + 1;
    return 'failed';
  }
  player.atGate = false;
  if (kind.type === 'gate') return 'passed';

  ctx.state.finalGateOpenedBy.push(player.id);
  ctx.events.push({ type: 'finalGateOpened', playerId: player.id });
  return 'opened';
}

/**
 * Effet de la case d'arrivée. Arrivée aux dés : l'effet s'applique. Arrivée par un effet :
 * pile ou face, une seule fois par tour, ce qui empêche toute boucle sans fin.
 */
function resolveArrival(ctx: Context, player: PlayerState, cause: 'dice' | 'effect'): void {
  if (player.atGate) return;
  const space = getSpace(ctx.board, player.position);
  const delta = movementOf(space.kind);
  if (delta === 0) return;

  if (cause === 'effect') {
    if (ctx.coinFlipUsed) return;
    ctx.coinFlipUsed = true;
    const heads = ctx.rng.chance(0.5);
    ctx.events.push({ type: 'coinFlipped', playerId: player.id, spaceId: space.id, heads });
    if (!heads) return;
  }

  ctx.events.push({ type: 'spaceTriggered', playerId: player.id, spaceId: space.id });
  moveByEffect(ctx, player, delta);
  resolveArrival(ctx, player, 'effect');
}

/**
 * Déplacement d'effet : vers l'avant par la voie principale, sans choix ; vers l'arrière
 * par le chemin réellement suivi. Un effet ne franchit jamais une porte : il s'arrête devant.
 */
function moveByEffect(ctx: Context, player: PlayerState, delta: number): void {
  const path: SpaceId[] = [];
  for (let i = 0; i < Math.abs(delta); i++) {
    if (delta > 0) {
      if (player.atGate) break;
      const next = getSpace(ctx.board, player.position).next[0];
      if (next === undefined) break;
      stepForward(player, next);
      player.atGate = isGate(getSpace(ctx.board, next).kind);
      path.push(next);
    } else {
      const previous = player.trail.pop() ?? ctx.board.predecessors.get(player.position)?.[0];
      if (previous === undefined) break;
      player.position = previous;
      player.atGate = isGate(getSpace(ctx.board, previous).kind);
      path.push(previous);
    }
  }
  if (path.length > 0) {
    ctx.events.push({ type: 'moved', playerId: player.id, path, cause: 'effect' });
  }
}

function stepForward(player: PlayerState, next: SpaceId): void {
  player.trail.push(player.position);
  if (player.trail.length > TRAIL_LENGTH) player.trail.shift();
  player.position = next;
  player.atGate = false;
}

function isGate(kind: SpaceKind): boolean {
  return kind.type === 'gate' || kind.type === 'finalGate';
}

function movementOf(kind: SpaceKind): number {
  if (kind.type === 'bonus') return kind.amount;
  if (kind.type === 'malus') return -kind.amount;
  return 0;
}
