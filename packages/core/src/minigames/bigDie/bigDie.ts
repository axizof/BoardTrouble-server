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
// retombe. Il penche un instant avant de basculer (on lit où il va), peut sauter deux cases en
// avant pour retomber sur les 3 x 3 cases autour, et lancer deux fois par partie des mini-dés enflammés dans
// les quatre directions. Les autres courent et bondissent pour l'esquiver jusqu'au bout du
// chrono ; le dé gagne s'il les écrase tous. Les coureurs sont les corps des arènes
// (arena/body.ts) ; le dé, lui, ne quitte jamais sa grille.

/** Une case de la grille, en mètres : le dé en occupe une. */
export const DIE_CELL = 1.6;
/**
 * La grille : tant de cases de côté (impair : le dé part du centre). La même à 6 : plus grande,
 * le dé n'y coinçait plus personne.
 */
export const DIE_GRID = 7;
const BIG_TABLE = 5;
/**
 * Le chrono, en secondes : les coureurs qui tiennent jusque-là gagnent. Le dé doit tous les
 * écraser : 30 s pour trois, 45 s pour cinq. Depuis que les coureurs n'ont plus qu'un bond, il
 * gagne entre bots Normaux ou Experts 6 à 7 parties sur 10 à 4 (avec 40 et 60 s : 9 sur 10).
 */
export const DIE_TIME_LIMIT = 30;
const BIG_TIME_LIMIT = 45;
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
/**
 * Le saut l'emmène tant de cases en avant (retour du test : sur place, il s'esquivait trop
 * facilement) : vers où l'on pousse, sinon dans le sens de sa dernière bascule.
 */
export const SLAM_REACH = 2;
/**
 * Les mini-dés enflammés (retour du test : le dé doit pouvoir finir le dernier coureur) : tant
 * de lancers par partie. Le dé se charge (les quatre lignes de cases rougissent), puis un mini-dé
 * part dans chaque direction, presque deux fois plus vite que lui, jusqu'au rebord. Il élimine
 * le premier coureur qu'il touche et disparaît ; un bond bien placé passe par-dessus.
 */
export const FIRE_THROWS = 2;
export const FIRE_WINDUP_TICKS = 12;
export const FIRE_SPEED = 9;
/**
 * La moitié de la taille d'un mini-dé (m). Un coureur en bond dont les pieds sont plus haut que
 * ça passe par-dessus : à sa hauteur entière, il fallait bondir à moins de 0,1 s près.
 */
export const FIRE_HALF = 0.35;
/** Un mini-dé arrêté (contre le rebord ou un coureur) reste tant de pas, le temps de s'éteindre. */
export const FIRE_FADE_TICKS = 15;
/** Les quatre directions de la grille : celles des mini-dés, des bascules et des sauts. */
const ROLL_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
/**
 * Le coureur : le marcheur des arènes, un peu plus rapide que le dé (5,4 m/s contre 4,8) : sans
 * bond à volonté, c'est en gardant ses distances qu'il lui échappe. Et un bond pour esquiver.
 */
const RUNNER: BodyTuning = { ...WALKER, walkSpeed: 5.4, jumpSpeed: 6 };
const LEAP_SPEED = 6.5;
/**
 * Les bonds d'un coureur par partie (retour du test : à volonté, le bond sauvait de tout). Au bac
 * à sable, ils ne s'épuisent pas.
 */
export const RUNNER_LEAPS = 1;
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
  /** Il saute au pas `at`, et retombe `ticks` pas plus tard sur la case (`col`, `row`). */
  | { type: 'slam'; at: number; ticks: number; col: number; row: number }
  /** Il se charge depuis le pas `at`, puis lance ses mini-dés. */
  | { type: 'fire'; at: number }
  | { type: 'recover'; at: number };

