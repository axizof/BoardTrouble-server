import type {
  BoardDefinition,
  FloorDefinition,
  Space,
  SpaceId,
  SpaceKind,
  WheelSegment,
} from '../board/board';
import {
  type Curve,
  type FloorRoute,
  horizontalDistance,
  laneCurve,
  routeCurve,
  spacedAlong,
} from './route';

// Le Mont Trouble (01-vision-et-plateau.md, section 7 ; 04-carte.md) : l'île, sa montagne
// et le chemin qui la contourne en montant, en grands lacets : chaque étage repasse
// au-dessus du précédent, dans l'autre sens. Chaque étage ajoute une mécanique et a son
// propre embranchement. Les destinations "à la verticale" (ascenseurs, monte-charge,
// toboggans, chutes) sont calculées sur la géométrie : la case la plus proche de l'étage
// voisin, juste au-dessus ou en contrebas.

/** La case départ, sur la plage : à quelques pas de la première case, côté mer. */
const START_FROM_SHORE = 4;

/** Destinations résolues sur la géométrie, une fois toutes les cases posées. */
const ABOVE = '@above';
const BELOW = '@below';

// Cases, en abrégé : le plan de chaque étage se lit comme une ligne du plateau.
const _: SpaceKind = { type: 'empty' };
const bonus = (amount: number): SpaceKind => ({ type: 'bonus', amount });
const malus = (amount: number): SpaceKind => ({ type: 'malus', amount });
const ITEM: SpaceKind = { type: 'item' };
const CHEST: SpaceKind = { type: 'chest' };
const REST: SpaceKind = { type: 'rest' };
const TROUBLE: SpaceKind = { type: 'trouble' };
const FILOUS: SpaceKind = { type: 'filous' };
const SQUALL: SpaceKind = { type: 'squall' };
const SWAP: SpaceKind = { type: 'swap' };
const MAGNET: SpaceKind = { type: 'magnet' };
const DUEL: SpaceKind = { type: 'duel' };
const ONE_VS_ALL: SpaceKind = { type: 'oneVsAll' };
const VENDETTA: SpaceKind = { type: 'vendetta' };
const JOSTLE: SpaceKind = { type: 'jostle' };
const GIANT_DIE: SpaceKind = { type: 'giantDie' };
const SPECIAL_DIE: SpaceKind = { type: 'specialDie' };
const BET: SpaceKind = { type: 'bet' };
const ICE: SpaceKind = { type: 'ice' };
const DRAWBRIDGE: SpaceKind = { type: 'drawbridge' };
const ELEVATOR: SpaceKind = { type: 'elevator', to: ABOVE };
const FREIGHT_LIFT: SpaceKind = { type: 'freightLift', to: ABOVE };
const SLIDE: SpaceKind = { type: 'slide', to: BELOW };
const springboard = (amount: number): SpaceKind => ({ type: 'springboard', amount });
const statue = (amount: number): SpaceKind => ({ type: 'statue', amount });
const teleporter = (to: SpaceId): SpaceKind => ({ type: 'teleporter', to });
const seesaw = (partner: SpaceId): SpaceKind => ({ type: 'seesaw', partner });
const conveyor = (direction: 'forward' | 'backward', amount: number): SpaceKind => ({
  type: 'conveyor',
  direction,
  amount,
});

const WORKSHOP_WHEEL: WheelSegment[] = [
  { type: 'advance', amount: 4 },
  { type: 'advance', amount: 2 },
  { type: 'item' },
  { type: 'recoil', amount: 3 },
  { type: 'trouble' },
  { type: 'nothing' },
];

type Branch = {
  name: string;
  /** Indices, sur la ligne de l'étage, de l'embranchement et de la jonction. */
  from: number;
  to: number;
  kinds: SpaceKind[];
  /**
   * Le tracé de la voie, de l'embranchement à la jonction : bombée de `bow` mètres sur le
   * côté (positif vers l'extérieur, négatif vers la paroi), montée de `rise` mètres. Sans
   * bosse, c'est un raccourci en ligne droite (le pont-levis à travers la boucle).
   */
  lane: { bow: number; rise?: number };
};

type FloorPlan = FloorDefinition & {
  route: FloorRoute;
  /** Le chemin principal de l'étage, de sa première case à sa porte comprise. */
  line: SpaceKind[];
  /** Cases du chemin principal au bord du vide, sans garde-fou (indices). */
  edges: number[];
  /** Voies alternatives : la voie principale reste celle de la ligne. */
  branches: Branch[];
};

