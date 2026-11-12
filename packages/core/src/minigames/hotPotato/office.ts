import type { ArenaBody } from '../arena/body';

// Le bureau de la Patate explosive (02-mini-jeux.md, fiche 5) : une grande salle du Plateau en
// désordre, avec de quoi tourner autour (îlots de bureaux, table de réunion, photocopieuse,
// canapé, armoires, plantes). Le même pour toutes les parties. Les meubles sont des rectangles
// et des disques que les corps ne traversent pas ; les bots s'y repèrent sur une grille.
// Plan (x, z) en mètres.

/** La salle : de -ROOM_HALF_X à ROOM_HALF_X en x, de -ROOM_HALF_Z à ROOM_HALF_Z en z. */
export const ROOM_HALF_X = 12;
export const ROOM_HALF_Z = 9;

export type FurnitureKind =
  | 'desks'
  | 'copier'
  | 'sofa'
  | 'cabinet'
  | 'meetingTable'
  | 'plant'
  | 'watercooler';

/** Un meuble rectangulaire : son centre, ses demi-côtés. */
export type BoxFurniture = {
  kind: FurnitureKind;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
};
/** Un meuble rond : son centre, son rayon. */
export type RoundFurniture = { kind: FurnitureKind; x: number; z: number; radius: number };

export const BOXES: readonly BoxFurniture[] = [
  // Quatre îlots de deux bureaux dos à dos.
  { kind: 'desks', x: -6.5, z: -4.5, halfX: 1.6, halfZ: 0.8 },
  { kind: 'desks', x: 6.5, z: -4.5, halfX: 1.6, halfZ: 0.8 },
  { kind: 'desks', x: -6.5, z: 4.5, halfX: 1.6, halfZ: 0.8 },
  { kind: 'desks', x: 6.5, z: 4.5, halfX: 1.6, halfZ: 0.8 },
  { kind: 'copier', x: 0, z: -6, halfX: 0.8, halfZ: 0.55 },
  { kind: 'sofa', x: 0, z: 6, halfX: 1.4, halfZ: 0.5 },
  // Des armoires au milieu des murs de côté, avec un passage derrière les îlots.
  { kind: 'cabinet', x: -11.6, z: 0, halfX: 0.4, halfZ: 1.5 },
  { kind: 'cabinet', x: 11.6, z: 0, halfX: 0.4, halfZ: 1.5 },
];

export const ROUNDS: readonly RoundFurniture[] = [
  { kind: 'meetingTable', x: 0, z: 0, radius: 1.5 },
  { kind: 'plant', x: -3.3, z: -2.2, radius: 0.45 },
  { kind: 'plant', x: 3.3, z: 2.2, radius: 0.45 },
  { kind: 'watercooler', x: -3.3, z: 2.4, radius: 0.35 },
  // Une plante dans chaque coin : on ne s'y fait pas coincer tout au fond.
  { kind: 'plant', x: -11.3, z: -8.3, radius: 0.55 },
  { kind: 'plant', x: 11.3, z: -8.3, radius: 0.55 },
  { kind: 'plant', x: -11.3, z: 8.3, radius: 0.55 },
  { kind: 'plant', x: 11.3, z: 8.3, radius: 0.55 },
];

/** Les places de départ, dans l'ordre des joueurs : les quatre premières se font face deux à deux. */
export const START_SPOTS: readonly { x: number; z: number }[] = [
  { x: -9, z: 0 },
  { x: 9, z: 0 },
  { x: -3.5, z: -7 },
  { x: 3.5, z: 7 },
  { x: 3.5, z: -7 },
  { x: -3.5, z: 7 },
];

/**
 * Sort `body` (un disque de rayon `radius`) des murs et des meubles où il est entré, et retire
 * de sa vitesse ce qui l'y enfonce (il glisse le long).
 */
