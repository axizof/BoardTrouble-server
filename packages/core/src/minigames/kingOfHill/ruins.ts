import type { ArenaBody } from '../arena/body';

// Les ruines de la jungle du Roi de la colline (02-mini-jeux.md, fiche 4) : une cour de temple
// en relief, la même pour toutes les parties. Au milieu, une pyramide à trois gradins (un mètre
// chacun : on les saute) avec un escalier devant et derrière ; au fond, deux terrasses reliées
// par un pont de lianes (on passe dessous), chacune avec sa rampe ; devant à droite, le socle
// d'une statue (on y saute) ; devant à gauche, une placette entre deux murets ; des colonnes.
// Chaque pièce est une boîte, une rampe ou un disque, avec un dessus (où l'on marche) et un
// dessous (le pont : on passe sous lui). Les zones à tenir sont sur ces reliefs. Les bots s'y
// repèrent sur une grille de pas de 0,5 m, à plusieurs étages (sous et sur le pont). Plan
// (x, z) en mètres, hauteur y.

/** La cour : de -COURT_HALF_X à COURT_HALF_X en x, de -COURT_HALF_Z à COURT_HALF_Z en z. */
export const COURT_HALF_X = 12;
export const COURT_HALF_Z = 10;
/** On monte sans sauter une marche de tant (le long d'une rampe) ; plus haut, c'est un mur. */
export const STEP_UP = 0.35;
/** La hauteur d'un corps : un pont plus haut que ça au-dessus de ses pieds, il passe dessous. */
const BODY_HEIGHT = 1.3;

export type RuinKind =
  | 'tier'
  | 'stairs'
  | 'terrace'
  | 'ramp'
  | 'bridge'
  | 'pedestal'
  | 'wall'
  | 'pillar';

/**
 * Une pièce des ruines : une boîte (`halfX`, `halfZ`) ou un disque (`radius`), de `bottom` à
 * `top`. Une rampe monte le long de `slope.axis` jusqu'à `top`, du côté `slope.toward` (-1 :
 * vers les petites coordonnées) ; elle est à 0 de l'autre côté. Une colonne n'a pas de dessus
 * où marcher.
 */
export type RuinPiece = {
  kind: RuinKind;
  x: number;
  z: number;
  top: number;
  bottom: number;
} & (
  | { shape: 'box'; halfX: number; halfZ: number; slope?: { axis: 'x' | 'z'; toward: -1 | 1 } }
  | { shape: 'disc'; radius: number }
);

const box = (
  kind: RuinKind,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  top: number,
  bottom = 0,
): RuinPiece => ({ kind, shape: 'box', x, z, halfX, halfZ, top, bottom });

const ramp = (
  kind: RuinKind,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  top: number,
  axis: 'x' | 'z',
  toward: -1 | 1,
): RuinPiece => ({
  kind,
  shape: 'box',
  x,
  z,
  halfX,
  halfZ,
  top,
  bottom: 0,
  slope: { axis, toward },
});

const disc = (kind: RuinKind, x: number, z: number, radius: number, top: number): RuinPiece => ({
  kind,
  shape: 'disc',
  x,
  z,
  radius,
  top,
  bottom: 0,
});

