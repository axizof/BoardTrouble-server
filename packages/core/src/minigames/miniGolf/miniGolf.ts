import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';
import { advanceBall, type BallMotion, GOLF_BALL_RADIUS } from './golfPhysics';
import { GOLF_HOLES, type GolfHole, type GolfWaypoint } from './holes';

// Le Mini-golf (02-mini-jeux.md, fiche 20) : un parcours de GOLF_COURSE trous tirés parmi ceux
// des îles flottantes (holes.ts), joués à la suite, chacun à son rythme. Tout le monde sur les
// mêmes trous ; les balles se cognent (une balle pas encore frappée sur ce trou passe au travers :
// au départ, posées côte à côte, elles ne s'accrochent pas). Le geste du tir :
//   - à la souris : on vise en la bougeant ; on maintient le clic, on recule la souris derrière
//     la balle et on l'avance : la balle part quand la souris la dépasse, d'autant plus fort que
//     le geste est rapide ;
//   - au stick : on vise à gauche et à droite ; on maintient A, on tire le stick vers soi et on le
//     relâche : plus on a tiré, plus c'est fort ;
//   - au clavier : on vise aux flèches ; on maintient Espace pour charger, on relâche pour tirer.
// MAX_STROKES coups au plus par trou : pas rentrée au dernier, la balle compte MAX_STROKES + 1.
// Une balle qui tombe dans le vide coûte un coup et revient où elle était. Au bout de GOLF_TIME
// secondes, un trou pas fini compte MAX_STROKES + 1. Le moins de coups gagne ; à égalité, le plus
// rapide (le premier à finir) ; à égalité parfaite, les dés.

export const GOLF_COURSE = 3;
export const MAX_STROKES = 6;
export const GOLF_TIME = 100;
/** La balle à pleine puissance (m/s). */
export const MAX_POWER_SPEED = 9.5;
/** À la souris : la vitesse du geste (m/s, au sol) qui donne la pleine puissance. */
export const FULL_SWING_SPEED = 22;
/** À la souris : il faut reculer d'au moins ça (m) derrière la balle pour que le geste compte. */
export const MIN_BACKSWING = 0.25;
/** Au clavier : la charge pleine en tant de secondes. */
const CHARGE_TIME = 1.2;
/** Au stick ou au clavier : la visée tourne à tant de radians par seconde. */
const AIM_TURN = 1.8;
/** La souris compte si elle a bougé depuis moins de tant de secondes. */
const MOUSE_FRESH = 0.5;
/** Une chute dans le vide dure tant avant le retour ; entre deux trous, tant de pause. */
export const GOLF_FALL_TIME = 1;
export const HOLE_PAUSE = 1.5;
/** Les trous sont posés côte à côte dans le monde, à tant de mètres l'un de l'autre (en x). */
export const HOLE_SPACING = 40;
/** Au départ, les balles sont côte à côte, à tant l'une de l'autre. */
const TEE_SPREAD = 0.38;

export type GolfPhase = 'ready' | 'rolling' | 'falling' | 'holed' | 'done';

/** Le geste en cours : la visée figée, ce qu'on a reculé, et la trace (pour la vitesse). */
export type GolfSwing = {
  aim: number;
  startAt: number;
  /** Au plus loin derrière la balle (m, souris) ou la charge (0 à 1, stick et clavier). */
  back: number;
  /** Les dernières positions du geste le long de la visée (souris), la plus récente à la fin. */
  trail: number[];
  /** Le geste se fait à la souris. */
  isMouse: boolean;
};

export type GolfBall = BallMotion & {
  id: PlayerId;
  /** Le cadre des arènes : personne n'est éliminé. */
  fellAt: null;
  /** Le trou du parcours où il en est (0 à GOLF_COURSE - 1). */
  hole: number;
  phase: GolfPhase;
  phaseAt: number;
  /** Les coups de chaque trou du parcours. */
  strokes: number[];
  /** Où reposait la balle avant le coup (elle y revient si elle tombe). */
  restX: number;
  restZ: number;
  /** Frappée sur ce trou : elle cogne les autres (avant, elle passe au travers). */
  struck: boolean;
  /** La visée (un angle autour de la verticale, comme `atan2(x, z)`). */
  aim: number;
  swing: GolfSwing | null;
  /** Le pas où il a fini le parcours, ou null. */
  finishedAt: number | null;
  /** Le pas de son dernier tir (le client le montre), ou null. */
  shotAt: number | null;
  heldPrimary: boolean;
  /**
   * Le dernier point de la souris reçu, et le pas où il a bougé : la souris ne compte que si elle
   * a bougé depuis peu (le point reste connu quand on passe au clavier ou au stick).
   */
  lastPoint: { x: number; z: number } | null;
  pointMovedAt: number;
};

