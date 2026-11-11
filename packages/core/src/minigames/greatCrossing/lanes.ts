import { forestUnit } from '../offPiste/forest';

// Les voies de La grande traversée (02-mini-jeux.md, fiche 49) : une rangée de cases après
// l'autre, qui monte les étages du Mont Trouble (Prairie, Marais, Ateliers, Glacier). Chaque
// rangée est de l'herbe (on y souffle ; quelques obstacles qu'on contourne), une route (des
// véhicules qui passent), une rivière (des radeaux qui dérivent : on saute dessus, sinon on se
// noie) ou une voie de wagonnets (un convoi très rapide, annoncé). Tout est tiré de la graine
// (la même traversée pour tous, chez l'hôte comme chez les joueurs, qui la dessinent) et se
// calcule à la demande : la traversée n'a pas de fin, et ce qui roule ou flotte est une fonction
// du temps (des objets réguliers qui défilent), sans rien à garder en mémoire. Plus on avance,
// plus c'est rapide et serré. Unités : la case (colonnes de -COLUMNS_HALF à COLUMNS_HALF).

/** Les colonnes où l'on peut se tenir : de -COLUMNS_HALF à COLUMNS_HALF. */
export const COLUMNS_HALF = 5;
/** Les premières rangées : de l'herbe, sans obstacle (le départ). */
const START_ROWS = 3;
/** Les étages, tous les tant de rangées (le dernier continue sans fin). */
export const ZONE_ROWS = 40;
export type Zone = 'prairie' | 'marsh' | 'workshops' | 'glacier';
const ZONES: readonly Zone[] = ['prairie', 'marsh', 'workshops', 'glacier'];
/** Plus loin, plus dur : de 0 au départ à 1 à partir de HARD_AT (rangées). */
const HARD_AT = 180;

/** Une file d'objets qui défilent sur une rangée : des véhicules, des radeaux, un convoi. */
export type Traffic = {
  /** Le sens (1 : vers +x), la vitesse (cases par seconde). */
  dir: 1 | -1;
  speed: number;
  /** La longueur d'un objet, l'écart d'un objet au suivant (de début à début), en cases. */
  length: number;
  spacing: number;
  /** Le décalage de la file au temps 0 (cases). */
  offset: number;
  /** Ce qui défile (pour le dessin), de 0 à 2 : du plus court au plus long. */
  kind: number;
};

export type Lane =
  | { type: 'grass'; zone: Zone; blocked: number[] }
  | { type: 'road'; zone: Zone; traffic: Traffic }
  | { type: 'river'; zone: Zone; traffic: Traffic }
  | { type: 'rail'; zone: Zone; traffic: Traffic };

/** Le convoi des wagonnets : son annonce (secondes avant d'arriver au bord), sa longueur, sa vitesse. */
export const RAIL_WARNING = 1.3;
const RAIL_LENGTH = 9;
const RAIL_SPEED = 24;
/** Le convoi repasse tous les tant de secondes. */
const RAIL_PERIOD: [number, number] = [5, 9];

/** L'étage de cette rangée. */
export function zoneOf(row: number): Zone {
  return ZONES[Math.min(ZONES.length - 1, Math.max(0, Math.floor(row / ZONE_ROWS)))] ?? 'prairie';
}

function hardness(row: number): number {
  return Math.max(0, Math.min(1, row / HARD_AT));
}

const cache = new Map<number, Map<number, Lane>>();
/** Les traversées gardées en mémoire (une par graine) : la partie en cours et le bac à sable. */
const KEPT_CROSSINGS = 4;

/** La rangée `row` de la traversée de cette graine. */
export function laneAt(seed: number, row: number): Lane {
  let crossing = cache.get(seed);
  if (!crossing) {
    crossing = new Map();
    cache.set(seed, crossing);
    if (cache.size > KEPT_CROSSINGS) cache.delete(cache.keys().next().value ?? seed);
  }
  const known = crossing.get(row);
  if (known) return known;
  const lane = buildLane(seed, row);
  crossing.set(row, lane);
  return lane;
}

