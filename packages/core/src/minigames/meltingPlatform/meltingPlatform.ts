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

// Plateforme fondante (02-mini-jeux.md, fiche 1) : trois niveaux de tuiles hexagonales
// superposés au-dessus du vide. Une tuile où l'on se tient se fissure, puis tombe une seconde
// plus tard : on a le temps de la quitter. On tombe alors au niveau du dessous ; celui qui tombe
// du dernier est éliminé. Dernier debout gagne. Les corps sont ceux des arènes (arena/body.ts),
// avec un saut court pour franchir une tuile tombée.

/** Les niveaux, du haut (0) au bas, et la hauteur entre deux niveaux. */
export const MELT_LEVELS = 3;
export const LEVEL_HEIGHT = 5;
/** Une tuile : un hexagone pointe en haut, de ce rayon (centre au coin), en mètres. */
export const HEX_SIZE = 1.1;
/** Le plateau de chaque niveau : un grand hexagone de tuiles, de ce rayon (en tuiles). */
const BOARD_RADIUS = 5;
const BIG_BOARD_RADIUS = 6;
/** À partir de ce nombre de joueurs, les niveaux sont plus grands. */
const BIG_TABLE = 5;
/** Une tuile fissurée tombe au bout de ce temps ; après HURRY_AT, plus vite (une fin garantie). */
export const CRACK_TIME = 1;
const HURRY_CRACK_TIME = 0.5;
export const HURRY_AT = 60;
/** Le chrono (secondes) : les survivants sont alors classés par niveau, les dés les départagent. */
export const MELT_TIME_LIMIT = 90;
/**
 * Un corps à peine sous le dessus d'une tuile (il tombait au bord d'un trou et passe au-dessus
 * d'une tuile intacte) se rattrape et remonte dessus ; sinon il passerait à travers son bord.
 */
const STEP_UP = 0.35;
/** Plus bas que ça, on est tombé du dernier niveau. */
const OUT_BELOW = -4;
/** Au bac à sable, une tuile tombée revient au bout de ce temps. */
const REGROW_TIME = 3;
/**
 * Le marcheur des arènes, plus prudent (on avance tuile par tuile : à pleine vitesse, quatre
 * joueurs faisaient fondre trois niveaux en 15 s), avec un saut court : de quoi franchir une
 * tuile tombée avec un peu d'élan.
 */
const MELT_WALKER: BodyTuning = { ...WALKER, walkSpeed: 3.2, jumpSpeed: 7 };
/**
 * Le saut est un bond en avant : on part à cette vitesse dans la direction où l'on va (environ
 * 3 m, de quoi franchir une tuile tombée ; à la vitesse de marche, il retombait dans le trou).
 */
const LEAP_SPEED = 4.5;

/** Une tuile : ses coordonnées axiales (q, r), et le pas où elle s'est fissurée, ou null. */
export type MeltTile = { q: number; r: number; crackedAt: number | null };

export type MeltFighter = ArenaBody & {
  /** La touche de saut tenue au pas précédent : il saute quand on appuie, pas en tenant. */
  held: boolean;
  /** Le pas où il est tombé du dernier niveau, ou null. */
  fellAt: number | null;
};

export type MeltState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** Les tuiles de chaque niveau, du haut au bas, rangées dans le même ordre à chaque niveau. */
  levels: MeltTile[][];
  /** Le rayon du plateau, en tuiles. */
  radius: number;
  fighters: MeltFighter[];
};

/** La hauteur du dessus d'un niveau. */
export function levelHeight(level: number): number {
  return (MELT_LEVELS - 1 - level) * LEVEL_HEIGHT;
}

/** Le centre d'une tuile, sur le plan. */
export function tileCenter(q: number, r: number): { x: number; z: number } {
  return { x: HEX_SIZE * Math.sqrt(3) * (q + r / 2), z: HEX_SIZE * 1.5 * r };
}

/** La tuile sous un point du plan (coordonnées axiales arrondies à l'hexagone le plus proche). */
export function tileAt(x: number, z: number): { q: number; r: number } {
  const fq = ((Math.sqrt(3) / 3) * x - z / 3) / HEX_SIZE;
  const fr = ((2 / 3) * z) / HEX_SIZE;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  // `+ 0` : jamais de -0, pour que la clé d'une tuile soit toujours la même.
  return { q: q + 0, r: r + 0 };
}

