// Les trous du Mini-golf (02-mini-jeux.md, fiche 20), sur les îles flottantes du Mont Trouble :
// une dizaine de trous courts, chacun avec son idée (un moulin, un saut, un pont qui bouge, des
// bumpers, une butte, des tapis roulants, une barre qui tourne, des tuyaux...). Une partie en tire
// trois. Chaque trou est dans son repère (x, z en mètres, le départ en bas, vers +z) : des sols
// (rectangles et disques) où roule la balle, le vide autour, des bordures (des segments), et ses
// obstacles. Le client dessine tout depuis ces données.

/** Un sol : un rectangle (`hx`, `hz` : ses demi-côtés) ou un disque. */
export type GolfSurface =
  | { kind: 'rect'; x: number; z: number; hx: number; hz: number }
  | { kind: 'disc'; x: number; z: number; r: number };

/** Une bordure : un segment où la balle rebondit. */
export type GolfWall = { ax: number; az: number; bx: number; bz: number };

/** Ce qui rend chaque trou différent. */
export type GolfFeature =
  /** Les pales d'un moulin (BLADES, de `length`), qui tournent à `speed` (rad/s). */
  | { kind: 'windmill'; x: number; z: number; length: number; speed: number }
  /** Une barre qui tourne sur son milieu. */
  | { kind: 'spinner'; x: number; z: number; length: number; speed: number }
  /** Un plot rond qui renvoie la balle plus fort. */
  | { kind: 'bumper'; x: number; z: number; r: number }
  /** Une zone qui pousse la balle (une pente, un tapis roulant) : son accélération (m/s²). */
  | { kind: 'slope'; x: number; z: number; hx: number; hz: number; ax: number; az: number }
  /** Une butte : elle repousse la balle loin de son centre, d'autant plus près du bord. */
  | { kind: 'mound'; x: number; z: number; r: number; push: number }
  /** Un tremplin : lancée assez vite (`speed`), la balle s'envole `flight` secondes. */
  | { kind: 'ramp'; x: number; z: number; hx: number; hz: number; speed: number; flight: number }
  /** Un pont qui va et vient en x (de `travel` mètres, en `period` secondes) au-dessus du vide. */
  | { kind: 'bridge'; x: number; z: number; hx: number; hz: number; travel: number; period: number }
  /** Un tuyau : la balle qui entre en (ax, az) ressort en (bx, bz), vers (dx, dz). */
  | { kind: 'pipe'; ax: number; az: number; bx: number; bz: number; dx: number; dz: number };

/**
 * Un point du chemin des bots vers le trou (holes.ts) : ils jugent un coup à ce qui reste de
 * chemin depuis là où la balle s'arrête (pas à vol d'oiseau : sur le serpent, le trou est derrière
 * un mur). `teleport` : de ce point au suivant, la balle passe par un tuyau (rien à parcourir).
 */
export type GolfWaypoint = { x: number; z: number; teleport?: boolean };

export type GolfHole = {
  id: string;
  name: string;
  /** Le chemin des bots jusqu'au trou (le trou à la fin) ; sans, tout droit vers le trou. */
  route?: GolfWaypoint[];
  /** Le départ (le milieu du tee) et le trou. */
  tee: { x: number; z: number };
  cup: { x: number; z: number };
  surfaces: GolfSurface[];
  walls: GolfWall[];
  features: GolfFeature[];
};

const wall = (ax: number, az: number, bx: number, bz: number): GolfWall => ({ ax, az, bx, bz });

/**
 * Les bordures d'un rectangle, sauf ses côtés ouverts (`open` : n pour -z, s pour +z, w pour
 * -x, e pour +x), et sauf les passages (`gaps` : [côté, du, au], en coordonnées le long du côté).
 */
