import { type Board, distanceToGoal } from '../board/board';
import type { GameState, Intent, PlayerId } from '../game/types';
import type { Rng } from '../random/rng';

export type BotLevel = 'easy' | 'normal' | 'expert';

/** Part de choix faits au hasard : un bot Facile se trompe souvent, un Expert jamais. */
const RANDOM_CHOICE_RATE: Record<BotLevel, number> = { easy: 0.5, normal: 0.15, expert: 0 };

/**
 * Décision d'un bot sur le plateau, ou null si ce n'est pas à lui de jouer. Le bot utilise
 * son propre générateur : ses choix ne consomment pas le hasard de la partie.
 */
export function chooseBoardIntent(
  board: Board,
  state: GameState,
  playerId: PlayerId,
  level: BotLevel,
  rng: Rng,
): Intent | null {
  const { phase } = state;
  if (phase.type !== 'turn' || phase.playerId !== playerId) return null;
  if (phase.step.type === 'awaitRoll') return { type: 'roll' };

  const { options } = phase.step;
  if (rng.chance(RANDOM_CHOICE_RATE[level]))
    return { type: 'chooseBranch', spaceId: rng.pick(options) };
  const best = [...options].sort((a, b) => distanceToGoal(board, a) - distanceToGoal(board, b))[0];
  return best === undefined ? null : { type: 'chooseBranch', spaceId: best };
}
