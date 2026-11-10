import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  collideBodies,
  createBody,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';

// Pile ou chute (02-mini-jeux.md, fiche 48) : des plaques de pierre pendues à des chaînes
// au-dessus d'un gouffre, reliées par des planches. Chacun a quelques secondes pour marcher sur
// celle de son choix ; le temps écoulé, les planches se relèvent, chacun est recentré sur sa
// plaque, puis toutes les plaques sauf une tombent, avec ceux qui sont dessus. Deux plaques
// jusqu'à la 5e manche, trois ensuite ; 10 manches au plus. Classement à l'ordre de chute.

export const PLATES_ROUNDS = 10;
/** À partir de cette manche, trois plaques (une seule tient). */
const THREE_PLATES_FROM = 6;
/** Une plaque (mètres) : sa largeur (x), sa profondeur (z), et l'écart entre deux plaques. */
export const PLATE_WIDTH = 4.4;
export const PLATE_DEPTH = 3.6;
export const PLATE_GAP = 1;
/** Le temps de choix : plus long à la première manche (on découvre), et avec trois plaques (plus de chemin). */
const FIRST_CHOOSE_TIME = 6;
const CHOOSE_TIME = 4.5;
const THREE_CHOOSE_TIME = 5;
/**
 * Après le choix : le recentrage, puis la révélation (les plaques condamnées craquent : le
 * suspense), la chute et l'arrivée des nouvelles plaques. La révélation attend que chacun soit
 * replacé : pendant le choix, des fissures se voyaient et on avait le temps de changer de plaque
 * (retour de test).
 */
export const PLATE_LOCK_TIME = 0.6;
export const PLATE_REVEAL_TIME = 1;
const PLATE_FALL_TIME = 1.8;
export const PLATE_REFILL_TIME = 1.2;
/** Recentré, il glisse vers sa place à ce rythme (par seconde) : arrivé en PLATE_LOCK_TIME. */
const SETTLE_RATE = 9;
/** Au bac à sable, on revient sur la plaque qui tient en tombant de cette hauteur. */
const RESPAWN_HEIGHT = 5;

/**
 * Les places sur une plaque (depuis son centre) : deux rangs de trois, le rang de devant
 * (vers la caméra, z positif) d'abord. Assez écartées pour six corps sans chevauchement.
 */
const SPOTS = [
  [0, 0.75],
  [-1.35, 0.75],
  [1.35, 0.75],
  [0, -0.75],
  [-1.35, -0.75],
  [1.35, -0.75],
] as const;

export type PlatesFighter = ArenaBody & {
  /** Le pas où il est tombé avec sa plaque, ou null. */
  fellAt: number | null;
  /** Sa plaque et sa place sur elle, fixées à la fin du choix ; null pendant le choix. */
  plate: number | null;
  spot: { x: number; z: number } | null;
};

export type PlatesState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** La manche (1 à PLATES_ROUNDS ; au bac à sable, elle continue), et son premier pas. */
  round: number;
  roundAt: number;
  /** Le nombre de plaques de la manche. */
  count: number;
  /** La plaque qui tient : tirée à la révélation, une fois chacun replacé ; inconnue (null) avant. */
  safe: number | null;
  fighters: PlatesFighter[];
};

/** Les moments d'une manche, en secondes depuis son début. */
export type PlatesTimeline = {
  lock: number;
  reveal: number;
  drop: number;
  refill: number;
  end: number;
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

export function platesOf(round: number): number {
  return round >= THREE_PLATES_FROM ? 3 : 2;
}

function chooseTime(round: number): number {
  if (round === 1) return FIRST_CHOOSE_TIME;
  return platesOf(round) === 3 ? THREE_CHOOSE_TIME : CHOOSE_TIME;
}

export function platesTimeline(round: number): PlatesTimeline {
  const lock = chooseTime(round);
  const reveal = lock + PLATE_LOCK_TIME;
  const drop = reveal + PLATE_REVEAL_TIME;
  return {
    lock,
    reveal,
    drop,
    refill: drop + PLATE_FALL_TIME,
    end: drop + PLATE_FALL_TIME + PLATE_REFILL_TIME,
  };
}

/** Le centre (x) de chaque plaque, de gauche à droite, rangée autour de 0. */
export function plateCenters(count: number): number[] {
  const pitch = PLATE_WIDTH + PLATE_GAP;
  return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * pitch);
}

