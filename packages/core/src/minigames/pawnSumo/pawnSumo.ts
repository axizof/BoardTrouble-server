import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  collideBodies,
  createBody,
  isSteady,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';

// Sumo des pions (02-mini-jeux.md, fiche 2) : bousculer les autres hors d'un plateau rond qui
// rétrécit. On marche, et on fonce (plus ou moins chargé) : c'est l'élan qui pousse. Les corps sont ceux des arènes
// (arena/body.ts) ; ici, l'élan, ses chocs et le plateau. Le plateau s'effrite anneau par anneau
// jusqu'à disparaître : il y a toujours un dernier debout. Un temps de sécurité très long termine
// quand même la partie si quelque chose tourne mal ; il n'est jamais atteint en jeu normal.

/** Le plateau : son rayon de départ, quand il commence à s'effriter et à quel rythme. */
export const SUMO_RADIUS = 7;
export const SHRINK_START = 15;
export const SHRINK_EVERY = 8;
/** Chaque effritement enlève un anneau de cette largeur, en tombant pendant SHRINK_FALL. */
export const SHRINK_RING = 1;
const SHRINK_FALL = 1;
/** Avant de tomber, l'anneau tremble ce temps-là : on le voit venir. */
export const SHRINK_WARNING = 2;
/** Temps de sécurité (secondes) : bien après la disparition du plateau (vers 71 s). */
export const SUMO_TIME_LIMIT = 120;

/**
 * L'élan : on maintient la touche pour le charger (CHARGE_TIME au plus, puis il part tout seul),
 * il part au lâcher, dans la direction où l'on va (ou devant soi, à l'arrêt). Tapoté, il fonce à
 * DASH_SPEED (environ 3,5 m, freinage compris) ; chargé à fond, à FULL_DASH_SPEED (environ 6 m).
 * En chargeant, on ne marche plus (on se tourne pour viser), et bousculé, on perd sa charge.
 * Raté, l'élan peut emmener au bord.
 */
const DASH_SPEED = 10;
const FULL_DASH_SPEED = 14;
export const CHARGE_TIME = 1;
export const DASH_TIME = 0.2;
export const DASH_COOLDOWN = 1.5;
/**
 * Un élan qui touche : un choc mou (même poids pour tous, s'arc-bouter n'y fait rien). La cible
 * repart à un peu plus de la moitié de la vitesse de l'élan et perd l'appui (HIT_STUN, plus
 * FULL_HIT_STUN chargé à fond) : elle glisse, d'environ 2 m tapoté à environ 4 m chargé. Celui
 * qui fonçait la suit un peu. Deux élans de face : les deux rebondissent.
 */
const DASH_BOUNCE = 0.1;
/** Deux élans de face rebondissent franchement : chacun repart à environ 6 m/s. */
const HEAD_ON_BOUNCE = 0.6;
const HIT_STUN = 0.35;
const FULL_HIT_STUN = 0.25;
/** Positions de départ : en cercle, à cette part du rayon. */
const START_RING = 0.45;

export type SumoFighter = ArenaBody & {
  /** Secondes de charge, tant qu'il charge un élan ; null sinon. */
  charge: number | null;
  /** Secondes restantes d'élan, sa force (0 tapoté, 1 chargé à fond), et avant de refoncer. */
  dashing: number;
  power: number;
  dashReady: number;
  /** La touche tenue au pas précédent : la charge part quand on appuie, pas en tenant. */
  held: boolean;
  /** Le pas où il est tombé du plateau, ou null s'il est encore dessus. */
  fellAt: number | null;
};

export type SumoState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: SumoFighter[];
};

/** Secondes écoulées depuis le début de la partie. */
export function sumoTime(state: SumoState): number {
  return state.tick * ARENA_STEP;
}

/** Le rayon du plateau à cet instant : il diminue d'un anneau toutes les SHRINK_EVERY secondes. */
export function sumoRadius(state: SumoState): number {
  if (state.practice) return SUMO_RADIUS;
  const time = sumoTime(state) - SHRINK_START;
  if (time < 0) return SUMO_RADIUS;
  const ring = Math.floor(time / SHRINK_EVERY);
  const falling = Math.min(1, (time - ring * SHRINK_EVERY) / SHRINK_FALL);
  return Math.max(0, SUMO_RADIUS - (ring + falling) * SHRINK_RING);
}