export const RUINS: readonly RuinPiece[] = [
  // La pyramide : trois gradins d'un mètre, un escalier devant (vers la caméra) et derrière.
  box('tier', 0, -1, 3.6, 3, 1),
  box('tier', 0, -1, 2.4, 2, 2),
  box('tier', 0, -1, 1.3, 1.2, 3),
  ramp('stairs', 0, 2.4, 0.8, 2.2, 3, 'z', -1),
  ramp('stairs', 0, -4.4, 0.8, 2.2, 3, 'z', 1),
  // Les deux terrasses du fond, chacune avec sa rampe, et le pont de lianes entre elles.
  box('terrace', -8.5, -6.5, 2.5, 2, 1.6),
  ramp('ramp', -4.3, -5.4, 1.7, 0.6, 1.6, 'x', -1),
  box('terrace', 8.5, -6.5, 2.5, 2, 1.6),
  ramp('ramp', 8.5, -2.8, 0.7, 1.7, 1.6, 'z', -1),
  box('bridge', 0, -8.65, 6, 0.45, 1.6, 1.4),
  // Le socle de la statue (on y saute), et la placette entre ses deux murets (on y saute aussi).
  disc('pedestal', 8, 5, 1.6, 1),
  box('wall', -7.5, 2.4, 2.6, 0.3, 0.7),
  box('wall', -10.4, 5, 0.3, 2.9, 0.7),
  // Les colonnes, trop hautes pour qu'on y monte.
  disc('pillar', -4.8, 3.2, 0.45, 3.6),
  disc('pillar', 4.8, 3.2, 0.45, 3.6),
  disc('pillar', -10.6, -2, 0.45, 3.6),
  disc('pillar', 10.6, -2, 0.45, 3.6),
];

/** Une place où la zone peut se poser : son centre, la hauteur de son sol, son rayon. */
export type HillSpot = { name: string; x: number; z: number; y: number; radius: number };

export const HILL_SPOTS: readonly HillSpot[] = [
  { name: 'court', x: 0, z: 7, y: 0, radius: 1.8 },
  { name: 'plaza', x: -7.5, z: 5, y: 0, radius: 1.7 },
  { name: 'pyramid', x: 0, z: -1, y: 3, radius: 1.1 },
  { name: 'westTerrace', x: -8.5, z: -6.5, y: 1.6, radius: 1.6 },
  { name: 'eastTerrace', x: 8.5, z: -6.5, y: 1.6, radius: 1.6 },
  { name: 'bridge', x: 0, z: -8.65, y: 1.6, radius: 1.3 },
  { name: 'statue', x: 8, z: 5, y: 1, radius: 1.4 },
  { name: 'ledge', x: 3, z: -1, y: 1, radius: 1.2 },
];

/** Les places de départ, dans l'ordre des joueurs, toutes au sol devant et sur les côtés. */
export const HILL_STARTS: readonly { x: number; z: number }[] = [
  { x: -3, z: 8.5 },
  { x: 3, z: 8.5 },
  { x: -9, z: 8.5 },
  { x: 9, z: 8.5 },
  { x: -6.5, z: 0 },
  { x: 6.5, z: 0 },
];

/** Le point d'une pièce le plus proche de (x, z) sur le plan (lui-même s'il est dessus). */
function nearestOn(piece: RuinPiece, x: number, z: number): { x: number; z: number } {
  if (piece.shape === 'box') {
    return {
      x: Math.max(piece.x - piece.halfX, Math.min(piece.x + piece.halfX, x)),
      z: Math.max(piece.z - piece.halfZ, Math.min(piece.z + piece.halfZ, z)),
    };
  }
  const dx = x - piece.x;
  const dz = z - piece.z;
  const gap = Math.hypot(dx, dz);
  if (gap <= piece.radius) return { x, z };
  return { x: piece.x + (dx / gap) * piece.radius, z: piece.z + (dz / gap) * piece.radius };
}

function isOn(piece: RuinPiece, x: number, z: number): boolean {
  if (piece.shape === 'box') {
    return Math.abs(x - piece.x) <= piece.halfX && Math.abs(z - piece.z) <= piece.halfZ;
  }
  return Math.hypot(x - piece.x, z - piece.z) <= piece.radius;
}

/** La hauteur du dessus d'une pièce en (x, z) (une rampe monte d'un bord à l'autre). */
export function topAt(piece: RuinPiece, x: number, z: number): number {
  if (piece.shape !== 'box' || !piece.slope) return piece.top;
  const { axis, toward } = piece.slope;
  const along = axis === 'x' ? x - piece.x : z - piece.z;
  const half = axis === 'x' ? piece.halfX : piece.halfZ;
  const share = Math.max(0, Math.min(1, (along * toward + half) / (2 * half)));
  return piece.top * share;
}

/**
 * Le sol sous (x, z) pour des pieds à la hauteur `y` : le plus haut dessus qu'on atteint sans
 * sauter (au plus STEP_UP au-dessus), ou la cour (0).
 */