/**
 * Les rangées vont par groupes d'un même type (une route de trois voies, une rivière de deux
 * bras), séparés par de l'herbe. Le groupe d'une rangée se trouve en remontant au début de son
 * bloc : les blocs font BLOCK rangées, et chacun commence par de l'herbe.
 */
const BLOCK = 5;

type Kind = Lane['type'];

/** Le type de chaque rangée d'un bloc : de l'herbe, puis un groupe, puis de l'herbe. */
function blockKinds(seed: number, block: number): Kind[] {
  const first = block * BLOCK;
  if (first < START_ROWS) return ['grass', 'grass', 'grass', 'road', 'grass'];
  const zone = zoneOf(first);
  const pick = forestUnit(seed, block, 11);
  // Chaque étage a ses dangers favoris.
  const odds: Record<Zone, [Kind, number][]> = {
    prairie: [
      ['road', 0.55],
      ['river', 0.3],
      ['rail', 0.15],
    ],
    marsh: [
      ['river', 0.6],
      ['road', 0.3],
      ['rail', 0.1],
    ],
    workshops: [
      ['rail', 0.35],
      ['road', 0.45],
      ['river', 0.2],
    ],
    glacier: [
      ['road', 0.4],
      ['river', 0.4],
      ['rail', 0.2],
    ],
  };
  let kind: Kind = 'road';
  let sum = 0;
  for (const [candidate, chance] of odds[zone]) {
    sum += chance;
    if (pick < sum) {
      kind = candidate;
      break;
    }
  }
  // Plus loin, des groupes plus larges : jusqu'à quatre voies d'affilée.
  const width = 1 + Math.floor(forestUnit(seed, block, 12) * (2 + hardness(first) * 1.99));
  const size = kind === 'rail' ? Math.min(2, width) : width;
  return Array.from({ length: BLOCK }, (_, index) =>
    index >= 1 && index <= size ? kind : 'grass',
  );
}

function between(seed: number, row: number, key: number, [min, max]: [number, number]): number {
  return min + forestUnit(seed, row, key) * (max - min);
}

function buildLane(seed: number, row: number): Lane {
  const zone = zoneOf(row);
  if (row < START_ROWS) return { type: 'grass', zone, blocked: [] };
  const kind = blockKinds(seed, Math.floor(row / BLOCK))[row % BLOCK] ?? 'grass';
  const hard = hardness(row);
  const dir = forestUnit(seed, row, 21) < 0.5 ? 1 : -1;
  const offset = forestUnit(seed, row, 22) * 40;
  if (kind === 'road') {
    const kindIndex = Math.floor(forestUnit(seed, row, 23) * 3);
    const length = [1, 1.8, 2.8][kindIndex] ?? 1;
    const speed = between(seed, row, 24, [1.6 + hard * 1.8, 2.8 + hard * 3.2]);
    const spacing = length + between(seed, row, 25, [5.5 - hard * 2.2, 9 - hard * 3]);
    return {
      type: 'road',
      zone,
      traffic: { dir, speed, length, spacing, offset, kind: kindIndex },
    };
  }
  if (kind === 'river') {
    // Des radeaux d'autant plus courts et rapides qu'on avance ; jamais trop espacés pour
    // qu'un passage revienne vite.
    const kindIndex = Math.floor(forestUnit(seed, row, 23) * 3);
    const length = [1, 2, 3][kindIndex] ?? 2;
    const speed = between(seed, row, 24, [0.9 + hard * 0.8, 1.6 + hard * 1.6]);
    const spacing = length + between(seed, row, 25, [1.2 + hard * 0.8, 2.6 + hard * 1.4]);
    return {
      type: 'river',
      zone,
      traffic: { dir, speed, length, spacing, offset, kind: kindIndex },
    };
  }
  if (kind === 'rail') {
    const period = between(seed, row, 24, RAIL_PERIOD);
    return {
      type: 'rail',
      zone,
      traffic: {
        dir,
        speed: RAIL_SPEED,
        length: RAIL_LENGTH,
        spacing: RAIL_SPEED * period,
        offset,
        kind: 0,
      },
    };
  }
  return { type: 'grass', zone, blocked: grassObstacles(seed, row) };
}