// Huit cases par ligne : le plan se lit comme le plateau, le formateur l'éclaterait en une
// case par ligne. Les embranchements sont répartis autour de la montagne : chaque étage a
// ses voies exposées d'un côté différent, et une chute ne tombe pas sur une autre voie
// exposée.
// biome-ignore format: plan d'étage aligné à la main
const FLOORS: FloorPlan[] = [
  {
    name: 'Prairie des Pions',
    route: {
      // De la plage, devant, la Prairie fait presque tout le tour de la montagne vers la
      // gauche, en grands S, avec un détour vers la plage au début.
      waypoints: [
        { turn: 0.0, radius: 47.51 },
        { turn: 0.0531, radius: 50.1 },
        { turn: 0.1062, radius: 48.67 },
        { turn: 0.1594, radius: 49.78 },
        { turn: 0.2125, radius: 45.7 },
        { turn: 0.2656, radius: 49.3 },
        { turn: 0.3187, radius: 45.7 },
        { turn: 0.3719, radius: 49.3 },
        { turn: 0.425, radius: 45.7 },
        { turn: 0.4781, radius: 49.3 },
        { turn: 0.5312, radius: 45.7 },
        { turn: 0.5844, radius: 49.3 },
        { turn: 0.6375, radius: 45.7 },
        { turn: 0.6906, radius: 49.3 },
        { turn: 0.7438, radius: 45.7 },
        { turn: 0.7969, radius: 49.3 },
        { turn: 0.85, radius: 47.5 },
      ],
      height: [1, 5],
    },
    // Les bases : bonus, malus, objets. Pas de bord dangereux. Embranchement "calme contre
    // tentant" : deux voies de même longueur, l'une tranquille, l'autre avec un gros bonus,
    // un coffre... et un -5. Un vrai ascenseur : sur ce plateau qui fait le tour de la
    // montagne, le monte-charge (une manche sur deux) laissait les parties trop longues.
    line: [
      _, bonus(3), _, ITEM, _, malus(3), teleporter('f1-19'), bonus(3),
      _, _, REST, _, _, _, ITEM, SQUALL,
      _, bonus(3), _, teleporter('f1-6'), springboard(8), ITEM, _, bonus(3),
      _, malus(3), _, ELEVATOR, bonus(3), DUEL, _, ITEM,
      _, malus(3), TROUBLE, _, bonus(3), _, _, { type: 'twinGate' },
    ],
    edges: [],
    branches: [
      { name: 'tempting', from: 8, to: 13, kinds: [bonus(5), CHEST, malus(5), bonus(3)], lane: { bow: 11 } },
    ],
  },
  {
    name: 'Marais aux Dés',
    route: {
      // Le Marais repasse au-dessus de la Prairie dans l'autre sens, en méandres entre les mares.
      waypoints: [
        { turn: 0.85, radius: 37.5 },
        { turn: 0.7893, radius: 39.1 },
        { turn: 0.7286, radius: 35.9 },
        { turn: 0.6679, radius: 39.1 },
        { turn: 0.6071, radius: 35.9 },
        { turn: 0.5464, radius: 39.1 },
        { turn: 0.4857, radius: 35.9 },
        { turn: 0.425, radius: 39.1 },
        { turn: 0.3643, radius: 35.9 },
        { turn: 0.3036, radius: 39.1 },
        { turn: 0.2429, radius: 35.9 },
        { turn: 0.1821, radius: 39.1 },
        { turn: 0.1214, radius: 35.9 },
        { turn: 0.0607, radius: 39.1 },
        { turn: 0.0, radius: 37.5 },
      ],
      height: [9, 13],
    },
    // Dés géants et dés spéciaux. Premier "court et exposé contre long et sûr" : la voie
    // courte longe le vide (objets, coffre, mais un Échange), la longue longe la paroi.
    line: [
      _, SPECIAL_DIE, bonus(3), _, GIANT_DIE, malus(3), seesaw('f2-17'), ITEM,
      _, SLIDE, _, ITEM, SWAP, CHEST, _, BET,
      bonus(3), seesaw('f2-6'), _, ITEM, _, ELEVATOR, FILOUS, ONE_VS_ALL,
      _, GIANT_DIE, malus(3), _, bonus(3), _, TROUBLE, { type: 'skillGate' },
    ],
    edges: [11, 12, 13],
    branches: [
      { name: 'wall', from: 10, to: 14, kinds: [bonus(3), _, bonus(5), _, ITEM], lane: { bow: -2.8, rise: 1 } },
    ],
  },
  {
    name: 'Ateliers',
    route: {
      // Les Ateliers repartent vers la gauche, avec une grande boucle autour des machines
      // que le pont-levis coupe en ligne droite.
      waypoints: [
        { turn: 0.0, radius: 28.0 },
        { turn: 0.0708, radius: 29.3 },
        { turn: 0.1417, radius: 26.7 },
        { turn: 0.2125, radius: 29.3 },
        { turn: 0.2833, radius: 26.7 },
        { turn: 0.3542, radius: 29.3 },
        { turn: 0.425, radius: 26.7 },
        { turn: 0.4958, radius: 29.3 },
        { turn: 0.5667, radius: 26.61 },
        { turn: 0.6375, radius: 26.42 },
        { turn: 0.7083, radius: 26.35 },
        { turn: 0.7792, radius: 29.3 },
        { turn: 0.85, radius: 28.0 },
      ],
      height: [17, 21],
    },
    // Tapis roulants et pont-levis : le raccourci par le pont n'est ouvert qu'une manche sur
    // deux. Le monte-charge mène au Glacier les manches paires.
    line: [
      { type: 'wheel', segments: WORKSHOP_WHEEL }, conveyor('forward', 3), ITEM, malus(3),
      teleporter('f3-12'), SLIDE, _, TROUBLE,
      ITEM, FILOUS, _, bonus(3), teleporter('f3-4'), _, bonus(3), conveyor('backward', 2),
      FREIGHT_LIFT, MAGNET, _, bonus(3), _, malus(3), conveyor('forward', 3), ITEM,
      _, { type: 'tollGate', threshold: 4 },
    ],
    edges: [7, 8, 9],
    branches: [
      { name: 'wall', from: 6, to: 10, kinds: [bonus(3), _, REST, bonus(5), _], lane: { bow: -2.4, rise: 1 } },
      { name: 'bridge', from: 17, to: 22, kinds: [DRAWBRIDGE, _], lane: { bow: 0 } },
    ],
  },
  {
    name: 'Glacier',
    route: {
      // Le Glacier revient vers la droite, en lacets entre séracs et crevasses.
      waypoints: [
        { turn: 0.85, radius: 19.5 },
        { turn: 0.765, radius: 20.7 },
        { turn: 0.68, radius: 18.3 },
        { turn: 0.595, radius: 20.7 },
        { turn: 0.51, radius: 18.3 },
        { turn: 0.425, radius: 20.7 },
        { turn: 0.34, radius: 18.3 },
        { turn: 0.255, radius: 20.7 },
        { turn: 0.17, radius: 18.3 },
        { turn: 0.085, radius: 20.7 },
        { turn: 0.0, radius: 19.5 },
      ],
      height: [25, 29],
    },
    // Cases gelées : on glisse jusqu'à la prochaine case non gelée. Embranchement "gauche ou
    // droite" : deux voies de même longueur, l'une glacée qui mène au bord du vide (on glisse
    // jusqu'au +5... ou au -3), l'autre sûre.
    line: [
      _, ITEM, ICE, ICE, SQUALL, _, ICE, ICE,
      bonus(5), malus(3), _, SLIDE, ELEVATOR, _, statue(10), ICE,
      ICE, TROUBLE, ITEM, { type: 'boulderGate', threshold: 5 },
    ],
    edges: [8, 9],
    branches: [
      { name: 'wall', from: 5, to: 10, kinds: [ITEM, _, bonus(3), _], lane: { bow: -2, rise: 1 } },
    ],
  },
  {
    name: 'Crête des Nuages',
    route: {
      // La Crête repart de devant et s'enroule en colimaçon jusqu'au sommet.
      waypoints: [
        { turn: 0, radius: 12.5 },
        { turn: 0.12, radius: 12 },
        { turn: 0.24, radius: 12.5 },
        { turn: 0.36, radius: 11.5 },
        { turn: 0.48, radius: 10.5 },
        { turn: 0.6, radius: 9 },
        { turn: 0.7, radius: 7 },
        { turn: 0.78, radius: 5 },
        { turn: 0.84, radius: 3 },
        { turn: 0.88, radius: 1 },
      ],
      height: [33, 37],
    },
    muddy: true,
    windy: true,
    // Boue et coups de vent, et une crête exposée au-dessus du Glacier. Pas de toboggan : à
    // deux pas de la porte finale, redescendre d'un étage décidait trop de parties au hasard.
    line: [
      _, bonus(3), _, CHEST, _, TROUBLE, JOSTLE, ITEM,
      VENDETTA, _, malus(3), bonus(3), _, { type: 'finalGate', threshold: 6 },
    ],
    // La crête est exposée là où elle passe au-dessus du Glacier ; le colimaçon final, qui
    // dépasse le Glacier, n'a pas de bord (on y tomberait trop loin).
    edges: [3, 4, 5, 6],
    branches: [
      { name: 'wall', from: 2, to: 6, kinds: [bonus(3), _, ITEM, _, _], lane: { bow: -3.2, rise: 1 } },
    ],
  },
];

