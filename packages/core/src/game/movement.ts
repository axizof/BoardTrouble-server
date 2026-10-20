import { getSpace, type SpaceId } from '../board/board';
import type { Context, Flow } from './context';
import { applyHostile, isGate, resolveArrival, stepForward } from './effects';
import { isIce, openNext } from './floors';
import { attemptGate } from './gates';
import type { PlayerState } from './types';

/**
 * Déplacement aux dés. S'arrête aux embranchements (le joueur choisira), sur une Colle
 * posée par un autre, et à chaque porte (tentative immédiate : réussite, on continue ;
 * échec, le tour s'arrête ; porte à choix, on attend le joueur). `firstStep` est la case
 * choisie à un embranchement. Le dé fini sur une case gelée, on glisse jusqu'à la prochaine
 * case non gelée : c'est elle qui se déclenche, comme une arrivée aux dés.
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

  while (remaining > 0 || isIce(ctx.board, player.position)) {
    const options = openNext(ctx.board, ctx.state, getSpace(ctx.board, player.position));
    if (forced === undefined && options.length > 1) {
      flush();
      ctx.events.push({ type: 'branchReached', playerId: player.id, options: [...options] });
      ctx.state.phase = {
        type: 'turn',
        playerId: player.id,
        step: {
          type: 'awaitBranch',
          remaining,
          options: [...options],
          mode: 'dice',
          resume: 'endTurn',
        },
      };
      return 'paused';
    }
    const next = forced ?? options[0];
    forced = undefined;
    if (next === undefined) break;

    stepForward(player, next);
    path.push(next);
    // Glisser sur la glace ne coûte pas de case au dé.
    if (remaining > 0) remaining--;

    if (isGate(getSpace(ctx.board, next).kind)) {
      flush();
      player.atGate = true;
      const outcome = attemptGate(ctx, player, remaining, null);
      if (outcome === 'paused') return 'paused';
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