export type BigDie = {
  id: PlayerId;
  /** Sa case (celle d'où il part, pendant une bascule). */
  col: number;
  row: number;
  motion: DieMotion;
  /** Le pas à partir duquel il peut sauter à nouveau. */
  slamReadyAt: number;
  /** Le sens de sa dernière bascule (une direction de la grille) : celui du saut, par défaut. */
  heading: { dx: number; dz: number };
  /** Les lancers de mini-dés qui lui restent. */
  throwsLeft: number;
  /** Les touches tenues au pas précédent (on agit à l'appui), et l'action demandée en attente. */
  held: { primary: boolean; secondary: boolean };
  queued: 'slam' | 'fire' | null;
  /** Les faces vers le haut, vers le sud (+z) et vers l'est (+x) ; les autres sont à 7 moins elles. */
  top: number;
  south: number;
  east: number;
};

export type DieRunner = ArenaBody & {
  /** La touche de bond tenue au pas précédent : il bondit quand on appuie, pas en tenant. */
  held: boolean;
  /** Les bonds qui lui restent. */
  leapsLeft: number;
  /** Le pas où il a été écrasé (au bac à sable, il revient), ou null. */
  crushedAt: number | null;
  /** Le pas où il est éliminé, ou null (jamais au bac à sable). */
  fellAt: number | null;
};

/** Un mini-dé enflammé : où il est, où il va (une direction de la grille), et s'il est arrêté. */
export type FireDie = {
  id: number;
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** Le pas où il s'est arrêté (rebord ou coureur), ou null s'il roule encore. */
  endedAt: number | null;
};

export type BigDieState = {
  tick: number;
  practice: boolean;
  seed: number;
  die: BigDie;
  /** Les coureurs (le dé n'en fait pas partie). */
  fighters: DieRunner[];
  fires: FireDie[];
};

/** Le centre d'une case, sur le plan (la grille est centrée sur l'origine). */
export function cellCenter(col: number, row: number): { x: number; z: number } {
  const offset = ((DIE_GRID - 1) / 2) * DIE_CELL;
  return { x: col * DIE_CELL - offset, z: row * DIE_CELL - offset };
}

/**
 * Les coureurs à écraser pour que le dé gagne : tous (retour du test : gagner avec un coureur
 * encore debout, c'était bizarre).
 */
export function crushesNeeded(state: BigDieState): number {
  return state.fighters.length;
}

/** Jusqu'où roule un mini-dé (m, depuis le centre) : contre le rebord. */
const FIRE_EDGE = (DIE_GRID / 2) * DIE_CELL - FIRE_HALF;

/**
 * Ce que les mini-dés vont balayer : pendant que le dé se charge, ses quatre lignes ; ensuite,
 * devant chaque mini-dé qui roule, jusqu'au rebord. Des bandes (centre et demi-tailles).
 */
export function fireLanes(
  state: BigDieState,
): { x: number; z: number; halfX: number; halfZ: number }[] {
  const { die } = state;
  const center = cellCenter(die.col, die.row);
  const starts =
    die.motion.type === 'fire'
      ? ROLL_DIRECTIONS.map(([dx, dz]) => ({
          x: center.x + (dx * DIE_CELL) / 2,
          z: center.z + (dz * DIE_CELL) / 2,
          dx,
          dz,
        }))
      : state.fires.filter((fire) => fire.endedAt === null);
  return starts.map(({ x, z, dx, dz }) => {
    const endX = dx === 0 ? x : dx * FIRE_EDGE;
    const endZ = dz === 0 ? z : dz * FIRE_EDGE;
    return {
      x: (x + endX) / 2,
      z: (z + endZ) / 2,
      halfX: Math.abs(endX - x) / 2 + FIRE_HALF,
      halfZ: Math.abs(endZ - z) / 2 + FIRE_HALF,
    };
  });
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
      // Vers la caméra : le premier saut, sans direction, part vers le bas de l'écran.
      heading: { dx: 0, dz: 1 },
      throwsLeft: FIRE_THROWS,
      held: { primary: false, secondary: false },
      queued: null,
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
        leapsLeft: RUNNER_LEAPS,
        crushedAt: null,
        fellAt: null,
      };
    }),
    fires: [],
  };
}

