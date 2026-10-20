import { type Board, getSpace, isGateKind, type SpaceId, type SpaceKind } from '../board/board';
import type { GameState, Overlays } from '../game/types';

/** Recul d'une case spéciale pendant l'Éruption. */
export const ERUPTION_RECOIL = 3;

/** Terrain des étages : il fait partie du décor, ni mélangé ni changé en -3. */
const TERRAIN = ['ice', 'conveyor', 'drawbridge'];

/** Cases "spéciales" : tout ce qui n'est ni vide, ni départ, ni porte, ni terrain. */
export function isSpecial(kind: SpaceKind): boolean {
  return (
    !isGateKind(kind) &&
    kind.type !== 'start' &&
    kind.type !== 'empty' &&
    !TERRAIN.includes(kind.type)
  );
}

/**
 * Effet réel d'une case, compte tenu des modifications du TROUBLE : Brouillard (effets
 * mélangés), Éruption (toutes les cases spéciales deviennent des -3), Inversion (bonus et
 * malus échangés).
 */
export function effectiveKind(board: Board, state: GameState, spaceId: SpaceId): SpaceKind {
  const { overlays } = state;
  return kindUnderOverlays(overlays.fog?.kinds[spaceId] ?? getSpace(board, spaceId).kind, overlays);
}

/**
 * Ce que devient une case sous l'Éruption et l'Inversion. Sert aussi aux clients, qui ne
 * connaissent pas le mélange secret du Brouillard mais affichent les deux autres.
 */
export function kindUnderOverlays(kind: SpaceKind, overlays: Overlays): SpaceKind {
  if (overlays.eruptionUntil !== null && isSpecial(kind)) {
    return { type: 'malus', amount: ERUPTION_RECOIL };
  }
  if (overlays.inversionUntil !== null) {
    if (kind.type === 'bonus') return { type: 'malus', amount: kind.amount };
    if (kind.type === 'malus') return { type: 'bonus', amount: kind.amount };
  }
  return kind;
}
