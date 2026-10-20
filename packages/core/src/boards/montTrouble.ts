import type {
  BoardDefinition,
  FloorDefinition,
  Space,
  SpaceId,
  SpaceKind,
  WheelSegment,
} from '../board/board';
import { laneOffset, pointOnSpiral, type Spiral } from './spiral';

// Le Mont Trouble (01-vision-et-plateau.md, section 7) : l'île, sa montagne et le chemin
// qui monte en spirale, un étage par tour. Chaque étage ajoute une mécanique et a son propre
// embranchement. Les destinations "à la verticale" (ascenseurs, monte-charge, toboggans,
// chutes) sont calculées sur la géométrie : elles tombent vraiment au-dessus ou en dessous.

const SPIRAL: Spiral = {
  baseRadius: 17,
  radiusPerTurn: 2.2,
  baseHeight: 0.8,
  heightPerTurn: 3.2,
  startAngle: Math.PI / 2,
};
/** Les voies qui longent la paroi s'écartent du bord d'autant. */
const WALL_LANE_DEPTH = 1.9;
const BEACH_OFFSET = 2.2;

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
};

type FloorPlan = FloorDefinition & {
  /** Le chemin principal de l'étage, de sa première case à sa porte comprise. */
  line: SpaceKind[];
  /** Cases du chemin principal au bord du vide, sans garde-fou (indices). */
  edges: number[];
  /** Voies alternatives : la voie principale reste celle de la ligne. */
  branches: Branch[];
};

// Huit cases par ligne : le plan se lit comme le plateau, le formateur l'éclaterait en une
// case par ligne.
// biome-ignore format: plan d'étage aligné à la main
const FLOORS: FloorPlan[] = [
  {
    name: 'Prairie des Pions',
    // Les bases : bonus, malus, objets. Pas de bord dangereux. Embranchement "calme contre
    // tentant" : deux voies de même longueur, l'une tranquille, l'autre avec un gros bonus,
    // un coffre... et un -5. Un monte-charge plutôt qu'un ascenseur : tout le monde passe
    // par la Prairie, un ascenseur toujours en marche y raccourcissait trop les parties.
    line: [
      _, bonus(3), _, ITEM, _, malus(3), teleporter('f1-19'), bonus(3),
      _, _, REST, _, _, _, ITEM, SQUALL,
      _, bonus(3), malus(3), teleporter('f1-6'), springboard(8), ITEM, bonus(3), DUEL,
      _, FREIGHT_LIFT, malus(3), TROUBLE, _, bonus(3), _, { type: 'twinGate' },
    ],
    edges: [],
    branches: [{ name: 'tempting', from: 8, to: 13, kinds: [bonus(5), CHEST, malus(5), bonus(3)] }],
  },
  {
    name: 'Marais aux Dés',
    // Dés géants et dés spéciaux. Premier "court et exposé contre long et sûr" : la voie
    // courte longe le vide (objets, coffre, mais un Échange), la longue longe la paroi.
    line: [
      _, SPECIAL_DIE, bonus(3), _, GIANT_DIE, malus(3), seesaw('f2-14'), ITEM,
      _, ITEM, SWAP, CHEST, _, bonus(3), seesaw('f2-6'), GIANT_DIE,
      BET, SLIDE, malus(3), _, FILOUS, ONE_VS_ALL, ELEVATOR, bonus(3),
      TROUBLE, { type: 'skillGate' },
    ],
    edges: [9, 10, 11],
    branches: [{ name: 'wall', from: 8, to: 12, kinds: [bonus(3), _, bonus(5), _, ITEM] }],
  },
  {
    name: 'Ateliers',
    // Tapis roulants et pont-levis : le raccourci par le pont n'est ouvert qu'une manche sur
    // deux. Le monte-charge mène au Glacier les manches paires.
    line: [
      { type: 'wheel', segments: WORKSHOP_WHEEL }, conveyor('forward', 3), ITEM, malus(3),
      teleporter('f3-15'), bonus(3), _, TROUBLE,
      ITEM, FILOUS, _, conveyor('backward', 2), MAGNET, _, bonus(3), teleporter('f3-4'),
      FREIGHT_LIFT, malus(3), _, conveyor('forward', 3), SLIDE, { type: 'tollGate', threshold: 4 },
    ],
    edges: [7, 8, 9],
    branches: [
      { name: 'wall', from: 6, to: 10, kinds: [bonus(3), _, REST, bonus(5), _] },
      { name: 'bridge', from: 13, to: 18, kinds: [DRAWBRIDGE, _] },
    ],
  },
  {
    name: 'Glacier',
    // Cases gelées : on glisse jusqu'à la prochaine case non gelée. Embranchement "gauche ou
    // droite" : deux voies de même longueur, l'une glacée au bord du vide, l'autre sûre.
    line: [
      _, ICE, ICE, ITEM, _, _, ICE, ICE,
      bonus(5), malus(3), _, ITEM, SQUALL, ELEVATOR, statue(10), ICE,
      ICE, TROUBLE, SLIDE, { type: 'boulderGate', threshold: 5 },
    ],
    edges: [8, 9],
    branches: [{ name: 'wall', from: 5, to: 10, kinds: [ITEM, _, bonus(3), _] }],
  },
  {
    name: 'Crête des Nuages',
    muddy: true,
    windy: true,
    // Boue et coups de vent, et une crête exposée jusqu'au sommet.
    line: [
      _, bonus(3), JOSTLE, ITEM, _, CHEST, TROUBLE, _,
      malus(3), VENDETTA, _, bonus(3), SLIDE, { type: 'finalGate', threshold: 6 },
    ],
    edges: [5, 6, 10, 11],
    branches: [{ name: 'wall', from: 4, to: 7, kinds: [bonus(3), _, ITEM, _] }],
  },
];