export type GolfState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** Les trous du parcours (rangs dans GOLF_HOLES). */
  course: number[];
  fighters: GolfBall[];
};

function steps(seconds: number): number {
  return Math.round(seconds / ARENA_STEP);
}

/** Le parcours d'une partie : GOLF_COURSE trous différents, tirés de la graine. */
export function golfCourseOf(seed: number): number[] {
  const left = GOLF_HOLES.map((_, index) => index);
  const course: number[] = [];
  for (let index = 0; index < GOLF_COURSE; index++) {
    const pick = Math.floor(forestUnit(seed, index, 801) * left.length);
    course.push(left.splice(pick, 1)[0] ?? 0);
  }
  return course;
}

/** Le trou de ce rang du parcours. */
export function courseHole(state: GolfState, hole: number): GolfHole {
  return GOLF_HOLES[state.course[hole] ?? 0] ?? (GOLF_HOLES[0] as GolfHole);
}

/** Où est posé le trou de ce rang dans le monde (son origine). */
export function holeOffset(hole: number): { x: number; z: number } {
  return { x: hole * HOLE_SPACING, z: 0 };
}

/** La place de départ d'un joueur sur le tee : côte à côte, de part et d'autre du milieu. */
function teeSpot(hole: GolfHole, index: number, count: number): { x: number; z: number } {
  const offset = (index - (count - 1) / 2) * TEE_SPREAD;
  return { x: hole.tee.x + offset, z: hole.tee.z };
}

/** La visée vers le trou, depuis un point. */
function aimAtCup(hole: GolfHole, x: number, z: number): number {
  return Math.atan2(hole.cup.x - x, hole.cup.z - z);
}

function placeOnHole(state: GolfState, ball: GolfBall, index: number): void {
  const hole = courseHole(state, ball.hole);
  const spot = teeSpot(hole, index, state.fighters.length);
  Object.assign(ball, {
    x: spot.x,
    z: spot.z,
    vx: 0,
    vz: 0,
    airborne: 0,
    restX: spot.x,
    restZ: spot.z,
    struck: false,
    aim: aimAtCup(hole, spot.x, spot.z),
    swing: null,
    phase: 'ready',
    phaseAt: state.tick,
  });
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): GolfState {
  const state: GolfState = { tick: 0, practice, seed, course: golfCourseOf(seed), fighters: [] };
  state.fighters = players.map((id) => ({
    id,
    fellAt: null,
    hole: 0,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    airborne: 0,
    piped: -1,
    phase: 'ready' as GolfPhase,
    phaseAt: 0,
    strokes: Array.from({ length: GOLF_COURSE }, () => 0),
    restX: 0,
    restZ: 0,
    struck: false,
    aim: 0,
    swing: null,
    finishedAt: null,
    shotAt: null,
    heldPrimary: false,
    lastPoint: null,
    pointMovedAt: -1000,
  }));
  state.fighters.forEach((ball, index) => {
    placeOnHole(state, ball, index);
  });
  return state;
}

function step(state: GolfState, inputs: Partial<Record<PlayerId, ArenaInput>>): GolfState {
  const tick = state.tick + 1;
  const next: GolfState = {
    ...state,
    tick,
    fighters: state.fighters.map((ball) => ({
      ...ball,
      strokes: [...ball.strokes],
      swing: ball.swing ? { ...ball.swing, trail: [...ball.swing.trail] } : null,
    })),
  };
  if (isOver(state)) return next;
  const time = tick * ARENA_STEP;
  next.fighters.forEach((ball, index) => {
    const input = inputs[ball.id] ?? IDLE_INPUT;
    const since = (tick - ball.phaseAt) * ARENA_STEP;
    if (ball.phase === 'ready') aimAndSwing(next, ball, input);
    else ball.heldPrimary = input.primary;
    if (ball.phase === 'rolling') roll(next, ball, time);
    else if (ball.phase === 'falling' && since >= GOLF_FALL_TIME) afterFall(next, ball);
    else if (ball.phase === 'holed' && since >= HOLE_PAUSE) nextHole(next, ball, index);
  });
  collideBalls(next);
  return next;
}

