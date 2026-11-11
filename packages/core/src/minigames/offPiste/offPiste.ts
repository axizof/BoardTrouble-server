import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  forestUnit,
  GATE_HALF,
  gateAt,
  gateBefore,
  PISTE_HALF,
  TREE_REACH,
  type Tree,
  treesBetween,
} from './forest';

// Hors-piste ! (02-mini-jeux.md, fiche 50) : chacun descend à ski la même forêt de sapins. On
// glisse tout seul, de plus en plus vite en descendant ; gauche et droite orientent les skis, et
// chaque virage fait déraper et coûte un peu de vitesse : couper droit va vite, zigzaguer est
// plus sûr. Un sapin touché : chute, puis retour tout en haut. Seule compte ta meilleure
// descente (la plus longue) au bout du chrono. Passer entre les fanions d'une porte de slalom
// donne un coup de vitesse. Chacun ses skis, sans collision (les autres sont des fantômes).

/** La partie dure tant (secondes), puis s'arrête après une courte pause. */
export const SKI_TIME_LIMIT = 90;
const END_PAUSE = 1.5;
/** On part de là (mètres sous le haut de la piste). */
export const SKI_START = 2;
/**
 * La vitesse vers laquelle la pente entraîne les skis tout droit (m/s) : de SPEED_TOP en haut,
 * plus SPEED_RAMP par mètre descendu, jusqu'à SPEED_MAX. Skis en travers, elle baisse (cosinus).
 */
const SPEED_TOP = 8;
const SPEED_RAMP = 0.012;
const SPEED_MAX = 17;
/** La vitesse rejoint la pente à ce rythme (par seconde), et retombe moins vite après un élan. */
const GLIDE = 0.6;
const COAST = 0.35;
/**
 * Les skis : leur angle le plus en travers (radians), la vitesse à laquelle ils tournent
 * (radians par seconde), et le dérapage (la part de vitesse perdue par radian tourné).
 */
const MAX_ANGLE = 1.05;
const TURN_RATE = 2.6;
const SKID = 0.18;
/** Contre le filet : on frotte, on perd tant de vitesse par seconde (part). */
const NET_RUB = 1.2;
const NET_MARGIN = 0.35;
/** Une porte passée : tant de vitesse en plus (m/s). */
export const GATE_BOOST = 3;
/** Tombé : on reste au pied du sapin tant de secondes, puis on repart d'en haut. */
export const CRASH_TIME = 1.4;
/** La distance comptée, au décimètre (mètres) : en dessous, ex aequo, départagés aux dés. */
const DISTANCE_GRAIN = 0.1;

export type Skier = {
  id: PlayerId;
  /** Sa place au départ (écart au milieu de la piste, mètres). */
  lane: number;
  /** Personne n'est éliminé : toujours null (contrat des arènes). */
  fellAt: null;
  x: number;
  /** La distance descendue dans la descente en cours (mètres). */
  d: number;
  /** L'angle des skis (radians, 0 : tout droit dans la pente, positif vers +x), la vitesse. */
  heading: number;
  speed: number;
  /** Le pas de sa dernière chute (il est au pied du sapin jusqu'à CRASH_TIME après), ou null. */
  crashedAt: number | null;
  /** Le sapin qu'il a touché, pendant la chute. */
  crashTree: number | null;
  /** Sa meilleure descente finie (mètres), et combien il en a faites. */
  best: number;
  runs: number;
  /** Les portes passées dans la descente en cours, et le pas de la dernière. */
  gates: number;
  gateAt: number | null;
};