/** La plaque qui tient garde sa place, sauf en passant à trois plaques : elle va au milieu. */
export function nextSlot(count: number, nextCount: number, safe: number): number {
  return nextCount === count ? safe : Math.floor(nextCount / 2);
}

/** La plaque la plus proche d'un point (on ne reste pas entre deux : le fossé). */
export function nearestPlate(count: number, x: number): number {
  const centers = plateCenters(count);
  let best = 0;
  centers.forEach((center, index) => {
    if (Math.abs(center - x) < Math.abs((centers[best] ?? 0) - x)) best = index;
  });
  return best;
}

/** La moitié de la largeur du terrain (plaques et planches) : des barrières tout autour. */
function halfWidth(count: number): number {
  return (count * PLATE_WIDTH + (count - 1) * PLATE_GAP) / 2;
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const pick = (unit: number, count: number) => Math.min(count - 1, Math.floor(unit * count));

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): PlatesState {
  const count = platesOf(1);
  const reach = halfWidth(count) - WALKER.radius * 2;
  return {
    tick: 0,
    practice,
    seed,
    round: 1,
    roundAt: 0,
    count,
    safe: null,
    // En ligne sur toute la largeur, face à la caméra : personne ne part avantagé.
    fighters: players.map((id, index) => {
      const x = players.length === 1 ? 0 : -reach + (index / (players.length - 1)) * reach * 2;
      return { ...createBody(id, x, 0, 0), fellAt: null, plate: null, spot: null };
    }),
  };
}

function step(state: PlatesState, inputs: Partial<Record<PlayerId, ArenaInput>>): PlatesState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const times = platesTimeline(state.round);
  const since = tick - state.roundAt;
  if (since >= steps(times.end)) return nextRound(state, tick);
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  const safe =
    state.safe ??
    (since >= steps(times.reveal)
      ? pick(hashUnit(`${state.seed}:safe:${state.round}`), state.count)
      : null);
  if (since < steps(times.lock)) {
    walk(state, standing, inputs, tick);
  } else if (since < steps(times.drop)) {
    if (since === steps(times.lock)) assignSpots(standing, state.count);
    settle(standing, dt);
  } else if (since === steps(times.drop)) {
    for (const fighter of standing) {
      if (fighter.plate !== safe) fighter.fellAt = tick;
    }
  } else if (since >= steps(times.refill) && safe !== null) {
    // En passant à trois plaques, celle qui tient glisse au milieu, avec ceux qui sont dessus.
    const nextCount = platesOf(state.round + 1);
    const centers = plateCenters(state.count);
    const shift =
      (plateCenters(nextCount)[nextSlot(state.count, nextCount, safe)] ?? 0) - (centers[safe] ?? 0);
    for (const fighter of standing) fighter.x += shift / steps(PLATE_REFILL_TIME);
  }
  return { ...state, tick, safe, fighters };
}

/** Pendant le choix : on marche librement sur les plaques et les planches, entre les barrières. */
function walk(
  state: PlatesState,
  standing: PlatesFighter[],
  inputs: Partial<Record<PlayerId, ArenaInput>>,
  tick: number,
): void {
  const braced = new Set<PlayerId>();
  for (const fighter of standing) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    walkBody(fighter, input.move, WALKER, ARENA_STEP);
    if (Math.hypot(input.move.x, input.move.z) <= 0.1) braced.add(fighter.id);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas.
  const shift = tick % Math.max(1, standing.length);
  collideBodies([...standing.slice(shift), ...standing.slice(0, shift)], WALKER, braced);
  moveBodies(standing, WALKER, ARENA_STEP);
  const maxX = halfWidth(state.count) - WALKER.radius;
  const maxZ = PLATE_DEPTH / 2 - WALKER.radius;
  for (const fighter of standing) {
    if (Math.abs(fighter.x) > maxX) {
      fighter.x = Math.sign(fighter.x) * maxX;
      fighter.vx = 0;
    }
    if (Math.abs(fighter.z) > maxZ) {
      fighter.z = Math.sign(fighter.z) * maxZ;
      fighter.vz = 0;
    }
  }
}