/** Ce que le joueur fait de sa balle arrêtée : viser, puis le geste du tir. */
function aimAndSwing(state: GolfState, ball: GolfBall, input: ArenaInput): void {
  const pressed = input.primary && !ball.heldPrimary;
  const released = !input.primary && ball.heldPrimary;
  ball.heldPrimary = input.primary;
  const offset = holeOffset(ball.hole);
  const moved =
    input.point !== null &&
    input.point !== undefined &&
    (ball.lastPoint === null ||
      ball.lastPoint.x !== input.point.x ||
      ball.lastPoint.z !== input.point.z);
  if (moved && input.point) {
    ball.lastPoint = { x: input.point.x, z: input.point.z };
    ball.pointMovedAt = state.tick;
  }
  // La souris compte si elle vient de bouger (et pas si l'on vise aux flèches ou au stick).
  const isMouse =
    input.point !== null &&
    input.point !== undefined &&
    Math.abs(input.move.x) < 0.1 &&
    (state.tick - ball.pointMovedAt) * ARENA_STEP < MOUSE_FRESH;
  const point =
    input.point && (isMouse || ball.swing?.isMouse)
      ? { x: input.point.x - offset.x, z: input.point.z - offset.z }
      : null;
  if (!ball.swing) {
    // La visée : vers la souris, ou tournée au stick et aux flèches.
    if (point && Math.hypot(point.x - ball.x, point.z - ball.z) > 0.3) {
      ball.aim = Math.atan2(point.x - ball.x, point.z - ball.z);
    } else if (!point) {
      ball.aim += input.move.x * AIM_TURN * ARENA_STEP;
    }
    if (pressed) {
      ball.swing = {
        aim: ball.aim,
        startAt: state.tick,
        back: 0,
        trail: [],
        isMouse: point !== null,
      };
    }
    return;
  }
  const swing = ball.swing;
  const dirX = Math.sin(swing.aim);
  const dirZ = Math.cos(swing.aim);
  if (swing.isMouse && point) {
    // Le geste à la souris : la position le long de la visée (négative derrière la balle).
    const along = (point.x - ball.x) * dirX + (point.z - ball.z) * dirZ;
    swing.trail = [...swing.trail.slice(-2), along];
    swing.back = Math.max(swing.back, -along);
    if (released) {
      ball.swing = null;
      return;
    }
    if (swing.back >= MIN_BACKSWING && along >= 0 && swing.trail.length >= 2) {
      const first = swing.trail[0] ?? along;
      const speed = (along - first) / ((swing.trail.length - 1) * ARENA_STEP);
      shoot(state, ball, Math.min(1, Math.max(0, speed / FULL_SWING_SPEED)));
    }
    return;
  }
  // Au stick (tiré vers soi) ou au clavier (la charge qui monte) : on tire en relâchant, ou quand
  // le stick revient d'un coup.
  const pull = Math.max(0, input.move.z);
  const charge = Math.min(1, ((state.tick - swing.startAt) * ARENA_STEP) / CHARGE_TIME);
  const wasPulled = swing.trail.some((value) => value > 0.3);
  swing.trail = [...swing.trail.slice(-3), pull];
  swing.back = wasPulled || pull > 0.3 ? Math.max(swing.back, pull) : charge;
  const snapped = wasPulled && pull < 0.1;
  if (released || snapped) shoot(state, ball, swing.back);
}

/** Le tir : la balle part dans la visée, à la puissance donnée (0 à 1). */
function shoot(state: GolfState, ball: GolfBall, power: number): void {
  const aim = ball.swing?.aim ?? ball.aim;
  ball.swing = null;
  if (power <= 0.02) return;
  const speed = power * MAX_POWER_SPEED;
  Object.assign(ball, {
    vx: Math.sin(aim) * speed,
    vz: Math.cos(aim) * speed,
    restX: ball.x,
    restZ: ball.z,
    struck: true,
    phase: 'rolling',
    phaseAt: state.tick,
    shotAt: state.tick,
  });
  ball.strokes[ball.hole] = (ball.strokes[ball.hole] ?? 0) + 1;
}