export type SkiState = {
  tick: number;
  practice: boolean;
  /** La graine de la forêt (publique : chacun la dessine). */
  seed: number;
  fighters: Skier[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** La plus longue descente de ce skieur, celle en cours comprise. */
export function bestRun(skier: Skier): number {
  return Math.max(skier.best, skier.d);
}

/** Il est au pied d'un sapin (sa chute). */
export function isCrashed(skier: Skier): boolean {
  return skier.crashedAt !== null;
}

/** Au départ, chacun a sa place, côte à côte, à cet écart (mètres) : on y revient après une chute. */
const START_SPACING = 1.5;

/** Un skieur en haut de la piste, à sa place, à l'arrêt, prêt pour une nouvelle descente. */
function atTop(skier: Pick<Skier, 'id' | 'best' | 'runs' | 'lane'>): Skier {
  return {
    ...skier,
    fellAt: null,
    x: skier.lane,
    d: SKI_START,
    heading: 0,
    speed: 0,
    crashedAt: null,
    crashTree: null,
    gates: 0,
    gateAt: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SkiState {
  const fighters = players.map((id, index) =>
    atTop({ id, best: 0, runs: 0, lane: (index - (players.length - 1) / 2) * START_SPACING }),
  );
  return { tick: 0, practice, seed, fighters };
}

/** La vitesse où la pente entraîne les skis tout droit, à cette distance (m/s). */
export function slopeSpeed(d: number): number {
  return Math.min(SPEED_MAX, SPEED_TOP + SPEED_RAMP * d);
}

/** Le premier sapin touché sur ce trajet (d'un point à l'autre), ou null. */
function hitTree(
  seed: number,
  from: { x: number; d: number },
  to: { x: number; d: number },
): Tree | null {
  for (const tree of treesBetween(seed, from.d - TREE_REACH, to.d + TREE_REACH)) {
    if (distanceToSegment(tree, from, to) < TREE_REACH) return tree;
  }
  return null;
}

function distanceToSegment(
  point: { x: number; d: number },
  from: { x: number; d: number },
  to: { x: number; d: number },
): number {
  const dx = to.x - from.x;
  const dd = to.d - from.d;
  const length = dx * dx + dd * dd;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.d - from.d) * dd) / length));
  return Math.hypot(point.x - (from.x + dx * t), point.d - (from.d + dd * t));
}

/** La part du trajet (0 à 1) parcourue quand on arrive à portée de ce sapin. */
function contactShare(
  tree: Tree,
  from: { x: number; d: number },
  to: { x: number; d: number },
): number {
  // Entre le départ (hors de portée) et le point le plus proche du tronc (à portée).
  const dx = to.x - from.x;
  const dd = to.d - from.d;
  const length = dx * dx + dd * dd;
  const closest = length === 0 ? 0 : ((tree.x - from.x) * dx + (tree.d - from.d) * dd) / length;
  let low = 0;
  let high = Math.max(0, Math.min(1, closest));
  for (let k = 0; k < 10; k++) {
    const mid = (low + high) / 2;
    const at = { x: from.x + (to.x - from.x) * mid, d: from.d + (to.d - from.d) * mid };
    if (Math.hypot(tree.x - at.x, tree.d - at.d) < TREE_REACH) high = mid;
    else low = mid;
  }
  return low;
}

/** Un pas de ski : l'angle des skis, le dérapage, la pente, le filet, les portes, les sapins. */
function ski(seed: number, skier: Skier, input: ArenaInput, tick: number): void {
  const dt = ARENA_STEP;
  const wanted = Math.max(-1, Math.min(1, input.move.x)) * MAX_ANGLE;
  const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, wanted - skier.heading));
  skier.heading += turn;
  // Chaque virage fait déraper : la vitesse baisse selon l'angle tourné.
  skier.speed *= 1 - SKID * Math.abs(turn);
  const pull = slopeSpeed(skier.d) * Math.cos(skier.heading);
  const rate = skier.speed < pull ? GLIDE : COAST;
  skier.speed += (pull - skier.speed) * Math.min(1, rate * dt);
  const from = { x: skier.x, d: skier.d };
  let x = skier.x + Math.sin(skier.heading) * skier.speed * dt;
  const d = skier.d + Math.cos(skier.heading) * skier.speed * dt;
  const edge = PISTE_HALF - NET_MARGIN;
  if (Math.abs(x) > edge) {
    x = Math.sign(x) * edge;
    skier.speed *= 1 - NET_RUB * dt;
  }
  const tree = hitTree(seed, from, { x, d });
  if (tree) {
    skier.crashedAt = tick;
    skier.crashTree = tree.key;
    skier.speed = 0;
    // Arrêté au point du trajet où il touche le sapin (pas au bord de sa rangée) : deux skieurs
    // qui percutent le même sapin ne s'arrêtent pas au même centimètre.
    const share = contactShare(tree, from, { x, d });
    skier.x = from.x + (x - from.x) * share;
    skier.d = from.d + (d - from.d) * share;
    return;
  }
  const gate = gateBefore(d);
  if (gate >= 0 && gate > gateBefore(from.d)) {
    const { d: gateD, x: gateX } = gateAt(seed, gate);
    const share = (gateD - from.d) / Math.max(1e-6, d - from.d);
    if (Math.abs(from.x + (x - from.x) * share - gateX) <= GATE_HALF) {
      skier.speed += GATE_BOOST;
      skier.gates++;
      skier.gateAt = tick;
    }
  }
  skier.x = x;
  skier.d = d;
}

