import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  type BodyTuning,
  collideBodies,
  createBody,
  isAirborne,
  jumpBody,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';

// Le Gros Dé (02-mini-jeux.md, fiche 28), un 1 contre tous : le joueur seul pilote un dé géant
// qui bascule d'une case à chaque coup sur une grille, et écrase qui est sur la case où il
// retombe. Il penche un instant avant de basculer (on lit où il va), et peut sauter pour
// retomber sur les 3 x 3 cases autour de lui. Les autres courent et bondissent pour l'esquiver
// pendant 30 s ; le dé gagne s'il en écrase plus de la moitié. Les coureurs sont les corps des
// arènes (arena/body.ts) ; le dé, lui, ne quitte jamais sa grille.

/** Une case de la grille, en mètres : le dé en occupe une. */
export const DIE_CELL = 1.6;
/**
 * La grille : tant de cases de côté (impair : le dé part du centre). La même à 6 : plus grande,
 * le dé n'y coinçait plus personne.
 */
export const DIE_GRID = 7;
const BIG_TABLE = 5;
/**
 * Le chrono, en secondes : les coureurs qui tiennent jusque-là gagnent. À 6, le dé a un coureur
 * de plus à écraser sur la même grille : il a un peu plus de temps.
 */
export const DIE_TIME_LIMIT = 30;
const BIG_TIME_LIMIT = 40;
/**
 * Une bascule, en pas : il penche (ce qu'on lit), puis roule sur l'arête. Soit 0,33 s par case
 * (4,8 m/s), un peu plus vite qu'un coureur (4,5 m/s) dès le début : plus lent, le dé humain
 * n'écrasait presque personne (premiers tests). Plus vite encore, même sur les 5 dernières
 * secondes, il gagnait près de 9 parties sur 10 entre bots.
 */
export const LEAN_TICKS = 4;
export const ROLL_TICKS = 6;
/**
 * Le saut presse au fil du chrono (retour du test : la fin doit devenir difficile) : chaque
 * durée va de `start` (au début) à `end` (à la fin). En pas d'air (0,8 s puis 0,67 s), et
 * l'attente avant le suivant (s).
 */
export const SLAM_TICKS = { start: 24, end: 20 } as const;
export const SLAM_COOLDOWN = { start: 4, end: 2.5 } as const;
/** Après le saut, le temps de s'en remettre (en pas). */
export const SLAM_RECOVER_TICKS = 9;
/** Le coureur : le marcheur des arènes, avec un bond pour esquiver (comme à la Plateforme). */
const RUNNER: BodyTuning = { ...WALKER, jumpSpeed: 6 };
const LEAP_SPEED = 6.5;
/** Ce qui touche le dé sans être écrasé est repoussé, sonné un instant. */
const SHOVE_SPEED = 3;
const SHOVE_STUN = 0.3;
/** Au bac à sable, un coureur écrasé revient au bout de ce temps. */
const RESPAWN_TIME = 1.5;
/** Au bac à sable, le dé (quand ce n'est pas toi) bascule vers toi tous les tant de pas. */
const DUMMY_ROLL_EVERY = 30;

export type DieMotion =
  | { type: 'idle' }
  /** Il bascule vers (dx, dz), depuis le pas `at` : il penche, puis roule. */
  | { type: 'roll'; dx: number; dz: number; at: number }
  /** Il saute au pas `at`, et retombe `ticks` pas plus tard. */
  | { type: 'slam'; at: number; ticks: number }
  | { type: 'recover'; at: number };

export type BigDie = {
  id: PlayerId;
  /** Sa case (celle d'où il part, pendant une bascule). */
  col: number;
  row: number;
  motion: DieMotion;
  /** Le pas à partir duquel il peut sauter à nouveau. */
  slamReadyAt: number;
  /** Les faces vers le haut, vers le sud (+z) et vers l'est (+x) ; les autres sont à 7 moins elles. */
  top: number;
  south: number;
  east: number;
};

export type DieRunner = ArenaBody & {
  /** La touche de bond tenue au pas précédent : il bondit quand on appuie, pas en tenant. */
  held: boolean;
  /** Le pas où il a été écrasé (au bac à sable, il revient), ou null. */
  crushedAt: number | null;
  /** Le pas où il est éliminé, ou null (jamais au bac à sable). */
  fellAt: number | null;
};

export type BigDieState = {
  tick: number;
  practice: boolean;
  seed: number;
  die: BigDie;
  /** Les coureurs (le dé n'en fait pas partie). */
  fighters: DieRunner[];
};

