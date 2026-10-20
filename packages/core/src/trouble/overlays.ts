import { type Board, getSpace, type SpaceId, type SpaceKind } from '../board/board';
import type { GameState } from '../game/types';

/** Recul d'une case spéciale pendant l'Éruption. */
export const ERUPTION_RECOIL = 3;

/** Cases "spéciales" : tout ce qui n'est ni vide, ni départ, ni porte. */
export function isSpecial(kind: SpaceKind): boolean {
  return !['start', 'empty', 'gate', 'finalGate'].includes(kind.type);
}

/**
 * Effet réel d'une case, compte tenu des modifications du TROUBLE : Brouillard (effets
 * mélangés), Éruption (toutes les cases spéciales deviennent des -3), Inversion (bonus et
 * malus échangés).
 */
export function effectiveKind(board: Board, state: GameState, spaceId: SpaceId): SpaceKind {
  const { overlays } = state;
  const kind = overlays.fog?.kinds[spaceId] ?? getSpace(board, spaceId).kind;
  if (overlays.eruptionUntil !== null && isSpecial(kind)) {
    return { type: 'malus', amount: ERUPTION_RECOIL };
  }
  if (overlays.inversionUntil !== null) {
    if (kind.type === 'bonus') return { type: 'malus', amount: kind.amount };
    if (kind.type === 'malus') return { type: 'bonus', amount: kind.amount };
  }
  return kind;
}
