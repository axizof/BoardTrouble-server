import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { COURSE_SAMPLE, type Course, courseOf, locate, sampleAt, slopeAt } from './course';

// Sur le fil (02-mini-jeux.md, fiche 56) : chacun descend à vélo une fine crête de rocher qui
// serpente au-dessus d'un canyon. Gauche et droite tournent le guidon (le vélo garde son élan, et
// vire moins serré quand il va vite : on freine avant les virages), haut ou Espace accélère, bas
// ou Maj freine. Qui sort du bord tombe dans le canyon : éliminé, classé à la distance atteinte ;
// les arrivés sont classés au temps. À mi-parcours, un portail inverse gauche et droite jusqu'à
// l'arrivée. Chacun son vélo sur la même crête, sans collision (les autres sont des fantômes).

/** Le vélo : vitesse maximale, poussée des pédales, freins, frottement (par seconde), pesanteur. */
const MAX_SPEED = 14;
const PEDAL = 5;
const BRAKE = 9;
const DRAG = 0.12;
const GRAVITY = 9.8;
/**
 * Le guidon : la vitesse de virage à l'arrêt (radians par seconde), qui baisse avec la vitesse
 * (divisée par 1 + v / TURN_SPEED) ; le guidon suit la commande à ce rythme (par seconde).
 */
const TURN = 2.6;
const TURN_SPEED = 6;
const STEER_RATE = 7;
/** On tombe quand le milieu du vélo dépasse le bord de tant (mètres). */
const EDGE_GRACE = 0.12;
/** La course s'arrête au bout de ce temps (secondes) ; la partie finit ce temps après la dernière chute ou arrivée. */
export const RIDE_TIME_LIMIT = 100;
const END_PAUSE = 1.5;
/** Au départ, les vélos sont côte à côte, à cet écart (mètres). */
const START_SPACING = 0.45;
/** Au bac à sable, on repart d'un peu avant sa chute au bout de ce temps (secondes). */
const PRACTICE_RESPAWN = 1.5;
const PRACTICE_BACK = 4;

export type RidgeRider = {
  id: PlayerId;
  /** Le pas où il est tombé dans le canyon, ou null. */
  fellAt: number | null;
  x: number;
  z: number;
  /** Sa direction (radians : 0 vers -z, positif vers +x), sa vitesse, son guidon (-1 à 1). */
  heading: number;
  speed: number;
  steer: number;
  /** Il serre les freins (pour le grincement et le feu stop). */
  braking: boolean;
  /** Où il en est le long de la crête (mètres), son écart au milieu, l'échantillon le plus proche. */
  s: number;
  lateral: number;
  index: number;
  /** Le moment exact (en pas, avec sa fraction) où il a passé la ligne, ou null. */
  finishedAt: number | null;
};

export type RidgeState = {
  tick: number;
  practice: boolean;
  /** La graine de la crête (publique : chacun la dessine). */
  seed: number;
  fighters: RidgeRider[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Après le portail, gauche et droite sont inversés (jusqu'à l'arrivée). */
export function isInverted(course: Course, rider: Pick<RidgeRider, 's'>): boolean {
  return rider.s >= course.portal;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): RidgeState {
  const course = courseOf(seed);
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id, index) => {
      const lateral = (index - (players.length - 1) / 2) * START_SPACING;
      const start = course.samples[2] ?? { x: 0, z: 0 };
      return {
        id,
        fellAt: null,
        x: start.x + lateral,
        z: start.z,
        heading: 0,
        speed: 0,
        steer: 0,
        braking: false,
        s: 2 * COURSE_SAMPLE,
        lateral,
        index: 2,
        finishedAt: null,
      };
    }),
  };
}

/** Un pas de vélo : le guidon, les pédales et les freins, la pente, puis où il est sur la crête. */
function ride(course: Course, rider: RidgeRider, input: ArenaInput, tick: number): void {
  const dt = ARENA_STEP;
  const isDone = rider.finishedAt !== null;
  const wanted = Math.max(-1, Math.min(1, input.move.x)) * (isInverted(course, rider) ? -1 : 1);
  rider.steer += (wanted - rider.steer) * Math.min(1, dt * STEER_RATE);
  // Passé la ligne, il freine tout seul.
  const pedal = isDone ? 0 : Math.max(input.primary ? 1 : 0, Math.min(1, -input.move.z));
  const brake = isDone ? 1 : Math.max(input.secondary ? 1 : 0, Math.min(1, input.move.z));
  rider.braking = !isDone && brake > 0.5;
  const slope = slopeAt(course, rider.s);
  const push = pedal * PEDAL - brake * BRAKE - DRAG * rider.speed + GRAVITY * slope;
  rider.speed = Math.max(0, Math.min(MAX_SPEED, rider.speed + push * dt));
  rider.heading += rider.steer * (TURN / (1 + rider.speed / TURN_SPEED)) * dt;
  rider.x += Math.sin(rider.heading) * rider.speed * dt;
  rider.z -= Math.cos(rider.heading) * rider.speed * dt;
  const before = rider.s;
  const at = locate(course, rider.x, rider.z, rider.index);
  Object.assign(rider, at);
  if (!isDone && rider.s >= course.finish) {
    const share = (course.finish - before) / Math.max(1e-6, rider.s - before);
    rider.finishedAt = tick - 1 + Math.max(0, Math.min(1, share));
  }
  const width = sampleAt(course, rider.s).width;
  if (Math.abs(rider.lateral) > width / 2 + EDGE_GRACE) rider.fellAt = tick;
}