/** Le temps de fissure d'une tuile fissurée à ce pas : plus court passé HURRY_AT. */
function crackTime(crackedAt: number): number {
  return crackedAt * ARENA_STEP >= HURRY_AT ? HURRY_CRACK_TIME : CRACK_TIME;
}

/** La tuile est tombée (ou partie) à ce pas. */
export function isFallen(tile: MeltTile, tick: number): boolean {
  return (
    tile.crackedAt !== null && (tick - tile.crackedAt) * ARENA_STEP >= crackTime(tile.crackedAt)
  );
}

/** Les tuiles d'un niveau, rangées par clé "q,r" pour les retrouver vite. */
function tileIndex(state: MeltState): Map<string, number> {
  const index = new Map<string, number>();
  state.levels[0]?.forEach(({ q, r }, i) => {
    index.set(`${q},${r}`, i);
  });
  return index;
}

/** Le niveau d'un corps posé à la hauteur `y`, ou null s'il est entre deux. */
function levelOf(y: number): number | null {
  const level = levelBelow(y);
  return Math.abs(levelHeight(level) - y) < 1e-3 ? level : null;
}

/** Le niveau à la hauteur `y` ou juste en dessous (en l'air, celui sur lequel on retombe). */
function levelBelow(y: number): number {
  const level = MELT_LEVELS - 1 - Math.floor(y / LEVEL_HEIGHT + 1e-6);
  return Math.min(MELT_LEVELS - 1, Math.max(0, level));
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): MeltState {
  const radius = players.length >= BIG_TABLE ? BIG_BOARD_RADIUS : BOARD_RADIUS;
  const tiles: { q: number; r: number }[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      tiles.push({ q, r });
    }
  }
  const top = levelHeight(0);
  return {
    tick: 0,
    practice,
    seed,
    radius,
    levels: Array.from({ length: MELT_LEVELS }, () =>
      tiles.map(({ q, r }) => ({ q, r, crackedAt: null })),
    ),
    fighters: players.map((id, index) => {
      // En cercle sur le niveau du haut, chacun regardant le centre.
      const angle = (index / players.length) * Math.PI * 2;
      const reach = players.length === 1 ? 0 : radius * HEX_SIZE * 0.9;
      const x = Math.sin(angle) * reach;
      const z = Math.cos(angle) * reach;
      return { ...createBody(id, x, z, Math.atan2(-x, -z), top), held: false, fellAt: null };
    }),
  };
}

function step(state: MeltState, inputs: Partial<Record<PlayerId, ArenaInput>>): MeltState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const index = tileIndex(state);
  // Une copie des tuiles : on en fissure pendant le pas, l'état précédent ne bouge pas.
  const levels = state.levels.map((tiles) =>
    tiles.map((tile) => {
      // Au bac à sable, une tuile tombée finit par revenir.
      const isBack =
        state.practice &&
        tile.crackedAt !== null &&
        (tick - tile.crackedAt) * ARENA_STEP >= crackTime(tile.crackedAt) + REGROW_TIME;
      return { ...tile, crackedAt: isBack ? null : tile.crackedAt };
    }),
  );
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  const braced = new Set<PlayerId>();
  for (const fighter of standing) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    walkBody(fighter, input.move, MELT_WALKER, dt);
    if (input.primary && !fighter.held && !isAirborne(fighter)) {
      jumpBody(fighter, MELT_WALKER);
      leap(fighter, input.move);
    }
    fighter.held = input.primary;
    if (Math.hypot(input.move.x, input.move.z) <= 0.1 && !isAirborne(fighter)) {
      braced.add(fighter.id);
    }
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas (aucune place
  // n'avantage).
  const shift = tick % Math.max(1, standing.length);
  collideBodies([...standing.slice(shift), ...standing.slice(0, shift)], MELT_WALKER, braced);
  const tileUnder = (level: number, x: number, z: number) => {
    const { q, r } = tileAt(x, z);
    const at = index.get(`${q},${r}`);
    return at === undefined ? undefined : levels[level]?.[at];
  };
  moveBodies(standing, MELT_WALKER, dt, (body) => {
    // Le plus haut niveau dont la tuile tient encore, à sa hauteur ou en dessous (à STEP_UP près).
    for (let level = 0; level < MELT_LEVELS; level++) {
      if (levelHeight(level) > body.y + STEP_UP) continue;
      const tile = tileUnder(level, body.x, body.z);
      if (tile && !isFallen(tile, tick)) return levelHeight(level);
    }
    return null;
  });
  for (const fighter of standing) {
    // Debout sur une tuile intacte : elle se fissure.
    const level = fighter.onGround ? levelOf(fighter.y) : null;
    if (level !== null) {
      const tile = tileUnder(level, fighter.x, fighter.z);
      if (tile && tile.crackedAt === null) tile.crackedAt = tick;
    }
    if (fighter.y > OUT_BELOW) continue;
    if (state.practice) {
      // Au bac à sable, on revient en haut, au centre.
      Object.assign(fighter, createBody(fighter.id, 0, 0, fighter.facing, levelHeight(0)));
    } else {
      fighter.fellAt = tick;
    }
  }
  return { ...state, tick, levels, fighters };
}