/** L'anneau qui va tomber et dans combien de secondes, ou null s'il n'y en a pas d'annoncé. */
export function nextCrumble(state: SumoState): { radius: number; in: number } | null {
  if (state.practice) return null;
  const time = sumoTime(state) - SHRINK_START;
  const ring = time < 0 ? 0 : Math.floor(time / SHRINK_EVERY) + 1;
  const at = ring * SHRINK_EVERY;
  const radius = SUMO_RADIUS - ring * SHRINK_RING;
  if (radius < 0 || at - time > SHRINK_WARNING) return null;
  return { radius: radius + SHRINK_RING, in: at - time };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SumoState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id, index) => {
      const angle = (index / players.length) * Math.PI * 2;
      const reach = players.length === 1 ? 0 : SUMO_RADIUS * START_RING;
      const x = Math.sin(angle) * reach;
      const z = Math.cos(angle) * reach;
      // Chacun regarde le centre.
      return { ...createBody(id, x, z, Math.atan2(-x, -z)), ...freshMoves(), fellAt: null };
    }),
  };
}

function freshMoves() {
  return { charge: null, dashing: 0, power: 0, dashReady: 0, held: false };
}

function step(state: SumoState, inputs: Partial<Record<PlayerId, ArenaInput>>): SumoState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  const braced = new Set<PlayerId>();
  for (const fighter of standing) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    act(fighter, input, dt);
    const isStill = Math.hypot(input.move.x, input.move.z) <= 0.1;
    if (isStill && isSteady(fighter) && fighter.dashing <= 0) braced.add(fighter.id);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas, pour que la
  // place dans la liste ne donne jamais l'avantage (à égalité, une place gagnait 3 fois plus).
  const shift = tick % Math.max(1, standing.length);
  const order = [...standing.slice(shift), ...standing.slice(0, shift)].reverse();
  bump(order);
  collideBodies(order, WALKER, braced);
  moveBodies(standing, WALKER, dt);
  const next: SumoState = { ...state, tick, fighters };
  const radius = sumoRadius(next);
  for (const fighter of standing) {
    if (Math.hypot(fighter.x, fighter.z) <= radius) continue;
    if (state.practice) {
      // Au bac à sable, on revient au centre.
      Object.assign(fighter, createBody(fighter.id, 0, 0, fighter.facing), freshMoves());
    } else {
      fighter.fellAt = tick;
    }
  }
  return next;
}

/** Les commandes d'un combattant : marcher, charger un élan, foncer. */
function act(fighter: SumoFighter, input: ArenaInput, dt: number): void {
  const pressed = input.primary && !fighter.held;
  fighter.held = input.primary;
  fighter.dashReady = Math.max(0, fighter.dashReady - dt);
  // Bousculé en pleine charge : elle est perdue.
  if (fighter.charge !== null && !isSteady(fighter)) fighter.charge = null;
  const canCharge = fighter.dashReady <= 0 && fighter.dashing <= 0 && isSteady(fighter);
  if (pressed && fighter.charge === null && canCharge) fighter.charge = 0;
  if (fighter.charge !== null) {
    fighter.charge = Math.min(CHARGE_TIME, fighter.charge + dt);
    if (input.primary && fighter.charge < CHARGE_TIME) {
      // Il charge : il ne marche plus, il se tourne pour viser.
      walkBody(fighter, input.move, WALKER, dt, 0);
      return;
    }
    dash(fighter, input, fighter.charge / CHARGE_TIME);
  }
  if (fighter.dashing > 0) {
    // Lancé : il ne freine ni ne tourne, il fonce.
    fighter.dashing = Math.max(0, fighter.dashing - dt);
    return;
  }
  walkBody(fighter, input.move, WALKER, dt);
}

/** Il s'élance, de la force `power` (0 tapoté, 1 chargé à fond). */
function dash(fighter: SumoFighter, input: ArenaInput, power: number): void {
  const isMoving = Math.hypot(input.move.x, input.move.z) > 0.1;
  if (isMoving) fighter.facing = Math.atan2(input.move.x, input.move.z);
  const speed = DASH_SPEED + (FULL_DASH_SPEED - DASH_SPEED) * power;
  Object.assign(fighter, { charge: null, power, dashing: DASH_TIME, dashReady: DASH_COOLDOWN });
  fighter.vx = Math.sin(fighter.facing) * speed;
  fighter.vz = Math.cos(fighter.facing) * speed;
}