function rails(
  x: number,
  z: number,
  hx: number,
  hz: number,
  open: string = '',
  gaps: [string, number, number][] = [],
): GolfWall[] {
  const sides: [string, number, number, number, number][] = [
    ['n', x - hx, z - hz, x + hx, z - hz],
    ['s', x - hx, z + hz, x + hx, z + hz],
    ['w', x - hx, z - hz, x - hx, z + hz],
    ['e', x + hx, z - hz, x + hx, z + hz],
  ];
  const out: GolfWall[] = [];
  for (const [side, ax, az, bx, bz] of sides) {
    if (open.includes(side)) continue;
    const isHorizontal = side === 'n' || side === 's';
    const from = isHorizontal ? ax : az;
    const to = isHorizontal ? bx : bz;
    // Le côté, coupé de ses passages.
    const cuts = gaps.filter(([gapSide]) => gapSide === side).sort((a, b) => a[1] - b[1]);
    let start = from;
    for (const [, gapFrom, gapTo] of cuts) {
      if (gapFrom > start)
        out.push(isHorizontal ? wall(start, az, gapFrom, bz) : wall(ax, start, bx, gapFrom));
      start = Math.max(start, gapTo);
    }
    if (start < to) out.push(isHorizontal ? wall(start, az, to, bz) : wall(ax, start, bx, to));
  }
  return out;
}

/** Les bordures d'un disque (en polygone), sauf un arc ouvert (de `openFrom` à `openTo` radians). */
function ring(
  x: number,
  z: number,
  r: number,
  openFrom = 0,
  openTo = 0,
  segments = 24,
): GolfWall[] {
  const out: GolfWall[] = [];
  for (let index = 0; index < segments; index++) {
    const a = (index / segments) * Math.PI * 2;
    const b = ((index + 1) / segments) * Math.PI * 2;
    const middle = (a + b) / 2;
    if (openTo > openFrom && middle > openFrom && middle < openTo) continue;
    out.push(
      wall(x + Math.sin(a) * r, z + Math.cos(a) * r, x + Math.sin(b) * r, z + Math.cos(b) * r),
    );
  }
  return out;
}