export function keepInOffice(body: ArenaBody, radius: number): void {
  for (const box of BOXES) {
    const nearX = Math.max(box.x - box.halfX, Math.min(box.x + box.halfX, body.x));
    const nearZ = Math.max(box.z - box.halfZ, Math.min(box.z + box.halfZ, body.z));
    const dx = body.x - nearX;
    const dz = body.z - nearZ;
    const gap = Math.hypot(dx, dz);
    if (gap >= radius) continue;
    if (gap > 0) {
      pushOut(body, dx / gap, dz / gap, radius - gap);
      continue;
    }
    // Le centre est dans le meuble (une ruée très vive) : on le sort par le côté le plus proche.
    const outX = box.halfX - Math.abs(body.x - box.x);
    const outZ = box.halfZ - Math.abs(body.z - box.z);
    if (outX < outZ) pushOut(body, Math.sign(body.x - box.x) || 1, 0, outX + radius);
    else pushOut(body, 0, Math.sign(body.z - box.z) || 1, outZ + radius);
  }
  for (const round of ROUNDS) {
    const dx = body.x - round.x;
    const dz = body.z - round.z;
    const gap = Math.hypot(dx, dz);
    const reach = round.radius + radius;
    if (gap >= reach) continue;
    if (gap === 0) pushOut(body, 1, 0, reach);
    else pushOut(body, dx / gap, dz / gap, reach - gap);
  }
  const maxX = ROOM_HALF_X - radius;
  const maxZ = ROOM_HALF_Z - radius;
  if (Math.abs(body.x) > maxX) {
    body.x = Math.sign(body.x) * maxX;
    if (body.vx * body.x > 0) body.vx = 0;
  }
  if (Math.abs(body.z) > maxZ) {
    body.z = Math.sign(body.z) * maxZ;
    if (body.vz * body.z > 0) body.vz = 0;
  }
}

/** Le pousse de `depth` vers (nx, nz), et retire la part de sa vitesse qui va contre. */
function pushOut(body: ArenaBody, nx: number, nz: number, depth: number): void {
  body.x += nx * depth;
  body.z += nz * depth;
  const into = body.vx * nx + body.vz * nz;
  if (into >= 0) return;
  body.vx -= nx * into;
  body.vz -= nz * into;
}

/** Le jour entre un point et le meuble ou le mur le plus proche (mètres, négatif dedans). */
export function clearanceAt(x: number, z: number): number {
  let clear = Math.min(ROOM_HALF_X - Math.abs(x), ROOM_HALF_Z - Math.abs(z));
  for (const box of BOXES) {
    const outX = Math.abs(x - box.x) - box.halfX;
    const outZ = Math.abs(z - box.z) - box.halfZ;
    const gap =
      outX > 0 || outZ > 0
        ? Math.hypot(Math.max(0, outX), Math.max(0, outZ))
        : Math.max(outX, outZ);
    clear = Math.min(clear, gap);
  }
  for (const round of ROUNDS) {
    clear = Math.min(clear, Math.hypot(x - round.x, z - round.z) - round.radius);
  }
  return clear;
}

// La grille des bots : des cases de NAV_CELL mètres, praticables si un corps y tient. Les
// distances de chemin d'une case à toutes les autres ne changent jamais (les meubles ne bougent
// pas) : chaque carte se calcule une fois, à la première demande, puis se garde.

const NAV_CELL = 0.5;
const NAV_COLUMNS = Math.round((ROOM_HALF_X * 2) / NAV_CELL);
const NAV_ROWS = Math.round((ROOM_HALF_Z * 2) / NAV_CELL);
/** Une case est praticable si son centre est à tant des meubles et des murs (le rayon d'un corps, plus un peu). */
const NAV_CLEARANCE = 0.55;
/** Une case injoignable. */
export const UNREACHABLE = 0x7fff;

let walkable: Uint8Array | null = null;
let openness: Float32Array | null = null;
const fields = new Map<number, Int16Array>();

function cellCenter(cell: number): { x: number; z: number } {
  const column = cell % NAV_COLUMNS;
  const row = Math.floor(cell / NAV_COLUMNS);
  return { x: -ROOM_HALF_X + (column + 0.5) * NAV_CELL, z: -ROOM_HALF_Z + (row + 0.5) * NAV_CELL };
}

function walkableCells(): Uint8Array {
  if (walkable) return walkable;
  walkable = new Uint8Array(NAV_COLUMNS * NAV_ROWS);
  for (let cell = 0; cell < walkable.length; cell++) {
    const { x, z } = cellCenter(cell);
    walkable[cell] = clearanceAt(x, z) >= NAV_CLEARANCE ? 1 : 0;
  }
  return walkable;
}

/** La case praticable la plus proche de ce point (on peut frôler un meuble entre deux cases). */
export function navCell(x: number, z: number): number {
  const cells = walkableCells();
  const column = Math.max(0, Math.min(NAV_COLUMNS - 1, Math.floor((x + ROOM_HALF_X) / NAV_CELL)));
  const row = Math.max(0, Math.min(NAV_ROWS - 1, Math.floor((z + ROOM_HALF_Z) / NAV_CELL)));
  const cell = row * NAV_COLUMNS + column;
  if (cells[cell]) return cell;
  let best = cell;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const c = column + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= NAV_COLUMNS || r >= NAV_ROWS) continue;
      const candidate = r * NAV_COLUMNS + c;
      if (!cells[candidate]) continue;
      const center = cellCenter(candidate);
      const gap = Math.hypot(center.x - x, center.z - z);
      if (gap < bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
  }
  return best;
}