/** Le centre d'une case, sur le plan (la grille est centrée sur l'origine). */
export function cellCenter(col: number, row: number): { x: number; z: number } {
  const offset = ((DIE_GRID - 1) / 2) * DIE_CELL;
  return { x: col * DIE_CELL - offset, z: row * DIE_CELL - offset };
}

/** Les coureurs à écraser pour que le dé gagne : plus de la moitié. */
export function crushesNeeded(state: BigDieState): number {
  return Math.floor(state.fighters.length / 2) + 1;
}

export function crushedCount(state: BigDieState): number {
  return state.fighters.filter((runner) => runner.fellAt !== null).length;
}

/** Où en est le chrono, de 0 (le début) à 1 (la fin) ; 0 au bac à sable. */
function rush(state: BigDieState): number {
  const left = timeLeft(state);
  if (left === null) return 0;
  return 1 - left / timeLimit(state);
}

/** Une durée du dé à ce moment de la partie, entre celle du début et celle de la fin. */
function ramp(range: { start: number; end: number }, state: BigDieState): number {
  return range.start + (range.end - range.start) * rush(state);
}

function create(
  players: PlayerId[],
  { practice, seed, solo }: { practice: boolean; seed: number; solo?: PlayerId | null },
): BigDieState {
  const dieId = solo ?? players[0] ?? '';
  const runners = players.filter((id) => id !== dieId);
  const middle = (DIE_GRID - 1) / 2;
  return {
    tick: 0,
    practice,
    seed,
    die: {
      id: dieId,
      col: middle,
      row: middle,
      motion: { type: 'idle' },
      slamReadyAt: 0,
      top: 6,
      south: 2,
      east: 4,
    },
    fighters: runners.map((id, index) => {
      // En cercle autour du dé, à mi-chemin du bord, chacun lui tournant le dos.
      const angle = (index / runners.length) * Math.PI * 2 + Math.PI / 4;
      const reach = (DIE_GRID / 2 - 1) * DIE_CELL;
      const x = Math.sin(angle) * reach;
      const z = Math.cos(angle) * reach;
      return {
        ...createBody(id, x, z, Math.atan2(x, z)),
        held: false,
        crushedAt: null,
        fellAt: null,
      };
    }),
  };
}

function step(state: BigDieState, inputs: Partial<Record<PlayerId, ArenaInput>>): BigDieState {
  const tick = state.tick + 1;
  const die = { ...state.die };
  const fighters = state.fighters.map((runner) => ({ ...runner }));
  const next = { ...state, tick, die, fighters };
  for (const runner of fighters) {
    if (state.practice && runner.crushedAt !== null) respawn(next, runner);
  }
  const running = fighters.filter((runner) => runner.crushedAt === null);
  moveRunners(next, running, inputs);
  const dieInput = inputs[die.id] ?? (state.practice ? dummyDieInput(next) : IDLE_INPUT);
  advanceDie(next, dieInput, running);
  return next;
}