export const GOLF_HOLES: readonly GolfHole[] = [
  {
    id: 'windmill',
    name: 'Le moulin',
    tee: { x: 0, z: 6.5 },
    cup: { x: 0, z: -6.5 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 1.6, hz: 8 }],
    walls: rails(0, 0, 1.6, 8),
    features: [{ kind: 'windmill', x: 0, z: 0, length: 1.55, speed: 1.4 }],
  },
  {
    id: 'dogleg',
    name: 'Le coude',
    tee: { x: 0, z: 7 },
    cup: { x: 8, z: -3.5 },
    route: [
      { x: 0, z: -3.5 },
      { x: 8, z: -3.5 },
    ],
    surfaces: [
      { kind: 'rect', x: 0, z: 3, hx: 1.5, hz: 5 },
      { kind: 'rect', x: 4, z: -3.5, hx: 5.5, hz: 1.5 },
    ],
    walls: [...rails(0, 3, 1.5, 5, 'n'), ...rails(4, -3.5, 5.5, 1.5, '', [['s', -1.5, 1.5]])],
    features: [{ kind: 'bumper', x: 0, z: -3.5, r: 0.45 }],
  },
  {
    id: 'bumpers',
    name: 'Le flipper',
    tee: { x: 0, z: 5 },
    cup: { x: 0, z: -3 },
    surfaces: [{ kind: 'disc', x: 0, z: 0, r: 6.2 }],
    walls: ring(0, 0, 6.2),
    features: [
      { kind: 'bumper', x: 0, z: 0, r: 0.6 },
      { kind: 'bumper', x: -2.2, z: -2, r: 0.5 },
      { kind: 'bumper', x: 2.2, z: -2, r: 0.5 },
      { kind: 'bumper', x: -1.2, z: -4.6, r: 0.4 },
      { kind: 'bumper', x: 1.2, z: -4.6, r: 0.4 },
    ],
  },
  {
    id: 'jump',
    name: 'Le grand saut',
    tee: { x: 0, z: 7 },
    cup: { x: 0, z: -6.5 },
    surfaces: [
      { kind: 'rect', x: 0, z: 4, hx: 1.5, hz: 4 },
      { kind: 'rect', x: 0, z: -5.75, hx: 2.5, hz: 3 },
    ],
    walls: [...rails(0, 4, 1.5, 4, 'n'), ...rails(0, -5.75, 2.5, 3, 's')],
    features: [{ kind: 'ramp', x: 0, z: 0.7, hx: 1.5, hz: 0.7, speed: 4, flight: 0.85 }],
  },
  {
    id: 'bridge',
    name: 'Le pont baladeur',
    tee: { x: 0, z: 7.5 },
    cup: { x: 0, z: -6.5 },
    surfaces: [
      { kind: 'rect', x: 0, z: 6, hx: 1.5, hz: 2.5 },
      { kind: 'rect', x: 0, z: -6, hx: 2, hz: 2.5 },
    ],
    walls: [...rails(0, 6, 1.5, 2.5, 'n'), ...rails(0, -6, 2, 2.5, 's')],
    features: [{ kind: 'bridge', x: 0, z: 0, hx: 1.5, hz: 3.5, travel: 1.4, period: 5 }],
  },
  {
    id: 'mound',
    name: 'Le volcan',
    tee: { x: 0, z: 4.5 },
    cup: { x: 0, z: -1 },
    surfaces: [{ kind: 'disc', x: 0, z: 0, r: 5.5 }],
    walls: ring(0, 0, 5.5),
    features: [{ kind: 'mound', x: 0, z: -1, r: 2.2, push: 3.2 }],
  },
  {
    id: 'conveyor',
    name: 'Les tapis roulants',
    tee: { x: 0, z: 7 },
    cup: { x: 0, z: -7 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 2.6, hz: 8.2 }],
    walls: rails(0, 0, 2.6, 8.2),
    features: [
      { kind: 'slope', x: 0, z: 3, hx: 2.6, hz: 0.9, ax: 3.2, az: 0 },
      { kind: 'slope', x: 0, z: -0.5, hx: 2.6, hz: 0.9, ax: -3.2, az: 0 },
      { kind: 'slope', x: 0, z: -4, hx: 2.6, hz: 0.9, ax: 3.2, az: 0 },
    ],
  },
  {
    id: 'spinner',
    name: 'La barre folle',
    tee: { x: 0, z: 6 },
    cup: { x: 0, z: -5 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 4, hz: 7 }],
    walls: rails(0, 0, 4, 7),
    features: [
      { kind: 'spinner', x: 0, z: 0.5, length: 3.4, speed: 1.3 },
      { kind: 'bumper', x: -2.6, z: -3.5, r: 0.45 },
      { kind: 'bumper', x: 2.6, z: -3.5, r: 0.45 },
    ],
  },
  {
    id: 'pipes',
    name: 'Les tuyaux',
    tee: { x: 0, z: 6 },
    cup: { x: 7, z: -5 },
    route: [
      { x: -1, z: -1.5, teleport: true },
      { x: 7, z: -0.8 },
      { x: 7, z: -5 },
    ],
    surfaces: [
      { kind: 'rect', x: 0, z: 2.5, hx: 2, hz: 5 },
      { kind: 'rect', x: 7, z: -3.5, hx: 2, hz: 3.5 },
    ],
    walls: [...rails(0, 2.5, 2, 5), ...rails(7, -3.5, 2, 3.5)],
    features: [
      { kind: 'pipe', ax: -1, az: -1.5, bx: 7, bz: -0.8, dx: 0, dz: -1 },
      { kind: 'pipe', ax: 1.2, az: -1.5, bx: 5.6, bz: -6.2, dx: 1, dz: 0 },
      { kind: 'bumper', x: 0.1, z: -1.2, r: 0.35 },
    ],
  },
  {
    id: 'snake',
    name: 'Le serpent',
    tee: { x: -3, z: 7 },
    cup: { x: 3, z: -6 },
    route: [
      { x: -3, z: 0.4 },
      { x: 3, z: 0.4 },
      { x: 3, z: -6 },
    ],
    surfaces: [
      { kind: 'rect', x: -3, z: 4.5, hx: 1.2, hz: 3.5 },
      { kind: 'rect', x: 0, z: 0.4, hx: 4.2, hz: 1.2 },
      { kind: 'rect', x: 3, z: -3.6, hx: 1.2, hz: 3.5 },
    ],
    walls: [
      ...rails(-3, 4.5, 1.2, 3.5, 'n'),
      ...rails(0, 0.4, 4.2, 1.2, '', [
        ['s', -4.2, -1.8],
        ['n', 1.8, 4.2],
      ]),
      ...rails(3, -3.6, 1.2, 3.5, 's'),
    ],
    features: [
      { kind: 'slope', x: 0, z: 0.4, hx: 1.6, hz: 1.2, ax: 0, az: -2.2 },
      { kind: 'bumper', x: 0, z: 0.4, r: 0.35 },
    ],
  },
];
