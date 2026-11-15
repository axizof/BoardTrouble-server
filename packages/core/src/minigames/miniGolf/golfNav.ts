import type { GolfHole, GolfWall } from './holes';

// La carte des bots du Mini-golf : pour chaque trou, la distance à pied (en mètres) de chaque
// point du green jusqu'au trou, en contournant les bordures et les plots (une grille de NAV_CELL
// mètres, parcourue depuis le trou). Les tuyaux relient leur entrée à leur sortie ; les passages
// que la balle franchit en l'air ou sur un pont (`nav` du trou) comptent comme du sol. Un bot
// juge un coup à la distance qui reste depuis là où la balle s'arrête : pas à vol d'oiseau (une
// balle arrêtée contre un mur, de l'autre côté du trou, n'est pas "presque arrivée").

const NAV_CELL = 0.25;
/** Au-delà de la carte (ou dans le vide) : une distance qu'aucun coup ne veut. */
export const FAR = 1000;

type NavMap = { minX: number; minZ: number; columns: number; rows: number; distance: Float64Array };

const maps = new Map<string, NavMap>();

/**
 * Le segment traverse le mur : ses deux bouts de part et d'autre de la ligne du mur, et le mur
 * coupé ou touché par un bout (un passage pile par le bout d'un mur, là où il rejoint une
 * bordure, compte : sinon la carte fuit par ce coin).
 */
function crosses(ax: number, az: number, bx: number, bz: number, wall: GolfWall): boolean {
  const d1 = (wall.bx - wall.ax) * (az - wall.az) - (wall.bz - wall.az) * (ax - wall.ax);
  const d2 = (wall.bx - wall.ax) * (bz - wall.az) - (wall.bz - wall.az) * (bx - wall.ax);
  const d3 = (bx - ax) * (wall.az - az) - (bz - az) * (wall.ax - ax);
  const d4 = (bx - ax) * (wall.bz - az) - (bz - az) * (wall.bx - ax);
  return d1 * d2 < 0 && d3 * d4 <= 0;
}

/** Un point où la balle peut rouler (pour la carte) : un sol, ou un passage du trou. */
function isFloor(hole: GolfHole, x: number, z: number): boolean {
  const surfaces = [...hole.surfaces, ...(hole.nav ?? [])];
  for (const surface of surfaces) {
    if (surface.kind === 'rect') {
      if (Math.abs(x - surface.x) <= surface.hx && Math.abs(z - surface.z) <= surface.hz)
        return true;
    } else if (Math.hypot(x - surface.x, z - surface.z) <= surface.r) {
      return true;
    }
  }
  for (const feature of hole.features) {
    if (
      feature.kind === 'bridge' &&
      Math.abs(x - feature.x) <= feature.hx + feature.travel &&
      Math.abs(z - feature.z) <= feature.hz
    ) {
      return true;
    }
  }
  return false;
}

function isBlocked(hole: GolfHole, x: number, z: number): boolean {
  return hole.features.some(
    (feature) =>
      feature.kind === 'bumper' && Math.hypot(x - feature.x, z - feature.z) < feature.r + 0.1,
  );
}