/** La balle roule : rentrée, tombée, ou arrêtée (au dernier coup permis, le trou est fini). */
function roll(state: GolfState, ball: GolfBall, time: number): void {
  const event = advanceBall(ball, courseHole(state, ball.hole), time, state.tick, ARENA_STEP);
  if (event === 'holed') {
    Object.assign(ball, { phase: 'holed', phaseAt: state.tick });
  } else if (event === 'fell') {
    Object.assign(ball, { phase: 'falling', phaseAt: state.tick });
  } else if (event === 'stopped') {
    const isOut = (ball.strokes[ball.hole] ?? 0) >= MAX_STROKES;
    if (isOut) {
      ball.strokes[ball.hole] = MAX_STROKES + 1;
      Object.assign(ball, { phase: 'holed', phaseAt: state.tick });
    } else {
      Object.assign(ball, {
        phase: 'ready',
        phaseAt: state.tick,
        aim: aimAtCup(courseHole(state, ball.hole), ball.x, ball.z),
      });
    }
  }
}

/** Après une chute : un coup de pénalité, et la balle revient où elle était. */
function afterFall(state: GolfState, ball: GolfBall): void {
  const strokes = (ball.strokes[ball.hole] ?? 0) + 1;
  ball.strokes[ball.hole] = Math.min(MAX_STROKES + 1, strokes);
  if (strokes >= MAX_STROKES + 1) {
    Object.assign(ball, { phase: 'holed', phaseAt: state.tick, vx: 0, vz: 0 });
    return;
  }
  Object.assign(ball, {
    x: ball.restX,
    z: ball.restZ,
    vx: 0,
    vz: 0,
    airborne: 0,
    phase: 'ready',
    phaseAt: state.tick,
    aim: aimAtCup(courseHole(state, ball.hole), ball.restX, ball.restZ),
  });
}

/** Le trou suivant, ou la fin du parcours (au bac à sable, on recommence au premier). */
function nextHole(state: GolfState, ball: GolfBall, index: number): void {
  if (ball.hole + 1 >= GOLF_COURSE) {
    if (state.practice) {
      ball.strokes = ball.strokes.map(() => 0);
      ball.hole = 0;
      placeOnHole(state, ball, index);
      return;
    }
    Object.assign(ball, { phase: 'done', phaseAt: state.tick, finishedAt: state.tick });
    return;
  }
  ball.hole += 1;
  placeOnHole(state, ball, index);
}

/** Les balles frappées sur un même trou se cognent (chocs élastiques, mêmes masses). */
function collideBalls(state: GolfState): void {
  const balls = state.fighters.filter(
    (ball) =>
      ball.struck && ball.airborne <= 0 && (ball.phase === 'ready' || ball.phase === 'rolling'),
  );
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i];
      const b = balls[j];
      if (!a || !b || a.hole !== b.hole) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const gap = Math.hypot(dx, dz);
      if (gap >= GOLF_BALL_RADIUS * 2 || gap === 0) continue;
      const nx = dx / gap;
      const nz = dz / gap;
      const overlap = GOLF_BALL_RADIUS * 2 - gap;
      a.x -= (nx * overlap) / 2;
      a.z -= (nz * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.z += (nz * overlap) / 2;
      const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (closing <= 0) continue;
      const impulse = closing * 0.95;
      a.vx -= impulse * nx;
      a.vz -= impulse * nz;
      b.vx += impulse * nx;
      b.vz += impulse * nz;
      // Une balle arrêtée qu'on cogne repart : elle roule (le coup ne lui coûte rien).
      for (const ball of [a, b]) {
        if (ball.phase === 'ready' && Math.hypot(ball.vx, ball.vz) > 0.1) {
          Object.assign(ball, {
            phase: 'rolling',
            phaseAt: state.tick,
            restX: ball.x,
            restZ: ball.z,
            swing: null,
          });
        }
      }
    }
  }
}

