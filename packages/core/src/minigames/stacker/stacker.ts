import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Empileur (02-mini-jeux.md, fiche 9) : chacun sa tour. Un bloc va et vient au-dessus d'elle ;
// on le lâche. La partie qui dépasse du bloc du dessous est coupée et tombe : le bloc suivant
// est donc plus étroit. Un bloc lâché à côté arrête la tour. La plus haute tour en 45 s gagne
// (à hauteur égale, celle qui y est arrivée la première). Tout se joue sur la touche
// principale ; les tours sont côte à côte, chacune pour soi.

/** Le chrono (secondes). */
export const STACK_TIME_LIMIT = 45;
/** Les tours, côte à côte (mètres entre deux tours). */
export const TOWER_SPACING = 7;
/** La largeur du socle (et donc du premier bloc), et la hauteur d'un bloc. */
export const BASE_WIDTH = 2.6;
export const BLOCK_HEIGHT = 0.5;
/** Le bloc va et vient jusqu'à cette distance du milieu de la tour, de part et d'autre. */
export const SWING = 2.2;
/**
 * Sa vitesse (m/s) : SPEED_START au premier bloc, SPEED_STEP de plus à chaque étage, jusqu'à
 * SPEED_MAX, et à chaque étage un peu plus ou un peu moins (SPEED_SPREAD, au hasard de la
 * partie, le même pour tout le monde au même étage) pour qu'on ne lâche pas en rythme.
 * Plus douce (0,09 par étage), on montait à 20 blocs sans difficulté (retour de test).
 */
const SPEED_START = 2.2;
const SPEED_STEP = 0.15;
const SPEED_MAX = 6.5;
const SPEED_SPREAD = 0.12;
/** Un bloc lâché presque pile (à cet écart près) se pose pile : rien n'est coupé. */
export const PERFECT_SNAP = 0.07;
/** Après un bloc posé, le suivant apparaît au bout de ce temps (secondes). */
const SPAWN_DELAY = 0.35;

/** Un bloc posé : son milieu et sa largeur (sur l'axe où il va et vient). */
export type StackBlock = { x: number; width: number };

/** Le morceau coupé du dernier bloc (ou tout le bloc, raté) : il tombe, le client le montre. */
export type StackCut = { x: number; width: number; level: number; at: number };

export type StackFighter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** La tour, du socle (niveau 0) au sommet. */
  blocks: StackBlock[];
  /** Le pas où le bloc en mouvement est apparu, ou null (entre deux blocs, ou tour finie). */
  movingSince: number | null;
  /** La vitesse du bloc en mouvement (m/s), tirée à son apparition. */
  speed: number;
  /** Le pas où le prochain bloc apparaîtra (après une pose). */
  spawnAt: number | null;
  /** Un bloc lâché à côté : la tour est finie. */
  isDone: boolean;
  /** Le pas du dernier bloc posé (départage : le premier arrivé à sa hauteur). */
  placedAt: number;
  /** Le dernier bloc posé l'a été pile. */
  wasPerfect: boolean;
  cut: StackCut | null;
  held: boolean;
};

export type StackState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: StackFighter[];
};

/** La hauteur d'une tour : ses blocs posés, socle non compris. */
export function towerHeight(fighter: StackFighter): number {
  return fighter.blocks.length - 1;
}

/** La vitesse du bloc de cet étage, dans cette partie. */
function speedAt(seed: number, level: number): number {
  const spread = (hashUnit(`${seed}:speed:${level}`) * 2 - 1) * SPEED_SPREAD;
  return Math.min(SPEED_MAX, SPEED_START + (level - 1) * SPEED_STEP) * (1 + spread);
}

/**
 * Où est le bloc en mouvement à ce pas (son milieu, sur l'axe), ou null. Il part d'un côté (un
 * étage sur deux de l'autre) et fait l'aller-retour entre -SWING et +SWING.
 */
export function movingBlockX(fighter: StackFighter, tick: number): number | null {
  if (fighter.movingSince === null || fighter.isDone) return null;
  const level = fighter.blocks.length;
  const travelled = (tick - fighter.movingSince) * ARENA_STEP * fighter.speed;
  const lap = SWING * 4;
  const along = travelled % lap;
  // Un aller (0 à 2 SWING) puis un retour : une onde en triangle.
  const offset = along < SWING * 2 ? along : lap - along;
  const side = level % 2 === 0 ? 1 : -1;
  return side * (offset - SWING);
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): StackState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      blocks: [{ x: 0, width: BASE_WIDTH }],
      movingSince: 0,
      speed: speedAt(seed, 1),
      spawnAt: null,
      isDone: false,
      placedAt: 0,
      wasPerfect: false,
      cut: null,
      held: false,
    })),
  };
}

