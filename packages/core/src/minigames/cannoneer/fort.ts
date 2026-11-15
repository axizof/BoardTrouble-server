import type { ArenaBody } from '../arena/body';

// Le fort pirate du Canonnier (02-mini-jeux.md, fiche 30) : un ponton de planches sur la plage,
// fermé par une palissade ; au fond, au milieu, la tour de guet où se tient le canonnier ; sur
// le ponton, des tonneaux et des caisses dont on fait le tour (les boulets passent au-dessus).
// Les leviers apparaissent à l'une des places LEVER_SPOTS. Plan (x, z) en mètres, le ponton à
// la hauteur 0.

/** Le ponton : de -DECK_HALF_X à DECK_HALF_X en x, de DECK_BACK à DECK_FRONT en z. */
export const DECK_HALF_X = 9;
export const DECK_BACK = -5;
export const DECK_FRONT = 7;
/** La tour, au fond au milieu, derrière le ponton ; la bouche du canon, en haut. */
export const TOWER = { x: 0, z: -8.5 } as const;
export const MUZZLE = { x: 0, y: 8, z: -7.4 } as const;

/** Un obstacle du ponton : tonneau (rond) ou caisse (carrée, `half`). */
export type DeckProp = { kind: 'barrel' | 'crate'; x: number; z: number; half: number };

export const DECK_PROPS: readonly DeckProp[] = [
  { kind: 'barrel', x: -5.5, z: -1.5, half: 0.5 },
  { kind: 'barrel', x: 5, z: 3.5, half: 0.5 },
  { kind: 'crate', x: 4.5, z: -2, half: 0.6 },
  { kind: 'crate', x: -4, z: 4, half: 0.6 },
  { kind: 'barrel', x: 0.5, z: 1, half: 0.45 },
];

/** Les places des leviers : toutes sur le ponton, loin des obstacles. */
export const LEVER_SPOTS: readonly { x: number; z: number }[] = [
  { x: -7, z: -3.5 },
  { x: 7, z: -3.5 },
  { x: -7.2, z: 5.5 },
  { x: 7.2, z: 5.5 },
  { x: -2, z: -3.8 },
  { x: 2.5, z: 5.8 },
  { x: 0, z: 3.2 },
];

/** Les places de départ des coureurs, au milieu du ponton. */
export const RUNNER_STARTS: readonly { x: number; z: number }[] = [
  { x: -2.5, z: 2.5 },
  { x: 2.5, z: 2.5 },
  { x: -6, z: 1 },
  { x: 6, z: 1 },
  { x: -2.5, z: 5.5 },
  { x: 2.5, z: 5.5 },
];

/** Ramène un point visé sur le ponton. */
export function clampToDeck(point: { x: number; z: number }): { x: number; z: number } {
  return {
    x: Math.max(-DECK_HALF_X, Math.min(DECK_HALF_X, point.x)),
    z: Math.max(DECK_BACK, Math.min(DECK_FRONT, point.z)),
  };
}

/**
 * Sort `body` (un disque de rayon `radius`) des obstacles et des bords du ponton, et retire de
 * sa vitesse ce qui l'y enfonce (il glisse le long).
 */
export function keepOnDeck(body: ArenaBody, radius: number): void {
  for (const prop of DECK_PROPS) {
    const near =
      prop.kind === 'crate'
        ? {
            x: Math.max(prop.x - prop.half, Math.min(prop.x + prop.half, body.x)),
            z: Math.max(prop.z - prop.half, Math.min(prop.z + prop.half, body.z)),
          }
        : nearOnCircle(prop, body);
    const dx = body.x - near.x;
    const dz = body.z - near.z;
    const gap = Math.hypot(dx, dz);
    if (gap >= radius) continue;
    const nx = gap > 0 ? dx / gap : 1;
    const nz = gap > 0 ? dz / gap : 0;
    body.x += nx * (radius - gap);
    body.z += nz * (radius - gap);
    const into = body.vx * nx + body.vz * nz;
    if (into < 0) {
      body.vx -= into * nx;
      body.vz -= into * nz;
    }
  }
  const minX = -DECK_HALF_X + radius;
  const maxX = DECK_HALF_X - radius;
  const minZ = DECK_BACK + radius;
  const maxZ = DECK_FRONT - radius;
  if (body.x < minX || body.x > maxX) {
    body.x = Math.max(minX, Math.min(maxX, body.x));
    body.vx = 0;
  }
  if (body.z < minZ || body.z > maxZ) {
    body.z = Math.max(minZ, Math.min(maxZ, body.z));
    body.vz = 0;
  }
}

/** Le point du bord d'un tonneau le plus proche du corps (le centre s'il est dessus). */
function nearOnCircle(prop: DeckProp, body: { x: number; z: number }): { x: number; z: number } {
  const dx = body.x - prop.x;
  const dz = body.z - prop.z;
  const gap = Math.hypot(dx, dz);
  if (gap <= prop.half) return { x: prop.x, z: prop.z };
  return { x: prop.x + (dx / gap) * prop.half, z: prop.z + (dz / gap) * prop.half };
}