/** Les coups d'un joueur : ceux joués, et MAX_STROKES + 1 pour chaque trou pas fini (à la fin). */
export function golfScore(state: GolfState, ball: GolfBall): number {
  const isEnded = isOver(state);
  return ball.strokes.reduce((total, strokes, hole) => {
    const isFinished =
      hole < ball.hole || ball.phase === 'done' || (hole === ball.hole && ball.phase === 'holed');
    return total + (isEnded && !isFinished ? MAX_STROKES + 1 : strokes);
  }, 0);
}

function timeLeft(state: GolfState): number | null {
  if (state.practice) return null;
  return Math.max(0, GOLF_TIME - state.tick * ARENA_STEP);
}

function isOver(state: GolfState): boolean {
  if (state.practice) return false;
  return state.tick >= steps(GOLF_TIME) || state.fighters.every((ball) => ball.phase === 'done');
}

/** Le moins de coups d'abord ; à coups égaux, le premier à finir ; à égalité parfaite, ensemble. */
function ranking(state: GolfState): PlayerId[][] {
  const scored = state.fighters.map((ball) => ({
    id: ball.id,
    score: golfScore(state, ball),
    finish: ball.finishedAt ?? Number.POSITIVE_INFINITY,
  }));
  scored.sort((a, b) => a.score - b.score || a.finish - b.finish);
  const groups: PlayerId[][] = [];
  let last: { score: number; finish: number } | null = null;
  for (const one of scored) {
    if (last && last.score === one.score && last.finish === one.finish)
      groups[groups.length - 1]?.push(one.id);
    else groups.push([one.id]);
    last = one;
  }
  return groups;
}

// Le bot (02-mini-jeux.md, fiche 20) : balle arrêtée, il essaie des coups en pensée (des
// directions, des puissances), joués avec la vraie physique (sans les autres balles), et garde
// celui qui finit au plus près du trou (rentré, c'est le meilleur ; tombé, le pire). Puis il le
// joue à la souris (reculer, avancer), avec une erreur de visée et de dosage selon son niveau.

const BOT: Record<
  BotLevel,
  { aims: number; powers: number; aimError: number; powerError: number; think: number }
> = {
  easy: { aims: 12, powers: 4, aimError: 0.1, powerError: 0.18, think: 1.2 },
  normal: { aims: 28, powers: 7, aimError: 0.045, powerError: 0.08, think: 0.9 },
  expert: { aims: 52, powers: 12, aimError: 0.015, powerError: 0.03, think: 0.6 },
};
/** Un coup essayé en pensée est suivi au plus tant de secondes. */
const PLAN_HORIZON = 5;
/** Le recul de la souris du bot (m), et ce qu'il garde de marge au-delà. */
const BOT_BACKSWING = 0.6;
const plans = new Map<string, { aim: number; power: number }>();

function botInput(state: GolfState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const ball = state.fighters.find((one) => one.id === player);
  if (ball?.phase !== 'ready') return IDLE_INPUT;
  const bot = BOT[level];
  if ((state.tick - ball.phaseAt) * ARENA_STEP < bot.think) return IDLE_INPUT;
  const plan = planShot(state, ball, level);
  const salt = player.length * 13 + (player.charCodeAt(0) || 0);
  const key = ball.hole * 64 + (ball.strokes[ball.hole] ?? 0);
  const aim = plan.aim + (forestUnit(state.seed, key, 802 + salt) * 2 - 1) * bot.aimError;
  const power = Math.max(
    0.05,
    Math.min(
      1,
      plan.power * (1 + (forestUnit(state.seed, key, 803 + salt) * 2 - 1) * bot.powerError),
    ),
  );
  const offset = holeOffset(ball.hole);
  const dirX = Math.sin(aim);
  const dirZ = Math.cos(aim);
  const at = (along: number) => ({
    x: offset.x + ball.x + dirX * along,
    z: offset.z + ball.z + dirZ * along,
  });
  // Il vise d'abord, puis recule la souris, puis l'avance à la vitesse voulue.
  if (!ball.swing) {
    const isAimed =
      Math.abs(Math.atan2(Math.sin(ball.aim - aim), Math.cos(ball.aim - aim))) < 0.001;
    return { ...IDLE_INPUT, point: at(2), primary: isAimed };
  }
  const since = state.tick - ball.swing.startAt;
  const forward = power * FULL_SWING_SPEED * ARENA_STEP;
  const along = -BOT_BACKSWING + forward * Math.max(0, since);
  return { ...IDLE_INPUT, point: at(along), primary: true };
}