export function isWalkable(x: number, z: number): boolean {
  return clearanceAt(x, z) >= NAV_CLEARANCE;
}

const NEIGHBOURS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Les distances de chemin (en cases, un pas en diagonale compte pour un) depuis `from` vers
 * toutes les cases ; UNREACHABLE pour celles qu'on ne peut pas joindre. On ne coupe pas un
 * coin de meuble en diagonale.
 */
export function pathField(from: number): Int16Array {
  const known = fields.get(from);
  if (known) return known;
  const cells = walkableCells();
  const field = new Int16Array(cells.length).fill(UNREACHABLE);
  const queue = new Int32Array(cells.length);
  let head = 0;
  let tail = 0;
  field[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const cell = queue[head++] ?? 0;
    const column = cell % NAV_COLUMNS;
    const row = Math.floor(cell / NAV_COLUMNS);
    const next = (field[cell] ?? 0) + 1;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = column + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= NAV_COLUMNS || r >= NAV_ROWS) continue;
      const neighbour = r * NAV_COLUMNS + c;
      if (!cells[neighbour] || (field[neighbour] ?? 0) <= next) continue;
      if (dc !== 0 && dr !== 0) {
        const isCornerCut = !cells[row * NAV_COLUMNS + c] || !cells[r * NAV_COLUMNS + column];
        if (isCornerCut) continue;
      }
      field[neighbour] = next;
      queue[tail++] = neighbour;
    }
  }
  fields.set(from, field);
  return field;
}

/** La distance de chemin entre deux points, en mètres (à peu près). */
export function pathDistance(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const steps = pathField(navCell(from.x, from.z))[navCell(to.x, to.z)] ?? UNREACHABLE;
  return steps === UNREACHABLE ? Number.POSITIVE_INFINITY : steps * NAV_CELL;
}

/**
 * Vers où aller pour se rapprocher de `to` par le plus court chemin : tout droit si rien ne
 * gêne, sinon vers la case voisine la plus proche de lui. Une direction de longueur 1, ou null
 * si l'on y est.
 */
export function pathToward(
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number } | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const gap = Math.hypot(dx, dz);
  if (gap < 0.05) return null;
  if (isClearLine(from, to)) return { x: dx / gap, z: dz / gap };
  const field = pathField(navCell(to.x, to.z));
  const here = navCell(from.x, from.z);
  const column = here % NAV_COLUMNS;
  const row = Math.floor(here / NAV_COLUMNS);
  let best = here;
  let bestSteps = field[here] ?? UNREACHABLE;
  for (const [dc, dr] of NEIGHBOURS) {
    const c = column + dc;
    const r = row + dr;
    if (c < 0 || r < 0 || c >= NAV_COLUMNS || r >= NAV_ROWS) continue;
    const neighbour = r * NAV_COLUMNS + c;
    const steps = field[neighbour] ?? UNREACHABLE;
    if (steps < bestSteps) {
      bestSteps = steps;
      best = neighbour;
    }
  }
  const target = best === here ? to : cellCenter(best);
  const tx = target.x - from.x;
  const tz = target.z - from.z;
  const length = Math.hypot(tx, tz);
  return length < 0.01 ? { x: dx / gap, z: dz / gap } : { x: tx / length, z: tz / length };
}

/** Rien entre deux points : un corps y passe tout droit. */
export function isClearLine(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const gap = Math.hypot(to.x - from.x, to.z - from.z);
  const samples = Math.ceil(gap / (NAV_CELL * 0.5));
  for (let k = 1; k < samples; k++) {
    const share = k / samples;
    const x = from.x + (to.x - from.x) * share;
    const z = from.z + (to.z - from.z) * share;
    if (clearanceAt(x, z) < NAV_CLEARANCE - 0.1) return false;
  }
  return true;
}

/**
 * L'espace autour d'un point (0 à 1) : 1 en plein milieu d'un passage large, 0 contre un meuble
 * ou au fond d'un coin. Pour que les bots qui fuient ne se jettent pas dans un cul-de-sac.
 */
export function opennessAt(x: number, z: number): number {
  if (!openness) {
    const cells = walkableCells();
    openness = new Float32Array(cells.length);
    for (let cell = 0; cell < cells.length; cell++) {
      if (!cells[cell]) continue;
      // Les cases praticables à moins de 2 m : beaucoup, c'est qu'on a de la place pour filer.
      const { x: cx, z: cz } = cellCenter(cell);
      let open = 0;
      let all = 0;
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          if (dr * dr + dc * dc > 16) continue;
          all++;
          if (isWalkable(cx + dc * NAV_CELL, cz + dr * NAV_CELL)) open++;
        }
      }
      openness[cell] = open / all;
    }
  }
  return openness[navCell(x, z)] ?? 0;
}