export function buildMontTrouble(): BoardDefinition {
  const spaces: Record<SpaceId, Space> = {};
  const turnOf = new Map<SpaceId, number>();
  const add = (space: Space, turn: number) => {
    spaces[space.id] = space;
    turnOf.set(space.id, turn);
  };

  add(
    {
      id: 'start',
      kind: { type: 'start' },
      floor: 0,
      next: [],
      position: { ...pointOnSpiral(SPIRAL, 0, BEACH_OFFSET), y: 0 },
    },
    -1,
  );
  let previous = 'start';
  FLOORS.forEach((plan, index) => {
    const floor = index + 1;
    const lineIds = plan.line.map((_kind, i) => lineId(floor, i, plan.line.length));
    const turnAt = (i: number) => floor - 1 + (i + 0.5) / plan.line.length;

    plan.line.forEach((kind, i) => {
      const id = lineIds[i] ?? '';
      add({ id, kind, floor, next: [], position: pointOnSpiral(SPIRAL, turnAt(i)) }, turnAt(i));
      spaces[previous]?.next.push(id);
      previous = id;
    });

    for (const branch of plan.branches) {
      const ids = branch.kinds.map((_kind, j) => `f${floor}-${branch.name}-${j}`);
      branch.kinds.forEach((kind, j) => {
        const progress = (j + 1) / (branch.kinds.length + 1);
        const turn = turnAt(branch.from) + (turnAt(branch.to) - turnAt(branch.from)) * progress;
        const position = pointOnSpiral(SPIRAL, turn, laneOffset(WALL_LANE_DEPTH, progress));
        add(
          {
            id: ids[j] ?? '',
            kind,
            floor,
            next: [ids[j + 1] ?? lineIds[branch.to] ?? ''],
            position,
          },
          turn,
        );
      });
      spaces[lineIds[branch.from] ?? '']?.next.push(ids[0] ?? '');
    }

    for (const i of plan.edges) {
      const space = spaces[lineIds[i] ?? ''];
      if (space) space.fallsTo = BELOW;
    }
  });

  resolveVerticalLinks(spaces, turnOf);
  return {
    id: 'mont-trouble',
    name: 'Mont Trouble',
    start: 'start',
    spaces,
    floors: {
      0: { name: 'Plage du départ' },
      ...Object.fromEntries(
        FLOORS.map(({ line: _line, edges: _edges, branches: _branches, ...floor }, index) => [
          index + 1,
          floor,
        ]),
      ),
    },
  };
}

function lineId(floor: number, index: number, length: number): SpaceId {
  if (index < length - 1) return `f${floor}-${index}`;
  return floor === FLOORS.length ? 'summit' : `f${floor}-gate`;
}

/**
 * Remplace les destinations "au-dessus" et "en dessous" par la case de l'étage voisin la plus
 * proche à la verticale, sur son chemin principal, en évitant les portes et la glace (on ne
 * s'arrête jamais sur une case gelée).
 */
function resolveVerticalLinks(spaces: Record<SpaceId, Space>, turnOf: Map<SpaceId, number>) {
  const landings = Object.values(spaces).filter(
    (space) => /^f\d+-\d+$/.test(space.id) && space.kind.type !== 'ice',
  );
  const vertical = (from: Space, direction: 1 | -1): SpaceId => {
    const target = (turnOf.get(from.id) ?? 0) + direction;
    const [closest] = landings
      .filter((space) => space.floor === from.floor + direction)
      .sort(
        (a, b) =>
          Math.abs((turnOf.get(a.id) ?? 0) - target) - Math.abs((turnOf.get(b.id) ?? 0) - target),
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