/** Le meilleur coup trouvé en pensée depuis la balle arrêtée (gardé pour ne pas le refaire). */
function planShot(
  state: GolfState,
  ball: GolfBall,
  level: BotLevel,
): { aim: number; power: number } {
  const key = `${state.seed}:${ball.id}:${level}:${ball.hole}:${ball.phaseAt}`;
  const known = plans.get(key);
  if (known) return known;
  if (plans.size > 500) plans.clear();
  const bot = BOT[level];
  const hole = courseHole(state, ball.hole);
  const toCup = aimAtCup(hole, ball.x, ball.z);
  let best = { aim: toCup, power: 0.5, score: Number.POSITIVE_INFINITY };
  // Le tir part quelques pas après la décision : on joue le coup à ce moment-là.
  const startTick = state.tick + 4;
  for (let a = 0; a < bot.aims; a++) {
    // Les visées : resserrées autour du trou, plus quelques-unes tout autour (les bandes).
    const spread = a < bot.aims / 2 ? (a / (bot.aims / 2) - 0.5) * 2 : (a / bot.aims) * Math.PI * 2;
    const aim = toCup + spread;
    for (let p = 1; p <= bot.powers; p++) {
      const power = p / bot.powers;
      const score = tryShot(hole, ball, aim, power, startTick);
      if (score < best.score) best = { aim, power, score };
    }
  }
  const plan = { aim: best.aim, power: best.power };
  plans.set(key, plan);
  return plan;
}

/** Le coup essayé en pensée : la distance au trou où la balle s'arrête (0 : rentrée ; tombée : loin). */
function tryShot(
  hole: GolfHole,
  from: GolfBall,
  aim: number,
  power: number,
  startTick: number,
): number {
  const speed = power * MAX_POWER_SPEED;
  const ball: BallMotion = {
    x: from.x,
    z: from.z,
    vx: Math.sin(aim) * speed,
    vz: Math.cos(aim) * speed,
    airborne: 0,
    piped: -1,
  };
  for (let k = 0; k < steps(PLAN_HORIZON); k++) {
    const tick = startTick + k;
    const event = advanceBall(ball, hole, tick * ARENA_STEP, tick, ARENA_STEP);
    if (event === 'holed') return 0;
    if (event === 'fell') return 100 + leftToCup(hole, from.x, from.z);
    if (event === 'stopped') break;
  }
  return leftToCup(hole, ball.x, ball.z);
}

/**
 * Ce qui reste de chemin jusqu'au trou depuis un point : on le pose sur le chemin des bots (au
 * plus près d'un de ses tronçons), puis on compte ce qui reste du chemin à partir de là. Un
 * simple "au plus près d'un point" faisait viser à travers les murs du serpent.
 */
function leftToCup(hole: GolfHole, x: number, z: number): number {
  const route: GolfWaypoint[] = hole.route ?? [hole.cup];
  if (route.length === 1) return Math.hypot(x - hole.cup.x, z - hole.cup.z);
  let best = Number.POSITIVE_INFINITY;
  let after = 0;
  // Du bout vers le début : chaque tronçon, et le chemin restant après lui.
  for (let index = route.length - 2; index >= 0; index--) {
    const from = route[index];
    const to = route[index + 1];
    if (!from || !to) continue;
    if (from.teleport) {
      // Un tuyau : on l'atteint, et on ressort au point suivant.
      best = Math.min(best, Math.hypot(x - from.x, z - from.z) + after);
      continue;
    }
    const ex = to.x - from.x;
    const ez = to.z - from.z;
    const length = Math.hypot(ex, ez) || 1;
    const share = Math.max(
      0,
      Math.min(1, ((x - from.x) * ex + (z - from.z) * ez) / (length * length)),
    );
    const px = from.x + ex * share;
    const pz = from.z + ez * share;
    best = Math.min(best, Math.hypot(x - px, z - pz) + length * (1 - share) + after);
    after += length;
  }
  return best;
}

export const MINI_GOLF: ArenaGame<GolfState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  reveal: {
    score: (state, player) => {
      const ball = state.fighters.find((one) => one.id === player);
      return ball ? -golfScore(state, ball) : 0;
    },
    close: 1,
    crushing: 6,
  },
};