/**
 * Les obstacles d'une bande d'herbe (arbres, rochers, selon l'étage), jamais sur la colonne de
 * passage : elle serpente d'une colonne au plus d'une rangée à la suivante, si bien qu'on peut
 * toujours avancer de bande en bande. Au plus MAX_BLOCKED par bande.
 */
const MAX_BLOCKED = 4;

/** La colonne toujours libre dans l'herbe, à cette rangée. */
export function passageColumn(seed: number, row: number): number {
  // Deux ondulations lentes : d'une rangée à la suivante, elle bouge de moins d'une colonne.
  const wander = Math.sin(row * 0.21 + forestUnit(seed, -7) * 6) * 0.4;
  return Math.round(wander * COLUMNS_HALF + Math.sin(row * 0.3) * 1);
}

function grassObstacles(seed: number, row: number): number[] {
  const count = Math.floor(forestUnit(seed, row, 31) * (MAX_BLOCKED + 1) * (0.4 + hardness(row)));
  const keep = passageColumn(seed, row);
  const blocked = new Set<number>();
  for (let k = 0; k < count * 3 && blocked.size < Math.min(MAX_BLOCKED, count); k++) {
    const column =
      Math.floor(forestUnit(seed, row, 32 + k) * (COLUMNS_HALF * 2 + 1)) - COLUMNS_HALF;
    if (Math.abs(column - keep) <= 0) continue;
    blocked.add(column);
  }
  return [...blocked].sort((a, b) => a - b);
}

/** Où est le début de la file au temps `time` (secondes) : le décalage de son motif. */
function trafficShift(traffic: Traffic, time: number): number {
  return traffic.offset + traffic.dir * traffic.speed * time;
}

/** La position de `x` dans le motif de la file (0 : le début d'un objet), dans [0, spacing[. */
export function patternAt(traffic: Traffic, x: number, time: number): number {
  const u = (x - trafficShift(traffic, time)) % traffic.spacing;
  return u < 0 ? u + traffic.spacing : u;
}

/** Un objet de la file couvre-t-il un segment de `x - half` à `x + half` à ce moment ? */
export function isCovered(traffic: Traffic, x: number, half: number, time: number): boolean {
  return patternAt(traffic, x - half, time) < traffic.length + half * 2;
}

/** Le segment de `x - margin` à `x + margin` est-il tout entier sur un objet (un radeau) ? */
export function isOn(traffic: Traffic, x: number, margin: number, time: number): boolean {
  return patternAt(traffic, x - margin, time) + margin * 2 <= traffic.length;
}

/** Les objets de la file entre `from` et `to` (leur début, en cases), pour le dessin. */
export function trafficBetween(traffic: Traffic, from: number, to: number, time: number): number[] {
  const shift = trafficShift(traffic, time);
  const first = Math.floor((from - traffic.length - shift) / traffic.spacing);
  const starts: number[] = [];
  for (let k = first; shift + k * traffic.spacing <= to; k++)
    starts.push(shift + k * traffic.spacing);
  return starts;
}

/**
 * Le convoi arrive-t-il bientôt (dans moins de RAIL_WARNING secondes) ou passe-t-il sur la
 * rangée (entre ses bords) ? Pour l'annonce (le feu qui clignote).
 */
export function isTrainNear(traffic: Traffic, time: number): boolean {
  const edge = COLUMNS_HALF + 2;
  const ahead = traffic.speed * RAIL_WARNING;
  // Le convoi couvre-t-il un point de la rangée, ou un point en amont d'au plus `ahead` ?
  const upstream = traffic.dir > 0 ? -edge - ahead : -edge;
  const downstream = traffic.dir > 0 ? edge : edge + ahead;
  return trafficBetween(traffic, upstream, downstream, time).some(
    (start) => start + traffic.length >= upstream && start <= downstream,
  );
}