function step(state: BigDieState, inputs: Partial<Record<PlayerId, ArenaInput>>): BigDieState {
  const tick = state.tick + 1;
  const die = { ...state.die };
  const fighters = state.fighters.map((runner) => ({ ...runner }));
  // Les mini-dés arrêtés s'effacent ; les autres sont copiés : ils vont rouler.
  const fires = state.fires
    .filter((fire) => fire.endedAt === null || tick - fire.endedAt < FIRE_FADE_TICKS)
    .map((fire) => ({ ...fire }));
  const next = { ...state, tick, die, fighters, fires };
  for (const runner of fighters) {
    if (state.practice && runner.crushedAt !== null) respawn(next, runner);
  }
  const running = fighters.filter((runner) => runner.crushedAt === null);
  moveRunners(next, running, inputs);
  const dieInput = inputs[die.id] ?? (state.practice ? dummyDieInput(next) : IDLE_INPUT);
  advanceDie(next, dieInput, running);
  rollFires(next, running);
  return next;
}

/** Les mini-dés roulent : le premier coureur touché est éliminé, le rebord les arrête. */
function rollFires(state: BigDieState, running: DieRunner[]): void {
  for (const fire of state.fires) {
    if (fire.endedAt !== null) continue;
    fire.x += fire.dx * FIRE_SPEED * ARENA_STEP;
    fire.z += fire.dz * FIRE_SPEED * ARENA_STEP;
    const victim = running.find(
      (runner) =>
        runner.crushedAt === null &&
        runner.y < FIRE_HALF &&
        Math.abs(runner.x - fire.x) < FIRE_HALF + RUNNER.radius &&
        Math.abs(runner.z - fire.z) < FIRE_HALF + RUNNER.radius,
    );
    if (victim) {
      eliminate(state, victim);
      fire.endedAt = state.tick;
      continue;
    }
    if (Math.abs(fire.x) >= FIRE_EDGE || Math.abs(fire.z) >= FIRE_EDGE) {
      fire.x = Math.max(-FIRE_EDGE, Math.min(FIRE_EDGE, fire.x));
      fire.z = Math.max(-FIRE_EDGE, Math.min(FIRE_EDGE, fire.z));
      fire.endedAt = state.tick;
    }
  }
}

/** Écrasé ou brûlé : il reste à plat ; éliminé, sauf au bac à sable. */
function eliminate(state: BigDieState, runner: DieRunner): void {
  runner.crushedAt = state.tick;
  runner.vx = 0;
  runner.vz = 0;
  if (!state.practice) runner.fellAt = state.tick;
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
    if (input.primary && !runner.held && !isAirborne(runner) && runner.leapsLeft > 0) {
      jumpBody(runner, RUNNER);
      // Le saut peut être refusé (sonné) : il ne bondit (et ne le dépense) que s'il a décollé.
      if (runner.vy > 0) {
        leap(runner, input.move);
        if (!state.practice) runner.leapsLeft -= 1;
      }
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
    die.col = motion.col;
    die.row = motion.row;
    die.motion = { type: 'recover', at: tick };
    die.slamReadyAt = tick + Math.round(ramp(SLAM_COOLDOWN, state) / ARENA_STEP);
    crush(state, running, 1);
  }
  if (motion.type === 'recover' && tick - motion.at >= SLAM_RECOVER_TICKS) {
    die.motion = { type: 'idle' };
  }
  if (motion.type === 'fire' && tick - motion.at >= FIRE_WINDUP_TICKS) {
    die.motion = { type: 'idle' };
    launchFires(state);
  }
  // Un appui pendant une bascule ou un saut attend que le dé soit libre (au lieu de se perdre).
  if (input.primary && !die.held.primary) die.queued = 'slam';
  if (input.secondary && !die.held.secondary) die.queued = 'fire';
  die.held = { primary: input.primary, secondary: input.secondary };
  if (die.motion.type !== 'idle') return;
  const queued = die.queued;
  die.queued = null;
  if (queued === 'fire' && die.throwsLeft > 0) {
    die.motion = { type: 'fire', at: tick };
    // Au bac à sable, les lancers ne s'épuisent pas.
    if (!state.practice) die.throwsLeft -= 1;
    return;
  }
  const pushed = rollDirection(input.move);
  const isPushing = pushed.dx !== 0 || pushed.dz !== 0;
  // Espace tenu saute dès que le saut est prêt ; un appui pendant l'attente est oublié.
  if ((queued === 'slam' || input.primary) && tick >= die.slamReadyAt) {
    const heading = isPushing ? pushed : die.heading;
    const landing = slamLanding(die, heading);
    die.heading = heading;
    die.motion = { type: 'slam', at: tick, ticks: Math.round(ramp(SLAM_TICKS, state)), ...landing };
    return;
  }
  const col = die.col + pushed.dx;
  const row = die.row + pushed.dz;
  const isInside = col >= 0 && row >= 0 && col < DIE_GRID && row < DIE_GRID;
  if (!isPushing || !isInside) return;
  die.heading = pushed;
  die.motion = { type: 'roll', ...pushed, at: tick };
}

