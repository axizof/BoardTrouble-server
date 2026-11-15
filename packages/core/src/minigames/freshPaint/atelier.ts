import type { ArenaBody } from '../arena/body';

// L'atelier du peintre géant de Peinture fraîche (02-mini-jeux.md, fiche 7) : une toile posée au
// sol, découpée en cases de CELL mètres que les joueurs peignent ; dessus, des pots de peinture,
// un tube écrasé et un pinceau géant couché, qu'il faut contourner (on ne peint pas dessous). La
// peinture tient dans une chaîne d'un caractère par case ('0' : vierge, '1' à '6' : la couleur
// du joueur de ce rang), légère à envoyer. Plan (x, z) en mètres.

/** La toile : de -CANVAS_HALF_X à CANVAS_HALF_X en x, de -CANVAS_HALF_Z à CANVAS_HALF_Z en z. */
export const CANVAS_HALF_X = 12;
export const CANVAS_HALF_Z = 9;
export const CELL = 0.5;
export const PAINT_COLUMNS = Math.round((CANVAS_HALF_X * 2) / CELL);
export const PAINT_ROWS = Math.round((CANVAS_HALF_Z * 2) / CELL);
export const BLANK = '0';

/** Un obstacle de l'atelier : un pot (rond, `radius`) ou une pièce couchée (boîte). */
export type AtelierProp =
  | { kind: 'pot'; x: number; z: number; radius: number; color: number }
  | { kind: 'tube' | 'brush'; x: number; z: number; halfX: number; halfZ: number };

export const ATELIER_PROPS: readonly AtelierProp[] = [
  { kind: 'pot', x: 0, z: 0, radius: 1.3, color: 0 },
  { kind: 'pot', x: -7, z: -4.5, radius: 1, color: 1 },
  { kind: 'pot', x: 7.5, z: 4.5, radius: 1, color: 2 },
  { kind: 'tube', x: 6.5, z: -5, halfX: 1.6, halfZ: 0.5 },
  { kind: 'brush', x: -6.5, z: 4.5, halfX: 0.4, halfZ: 2.5 },
];

export const PAINT_STARTS: readonly { x: number; z: number }[] = [
  { x: -9, z: 0 },
  { x: 9, z: 0 },
  { x: 0, z: -6.5 },
  { x: 0, z: 6.5 },
  { x: -9, z: -7 },
  { x: 9, z: 7 },
];

/** Le point d'un obstacle le plus proche de (x, z) (lui-même s'il est dessus). */
function nearestOn(prop: AtelierProp, x: number, z: number): { x: number; z: number } {
  if (prop.kind === 'pot') {
    const dx = x - prop.x;
    const dz = z - prop.z;
    const gap = Math.hypot(dx, dz);
    if (gap <= prop.radius) return { x, z };
    return { x: prop.x + (dx / gap) * prop.radius, z: prop.z + (dz / gap) * prop.radius };
  }
  return {
    x: Math.max(prop.x - prop.halfX, Math.min(prop.x + prop.halfX, x)),
    z: Math.max(prop.z - prop.halfZ, Math.min(prop.z + prop.halfZ, z)),
  };
}

/** Un point sous un obstacle (on n'y peint pas, on n'y marche pas). */
export function isUnderProp(x: number, z: number): boolean {
  return ATELIER_PROPS.some((prop) => {
    const near = nearestOn(prop, x, z);
    return near.x === x && near.z === z;
  });
}

/** Le rang de la case sous (x, z), ou -1 hors de la toile. */
export function cellAt(x: number, z: number): number {
  const column = Math.floor((x + CANVAS_HALF_X) / CELL);
  const row = Math.floor((z + CANVAS_HALF_Z) / CELL);
  if (column < 0 || column >= PAINT_COLUMNS || row < 0 || row >= PAINT_ROWS) return -1;
  return row * PAINT_COLUMNS + column;
}

/** Le centre de la case de ce rang. */
export function paintCellCenter(cell: number): { x: number; z: number } {
  const column = cell % PAINT_COLUMNS;
  const row = Math.floor(cell / PAINT_COLUMNS);
  return { x: -CANVAS_HALF_X + (column + 0.5) * CELL, z: -CANVAS_HALF_Z + (row + 0.5) * CELL };
}

/** Les cases peignables (pas sous un obstacle), calculées une fois. */
export const PAINTABLE: readonly boolean[] = Array.from(
  { length: PAINT_COLUMNS * PAINT_ROWS },
  (_, cell) => {
    const { x, z } = paintCellCenter(cell);
    return !isUnderProp(x, z);
  },
);
export const PAINTABLE_CELLS = PAINTABLE.filter(Boolean).length;

/** Les cases dont le centre est à moins de `radius` de (x, z), sur la toile et peignables. */
export function cellsAround(x: number, z: number, radius: number): number[] {
  const cells: number[] = [];
  const reach = Math.ceil(radius / CELL);
  const center = cellAt(x, z);
  if (center < 0) return cells;
  const column = center % PAINT_COLUMNS;
  const row = Math.floor(center / PAINT_COLUMNS);
  for (let r = row - reach; r <= row + reach; r++) {
    for (let c = column - reach; c <= column + reach; c++) {
      if (r < 0 || r >= PAINT_ROWS || c < 0 || c >= PAINT_COLUMNS) continue;
      const cell = r * PAINT_COLUMNS + c;
      const at = paintCellCenter(cell);
      if (PAINTABLE[cell] && Math.hypot(at.x - x, at.z - z) <= radius) cells.push(cell);
    }
  }
  return cells;
}

/** Sort `body` des obstacles et des bords de la toile ; il glisse le long. */
export function keepInAtelier(body: ArenaBody, radius: number): void {
  for (const prop of ATELIER_PROPS) {
    const near = nearestOn(prop, body.x, body.z);
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
  const limitX = CANVAS_HALF_X - radius;
  const limitZ = CANVAS_HALF_Z - radius;
  if (Math.abs(body.x) > limitX) {
    body.x = Math.sign(body.x) * limitX;
    body.vx = 0;
  }
  if (Math.abs(body.z) > limitZ) {
    body.z = Math.sign(body.z) * limitZ;
    body.vz = 0;
  }
}