/**
 * Les chocs d'un élan : un élan qui touche quelqu'un s'arrête là, l'autre est bousculé et perd
 * l'appui, d'autant plus longtemps que l'élan était chargé. Réglés avant les contacts ordinaires, qui ne font ensuite que séparer les corps.
 */
function bump(fighters: SumoFighter[]): void {
  for (let i = 0; i < fighters.length; i++) {
    for (let j = i + 1; j < fighters.length; j++) {
      const a = fighters[i];
      const b = fighters[j];
      if (!a || !b || (a.dashing <= 0 && b.dashing <= 0)) continue;
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      if (gap >= WALKER.radius * 2 || gap === 0) continue;
      const nx = (b.x - a.x) / gap;
      const nz = (b.z - a.z) / gap;
      const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (closing <= 0) continue;
      const bounce = a.dashing > 0 && b.dashing > 0 ? HEAD_ON_BOUNCE : DASH_BOUNCE;
      const impulse = ((1 + bounce) * closing) / 2;
      a.vx -= nx * impulse;
      a.vz -= nz * impulse;
      b.vx += nx * impulse;
      b.vz += nz * impulse;
      // Celui qui fonçait s'arrête ; celui qui ne fonçait pas est bousculé.
      for (const [hit, other] of [
        [a, b],
        [b, a],
      ] as const) {
        if (hit.dashing <= 0 || other.dashing > 0) {
          hit.stunned = HIT_STUN + FULL_HIT_STUN * other.power;
        }
      }
      a.dashing = 0;
      b.dashing = 0;
    }
  }
}

function standing(state: SumoState): SumoFighter[] {
  return state.fighters.filter((fighter) => fighter.fellAt === null);
}

function isOver(state: SumoState): boolean {
  if (state.practice) return false;
  const alive = standing(state).length;
  return (
    alive === 0 || (state.fighters.length > 1 && alive <= 1) || sumoTime(state) >= SUMO_TIME_LIMIT
  );
}

/**
 * Le classement : ceux encore debout d'abord (au temps de sécurité, du plus près du centre au
 * plus loin), puis les tombés, du dernier tombé au premier. Tombés au même pas : ex aequo.
 */
function ranking(state: SumoState): PlayerId[][] {
  const alive = standing(state)
    .map((fighter) => ({ id: fighter.id, distance: Math.hypot(fighter.x, fighter.z) }))
    .sort((a, b) => a.distance - b.distance)
    .map(({ id }) => [id]);
  const fallen = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    if (fighter.fellAt === null) continue;
    fallen.set(fighter.fellAt, [...(fallen.get(fighter.fellAt) ?? []), fighter.id]);
  }
  const byFall = [...fallen.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return [...alive, ...byFall];
}

/** La part des élans qu'un bot esquive (il s'écarte de leur ligne), selon son niveau. */
const DODGE_SKILL: Record<BotLevel, number> = { easy: 0.15, normal: 0.4, expert: 0.65 };
/** Un bot vise moins bien selon son niveau (radians d'écart au hasard). */
const AIM_NOISE: Record<BotLevel, number> = { easy: 0.6, normal: 0.3, expert: 0.1 };
/**
 * Il ne fonce pas à la première occasion : une chance par pas, selon son niveau (il hésite,
 * il guette). Sans ça, quatre bots fonçaient toutes les deux secondes et la partie durait 5 s.
 */
const DASH_EAGERNESS: Record<BotLevel, number> = { easy: 0.04, normal: 0.07, expert: 0.1 };
/**
 * Il charge quand sa cible est à cette distance et que l'élan la pousse vers le bord, et tient
 * sa charge plus ou moins longtemps (une part de CHARGE_TIME tirée entre ces bornes, selon son
 * niveau : le Facile lâche vite, l'Expert ose charger).
 */
const DASH_RANGE = 4;
const CHARGE_WISH: Record<BotLevel, readonly [number, number]> = {
  easy: [0, 0.4],
  normal: [0.1, 0.6],
  expert: [0.2, 0.7],
};
/** Il reste à cette distance du bord, et se place de ce côté-ci de sa cible. */
const SAFE_EDGE = 1.4;
const BEHIND_TARGET = 1.2;
/** Un élan qui arrive : assez près, et vers lui. */
const THREAT_RANGE = 3;
/** Le nombre de pas d'un élan : la chance d'esquive se tire à chacun. */
const DODGE_STEPS = DASH_TIME / ARENA_STEP;