function step(state: SkiState, inputs: Partial<Record<PlayerId, ArenaInput>>): SkiState {
  const tick = state.tick + 1;
  const isTimeUp = !state.practice && tick > steps(SKI_TIME_LIMIT);
  const fighters = state.fighters.map((skier) => {
    const next = { ...skier };
    if (isTimeUp) return next;
    if (next.crashedAt !== null) {
      if (tick - next.crashedAt < steps(CRASH_TIME)) return next;
      // Retour tout en haut : la descente finie compte si c'est la meilleure.
      return atTop({ ...next, best: bestRun(next), runs: next.runs + 1 });
    }
    ski(state.seed, next, inputs[next.id] ?? IDLE_INPUT, tick);
    return next;
  });
  return { ...state, tick, fighters };
}

function isOver(state: SkiState): boolean {
  return !state.practice && state.tick >= steps(SKI_TIME_LIMIT) + steps(END_PAUSE);
}

function timeLeft(state: SkiState): number | null {
  if (state.practice) return null;
  return Math.max(0, SKI_TIME_LIMIT - state.tick * ARENA_STEP);
}

/** Le classement : la plus longue descente (au décimètre ; les ex aequo se départagent aux dés). */
function ranking(state: SkiState): PlayerId[][] {
  const groups = new Map<number, PlayerId[]>();
  for (const skier of state.fighters) {
    const distance = Math.round(bestRun(skier) / DISTANCE_GRAIN);
    groups.set(distance, [...(groups.get(distance) ?? []), skier.id]);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, ids]) => ids);
}

/**
 * Le bot lit la forêt devant lui (plus loin s'il est fort), rangée par rangée : pour chaque point
 * de la piste, jusqu'où peut-on descendre sans toucher de tronc en partant de là, sachant qu'on ne
 * se décale que d'autant à chaque mètre (l'angle des skis) ? Il prend le chemin qui va le plus
 * loin, en tournant peu (tourner freine) et en passant les portes, et vise quelques mètres devant
 * lui sur ce chemin. Comme un joueur, il ne voit pas tout : certains sapins lui échappent
 * (`MISSED`, au hasard), et il se laisse enfermer s'il lit trop court. Chaque descente, il
 * préfère un côté de la piste : les bots ne suivent pas tous le même chemin.
 */
const LOOK: Record<BotLevel, number> = { easy: 0.8, normal: 1, expert: 1.3 };
const MISSED: Record<BotLevel, number> = { easy: 0.08, normal: 0.045, expert: 0.02 };
/** La marge qu'il veut entre son chemin et un tronc (mètres, au-delà de la portée du sapin). */
const MARGIN: Record<BotLevel, number> = { easy: 0.15, normal: 0.25, expert: 0.35 };
/** Sa lecture : une rangée par mètre, un point tous les LANE_STEP mètres en travers. */
const PLAN_STEP = 1;
const LANE_STEP = 0.25;
/**
 * Le décalage qu'il s'autorise par rangée : les skis mettent un moment à tourner, d'autant plus
 * de mètres qu'on va vite (l'angle visé, en radians, vaut au plus PLAN_TURN / vitesse).
 */
const PLAN_TURN = 4.5;
const PLAN_ANGLE = 0.8;
/** Ce que vaut une rangée de plus, un mètre de décalage, une porte (points de sa lecture). */
const ROW_VALUE = 10;
const SHIFT_COST = 0.4;
const GATE_VALUE = 4;
/** Il vise ce nombre de rangées devant lui sur son chemin. */
const AIM_ROWS = 3;
/** Le côté qu'il préfère : jusqu'à tant du milieu de la piste (mètres), et son poids. */
const SIDE_SPREAD = 5;
const SIDE_PULL = 0.15;
const LANE_FIRST = -PISTE_HALF + 0.6;
const LANES = Array.from(
  { length: Math.floor((2 * (PISTE_HALF - 0.6)) / LANE_STEP) + 1 },
  (_, index) => LANE_FIRST + index * LANE_STEP,
);