/** Au bac à sable, celui qui est tombé repart un peu avant, à l'arrêt ; arrivé, il repart du début. */
function respawn(course: Course, rider: RidgeRider, tick: number): void {
  const isDue = rider.fellAt !== null && tick - rider.fellAt >= steps(PRACTICE_RESPAWN);
  const isAround = rider.finishedAt !== null && rider.speed < 0.2;
  if (!isDue && !isAround) return;
  const s = isAround ? 2 * COURSE_SAMPLE : Math.max(2 * COURSE_SAMPLE, rider.s - PRACTICE_BACK);
  const index = Math.round(s / COURSE_SAMPLE);
  const point = course.samples[index] ?? { x: 0, z: 0, heading: 0 };
  Object.assign(rider, {
    fellAt: null,
    finishedAt: null,
    x: point.x,
    z: point.z,
    heading: point.heading,
    speed: 0,
    steer: 0,
    braking: false,
    s,
    lateral: 0,
    index,
  });
}

function step(state: RidgeState, inputs: Partial<Record<PlayerId, ArenaInput>>): RidgeState {
  const tick = state.tick + 1;
  const course = courseOf(state.seed);
  const fighters = state.fighters.map((rider) => ({ ...rider }));
  for (const rider of fighters) {
    if (state.practice) respawn(course, rider, tick);
    if (rider.fellAt !== null) continue;
    if (!state.practice && tick > steps(RIDE_TIME_LIMIT)) continue;
    ride(course, rider, inputs[rider.id] ?? IDLE_INPUT, tick);
  }
  return { ...state, tick, fighters };
}

/** Le dernier moment qui compte : la dernière chute ou arrivée (null : quelqu'un roule encore). */
function lastEvent(state: RidgeState): number | null {
  let last = 0;
  for (const rider of state.fighters) {
    const at = rider.fellAt ?? rider.finishedAt;
    if (at === null) return null;
    last = Math.max(last, at);
  }
  return last;
}

function isOver(state: RidgeState): boolean {
  if (state.practice) return false;
  if (state.tick >= steps(RIDE_TIME_LIMIT) + steps(END_PAUSE)) return true;
  const last = lastEvent(state);
  return last !== null && state.tick >= last + steps(END_PAUSE);
}

function timeLeft(state: RidgeState): number | null {
  if (state.practice) return null;
  return Math.max(0, RIDE_TIME_LIMIT - state.tick * ARENA_STEP);
}

/** La distance comptée d'un tombé (ou d'un retardataire), arrondie à ce que l'œil voit (mètres). */
const DISTANCE_GRAIN = 0.5;

/**
 * Le classement : les arrivés au temps (au centième de seconde : ex aequo en dessous), puis les
 * autres à la distance atteinte (plus loin, mieux classé).
 */