function buildMap(hole: GolfHole): NavMap {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const surface of [...hole.surfaces, ...(hole.nav ?? [])]) {
    const hx = surface.kind === 'rect' ? surface.hx : surface.r;
    const hz = surface.kind === 'rect' ? surface.hz : surface.r;
    minX = Math.min(minX, surface.x - hx);
    maxX = Math.max(maxX, surface.x + hx);
    minZ = Math.min(minZ, surface.z - hz);
    maxZ = Math.max(maxZ, surface.z + hz);
  }
  const columns = Math.ceil((maxX - minX) / NAV_CELL) + 1;
  const rows = Math.ceil((maxZ - minZ) / NAV_CELL) + 1;
  const distance = new Float64Array(columns * rows).fill(FAR);
  const center = (cell: number) => ({
    x: minX + (cell % columns) * NAV_CELL,
    z: minZ + Math.floor(cell / columns) * NAV_CELL,
  });
  const open = (cell: number) => {
    const { x, z } = center(cell);
    return isFloor(hole, x, z) && !isBlocked(hole, x, z);
  };
  const cellOf = (x: number, z: number) =>
    Math.round((z - minZ) / NAV_CELL) * columns + Math.round((x - minX) / NAV_CELL);
  // Les tuyaux : de la sortie, on remonte à l'entrée sans rien parcourir.
  const pipes = hole.features.flatMap((feature) =>
    feature.kind === 'pipe'
      ? [{ from: cellOf(feature.bx, feature.bz), to: cellOf(feature.ax, feature.az) }]
      : [],
  );
  // Dijkstra depuis le trou (un tas binaire : quelques milliers de cases, une fois par trou).
  const heap = new MinHeap();
  const push = (cell: number, cost: number) => {
    if (cost >= (distance[cell] ?? FAR)) return;
    distance[cell] = cost;
    heap.push(cell, cost);
  };
  push(cellOf(hole.cup.x, hole.cup.z), 0);
  for (let item = heap.pop(); item !== null; item = heap.pop()) {
    const [cell, cost] = item;
    if (cost > (distance[cell] ?? FAR)) continue;
    const from = center(cell);
    const column = cell % columns;
    const row = Math.floor(cell / columns);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const c = column + dc;
        const r = row + dr;
        if (c < 0 || c >= columns || r < 0 || r >= rows) continue;
        const next = r * columns + c;
        if (!open(next)) continue;
        const to = center(next);
        if (hole.walls.some((wall) => crosses(from.x, from.z, to.x, to.z, wall))) continue;
        push(next, cost + Math.hypot(dr, dc) * NAV_CELL);
      }
    }
    for (const pipe of pipes) if (pipe.from === cell) push(pipe.to, cost);
  }
  return { minX, minZ, columns, rows, distance };
}

/** Une file de priorité minimale : (case, coût). */
class MinHeap {
  #items: [number, number][] = [];

  push(id: number, cost: number): void {
    const items = this.#items;
    items.push([id, cost]);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const up = items[parent];
      const here = items[index];
      if (!up || !here || up[1] <= here[1]) break;
      items[parent] = here;
      items[index] = up;
      index = parent;
    }
  }

  pop(): [number, number] | null {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (!top || !last) return null;
    if (items.length === 0) return top;
    items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if ((items[left]?.[1] ?? FAR) < (items[smallest]?.[1] ?? 0)) smallest = left;
      if ((items[right]?.[1] ?? FAR) < (items[smallest]?.[1] ?? 0)) smallest = right;
      if (smallest === index) break;
      const a = items[index];
      const b = items[smallest];
      if (!a || !b) break;
      items[index] = b;
      items[smallest] = a;
      index = smallest;
    }
    return top;
  }
}

/**
 * La distance à pied (m) de ce point jusqu'au trou, en contournant les murs ; FAR si inconnue.
 * Parmi les cases autour du point, celles qu'on rejoint sans traverser de mur (une balle arrêtée
 * contre un mur est souvent plus près d'une case de l'autre côté).
 */
export function navDistance(hole: GolfHole, x: number, z: number): number {
  let map = maps.get(hole.id);
  if (!map) {
    map = buildMap(hole);
    maps.set(hole.id, map);
  }
  const column = Math.floor((x - map.minX) / NAV_CELL);
  const row = Math.floor((z - map.minZ) / NAV_CELL);
  let best = FAR;
  for (let dr = -1; dr <= 2; dr++) {
    for (let dc = -1; dc <= 2; dc++) {
      const c = column + dc;
      const r = row + dr;
      if (c < 0 || c >= map.columns || r < 0 || r >= map.rows) continue;
      const value = map.distance[r * map.columns + c] ?? FAR;
      if (value >= FAR) continue;
      const cx = map.minX + c * NAV_CELL;
      const cz = map.minZ + r * NAV_CELL;
      if (hole.walls.some((wall) => crosses(x, z, cx, cz, wall))) continue;
      best = Math.min(best, value + Math.hypot(cx - x, cz - z));
    }
  }
  return best;
}