export function ruinGround(x: number, z: number, y: number): number {
  let ground = 0;
  for (const piece of RUINS) {
    if (piece.kind === 'pillar' || !isOn(piece, x, z)) continue;
    const top = topAt(piece, x, z);
    if (top <= y + STEP_UP + 1e-6 && top > ground) ground = top;
  }
  return ground;
}

/** Une pièce fait mur pour des pieds à la hauteur `y`, à ce point de son bord. */
function blocks(piece: RuinPiece, at: { x: number; z: number }, y: number): boolean {
  return piece.bottom < y + BODY_HEIGHT && topAt(piece, at.x, at.z) > y + STEP_UP + 1e-6;
}

/**
 * Sort `body` (un disque de rayon `radius`) des pièces qui lui font mur et des bords de la cour,
 * et retire de sa vitesse ce qui l'y enfonce (il glisse le long).
 */
export function keepInRuins(body: ArenaBody, radius: number): void {
  for (const piece of RUINS) {
    const near = nearestOn(piece, body.x, body.z);
    if (!blocks(piece, near, body.y)) continue;
    let dx = body.x - near.x;
    let dz = body.z - near.z;
    let gap = Math.hypot(dx, dz);
    if (gap >= radius) continue;
    if (gap === 0) {
      // Le centre est entré dans la pièce : on ressort par le bord le plus proche.
      const out = exitOf(piece, body.x, body.z);
      dx = out.x;
      dz = out.z;
      gap = 0;
    } else {
      dx /= gap;
      dz /= gap;
    }
    body.x += dx * (radius - gap);
    body.z += dz * (radius - gap);
    const into = body.vx * dx + body.vz * dz;
    if (into < 0) {
      body.vx -= into * dx;
      body.vz -= into * dz;
    }
  }
  const limitX = COURT_HALF_X - radius;
  const limitZ = COURT_HALF_Z - radius;
  if (Math.abs(body.x) > limitX) {
    body.x = Math.sign(body.x) * limitX;
    body.vx = 0;
  }
  if (Math.abs(body.z) > limitZ) {
    body.z = Math.sign(body.z) * limitZ;
    body.vz = 0;
  }
}

/** La direction pour sortir d'une pièce par son bord le plus proche (le centre est dedans). */
function exitOf(piece: RuinPiece, x: number, z: number): { x: number; z: number } {
  if (piece.shape === 'disc') {
    const gap = Math.hypot(x - piece.x, z - piece.z);
    return gap > 0 ? { x: (x - piece.x) / gap, z: (z - piece.z) / gap } : { x: 1, z: 0 };
  }
  const toX = piece.halfX - Math.abs(x - piece.x);
  const toZ = piece.halfZ - Math.abs(z - piece.z);
  return toX < toZ
    ? { x: Math.sign(x - piece.x) || 1, z: 0 }
    : { x: 0, z: Math.sign(z - piece.z) || 1 };
}

/** Le corps est dans la zone de cette place : au-dessus de son disque, à peu près à sa hauteur. */
export function isInSpot(spot: HillSpot, x: number, y: number, z: number): boolean {
  return Math.hypot(x - spot.x, z - spot.z) <= spot.radius && y > spot.y - 0.3 && y < spot.y + 1.4;
}

// La grille des bots : une case tous les 0,5 m, et dans chaque case un nœud par sol où l'on
// tient debout (la cour, un gradin, une rampe, le pont...). D'un nœud à une case voisine, on y
// va en marchant (une marche d'au plus WALK_UP) ou en sautant (au plus JUMP_UP) ; on en descend
// toujours. Les distances à chaque place se calculent une fois.

