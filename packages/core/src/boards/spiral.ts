import type { Point } from '../board/board';

/**
 * Géométrie d'un chemin qui monte en spirale autour d'une montagne : un tour par étage, le
 * rayon diminue et la hauteur augmente à chaque tour. `turn` vaut 0 au pied de l'étage 1 et
 * k au sommet de l'étage k.
 */
export type Spiral = {
  baseRadius: number;
  radiusPerTurn: number;
  baseHeight: number;
  heightPerTurn: number;
  startAngle: number;
};

/** Point du chemin, décalé de `offset` vers l'extérieur (négatif : vers la paroi). */
export function pointOnSpiral(spiral: Spiral, turn: number, offset = 0): Point {
  const angle = spiral.startAngle + 2 * Math.PI * turn;
  const radius = spiral.baseRadius - spiral.radiusPerTurn * turn + offset;
  return {
    x: round(radius * Math.cos(angle)),
    y: round(spiral.baseHeight + spiral.heightPerTurn * turn),
    z: round(radius * Math.sin(angle)),
  };
}

/**
 * Décalage d'une voie qui quitte le chemin puis le rejoint : elle s'écarte vite, longe la
 * paroi, puis revient. `progress` va de 0 (embranchement) à 1 (jonction).
 */
export function laneOffset(depth: number, progress: number): number {
  return -depth * Math.min(1, 1.5 * Math.sin(Math.PI * progress));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