function botInput(state: SkiState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((skier) => skier.id === player);
  if (!me || me.crashedAt !== null) return IDLE_INPUT;
  const rows = Math.ceil((Math.max(8, me.speed) * LOOK[level] + 6) / PLAN_STEP);
  const seen = treesBetween(state.seed, me.d - 1, me.d + rows * PLAN_STEP + 2).filter(
    (tree) => forestUnit(state.seed, tree.key, hashId(player)) >= MISSED[level],
  );
  const reach = TREE_REACH + MARGIN[level];
  const shift = PLAN_STEP * Math.tan(Math.min(PLAN_ANGLE, PLAN_TURN / Math.max(4, me.speed)));
  const shiftLanes = Math.max(1, Math.floor(shift / LANE_STEP));
  const lanes = LANES.length;
  // Les points pris par un tronc : la rangée r va de me.d + r à me.d + r + 1 (mètres).
  const blocked = new Uint8Array(rows * lanes);
  for (const tree of seen) {
    const first = Math.max(0, Math.floor((tree.d - me.d - reach) / PLAN_STEP) - 1);
    const last = Math.min(rows - 1, Math.ceil((tree.d - me.d + reach) / PLAN_STEP));
    for (let row = first; row <= last; row++) {
      const top = me.d + row * PLAN_STEP;
      const along = tree.d < top ? top - tree.d : Math.max(0, tree.d - top - PLAN_STEP);
      if (along >= reach) continue;
      const half = Math.sqrt(reach * reach - along * along);
      const low = Math.max(0, Math.ceil((tree.x - half - LANE_FIRST) / LANE_STEP));
      const high = Math.min(lanes - 1, Math.floor((tree.x + half - LANE_FIRST) / LANE_STEP));
      for (let lane = low; lane <= high; lane++) blocked[row * lanes + lane] = 1;
    }
  }
  // De la dernière rangée vers la première : ce que vaut chaque point, et le suivant à prendre.
  const value = new Float64Array(rows * lanes);
  const next = new Int16Array(rows * lanes);
  for (let row = rows - 1; row >= 0; row--) {
    const d = me.d + (row + 1) * PLAN_STEP;
    const gate = gateBefore(d);
    const gateHere =
      gate >= 0 && gate > gateBefore(d - PLAN_STEP) ? gateAt(state.seed, gate) : null;
    for (let lane = 0; lane < lanes; lane++) {
      const cell = row * lanes + lane;
      next[cell] = lane;
      if (blocked[cell]) continue;
      let best = 0;
      if (row < rows - 1) {
        best = Number.NEGATIVE_INFINITY;
        const last = Math.min(lanes - 1, lane + shiftLanes);
        for (let other = Math.max(0, lane - shiftLanes); other <= last; other++) {
          const score =
            (value[cell + lanes - lane + other] ?? 0) -
            Math.abs(other - lane) * LANE_STEP * SHIFT_COST;
          if (score > best) {
            best = score;
            next[cell] = other;
          }
        }
      }
      const x = LANE_FIRST + lane * LANE_STEP;
      const isGate = gateHere !== null && Math.abs(x - gateHere.x) < GATE_HALF * 0.75;
      value[cell] = ROW_VALUE + (isGate ? GATE_VALUE : 0) + best;
    }
  }
  // Le premier pas : un point de la première rangée qu'il peut atteindre d'où il est, sur son élan.
  const start = me.x + Math.tan(me.heading) * PLAN_STEP;
  const side = (forestUnit(state.seed, me.runs, hashId(player)) * 2 - 1) * SIDE_SPREAD;
  let lane = -1;
  let best = -Infinity;
  for (const [index, x] of LANES.entries()) {
    if (Math.abs(x - start) > shift) continue;
    const score =
      (value[index] ?? 0) - Math.abs(x - start) * SHIFT_COST - Math.abs(x - side) * SIDE_PULL;
    if (score > best) {
      best = score;
      lane = index;
    }
  }
  if (lane < 0) return IDLE_INPUT;
  for (let row = 0; row < AIM_ROWS - 1; row++) lane = next[row * lanes + lane] ?? lane;
  const aim = LANES[lane] ?? me.x;
  const heading = Math.atan2(aim - me.x, AIM_ROWS * PLAN_STEP);
  return { ...IDLE_INPUT, move: { x: Math.max(-1, Math.min(1, heading / MAX_ANGLE)), z: 0 } };
}

/** Un nombre propre à chaque joueur, pour ses tirages. */
function hashId(id: PlayerId): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export const OFF_PISTE: ArenaGame<SkiState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