const CELL = 0.5;
const COLUMNS = Math.round((COURT_HALF_X * 2) / CELL);
const ROWS = Math.round((COURT_HALF_Z * 2) / CELL);
/** La marche entre deux cases (une rampe y monte d'au plus 0,34) ; le saut monte de 1,2 m. */
const WALK_UP = 0.5;
const JUMP_UP = 1.05;
/** Une case trop près d'un mur (moins que ça du centre) n'a pas de nœud : on s'y cognerait. */
const CLEARANCE = 0.3;
/** Un saut coûte autant que tant de mètres de marche (on préfère l'escalier, s'il est près). */
const JUMP_COST = 1.5;

export type HillNode = { x: number; z: number; y: number };
type HillEdge = { to: number; cost: number; isJump: boolean };

type Grid = { nodes: HillNode[]; byCell: number[][]; edges: HillEdge[][] };

let grid: Grid | null = null;
const distances = new Map<number, Float64Array>();

function cellCenter(column: number, row: number): { x: number; z: number } {
  return { x: -COURT_HALF_X + (column + 0.5) * CELL, z: -COURT_HALF_Z + (row + 0.5) * CELL };
}

/** Les sols où l'on tient debout au centre d'une case, sans mur trop près. */
function floorsAt(x: number, z: number): number[] {
  const tops = new Set<number>([0]);
  for (const piece of RUINS) {
    if (piece.kind !== 'pillar' && isOn(piece, x, z)) tops.add(topAt(piece, x, z));
  }
  return [...tops].filter((y) =>
    RUINS.every((piece) => {
      const near = nearestOn(piece, x, z);
      return Math.hypot(near.x - x, near.z - z) >= CLEARANCE || !blocks(piece, near, y);
    }),
  );
}

/** Où l'on arrive dans une case voisine depuis la hauteur `y`, en montant d'au plus `up`. */
function landing(floors: number[], y: number, up: number): number | null {
  let best: number | null = null;
  for (const floor of floors) {
    if (floor <= y + up && (best === null || floor > best)) best = floor;
  }
  return best;
}

function buildGrid(): Grid {
  const nodes: HillNode[] = [];
  const byCell: number[][] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const { x, z } = cellCenter(column, row);
      byCell.push(
        floorsAt(x, z).map((y) => {
          nodes.push({ x, z, y });
          return nodes.length - 1;
        }),
      );
    }
  }
  const edges: HillEdge[][] = nodes.map(() => []);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      for (const from of byCell[row * COLUMNS + column] ?? []) {
        const start = nodes[from];
        if (!start) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const r = row + dr;
            const c = column + dc;
            if ((dr === 0 && dc === 0) || r < 0 || r >= ROWS || c < 0 || c >= COLUMNS) continue;
            const ids = byCell[r * COLUMNS + c] ?? [];
            const floors = ids.map((id) => nodes[id]?.y ?? 0);
            const step = Math.hypot(dr, dc) * CELL;
            // En marchant, on arrive sur le plus haut sol à portée de pas ; en sautant, plus haut.
            const walked = landing(floors, start.y, WALK_UP);
            const jumped = landing(floors, start.y, JUMP_UP);
            if (walked !== null) {
              const to = ids[floors.indexOf(walked)];
              if (to !== undefined) edges[from]?.push({ to, cost: step, isJump: false });
            }
            if (jumped !== null && jumped !== walked) {
              const to = ids[floors.indexOf(jumped)];
              if (to !== undefined) edges[from]?.push({ to, cost: step + JUMP_COST, isJump: true });
            }
          }
        }
      }
    }
  }
  return { nodes, byCell, edges };
}

function theGrid(): Grid {
  grid ??= buildGrid();
  return grid;
}

/** Le nœud où se tient un corps (sa case, le plus haut sol sous ses pieds), ou null. */
export function nodeAt(x: number, z: number, y: number): number | null {
  const { nodes, byCell } = theGrid();
  const column = Math.floor((x + COURT_HALF_X) / CELL);
  const row = Math.floor((z + COURT_HALF_Z) / CELL);
  let best: number | null = null;
  // Sa case, puis ses voisines (près d'un mur, sa case n'a pas toujours de nœud).
  for (const [dr, dc] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const) {
    const r = row + dr;
    const c = column + dc;
    if (r < 0 || r >= ROWS || c < 0 || c >= COLUMNS) continue;
    for (const id of byCell[r * COLUMNS + c] ?? []) {
      const node = nodes[id];
      if (!node || node.y > y + 0.4) continue;
      if (best === null || node.y > (nodes[best]?.y ?? 0)) best = id;
    }
    if (best !== null) return best;
  }
  return best;
}

