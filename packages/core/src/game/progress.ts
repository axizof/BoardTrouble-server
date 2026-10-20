import { type Board, distanceToGoal } from '../board/board';
import type { GameState, PlayerId } from './types';

/**
 * Classement du plateau, du plus avancé au moins avancé : distance à la porte finale, et
 * ceux qui l'ont déjà ouverte en tête. Sert au TROUBLE ("le dernier"), aux objets, aux
 * stats et au simulateur.
 */
export function progressRanking(board: Board, state: GameState): PlayerId[] {
  const score = (id: PlayerId) => {
    if (state.finalGateOpenedBy.includes(id)) return -1;
    const player = state.players.find((candidate) => candidate.id === id);
    return player ? distanceToGoal(board, player.position) : Number.POSITIVE_INFINITY;
  };
  return state.players.map((player) => player.id).sort((a, b) => score(a) - score(b));
}