function moveRunners(
  state: BigDieState,
  running: DieRunner[],
  inputs: Partial<Record<PlayerId, ArenaInput>>,
): void {
  const braced = new Set<PlayerId>();
  for (const runner of running) {
    const input = inputs[runner.id] ?? IDLE_INPUT;
    walkBody(runner, input.move, RUNNER, ARENA_STEP);
    if (input.primary && !runner.held && !isAirborne(runner)) {
      jumpBody(runner, RUNNER);
      // Le saut peut être refusé (sonné) : il ne bondit que s'il a décollé.
      if (runner.vy > 0) leap(runner, input.move);
    }
    runner.held = input.primary;
    if (Math.hypot(input.move.x, input.move.z) <= 0.1 && !isAirborne(runner)) braced.add(runner.id);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas.
  const shift = state.tick % Math.max(1, running.length);
  collideBodies([...running.slice(shift), ...running.slice(0, shift)], RUNNER, braced);
  moveBodies(running, RUNNER, ARENA_STEP);
  const edge = (DIE_GRID / 2) * DIE_CELL - RUNNER.radius;
  for (const runner of running) {
    runner.x = Math.max(-edge, Math.min(edge, runner.x));
    runner.z = Math.max(-edge, Math.min(edge, runner.z));
    const solid = solidCell(state);
    if (solid) shoveOut(runner, solid.col, solid.row, false);
  }
}

/** Il bondit vers où il va (devant lui, s'il ne va nulle part). */
function leap(runner: DieRunner, move: { x: number; z: number }): void {
  const length = Math.hypot(move.x, move.z);
  const dirX = length > 0.1 ? move.x / length : Math.sin(runner.facing);
  const dirZ = length > 0.1 ? move.z / length : Math.cos(runner.facing);
  runner.vx = dirX * LEAP_SPEED;
  runner.vz = dirZ * LEAP_SPEED;
}

/** La case où le dé pose : on ne la traverse pas (en l'air, il ne pose nulle part). */
function solidCell(state: BigDieState): { col: number; row: number } | null {
  return state.die.motion.type === 'slam' ? null : { col: state.die.col, row: state.die.row };
}

/** Repousse hors de la case un coureur qui la touche (`shove` : avec un choc, il est sonné). */
function shoveOut(runner: DieRunner, col: number, row: number, shove: boolean): void {
  const center = cellCenter(col, row);
  const half = DIE_CELL / 2;
  const nearX = Math.max(center.x - half, Math.min(center.x + half, runner.x));
  const nearZ = Math.max(center.z - half, Math.min(center.z + half, runner.z));
  let dx = runner.x - nearX;
  let dz = runner.z - nearZ;
  let distance = Math.hypot(dx, dz);
  if (distance >= RUNNER.radius) return;
  if (distance === 0) {
    // Le centre dans la case (il n'a pas été écrasé) : on le sort par le côté le plus proche.
    dx = runner.x - center.x;
    dz = runner.z - center.z;
    if (Math.abs(dx) > Math.abs(dz)) dz = 0;
    else dx = 0;
    distance = Math.hypot(dx, dz) || 1;
    runner.x = center.x + (dx / distance) * (half + RUNNER.radius);
    runner.z = center.z + (dz / distance) * (half + RUNNER.radius);
  } else {
    runner.x = nearX + (dx / distance) * RUNNER.radius;
    runner.z = nearZ + (dz / distance) * RUNNER.radius;
  }
  const nx = dx / distance;
  const nz = dz / distance;
  const into = runner.vx * nx + runner.vz * nz;
  if (into < 0) {
    runner.vx -= nx * into;
    runner.vz -= nz * into;
  }
  if (!shove) return;
  runner.vx = nx * SHOVE_SPEED;
  runner.vz = nz * SHOVE_SPEED;
  runner.stunned = Math.max(runner.stunned, SHOVE_STUN);
}

function advanceDie(state: BigDieState, input: ArenaInput, running: DieRunner[]): void {
  const { die, tick } = state;
  const { motion } = die;
  if (motion.type === 'roll' && tick - motion.at >= LEAN_TICKS + ROLL_TICKS) {
    land(die, motion.dx, motion.dz);
    die.motion = { type: 'idle' };
    crush(state, running, 0);
  }
  if (motion.type === 'slam' && tick - motion.at >= motion.ticks) {
    die.motion = { type: 'recover', at: tick };
    die.slamReadyAt = tick + Math.round(ramp(SLAM_COOLDOWN, state) / ARENA_STEP);
    crush(state, running, 1);
  }
  if (motion.type === 'recover' && tick - motion.at >= SLAM_RECOVER_TICKS) {
    die.motion = { type: 'idle' };
  }
  if (die.motion.type !== 'idle') return;
  if (input.primary && tick >= die.slamReadyAt) {
    die.motion = { type: 'slam', at: tick, ticks: Math.round(ramp(SLAM_TICKS, state)) };
    return;
  }
  const { dx, dz } = rollDirection(input.move);
  const col = die.col + dx;
  const row = die.row + dz;
  const isInside = col >= 0 && row >= 0 && col < DIE_GRID && row < DIE_GRID;
  if ((dx === 0 && dz === 0) || !isInside) return;
  die.motion = { type: 'roll', dx, dz, at: tick };
}

/** La direction de la bascule : l'axe où l'on pousse le plus, s'il y en a un franchement. */
function rollDirection(move: { x: number; z: number }): { dx: number; dz: number } {
  if (Math.max(Math.abs(move.x), Math.abs(move.z)) < 0.5) return { dx: 0, dz: 0 };
  return Math.abs(move.x) >= Math.abs(move.z)
    ? { dx: Math.sign(move.x), dz: 0 }
    : { dx: 0, dz: Math.sign(move.z) };
}

/** Il retombe sur la case voisine : ses faces tournent avec lui. */
function land(die: BigDie, dx: number, dz: number): void {
  const { top, south, east } = die;
  die.col += dx;
  die.row += dz;
  if (dz > 0) Object.assign(die, { top: 7 - south, south: top });
  if (dz < 0) Object.assign(die, { top: south, south: 7 - top });
  if (dx > 0) Object.assign(die, { top: 7 - east, east: top });
  if (dx < 0) Object.assign(die, { top: east, east: 7 - top });
}

/**
 * Il retombe : qui a le centre sous lui (sa case, et les `reach` cases autour) est écrasé ; qui
 * le touche seulement est repoussé.
 */
function crush(state: BigDieState, running: DieRunner[], reach: number): void {
  const { die, tick } = state;
  const center = cellCenter(die.col, die.row);
  const half = DIE_CELL * (reach + 0.5);
  for (const runner of running) {
    const isUnder = Math.abs(runner.x - center.x) < half && Math.abs(runner.z - center.z) < half;
    if (!isUnder) {
      shoveOut(runner, die.col, die.row, true);
      continue;
    }
    runner.crushedAt = tick;
    runner.vx = 0;
    runner.vz = 0;
    if (!state.practice) runner.fellAt = tick;
  }
}

/** Au bac à sable, l'écrasé revient, sur la case la plus loin du dé. */
function respawn(state: BigDieState, runner: DieRunner): void {
  if (runner.crushedAt === null || (state.tick - runner.crushedAt) * ARENA_STEP < RESPAWN_TIME) {
    return;
  }
  const last = DIE_GRID - 1;
  const corners = [
    [0, 0],
    [last, 0],
    [0, last],
    [last, last],
  ] as const;
  const far = corners.reduce((best, corner) =>
    cellGap(state.die, corner) > cellGap(state.die, best) ? corner : best,
  );
  const { x, z } = cellCenter(far[0], far[1]);
  Object.assign(runner, createBody(runner.id, x, z, runner.facing), {
    held: false,
    crushedAt: null,
  });
}

function cellGap(die: BigDie, [col, row]: readonly [number, number]): number {
  return Math.abs(die.col - col) + Math.abs(die.row - row);
}

/** Au bac à sable, le dé qui n'est pas toi bascule de temps en temps vers le coureur. */
function dummyDieInput(state: BigDieState): ArenaInput {
  const target = state.fighters.find((runner) => runner.crushedAt === null);
  if (!target || state.tick % DUMMY_ROLL_EVERY !== 0) return IDLE_INPUT;
  const center = cellCenter(state.die.col, state.die.row);
  return { ...IDLE_INPUT, move: { x: target.x - center.x, z: target.z - center.z } };
}

function timeLimit(state: BigDieState): number {
  return state.fighters.length + 1 >= BIG_TABLE ? BIG_TIME_LIMIT : DIE_TIME_LIMIT;
}

function timeLeft(state: BigDieState): number | null {
  if (state.practice) return null;
  return Math.max(0, timeLimit(state) - state.tick * ARENA_STEP);
}

function isOver(state: BigDieState): boolean {
  if (state.practice) return false;
  return crushedCount(state) >= crushesNeeded(state) || (timeLeft(state) ?? 1) <= 0;
}

/** Le dé seul d'un côté, les coureurs ensemble de l'autre : le 1 contre tous se gagne en camp. */
function ranking(state: BigDieState): PlayerId[][] {
  const runners = state.fighters.map((runner) => runner.id);
  return crushedCount(state) >= crushesNeeded(state)
    ? [[state.die.id], runners]
    : [runners, [state.die.id]];
}

/**
 * Le bot du dé poursuit le coureur le plus entouré (02-mini-jeux.md : le groupe le plus dense),
 * là où il sera bientôt, et saute quand quelqu'un est tout près. Son niveau règle son temps de
 * réaction entre deux bascules, son anticipation et son goût pour le saut.
 */
const DIE_PAUSE: Record<BotLevel, number> = { easy: 0.85, normal: 0.6, expert: 0.2 };
const DIE_LEAD: Record<BotLevel, number> = { easy: 0, normal: 0.25, expert: 0.45 };
const DIE_SLAM: Record<BotLevel, number> = { easy: 0.04, normal: 0.12, expert: 0.25 };
/**
 * Le bot coureur fuit le dé et les murs, s'écarte des autres (le dé vise les groupes), et sort
 * de la case où le dé va retomber, en bondissant s'il le faut. Son niveau règle quand il remarque
 * la bascule ou le saut (en pas), et sa lucidité dans le choix de la fuite.
 */
const RUNNER_NOTICE: Record<BotLevel, number> = { easy: 5, normal: 3, expert: 1 };
const RUNNER_NOISE: Record<BotLevel, number> = { easy: 2.5, normal: 1.2, expert: 0.5 };
const RUNNER_LEAP: Record<BotLevel, number> = { easy: 0.25, normal: 0.4, expert: 0.8 };
const FLEE_DIRECTIONS = 16;
const FLEE_LOOK = 1.5;

function botInput(state: BigDieState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  if (player === state.die.id) return dieBotInput(state, level, rng);
  const me = state.fighters.find((runner) => runner.id === player);
  if (!me || me.crushedAt !== null || isAirborne(me)) return IDLE_INPUT;
  return runnerBotInput(state, me, level, rng);
}

function dieBotInput(state: BigDieState, level: BotLevel, rng: Rng): ArenaInput {
  const { die } = state;
  if (die.motion.type !== 'idle') return IDLE_INPUT;
  const running = state.fighters.filter((runner) => runner.crushedAt === null);
  if (running.length === 0 || rng.chance(DIE_PAUSE[level])) return IDLE_INPUT;
  const center = cellCenter(die.col, die.row);
  const isClose = (runner: DieRunner) =>
    Math.abs(runner.x - center.x) < DIE_CELL * 1.5 &&
    Math.abs(runner.z - center.z) < DIE_CELL * 1.5;
  if (state.tick >= die.slamReadyAt && running.some(isClose) && rng.chance(DIE_SLAM[level])) {
    return { ...IDLE_INPUT, primary: true };
  }
  const score = (runner: DieRunner) =>
    running.reduce(
      (sum, other) =>
        other === runner ? sum : sum + 2 / (1 + Math.hypot(other.x - runner.x, other.z - runner.z)),
      0,
    ) -
    Math.hypot(runner.x - center.x, runner.z - center.z) * 0.3;
  const target = running.reduce((best, runner) => (score(runner) > score(best) ? runner : best));
  const x = target.x + target.vx * DIE_LEAD[level] - center.x;
  const z = target.z + target.vz * DIE_LEAD[level] - center.z;
  return { ...IDLE_INPUT, move: { x, z } };
}

function runnerBotInput(state: BigDieState, me: DieRunner, level: BotLevel, rng: Rng): ArenaInput {
  const { die, tick } = state;
  const { motion } = die;
  const noticed =
    motion.type !== 'idle' && tick - ('at' in motion ? motion.at : tick) >= RUNNER_NOTICE[level];
  // La zone où le dé va retomber, s'il l'a remarqué : sa case d'arrivée, ou les 3 x 3 du saut.
  const danger =
    noticed && motion.type === 'roll'
      ? { ...cellCenter(die.col + motion.dx, die.row + motion.dz), half: DIE_CELL / 2 }
      : noticed && motion.type === 'slam'
        ? { ...cellCenter(die.col, die.row), half: DIE_CELL * 1.5 }
        : null;
  const center = cellCenter(die.col, die.row);
  const edge = (DIE_GRID / 2) * DIE_CELL;
  const others = state.fighters.filter((one) => one !== me && one.crushedAt === null);
  const isInDanger =
    danger !== null &&
    Math.abs(me.x - danger.x) < danger.half + RUNNER.radius &&
    Math.abs(me.z - danger.z) < danger.half + RUNNER.radius;
  let best = { x: 0, z: 0, score: Number.NEGATIVE_INFINITY };
  for (let index = 0; index < FLEE_DIRECTIONS; index++) {
    const angle = (index / FLEE_DIRECTIONS) * Math.PI * 2;
    const x = Math.sin(angle);
    const z = Math.cos(angle);
    const px = me.x + x * FLEE_LOOK;
    const pz = me.z + z * FLEE_LOOK;
    const wall = Math.min(edge - Math.abs(px), edge - Math.abs(pz));
    const crowd = others.reduce(
      (sum, other) => sum + 1 / (1 + Math.hypot(other.x - px, other.z - pz)),
      0,
    );
    const inDanger =
      danger !== null &&
      Math.abs(px - danger.x) < danger.half + RUNNER.radius &&
      Math.abs(pz - danger.z) < danger.half + RUNNER.radius;
    const noise = hashUnit(`${state.seed}:${me.id}:${Math.floor(tick / 15)}:${index}`);
    const score =
      Math.min(6, Math.hypot(px - center.x, pz - center.z)) +
      Math.min(0, wall - 1.2) * 3 -
      crowd * 1.5 -
      (inDanger ? 20 : 0) +
      noise * RUNNER_NOISE[level];
    if (score > best.score) best = { x, z, score };
  }
  const leap = isInDanger && !me.held && rng.chance(RUNNER_LEAP[level]);
  return { move: { x: best.x, z: best.z }, primary: leap, secondary: false };
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

export const BIG_DIE: ArenaGame<BigDieState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