/** Où retombe un saut vers `heading` : SLAM_REACH cases plus loin, sans quitter la planche. */
function slamLanding(
  die: BigDie,
  heading: { dx: number; dz: number },
): { col: number; row: number } {
  const inside = (cell: number) => Math.max(0, Math.min(DIE_GRID - 1, cell));
  return {
    col: inside(die.col + heading.dx * SLAM_REACH),
    row: inside(die.row + heading.dz * SLAM_REACH),
  };
}

/** Un mini-dé part de chaque face du dé posée au sol. */
function launchFires(state: BigDieState): void {
  const center = cellCenter(state.die.col, state.die.row);
  ROLL_DIRECTIONS.forEach(([dx, dz], index) => {
    state.fires.push({
      id: state.tick * ROLL_DIRECTIONS.length + index,
      x: center.x + (dx * DIE_CELL) / 2,
      z: center.z + (dz * DIE_CELL) / 2,
      dx,
      dz,
      endedAt: null,
    });
  });
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
  const { die } = state;
  const center = cellCenter(die.col, die.row);
  const half = DIE_CELL * (reach + 0.5);
  for (const runner of running) {
    const isUnder = Math.abs(runner.x - center.x) < half && Math.abs(runner.z - center.z) < half;
    if (!isUnder) {
      shoveOut(runner, die.col, die.row, true);
      continue;
    }
    eliminate(state, runner);
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
const DIE_PAUSE: Record<BotLevel, number> = { easy: 0.86, normal: 0.66, expert: 0.3 };
const DIE_LEAD: Record<BotLevel, number> = { easy: 0, normal: 0.25, expert: 0.45 };
const DIE_SLAM: Record<BotLevel, number> = { easy: 0.04, normal: 0.12, expert: 0.25 };
/** Ses mini-dés : une chance à chaque pas quand un coureur est dans ses lignes, pas collé à lui. */
const DIE_FIRE: Record<BotLevel, number> = { easy: 0.03, normal: 0.07, expert: 0.16 };
/**
 * Le bot coureur fuit le dé et les murs, s'écarte des autres (le dé vise les groupes), et sort
 * de la case où le dé va retomber, en bondissant s'il le faut. Son niveau règle quand il remarque
 * la bascule ou le saut (en pas), et sa lucidité dans le choix de la fuite.
 */
const RUNNER_NOTICE: Record<BotLevel, number> = { easy: 5, normal: 3, expert: 1 };
const RUNNER_NOISE: Record<BotLevel, number> = { easy: 2.5, normal: 1.2, expert: 0.5 };
const RUNNER_LEAP: Record<BotLevel, number> = { easy: 0.25, normal: 0.4, expert: 0.8 };
const FLEE_DIRECTIONS = 16;
/**
 * Il garde tant de place (m) entre lui et les rebords : dans un coin, le dé le coince (sans son
 * bond illimité, les bots s'y faisaient tous écraser).
 */
const RUNNER_WALL_ROOM = 2;
/** Un pas de marge (en cases) autour de la ligne du dé : il ne s'y colle pas. */
const RUNNER_MARGIN = 0.3;
/** Il sort d'une zone avec tant de marge (m), et compte tant de temps (s) pour réagir. */
const EXIT_STEP = 0.1;
const REACTION_MARGIN = 0.1;
/** Un mini-dé à cette distance (m) : c'est le moment de bondir par-dessus. */
const FIRE_JUMP_RANGE = 1.3;
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
  if (state.tick >= die.slamReadyAt && rng.chance(DIE_SLAM[level])) {
    // Le saut qui retomberait sur le plus de coureurs, s'il y en a.
    const hits = ROLL_DIRECTIONS.map(([dx, dz]) => {
      const { col, row } = slamLanding(die, { dx, dz });
      const landing = cellCenter(col, row);
      const count = running.filter(
        (runner) =>
          Math.abs(runner.x - landing.x) < DIE_CELL * 1.5 &&
          Math.abs(runner.z - landing.z) < DIE_CELL * 1.5,
      ).length;
      return { dx, dz, count };
    });
    const best = hits.reduce((top, hit) => (hit.count > top.count ? hit : top));
    if (best.count > 0) return { ...IDLE_INPUT, primary: true, move: { x: best.dx, z: best.dz } };
  }
  const isInLine = (runner: DieRunner) =>
    !isClose(runner) &&
    (Math.abs(runner.x - center.x) < DIE_CELL / 2 || Math.abs(runner.z - center.z) < DIE_CELL / 2);
  if (die.throwsLeft > 0 && running.some(isInLine) && rng.chance(DIE_FIRE[level])) {
    return { ...IDLE_INPUT, secondary: true };
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
  // Ce qu'il fuit, une fois remarqué : la case d'arrivée du dé, les 3 x 3 du saut, et les lignes
  // des mini-dés (des bandes : centre et demi-tailles).
  const zones: { x: number; z: number; half: number }[] = [];
  if (noticed && motion.type === 'roll') {
    zones.push({ ...cellCenter(die.col + motion.dx, die.row + motion.dz), half: DIE_CELL / 2 });
  }
  if (noticed && motion.type === 'slam') {
    zones.push({ ...cellCenter(motion.col, motion.row), half: DIE_CELL * 1.5 });
  }
  // Posé, le dé peut basculer à tout moment sur une case voisine : il ne reste pas collé à lui
  // (ni ne fuit à travers sa case).
  if (motion.type === 'idle' || motion.type === 'recover' || motion.type === 'fire') {
    for (const [dx, dz] of [[0, 0], ...ROLL_DIRECTIONS]) {
      zones.push({ ...cellCenter(die.col + dx, die.row + dz), half: DIE_CELL / 2 });
    }
  }
  const dangers = zones.map(({ x, z, half }) => ({ x, z, halfX: half, halfZ: half }));
  if (noticed || motion.type !== 'fire') dangers.push(...fireLanes(state));
  const isIn = (x: number, z: number) =>
    dangers.some(
      (zone) =>
        Math.abs(x - zone.x) < zone.halfX + RUNNER.radius &&
        Math.abs(z - zone.z) < zone.halfZ + RUNNER.radius,
    );
  const center = cellCenter(die.col, die.row);
  const edge = (DIE_GRID / 2) * DIE_CELL;
  const others = state.fighters.filter((one) => one !== me && one.crushedAt === null);
  const isInDanger = isIn(me.x, me.z);
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
    const inDanger = isIn(px, pz);
    // Les cases d'où il ne pourrait plus s'échapper : collées au dé (sa prochaine bascule), et
    // celles de son saut, s'il est prêt. Il s'en tient loin plutôt que de compter sur son bond.
    const cols = Math.abs(px - center.x) / DIE_CELL;
    const rows = Math.abs(pz - center.z) / DIE_CELL;
    const isNextToDie = Math.min(cols, rows) < 0.5 + RUNNER_MARGIN && Math.max(cols, rows) < 1.5;
    const isInSlamReach =
      tick >= die.slamReadyAt && Math.min(cols, rows) < 1.5 && Math.max(cols, rows) < 3.5;
    const noise = hashUnit(`${state.seed}:${me.id}:${Math.floor(tick / 15)}:${index}`);
    const score =
      Math.min(6, Math.hypot(px - center.x, pz - center.z)) +
      Math.min(0, wall - RUNNER_WALL_ROOM) * 6 -
      crowd * 1.5 -
      (inDanger ? 20 : 0) -
      (isNextToDie ? 10 : 0) -
      (isInSlamReach ? 3 : 0) +
      noise * RUNNER_NOISE[level];
    if (score > best.score) best = { x, z, score };
  }
  // Il bondit hors de la case du dé, ou par-dessus un mini-dé tout près (s'il y pense).
  const isFireNear = state.fires.some(
    (fire) => fire.endedAt === null && Math.hypot(fire.x - me.x, fire.z - me.z) < FIRE_JUMP_RANGE,
  );
  // Son seul bond, gardé pour le dernier moment : le dé retombe bientôt, ou un mini-dé arrive.
  const landsIn =
    motion.type === 'roll'
      ? LEAN_TICKS + ROLL_TICKS - (tick - motion.at)
      : motion.type === 'slam'
        ? motion.ticks - (tick - motion.at)
        : Number.POSITIVE_INFINITY;
  // Dans une zone : il en sort par le côté le plus court (sans foncer dans le rebord ni dans une
  // autre zone), et ne bondit que si, en courant, il n'y arriverait pas à temps.
  const exit = isInDanger ? escapeRoute(me, dangers, isIn) : null;
  const isTooFar =
    exit !== null && exit.distance / RUNNER.walkSpeed > landsIn * ARENA_STEP - REACTION_MARGIN;
  const isThreat = isTooFar || isFireNear;
  const leap =
    isInDanger && isThreat && me.leapsLeft > 0 && !me.held && rng.chance(RUNNER_LEAP[level]);
  const move = exit ?? best;
  return { move: { x: move.x, z: move.z }, primary: leap, secondary: false };
}

/** La sortie la plus courte des zones où il est : une direction de la grille, et la distance. */
function escapeRoute(
  me: DieRunner,
  zones: { x: number; z: number; halfX: number; halfZ: number }[],
  isIn: (x: number, z: number) => boolean,
): { x: number; z: number; distance: number } | null {
  const edge = (DIE_GRID / 2) * DIE_CELL - RUNNER.radius;
  let route: { x: number; z: number; distance: number } | null = null;
  for (const zone of zones) {
    const reachX = zone.halfX + RUNNER.radius + EXIT_STEP;
    const reachZ = zone.halfZ + RUNNER.radius + EXIT_STEP;
    if (Math.abs(me.x - zone.x) >= reachX || Math.abs(me.z - zone.z) >= reachZ) continue;
    for (const [dx, dz] of ROLL_DIRECTIONS) {
      const toX = dx === 0 ? me.x : zone.x + dx * reachX;
      const toZ = dz === 0 ? me.z : zone.z + dz * reachZ;
      if (Math.abs(toX) > edge || Math.abs(toZ) > edge || isIn(toX, toZ)) continue;
      const distance = Math.hypot(toX - me.x, toZ - me.z);
      if (!route || distance < route.distance) route = { x: dx, z: dz, distance };
    }
  }
  return route;
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
