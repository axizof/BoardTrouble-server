import { getSpace, type SpaceId } from '../board/board';
import { rollDice } from '../dice/dice';
import { type Context, type Flow, removeItem } from './context';
import { applyHostile, isGate, resolveArrival, stepForward } from './effects';
import type { PlayerState } from './types';

/** Une porte à seuil ne descend pas sous ce seuil, quel que soit le nombre d'échecs. */
const MIN_GATE_THRESHOLD = 2;

/**
 * Déplacement aux dés. S'arrête aux embranchements (le joueur choisira), sur une Colle
 * posée par un autre, et à chaque porte (test immédiat : réussite, on continue ; échec,
 * le tour s'arrête). `firstStep` est la case choisie à un embranchement.
 */
export function moveWithDice(
  ctx: Context,
  player: PlayerState,
  steps: number,
  firstStep?: SpaceId,
): Flow {
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
        step: {
          type: 'awaitBranch',
          remaining,
          options: [...space.next],
          mode: 'dice',
          resume: 'endTurn',
        },
      };
      return 'paused';
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
      const outcome = testGate(ctx, player, () => {
        const roll = rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null);
        ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'gate', roll });
        return roll.total;
      });
      if (outcome !== 'passed') return 'continue';
      continue;
    }

    const trap = ctx.state.traps[next];
    if (trap?.type === 'glue' && trap.owner !== player.id && remaining > 0) {
      flush();
      delete ctx.state.traps[next];
      ctx.events.push({ type: 'trapTriggered', playerId: player.id, spaceId: next, trap: 'glue' });
      // L'effet n'est appelé que si aucun Bouclier ne l'annule.
      applyHostile(ctx, player, null, () => {
        remaining = 0;
        return 'continue';
      });
    }
  }

  flush();
  return resolveArrival(ctx, player, 'dice');
}

export type GateOutcome = 'passed' | 'failed' | 'opened';

/**
 * Tente la porte devant laquelle se trouve le joueur. Une Clé ouvre une porte à seuil
 * sans test. Sinon `rollTotal` donne le total des dés (lancé seulement si nécessaire).
 */
export function testGate(ctx: Context, player: PlayerState, rollTotal: () => number): GateOutcome {
  const space = getSpace(ctx.board, player.position);
  const { kind } = space;
  if (kind.type !== 'gate' && kind.type !== 'finalGate') throw new Error('Pas de porte ici');

  if (kind.type === 'gate' && player.inventory.includes('key')) {
    removeItem(player, 'key');
    player.atGate = false;
    ctx.events.push({ type: 'keyUsed', playerId: player.id, spaceId: space.id });
    return 'passed';
  }

  const failures = player.gateFailures[space.id] ?? 0;
  const threshold =
    kind.type === 'gate'
      ? kind.threshold - Math.max(0, Math.min(failures, kind.threshold - MIN_GATE_THRESHOLD))
      : kind.threshold;
  const total = rollTotal();
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