/** Le temps écoulé : chacun est rendu à la plaque la plus proche, à la place libre la plus proche. */
function assignSpots(standing: PlatesFighter[], count: number): void {
  const centers = plateCenters(count);
  const taken = new Set<string>();
  for (const fighter of standing) {
    const plate = nearestPlate(count, fighter.x);
    const center = centers[plate] ?? 0;
    let best = { x: center, z: 0 };
    let bestKey = '';
    let bestDistance = Infinity;
    SPOTS.forEach(([dx, dz], index) => {
      const key = `${plate}:${index}`;
      const spot = { x: center + dx, z: dz };
      const distance = Math.hypot(spot.x - fighter.x, spot.z - fighter.z);
      if (taken.has(key) || distance >= bestDistance) return;
      best = spot;
      bestKey = key;
      bestDistance = distance;
    });
    taken.add(bestKey);
    fighter.plate = plate;
    fighter.spot = best;
  }
}

/** Il glisse vers sa place (les jambes suivent : sa vitesse est celle du glissement), face à la caméra. */
function settle(standing: PlatesFighter[], dt: number): void {
  for (const fighter of standing) {
    if (!fighter.spot) continue;
    const share = Math.min(1, dt * SETTLE_RATE);
    const dx = (fighter.spot.x - fighter.x) * share;
    const dz = (fighter.spot.z - fighter.z) * share;
    fighter.x += dx;
    fighter.z += dz;
    fighter.vx = dx / dt;
    fighter.vz = dz / dt;
    fighter.facing = 0;
  }
}

/** La manche suivante : on rechoisit. Au bac à sable, celui qui est tombé revient d'en haut. */
function nextRound(state: PlatesState, tick: number): PlatesState {
  const round = state.round + 1;
  const count = platesOf(round);
  const center = plateCenters(count)[nextSlot(state.count, count, state.safe ?? 0)] ?? 0;
  const fighters = state.fighters.map((fighter) => {
    const ready = { ...fighter, vx: 0, vz: 0, plate: null, spot: null };
    if (!state.practice || fighter.fellAt === null) return ready;
    const body = createBody(fighter.id, center, 0, 0, RESPAWN_HEIGHT);
    return { ...ready, ...body, onGround: false, fellAt: null };
  });
  return { ...state, tick, round, roundAt: tick, count, safe: null, fighters };
}

function standingFighters(state: PlatesState): PlatesFighter[] {
  return state.fighters.filter((fighter) => fighter.fellAt === null);
}

function timeLeft(): number | null {
  return null;
}

/** La partie finit une fois la chute vue : un seul debout (ou personne), ou la dernière manche. */
function isOver(state: PlatesState): boolean {
  if (state.practice) return false;
  const since = state.tick - state.roundAt;
  if (since < steps(platesTimeline(state.round).refill)) return false;
  const alive = standingFighters(state).length;
  return alive === 0 || (state.fighters.length > 1 && alive <= 1) || state.round >= PLATES_ROUNDS;
}

/**
 * Le classement : ceux encore debout, ex aequo (les dés les départagent), puis les tombés, du
 * dernier tombé au premier ; tombés ensemble : ex aequo.
 */
function ranking(state: PlatesState): PlayerId[][] {
  const alive = standingFighters(state).map((fighter) => fighter.id);
  const fallen = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    if (fighter.fellAt === null) continue;
    fallen.set(fighter.fellAt, [...(fallen.get(fighter.fellAt) ?? []), fighter.id]);
  }
  const byFall = [...fallen.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return alive.length > 0 ? [alive, ...byFall] : byFall;
}