export function hillNode(id: number): HillNode | undefined {
  return theGrid().nodes[id];
}

/** Les distances de chaque nœud à la zone de cette place (en mètres de marche, sauts comptés). */
function distancesTo(spot: number): Float64Array {
  const known = distances.get(spot);
  if (known) return known;
  const { nodes, edges } = theGrid();
  const place = HILL_SPOTS[spot];
  const dist = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY);
  const reverse: { from: number; cost: number }[][] = nodes.map(() => []);
  edges.forEach((list, from) => {
    for (const edge of list) reverse[edge.to]?.push({ from, cost: edge.cost });
  });
  const queue: number[] = [];
  nodes.forEach((node, id) => {
    if (!place) return;
    const isInside =
      Math.abs(node.y - place.y) < 0.3 &&
      Math.hypot(node.x - place.x, node.z - place.z) <= place.radius - 0.3;
    if (isInside) {
      dist[id] = 0;
      queue.push(id);
    }
  });
  // Dijkstra, avec une file triée à la main (quelques milliers de nœuds, une fois par place).
  const heap = new MinHeap();
  for (const id of queue) heap.push(id, 0);
  for (let item = heap.pop(); item !== null; item = heap.pop()) {
    const [id, cost] = item;
    if (cost > (dist[id] ?? 0)) continue;
    for (const { from, cost: step } of reverse[id] ?? []) {
      const through = cost + step;
      if (through < (dist[from] ?? Number.POSITIVE_INFINITY)) {
        dist[from] = through;
        heap.push(from, through);
      }
    }
  }
  distances.set(spot, dist);
  return dist;
}

/** La distance (mètres de marche, sauts comptés) d'un nœud à la zone de cette place. */
export function distanceToSpot(node: number, spot: number): number {
  return distancesTo(spot)[node] ?? Number.POSITIVE_INFINITY;
}

/**
 * Le chemin vers la zone de cette place depuis un nœud : le point à viser (quelques cases plus
 * loin quand le chemin va tout droit), et s'il faut sauter pour la prochaine case.
 */
export function wayToSpot(
  node: number,
  spot: number,
): { x: number; z: number; isJump: boolean } | null {
  const { nodes, edges } = theGrid();
  const dist = distancesTo(spot);
  let current = node;
  let isJump = false;
  let direction = '';
  for (let hop = 0; hop < 3; hop++) {
    if ((dist[current] ?? 0) === 0) break;
    let best: HillEdge | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const edge of edges[current] ?? []) {
      const cost = edge.cost + (dist[edge.to] ?? Number.POSITIVE_INFINITY);
      if (cost < bestCost) {
        bestCost = cost;
        best = edge;
      }
    }
    if (!best) break;
    const from = nodes[current];
    const to = nodes[best.to];
    if (!from || !to) break;
    const heading = `${Math.sign(to.x - from.x)},${Math.sign(to.z - from.z)}`;
    // On vise plus loin tant que le chemin va tout droit (sinon on couperait un coin de mur).
    if (hop === 0) {
      isJump = best.isJump;
      direction = heading;
    } else if (heading !== direction) break;
    current = best.to;
    // On ne vise pas au-delà d'un saut, ni d'une marche après lui.
    if (best.isJump) break;
  }
  if (current === node) return null;
  const target = nodes[current];
  return target ? { x: target.x, z: target.z, isJump } : null;
}

/** Une file de priorité minimale : (nœud, coût). */
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
      if ((items[left]?.[1] ?? Number.POSITIVE_INFINITY) < (items[smallest]?.[1] ?? 0))
        smallest = left;
      if ((items[right]?.[1] ?? Number.POSITIVE_INFINITY) < (items[smallest]?.[1] ?? 0))
        smallest = right;
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