export function buildMontTrouble(): BoardDefinition {
  const spaces: Record<SpaceId, Space> = {};
  const add = (space: Space) => {
    spaces[space.id] = space;
  };

  const shore = FLOORS[0] ? routeCurve(FLOORS[0].route)(0) : { x: 0, y: 0, z: 0 };
  const out = Math.hypot(shore.x, shore.z) || 1;
  add({
    id: 'start',
    kind: { type: 'start' },
    floor: 0,
    next: [],
    position: {
      x: shore.x + (shore.x / out) * START_FROM_SHORE,
      y: 0,
      z: shore.z + (shore.z / out) * START_FROM_SHORE,
    },
  });
  let previous = 'start';
  FLOORS.forEach((plan, index) => {
    const floor = index + 1;
    const curve = routeCurve(plan.route);
    const lineIds = plan.line.map((_kind, i) => lineId(floor, i, plan.line.length));
    const at = (i: number) => i / (plan.line.length - 1);
    const positions = spacedAlong(curve, plan.line.length);

    plan.line.forEach((kind, i) => {
      const id = lineIds[i] ?? '';
      add({ id, kind, floor, next: [], position: positions[i] ?? curve(at(i)) });
      spaces[previous]?.next.push(id);
      previous = id;
    });

    for (const branch of plan.branches) {
      const ids = branch.kinds.map((_kind, j) => `f${floor}-${branch.name}-${j}`);
      const lanePositions = laneTiles(curve, at(branch.from), at(branch.to), branch);
      branch.kinds.forEach((kind, j) => {
        add({
          id: ids[j] ?? '',
          kind,
          floor,
          next: [ids[j + 1] ?? lineIds[branch.to] ?? ''],
          position: lanePositions[j] ?? curve(at(branch.from)),
        });
      });
      spaces[lineIds[branch.from] ?? '']?.next.push(ids[0] ?? '');
    }

    for (const i of plan.edges) {
      const space = spaces[lineIds[i] ?? ''];
      if (space) space.fallsTo = BELOW;
    }
  });

  resolveVerticalLinks(spaces);
  return {
    id: 'mont-trouble',
    name: 'Mont Trouble',
    start: 'start',
    spaces,
    floors: {
      0: { name: 'Plage du départ' },
      ...Object.fromEntries(
        FLOORS.map(
          ({ line: _line, edges: _edges, branches: _branches, route: _route, ...floor }, index) => [
            index + 1,
            floor,
          ],
        ),
      ),
    },
  };
}