/** La graine reste chez l'hôte : avec elle, on saurait d'avance quelle plaque tient. */
function viewFor(state: PlatesState, _viewer: Viewer): PlatesState {
  return { ...state, seed: 0 };
}

/**
 * Le bot part après un temps de réaction vers une plaque au hasard, à une place au hasard sur
 * elle. Le Facile et le Normal changent parfois d'avis en route (du bluff, ou de l'hésitation).
 * L'Expert, lui, évite de suivre la foule : peu avant la fin, il va sur la plaque la moins
 * peuplée.
 */
const REACTION: Record<BotLevel, [number, number]> = {
  easy: [0.5, 1.2],
  normal: [0.3, 0.9],
  expert: [0.2, 0.6],
};
const CHANGE_MIND: Record<BotLevel, number> = { easy: 0.25, normal: 0.35, expert: 0 };
/** L'Expert regarde la foule à ce temps de la fin du choix. */
const CROWD_LOOK = 1.6;
/** Arrivé à tant de sa place, il s'arrête ; il ralentit en approchant. */
const ARRIVED = 0.25;
const SLOW_DOWN = 0.6;

function botInput(state: PlatesState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null) return IDLE_INPUT;
  const times = platesTimeline(state.round);
  const seconds = (state.tick - state.roundAt) * ARENA_STEP;
  const key = `${state.seed}:${player}:${state.round}`;
  const [fastest, slowest] = REACTION[level];
  if (seconds >= times.lock || seconds < fastest + hashUnit(`${key}:react`) * (slowest - fastest)) {
    return IDLE_INPUT;
  }
  const plate = botPlate(state, me, level, key, seconds);
  const center = plateCenters(state.count)[plate] ?? 0;
  const targetX = center + (hashUnit(`${key}:${plate}:x`) - 0.5) * (PLATE_WIDTH - 1.6);
  const targetZ = (hashUnit(`${key}:${plate}:z`) - 0.5) * (PLATE_DEPTH - 1.4);
  const dx = targetX - me.x;
  const dz = targetZ - me.z;
  const gap = Math.hypot(dx, dz);
  if (gap < ARRIVED) return IDLE_INPUT;
  const strength = Math.min(1, gap / SLOW_DOWN);
  return {
    move: { x: (dx / gap) * strength, z: (dz / gap) * strength },
    primary: false,
    secondary: false,
  };
}

/** La plaque que vise le bot à cet instant du choix. */
function botPlate(
  state: PlatesState,
  me: PlatesFighter,
  level: BotLevel,
  key: string,
  seconds: number,
): number {
  const times = platesTimeline(state.round);
  const first = pick(hashUnit(`${key}:first`), state.count);
  if (level === 'expert') {
    if (seconds < times.lock - CROWD_LOOK) return first;
    return leastCrowded(state, me, first);
  }
  const changeAt = times.lock * (0.4 + hashUnit(`${key}:when`) * 0.4);
  if (hashUnit(`${key}:change`) >= CHANGE_MIND[level] || seconds < changeAt) return first;
  return (first + 1 + pick(hashUnit(`${key}:other`), state.count - 1)) % state.count;
}

/** La plaque où il y a le moins d'autres joueurs ; à égalité, il garde la sienne. */
function leastCrowded(state: PlatesState, me: PlatesFighter, mine: number): number {
  const crowd = Array.from({ length: state.count }, () => 0);
  for (const other of standingFighters(state)) {
    if (other.id === me.id) continue;
    const plate = nearestPlate(state.count, other.x);
    crowd[plate] = (crowd[plate] ?? 0) + 1;
  }
  let best = mine;
  crowd.forEach((people, plate) => {
    if (people < (crowd[best] ?? 0)) best = plate;
  });
  return best;
}

export const FALLING_PLATES: ArenaGame<PlatesState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  viewFor,
};