function step(state: StackState, inputs: Partial<Record<PlayerId, ArenaInput>>): StackState {
  const tick = state.tick + 1;
  const isTimeUp = !state.practice && tick * ARENA_STEP >= STACK_TIME_LIMIT;
  const fighters = state.fighters.map((fighter) => {
    const next = { ...fighter };
    const pressing = (inputs[fighter.id] ?? IDLE_INPUT).primary;
    const isPress = pressing && !fighter.held;
    next.held = pressing;
    if (next.spawnAt !== null && tick >= next.spawnAt) {
      next.movingSince = tick;
      next.speed = speedAt(state.seed, next.blocks.length);
      next.spawnAt = null;
    }
    const x = movingBlockX(next, tick);
    if (!isPress || x === null || isTimeUp) return next;
    return drop(next, x, tick, state.practice);
  });
  return { ...state, tick, fighters };
}

/** Il lâche le bloc en `x` : posé (coupé de ce qui dépasse), pile, ou à côté. */
function drop(fighter: StackFighter, x: number, tick: number, practice: boolean): StackFighter {
  const top = fighter.blocks.at(-1) ?? { x: 0, width: BASE_WIDTH };
  const width = top.width;
  const level = fighter.blocks.length;
  if (Math.abs(x - top.x) <= PERFECT_SNAP) {
    return place(fighter, { x: top.x, width }, null, true, tick);
  }
  const left = Math.max(x - width / 2, top.x - top.width / 2);
  const right = Math.min(x + width / 2, top.x + top.width / 2);
  if (right <= left) {
    const missed: StackCut = { x, width, level, at: tick };
    const stopped = { ...fighter, movingSince: null, cut: missed, wasPerfect: false };
    // Au bac à sable, on recommence sa tour ; sinon, elle est finie.
    if (!practice) return { ...stopped, isDone: true };
    const spawnAt = tick + Math.round(SPAWN_DELAY / ARENA_STEP);
    return { ...stopped, blocks: [{ x: 0, width: BASE_WIDTH }], spawnAt };
  }
  // Ce qui dépasse, du côté où il est lâché, tombe.
  const kept = { x: (left + right) / 2, width: right - left };
  const overhang = width - kept.width;
  const cutX = x > top.x ? right + overhang / 2 : left - overhang / 2;
  return place(fighter, kept, { x: cutX, width: overhang, level, at: tick }, false, tick);
}

function place(
  fighter: StackFighter,
  block: StackBlock,
  cut: StackCut | null,
  isPerfect: boolean,
  tick: number,
): StackFighter {
  return {
    ...fighter,
    blocks: [...fighter.blocks, block],
    movingSince: null,
    spawnAt: tick + Math.round(SPAWN_DELAY / ARENA_STEP),
    placedAt: tick,
    wasPerfect: isPerfect,
    cut,
  };
}

function timeLeft(state: StackState): number | null {
  return state.practice ? null : Math.max(0, STACK_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: StackState): boolean {
  if (state.practice) return false;
  return (timeLeft(state) ?? 1) <= 0 || state.fighters.every((fighter) => fighter.isDone);
}

/** Le classement : la plus haute tour, puis la première arrivée à sa hauteur ; sinon ex aequo. */
function ranking(state: StackState): PlayerId[][] {
  const sorted = [...state.fighters].sort(
    (a, b) => towerHeight(b) - towerHeight(a) || a.placedAt - b.placedAt,
  );
  const groups: PlayerId[][] = [];
  sorted.forEach((fighter, index) => {
    const before = sorted[index - 1];
    const isTied =
      before &&
      towerHeight(before) === towerHeight(fighter) &&
      before.placedAt === fighter.placedAt;
    if (isTied) groups.at(-1)?.push(fighter.id);
    else groups.push([fighter.id]);
  });
  return groups;
}

/**
 * Le bot vise le milieu du bloc du dessous, avec une erreur (en mètres) qui dépend de son
 * niveau et grandit avec la vitesse du bloc (et parfois un raté de main) ; il lâche quand le
 * bloc passe sur sa visée. Son
 * erreur ne change pas pendant qu'un même bloc va et vient.
 */
const AIM_NOISE: Record<BotLevel, number> = { easy: 0.28, normal: 0.19, expert: 0.165 };
/** Parfois, un raté de main : l'erreur est triplée (de quoi qu'un Expert perde aussi). */
const SLIP: Record<BotLevel, number> = { easy: 0.08, normal: 0.06, expert: 0.06 };
const SLIP_FACTOR = 3;

function botInput(state: StackState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me) return IDLE_INPUT;
  const now = movingBlockX(me, state.tick);
  const next = movingBlockX(me, state.tick + 1);
  const top = me.blocks.at(-1);
  if (now === null || next === null || !top || me.held) return IDLE_INPUT;
  const height = me.blocks.length;
  const haste = me.speed / SPEED_START;
  const key = `${state.seed}:${player}:${height}`;
  const slip = hashUnit(`${key}:slip`) < SLIP[level] ? SLIP_FACTOR : 1;
  const error = (hashUnit(key) * 2 - 1) * AIM_NOISE[level] * haste * slip;
  const aim = top.x + error;
  // Le bloc passe sur sa visée pendant le prochain pas : il lâche.
  const crosses = (now - aim) * (next - aim) <= 0;
  return { ...IDLE_INPUT, primary: crosses };
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

export const STACKER: ArenaGame<StackState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