function ranking(state: RidgeState): PlayerId[][] {
  const groups = new Map<string, { order: number; ids: PlayerId[] }>();
  for (const rider of state.fighters) {
    const { finishedAt } = rider;
    const hundredths = finishedAt === null ? null : Math.round(finishedAt * ARENA_STEP * 100);
    const distance = Math.round(rider.s / DISTANCE_GRAIN) * DISTANCE_GRAIN;
    // Les arrivés d'abord (ordre négatif, par temps croissant), puis par distance décroissante.
    const order = hundredths === null ? 1e6 - distance : hundredths - 1e6;
    const key = String(order);
    const group = groups.get(key) ?? { order, ids: [] };
    group.ids.push(rider.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map((group) => group.ids);
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/**
 * Le bot vise un point de la crête un peu devant lui (plus loin s'il va vite), en ondulant un
 * peu, et règle sa vitesse sur les virages qui arrivent, avec la marge de son niveau. Comme un
 * joueur : chaque partie, il prend plus ou moins de risques (`RISK`, au hasard), et fait quelques
 * écarts vers un bord (`SLIPS`, à des endroits au hasard), qui le font tomber là où la crête est
 * fine. Après le portail, il lui faut un moment pour s'habituer aux commandes inversées : il
 * braque d'abord du mauvais côté.
 */
const GRIP: Record<BotLevel, number> = { easy: 4, normal: 5, expert: 5.7 };
const TOP_SPEED: Record<BotLevel, number> = { easy: 9, normal: 10.5, expert: 11.5 };
const RISK: [number, number] = [0.85, 1.6];
const WOBBLE: Record<BotLevel, number> = { easy: 0.3, normal: 0.2, expert: 0.1 };
const SLIPS: Record<BotLevel, number> = { easy: 4, normal: 3, expert: 3 };
/** Un écart : jusqu'à cette part de la demi-largeur, pendant tant de secondes. */
const SLIP_DEPTH: [number, number] = [0.6, 1.3];
const SLIP_TIME = 0.7;
const CONFUSION: Record<BotLevel, number> = { easy: 0.75, normal: 0.5, expert: 0.3 };
/** Le freinage qu'il prévoit (m/s²), un peu sous celui du vélo : il garde de la marge. */
const PLANNED_BRAKE = 6;
const STEER_GAIN = 2.4;

function botInput(state: RidgeState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((rider) => rider.id === player);
  if (!me || me.fellAt !== null || me.finishedAt !== null) return IDLE_INPUT;
  const course = courseOf(state.seed);
  const key = `${state.seed}:${player}`;
  const seconds = state.tick * ARENA_STEP;
  const width = sampleAt(course, me.s).width;
  const aside =
    WOBBLE[level] * Math.sin(seconds * 1.3 + hashUnit(`${key}:phase`) * 6) +
    slipAside(course, key, level, me, width);
  const ahead = sampleAt(course, me.s + 2.5 + me.speed * 0.45);
  const tx = ahead.x + Math.cos(ahead.heading) * aside;
  const tz = ahead.z + Math.sin(ahead.heading) * aside;
  const desired = Math.atan2(tx - me.x, -(tz - me.z));
  let delta = desired - me.heading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  let steer = Math.max(-1, Math.min(1, delta * STEER_GAIN));
  // Passé le portail : la commande est inversée ; il lui faut un temps pour s'y faire.
  const sincePortal = (me.s - course.portal) / Math.max(1, me.speed);
  if (isInverted(course, me) && sincePortal >= CONFUSION[level]) steer = -steer;
  const risk = RISK[0] + hashUnit(`${key}:risk`) * (RISK[1] - RISK[0]);
  const target = safeSpeed(course, me, level, risk);
  const pedal = me.speed < target - 0.3;
  const brake = me.speed > target + 0.6;
  return { move: { x: steer, z: pedal ? -1 : brake ? 1 : 0 }, primary: false, secondary: false };
}

/** L'écart d'une erreur en cours (mètres, de côté), ou 0 : il dérive vers un bord, puis revient. */
function slipAside(
  course: Course,
  key: string,
  level: BotLevel,
  me: RidgeRider,
  width: number,
): number {
  for (let slip = 0; slip < SLIPS[level]; slip++) {
    const at = course.portal * 0.15 + hashUnit(`${key}:slip:${slip}`) * course.finish * 0.85;
    const into = me.s - at;
    const length = Math.max(2, me.speed * SLIP_TIME);
    if (into < 0 || into > length) continue;
    const depth =
      SLIP_DEPTH[0] + hashUnit(`${key}:depth:${slip}`) * (SLIP_DEPTH[1] - SLIP_DEPTH[0]);
    const side = hashUnit(`${key}:side:${slip}`) < 0.5 ? -1 : 1;
    return side * depth * (width / 2) * Math.sin((into / length) * Math.PI);
  }
  return 0;
}

/** La vitesse à laquelle le bot ose aller ici, vu les virages devant lui. */
function safeSpeed(course: Course, me: RidgeRider, level: BotLevel, risk: number): number {
  let target = TOP_SPEED[level] * (0.9 + 0.1 * risk);
  const reach = (me.speed * me.speed) / (2 * PLANNED_BRAKE) + 6;
  for (let d = 0; d <= reach; d += COURSE_SAMPLE * 2) {
    const point = sampleAt(course, me.s + d);
    if (point.curvature <= 0) continue;
    const corner = Math.sqrt((GRIP[level] * risk) / point.curvature);
    target = Math.min(target, Math.sqrt(corner * corner + 2 * PLANNED_BRAKE * d));
  }
  return target;
}

export const RIDGE_RIDE: ArenaGame<RidgeState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