/**
 * Le bot (02-mini-jeux.md, fiche 2) : il vise le joueur le plus près du bord, se place entre
 * lui et le centre, fonce quand l'élan le pousse vers le bord, et s'écarte d'un élan qui arrive
 * (plus ou moins souvent selon son niveau). Quand le plateau rétrécit, il reste loin du bord.
 */
function botInput(state: SumoState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || !isSteady(me) || me.dashing > 0) return IDLE_INPUT;
  const isCharging = me.charge !== null;
  const radius = sumoRadius(state);
  const others = standing(state).filter((fighter) => fighter.id !== player);

  // Un élan arrive : il s'écarte de sa ligne, s'il le voit venir. Décidé une fois par pas, avec
  // une chance ramenée au pas pour que la réussite sur un élan entier vaille DODGE_SKILL.
  const threat = others.find((other) => {
    if (other.dashing <= 0) return false;
    const dx = me.x - other.x;
    const dz = me.z - other.z;
    const gap = Math.hypot(dx, dz);
    return gap < THREAT_RANGE && (other.vx * dx + other.vz * dz) / (gap || 1) > 4;
  });
  if (threat && !isCharging) {
    const perStep = 1 - (1 - DODGE_SKILL[level]) ** (1 / DODGE_STEPS);
    if (rng.chance(perStep)) {
      // De côté par rapport à l'élan, du côté du centre plutôt que du bord.
      const speed = Math.hypot(threat.vx, threat.vz) || 1;
      const side = { x: -threat.vz / speed, z: threat.vx / speed };
      const towardCenter = side.x * -me.x + side.z * -me.z >= 0 ? 1 : -1;
      return {
        move: { x: side.x * towardCenter, z: side.z * towardCenter },
        primary: false,
        secondary: false,
      };
    }
  }

  // Trop près du bord : il revient vers le centre avant tout (et lâche sa charge).
  if (Math.hypot(me.x, me.z) > radius - SAFE_EDGE) {
    return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };
  }
  // La cible : près du bord et pas trop loin de lui. Chaque bot a ses têtes (une préférence
  // par paire, tirée pour la partie) : sans elle, à égalité au départ, tous visaient le même.
  const score = (other: SumoFighter) =>
    Math.hypot(other.x, other.z) -
    0.3 * Math.hypot(other.x - me.x, other.z - me.z) +
    hashUnit(`${state.seed}:${player}>${other.id}`) * 1.5;
  const target = [...others].sort((a, b) => score(b) - score(a))[0];
  if (!target) return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };

  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const gap = Math.hypot(dx, dz);
  const out = Math.hypot(target.x, target.z) || 1;
  const aimed = Math.atan2(dx, dz) + (rng.next() - 0.5) * AIM_NOISE[level];
  // L'élan pousse la cible vers le bord : il est entre elle et le centre.
  const outward = (dx * target.x + dz * target.z) / ((gap || 1) * out);
  const isAligned = gap < DASH_RANGE && outward > 0.3;
  // Placé, il se tourne vers elle d'une petite poussée, sans foncer dedans.
  const face = { x: Math.sin(aimed) * 0.3, z: Math.cos(aimed) * 0.3 };
  if (me.charge !== null) {
    // Il vise en chargeant, et lâche à la charge voulue (tirée pour cette charge-là).
    const startTick = state.tick - Math.round(me.charge / ARENA_STEP);
    const [from, to] = CHARGE_WISH[level];
    const wish = from + (to - from) * hashUnit(`${state.seed}:${player}:${startTick}`);
    return { move: face, primary: me.charge < wish * CHARGE_TIME, secondary: false };
  }
  if (isAligned && me.dashReady <= 0 && rng.chance(DASH_EAGERNESS[level])) {
    return { move: face, primary: true, secondary: false };
  }
  // Il se place entre le centre et sa cible, pour la pousser vers le bord.
  const spot = {
    x: target.x - (target.x / out) * BEHIND_TARGET,
    z: target.z - (target.z / out) * BEHIND_TARGET,
  };
  const isPlaced = Math.hypot(spot.x - me.x, spot.z - me.z) < 0.6;
  return { move: isPlaced ? face : toward(me, spot), primary: false, secondary: false };
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

function toward(from: { x: number; z: number }, to: { x: number; z: number }) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const gap = Math.hypot(dx, dz);
  return gap < 0.05 ? { x: 0, z: 0 } : { x: dx / gap, z: dz / gap };
}

export const PAWN_SUMO: ArenaGame<SumoState> = { create, step, botInput, isOver, ranking };
