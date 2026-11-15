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

export type GolfHole = {
  id: string;
  name: string;
  /**
   * Pour la carte des bots (golfNav.ts) : des passages que la balle franchit sans sol (le saut
   * du tremplin), comptés comme du sol.
   */
  nav?: GolfSurface[];
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

/** Les bordures d'un disque (en polygone), sauf ses passages (`gaps` : des arcs, en radians). */
function ringGaps(
  x: number,
  z: number,
  r: number,
  gaps: [number, number][],
  segments = 28,
): GolfWall[] {
  const out: GolfWall[] = [];
  for (let index = 0; index < segments; index++) {
    const a = (index / segments) * Math.PI * 2;
    const b = ((index + 1) / segments) * Math.PI * 2;
    const middle = (a + b) / 2;
    if (gaps.some(([from, to]) => middle > from && middle < to)) continue;
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
    tee: { x: 0, z: 7.8 },
    cup: { x: 0, z: -7.4 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 2.2, hz: 9 }],
    walls: [
      ...rails(0, 0, 2.2, 9),
      // La chicane avant le moulin : passer à droite, puis à gauche.
      wall(-2.2, 5.2, 0.7, 3.8),
      wall(2.2, 2.6, -0.7, 1.2),
      // La niche du trou, derrière le moulin.
      wall(-1.1, -6, -1.1, -9),
      wall(1.1, -6, 1.1, -9),
    ],
    features: [{ kind: 'windmill', x: 0, z: -2.6, length: 1.95, speed: 1.3 }],
  },
  {
    id: 'dogleg',
    name: 'Le coude',
    tee: { x: 0, z: 7.8 },
    cup: { x: 9.9, z: -4.25 },
    surfaces: [
      { kind: 'rect', x: 0, z: 3, hx: 1.8, hz: 5.5 },
      { kind: 'rect', x: 4.6, z: -4.25, hx: 6.4, hz: 1.75 },
    ],
    walls: [
      ...rails(0, 3, 1.8, 5.5, 'n'),
      ...rails(4.6, -4.25, 6.4, 1.75, '', [['s', -1.8, 1.8]]),
      // Une bande en biais dans le virage, et un muret au milieu : deux couloirs jusqu'au trou.
      wall(1.8, -0.6, 0.4, -2.5),
      wall(3.4, -4.25, 8, -4.25),
    ],
    features: [{ kind: 'bumper', x: -0.9, z: -5.2, r: 0.4 }],
  },
  {
    id: 'bumpers',
    name: 'Le flipper',
    tee: { x: 0, z: 5.6 },
    cup: { x: 0, z: -3.2 },
    surfaces: [{ kind: 'disc', x: 0, z: 0, r: 6.5 }],
    walls: [
      ...ringGaps(0, 0, 6.5, []),
      // L'entonnoir devant le trou : il faut passer par son ouverture (ou faire le tour).
      wall(-1.7, -2.2, -0.65, -1.6),
      wall(1.7, -2.2, 0.65, -1.6),
    ],
    features: [
      { kind: 'bumper', x: 0, z: 1.3, r: 0.55 },
      { kind: 'bumper', x: -2.8, z: 0.2, r: 0.5 },
      { kind: 'bumper', x: 2.8, z: 0.2, r: 0.5 },
      { kind: 'bumper', x: -3.6, z: -3.4, r: 0.45 },
      { kind: 'bumper', x: 3.6, z: -3.4, r: 0.45 },
    ],
  },
  {
    id: 'jump',
    name: 'Le grand saut',
    tee: { x: 0, z: 7.6 },
    cup: { x: 0, z: -7.2 },
    surfaces: [
      { kind: 'rect', x: 0, z: 4.2, hx: 1.6, hz: 4.2 },
      { kind: 'rect', x: 0, z: -6, hx: 2.6, hz: 3 },
    ],
    nav: [{ kind: 'rect', x: 0, z: -1.4, hx: 1.6, hz: 1.7 }],
    walls: [...rails(0, 4.2, 1.6, 4.2, 'n'), ...rails(0, -6, 2.6, 3, 's')],
    features: [
      { kind: 'ramp', x: 0, z: 0.7, hx: 1.6, hz: 0.7, speed: 4, flight: 0.85 },
      { kind: 'bumper', x: -1.1, z: -5.4, r: 0.35 },
      { kind: 'bumper', x: 1.1, z: -5.4, r: 0.35 },
    ],
  },
  {
    id: 'bridge',
    name: 'Le pont baladeur',
    tee: { x: 0, z: 7.8 },
    cup: { x: -1.4, z: -8 },
    surfaces: [
      { kind: 'rect', x: 0, z: 6, hx: 1.6, hz: 2.5 },
      { kind: 'rect', x: 0, z: -6.2, hx: 2.4, hz: 2.7 },
    ],
    walls: [
      ...rails(0, 6, 1.6, 2.5, 'n'),
      ...rails(0, -6.2, 2.4, 2.7, 's'),
      // Le zigzag de l'arrivée : passer à droite, puis revenir à gauche.
      wall(-2.4, -5.2, 0.4, -5.2),
      wall(2.4, -6.8, -0.4, -6.8),
    ],
    features: [{ kind: 'bridge', x: 0, z: 0, hx: 1.7, hz: 3.5, travel: 1.3, period: 6 }],
  },
  {
    id: 'mound',
    name: 'Le volcan',
    tee: { x: 0, z: 5.2 },
    cup: { x: 0, z: -1 },
    surfaces: [{ kind: 'disc', x: 0, z: 0, r: 6 }],
    walls: [
      ...ringGaps(0, 0, 6, []),
      // Le rempart du volcan : on n'y entre que par l'est ou par l'ouest.
      ...ringGaps(0, -1, 2.8, [
        [1.15, 2],
        [4.3, 5.1],
      ]),
    ],
    features: [{ kind: 'mound', x: 0, z: -1, r: 2.3, push: 3.4 }],
  },
  {
    id: 'conveyor',
    name: 'Les tapis roulants',
    tee: { x: 0, z: 8.3 },
    cup: { x: 1.2, z: -7.8 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 2.8, hz: 9.5 }],
    walls: [...rails(0, 0, 2.8, 9.5), wall(-2.8, -5, -0.6, -6.4)],
    features: [
      { kind: 'slope', x: 0, z: 4.5, hx: 2.8, hz: 0.9, ax: 3.4, az: 0 },
      { kind: 'slope', x: 0, z: 1, hx: 2.8, hz: 0.9, ax: -3.4, az: 0 },
      { kind: 'slope', x: 0, z: -2.5, hx: 2.8, hz: 0.9, ax: 3.4, az: 0 },
      { kind: 'bumper', x: -1.5, z: 6.6, r: 0.35 },
      { kind: 'bumper', x: 1.6, z: -0.9, r: 0.35 },
    ],
  },
  {
    id: 'spinner',
    name: 'La barre folle',
    tee: { x: 0, z: 7.2 },
    cup: { x: -2.5, z: -6.8 },
    surfaces: [{ kind: 'rect', x: 0, z: 0, hx: 4.2, hz: 8 }],
    walls: [
      ...rails(0, 0, 4.2, 8),
      // Après la barre, une chicane : à droite, puis à gauche.
      wall(-4.2, -2.5, 1.5, -2.5),
      wall(4.2, -5, -1.5, -5),
    ],
    features: [
      { kind: 'spinner', x: 0, z: 2, length: 3.6, speed: 1.3 },
      { kind: 'bumper', x: 2.9, z: -3.7, r: 0.4 },
    ],
  },
  {
    id: 'pipes',
    name: 'Les tuyaux',
    tee: { x: 0, z: 6.8 },
    cup: { x: 7.6, z: -5.8 },
    surfaces: [
      { kind: 'rect', x: 0, z: 2.5, hx: 2.2, hz: 5 },
      { kind: 'rect', x: 7.5, z: -3, hx: 2.2, hz: 4 },
    ],
    walls: [
      ...rails(0, 2.5, 2.2, 5),
      ...rails(7.5, -3, 2.2, 4),
      // L'entonnoir vers les tuyaux, et le muret de l'autre île (on en fait le tour à droite).
      wall(-2.2, 1.5, -0.6, 0.6),
      wall(2.2, 1.5, 0.6, 0.6),
      wall(5.3, -3, 8.2, -3),
    ],
    features: [
      { kind: 'pipe', ax: -1.2, az: -1.6, bx: 7.5, bz: 0.4, dx: 0, dz: -1 },
      { kind: 'pipe', ax: 1.3, az: -1.6, bx: 5.9, bz: -6.2, dx: 1, dz: 0 },
      { kind: 'bumper', x: 0.05, z: -1.2, r: 0.35 },
    ],
  },
  {
    id: 'snake',
    name: 'Le serpent',
    tee: { x: -3.2, z: 7.6 },
    cup: { x: 3.2, z: -6.6 },
    surfaces: [
      { kind: 'rect', x: -3.2, z: 4.6, hx: 1.3, hz: 3.6 },
      { kind: 'rect', x: 0, z: 0.2, hx: 4.5, hz: 1.3 },
      { kind: 'rect', x: 3.2, z: -3.8, hx: 1.3, hz: 3.6 },
    ],
    walls: [
      ...rails(-3.2, 4.6, 1.3, 3.6, 'n'),
      ...rails(0, 0.2, 4.5, 1.3, '', [
        ['s', -4.5, -1.9],
        ['n', 1.9, 4.5],
      ]),
      ...rails(3.2, -3.8, 1.3, 3.6, 's'),
      // Des bandes en biais dans les deux virages.
      wall(-4.5, -0.4, -3.6, -1.1),
      wall(4.5, 0.8, 3.6, 1.5),
    ],
    features: [
      { kind: 'slope', x: 0, z: 0.2, hx: 1.6, hz: 1.3, ax: 0, az: -2.2 },
      { kind: 'bumper', x: 0, z: 0.2, r: 0.35 },
      { kind: 'bumper', x: 3.2, z: -3.6, r: 0.35 },
    ],
  },
];