/** Il bondit vers où il va (devant lui, s'il ne va nulle part). */
function leap(fighter: MeltFighter, move: { x: number; z: number }): void {
  const length = Math.hypot(move.x, move.z);
  const dirX = length > 0.1 ? move.x / length : Math.sin(fighter.facing);
  const dirZ = length > 0.1 ? move.z / length : Math.cos(fighter.facing);
  fighter.vx = dirX * LEAP_SPEED;
  fighter.vz = dirZ * LEAP_SPEED;
}

function standingFighters(state: MeltState): MeltFighter[] {
  return state.fighters.filter((fighter) => fighter.fellAt === null);
}

function timeLeft(state: MeltState): number | null {
  return state.practice ? null : Math.max(0, MELT_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: MeltState): boolean {
  if (state.practice) return false;
  const alive = standingFighters(state).length;
  return alive === 0 || (state.fighters.length > 1 && alive <= 1) || (timeLeft(state) ?? 1) <= 0;
}

/**
 * Le classement : ceux encore debout d'abord, du niveau le plus haut au plus bas (au chrono,
 * ceux d'un même niveau sont ex aequo : les dés les départageront), puis les tombés, du dernier
 * tombé au premier. Tombés au même pas : ex aequo.
 */
function ranking(state: MeltState): PlayerId[][] {
  const byLevel = new Map<number, PlayerId[]>();
  for (const fighter of standingFighters(state)) {
    // En l'air entre deux niveaux, il compte pour le niveau du dessous.
    const level = levelBelow(fighter.y);
    byLevel.set(level, [...(byLevel.get(level) ?? []), fighter.id]);
  }
  const alive = [...byLevel.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids);
  const fallen = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    if (fighter.fellAt === null) continue;
    fallen.set(fighter.fellAt, [...(fallen.get(fighter.fellAt) ?? []), fighter.id]);
  }
  const byFall = [...fallen.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return [...alive, ...byFall];
}

/**
 * Le bot avance comme un joueur prudent : il reste sur sa tuile tant qu'elle tient (BOT_STAY),
 * puis passe sur une tuile intacte proche (à deux tuiles au plus : il saute s'il y a un trou),
 * de préférence entourée de tuiles intactes (pour ne pas s'enfermer), au-dessus d'une tuile
 * intacte du niveau du dessous (au cas où il tombe), et loin des autres. Plus rien autour : il
 * va vers des tuiles intactes plus loin, ou se laisse tomber sur le niveau du dessous. Son
 * niveau règle sa clairvoyance (le Facile se trompe souvent de tuile, et s'enferme parfois) et
 * la sûreté de ses sauts.
 */
const BOT_NOISE: Record<BotLevel, number> = { easy: 3, normal: 1.4, expert: 0.9 };
/** Les tuiles proches, en tuiles ; plus loin, il ne regarde que jusqu'à BOT_SIGHT (mètres). */
const BOT_NEAR = 2;
const BOT_SIGHT = 8;
/** Il saute quand le trou est à cette distance devant lui. */
const JUMP_LOOK = 1.2;
/**
 * Sur une tuile qui vient de se fissurer, il attend cette part du temps de fissure avant de
 * partir (il ne gâche pas les tuiles en courant partout) ; le Facile repart trop tôt.
 */
const BOT_STAY: Record<BotLevel, number> = { easy: 0.1, normal: 0.3, expert: 0.35 };
/**
 * Devant un trou, il pense à sauter : une chance à chaque pas, selon son niveau (le Facile y
 * pense parfois trop tard et tombe dedans).
 */
const JUMP_SKILL: Record<BotLevel, number> = { easy: 0.1, normal: 0.25, expert: 0.6 };

function botInput(state: MeltState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null) return IDLE_INPUT;
  // En l'air : il garde le cap.
  if (isAirborne(me)) {
    const speed = Math.hypot(me.vx, me.vz);
    const move = speed > 0.1 ? { x: me.vx / speed, z: me.vz / speed } : { x: 0, z: 0 };
    return { move, primary: false, secondary: false };
  }
  const index = tileIndex(state);
  const tileOf = (lvl: number, q: number, r: number) => {
    const at = index.get(`${q},${r}`);
    return at === undefined ? undefined : state.levels[lvl]?.[at];
  };
  const here = levelBelow(me.y);
  const under = tileAt(me.x, me.z);
  // Sur une tuile qui tient encore un moment : il y reste.
  const mine = tileOf(here, under.q, under.r);
  if (mine?.crackedAt != null) {
    const since = (state.tick - mine.crackedAt) * ARENA_STEP;
    if (since < BOT_STAY[level] * crackTime(mine.crackedAt)) return IDLE_INPUT;
  }
  const others = standingFighters(state).filter((f) => f.id !== player);
  // Son hasard ne change pas tant qu'il est sur la même tuile : il ne change pas d'avis en route.
  const thought = `${state.seed}:${player}:${under.q},${under.r}:${mine?.crackedAt ?? '-'}`;
  const choose = (target: number, isNear: boolean) => {
    let best: { x: number; z: number; score: number } | null = null;
    for (const tile of state.levels[target] ?? []) {
      if (tile.crackedAt !== null) continue;
      const steps = hexDistance(under, tile);
      const { x, z } = tileCenter(tile.q, tile.r);
      const distance = Math.hypot(x - me.x, z - me.z);
      if (isNear ? steps === 0 || steps > BOT_NEAR : distance > BOT_SIGHT) continue;
      const neighbours = HEX_NEIGHBOURS.filter(
        ([dq, dr]) => tileOf(target, tile.q + dq, tile.r + dr)?.crackedAt === null,
      ).length;
      const below =
        target + 1 < MELT_LEVELS && tileOf(target + 1, tile.q, tile.r)?.crackedAt === null;
      const crowd = others.reduce(
        (sum, other) => sum + 1 / (1 + Math.hypot(other.x - x, other.z - z)),
        0,
      );
      const noise = hashUnit(`${thought}>${tile.q},${tile.r}`) * BOT_NOISE[level];
      const score = neighbours + (below ? 0.8 : 0) - distance * 0.35 - crowd * 2 + noise;
      if (!best || score > best.score) best = { x, z, score };
    }
    return best;
  };
  // Une tuile proche ; sinon une plus loin ; sinon il se laisse tomber au niveau du dessous.
  const best = choose(here, true) ?? choose(here, false) ?? choose(here + 1, false);
  if (!best) return IDLE_INPUT;
  const dx = best.x - me.x;
  const dz = best.z - me.z;
  const gap = Math.hypot(dx, dz);
  const move = gap < 0.3 ? { x: 0, z: 0 } : { x: dx / gap, z: dz / gap };
  // Un vrai trou juste devant, et la tuile visée au-delà : il saute (s'il y pense).
  const ahead = tileAt(me.x + move.x * JUMP_LOOK, me.z + move.z * JUMP_LOOK);
  const hole = tileOf(here, ahead.q, ahead.r);
  const isHole = gap > JUMP_LOOK && (hole === undefined || isFallen(hole, state.tick));
  const jump = isHole && rng.chance(JUMP_SKILL[level]);
  return { move, primary: jump, secondary: false };
}

/** Le nombre de pas d'une tuile à l'autre. */
function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Les six voisines d'une tuile, en coordonnées axiales. */
const HEX_NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
] as const;

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

export const MELTING_PLATFORM: ArenaGame<MeltState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