/** Les cases d'une voie annexe, sans ses deux bouts (l'embranchement et la jonction). */
function laneTiles(curve: Curve, from: number, to: number, branch: Branch) {
  const lane = laneCurve(curve(from), curve(to), branch.lane.bow, branch.lane.rise);
  return spacedAlong(lane, branch.kinds.length + 2).slice(1, -1);
}

function lineId(floor: number, index: number, length: number): SpaceId {
  if (index < length - 1) return `f${floor}-${index}`;
  return floor === FLOORS.length ? 'summit' : `f${floor}-gate`;
}

/**
 * Remplace les destinations "au-dessus" et "en dessous" par la case de l'étage voisin la plus
 * proche à l'horizontale, sur son chemin principal, en évitant les portes et la glace (on ne
 * s'arrête jamais sur une case gelée). Le tracé fait passer chaque étage au-dessus du
 * précédent : la destination est juste en contrebas, ou juste au-dessus.
 */
function resolveVerticalLinks(spaces: Record<SpaceId, Space>) {
  const landings = Object.values(spaces).filter(
    (space) => /^f\d+-\d+$/.test(space.id) && space.kind.type !== 'ice',
  );
  const vertical = (from: Space, direction: 1 | -1): SpaceId => {
    const [closest] = landings
      .filter((space) => space.floor === from.floor + direction)
      .sort(
        (a, b) =>
          horizontalDistance(a.position, from.position) -
          horizontalDistance(b.position, from.position),
      );
    if (!closest) throw new Error(`Pas d'étage ${from.floor + direction} sous ou sur ${from.id}`);
    return closest.id;
  };
  for (const space of Object.values(spaces)) {
    const { kind } = space;
    if ('to' in kind && (kind.to === ABOVE || kind.to === BELOW)) {
      space.kind = { ...kind, to: vertical(space, kind.to === ABOVE ? 1 : -1) };
    }
    if (space.fallsTo === BELOW) space.fallsTo = vertical(space, -1);
  }
}
