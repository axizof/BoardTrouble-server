import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  collideBodies,
  createBody,
  isSteady,
  knockDown,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';

// Sumo des pions (02-mini-jeux.md, fiche 2) : faire tomber les autres d'un plateau rond qui
// rétrécit, à coups de poing. Les corps sont ceux des arènes (arena/body.ts) ; ici, les coups, la
// parade et le plateau. Le plateau s'effrite anneau par anneau jusqu'à disparaître : il y a
// toujours un dernier debout. Un temps de sécurité très long termine quand même la partie si
// quelque chose tourne mal ; il n'est jamais atteint en jeu normal.

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
 * Le coup : il arme (WINDUP, on le voit venir et on marche à peine), puis frappe (STRIKE_TIME) en
 * se jetant un peu en avant. Il touche le premier adversaire à portée devant lui ; le premier qui
 * frappe gagne (celui qui armait encore est interrompu).
 */
export const STRIKE_WINDUP = 0.15;
export const STRIKE_TIME = 0.12;
export const STRIKE_COOLDOWN = 0.9;
const STRIKE_LUNGE = 3;
const WINDUP_CONTROL = 0.35;
/** Portée (du centre au centre) et ouverture du coup, de part et d'autre du regard. */
const STRIKE_REACH = 1.3;
const STRIKE_ARC = Math.cos((60 * Math.PI) / 180);
/** Touché : projeté (1,5 m environ), au sol un moment, et pas de riposte tout de suite. */
const HIT_KNOCK = 6.5;
export const DOWN_TIME = 1.1;
const GET_UP_STRIKE_DELAY = 0.4;
/**
 * La parade : une fenêtre courte. Un coup paré fait tituber l'attaquant (STAGGER_TIME, sans
 * coups ni parade) et rend son coup au défenseur tout de suite : de quoi contre-attaquer.
 */
export const PARRY_TIME = 0.25;
export const PARRY_COOLDOWN = 1;
const STAGGER_TIME = 0.8;
const STAGGER_KNOCK = 1.2;
/** Positions de départ : en cercle, à cette part du rayon. */
const START_RING = 0.45;

export type SumoFighter = ArenaBody & {
  /** Secondes restantes à armer, à frapper, à parer. */
  winding: number;
  striking: number;
  parrying: number;
  /** Secondes avant de pouvoir refrapper, reparer. */
  strikeReady: number;
  parryReady: number;
  /** Les touches tenues au pas précédent : une action part quand on appuie, pas en tenant. */
  held: { primary: boolean; secondary: boolean };
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
      return {
        // Chacun regarde le centre.
        ...createBody(id, x, z, Math.atan2(-x, -z)),
        winding: 0,
        striking: 0,
        parrying: 0,
        strikeReady: 0,
        parryReady: 0,
        held: { primary: false, secondary: false },
        fellAt: null,
      };
    }),
  };
}

function step(state: SumoState, inputs: Partial<Record<PlayerId, ArenaInput>>): SumoState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const fighters = state.fighters.map((fighter) => ({ ...fighter, held: { ...fighter.held } }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  const braced = new Set<PlayerId>();
  for (const fighter of standing) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    act(fighter, input, dt);
    if (Math.hypot(input.move.x, input.move.z) <= 0.1 && isSteady(fighter)) braced.add(fighter.id);
  }
  strike(standing);
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas, pour que la
  // place dans la liste ne donne jamais l'avantage (à égalité, une place gagnait 3 fois plus).
  const shift = tick % Math.max(1, standing.length);
  collideBodies([...standing.slice(shift), ...standing.slice(0, shift)].reverse(), WALKER, braced);
  moveBodies(standing, WALKER, dt);
  const next: SumoState = { ...state, tick, fighters };
  const radius = sumoRadius(next);
  for (const fighter of standing) {
    if (Math.hypot(fighter.x, fighter.z) <= radius) continue;
    if (state.practice) {
      // Au bac à sable, on revient au centre.
      Object.assign(fighter, createBody(fighter.id, 0, 0, fighter.facing));
    } else {
      fighter.fellAt = tick;
    }
  }
  return next;
}

/** Les commandes d'un combattant : marcher, armer un coup, parer. */
function act(fighter: SumoFighter, input: ArenaInput, dt: number): void {
  const pressedPrimary = input.primary && !fighter.held.primary;
  const pressedSecondary = input.secondary && !fighter.held.secondary;
  fighter.held = { primary: input.primary, secondary: input.secondary };
  fighter.strikeReady = Math.max(0, fighter.strikeReady - dt);
  fighter.parryReady = Math.max(0, fighter.parryReady - dt);
  fighter.parrying = Math.max(0, fighter.parrying - dt);
  fighter.striking = Math.max(0, fighter.striking - dt);
  if (fighter.winding > 0) {
    fighter.winding = Math.max(0, fighter.winding - dt);
    if (fighter.winding === 0) {
      // Il frappe : il se jette en avant.
      fighter.striking = STRIKE_TIME;
      fighter.vx += Math.sin(fighter.facing) * STRIKE_LUNGE;
      fighter.vz += Math.cos(fighter.facing) * STRIKE_LUNGE;
    }
  }
  const isBusy = fighter.winding > 0 || fighter.striking > 0;
  if (isSteady(fighter) && !isBusy) {
    if (pressedSecondary && fighter.parryReady <= 0) {
      fighter.parrying = PARRY_TIME;
      fighter.parryReady = PARRY_COOLDOWN;
    } else if (pressedPrimary && fighter.strikeReady <= 0 && fighter.parrying <= 0) {
      fighter.winding = STRIKE_WINDUP;
      fighter.strikeReady = STRIKE_COOLDOWN;
    }
  }
  // En armant, il marche à peine (on peut l'esquiver) ; en frappant, il suit son élan.
  const control = fighter.winding > 0 ? WINDUP_CONTROL : fighter.striking > 0 ? 0 : 1;
  walkBody(fighter, input.move, WALKER, dt, control);
}

/**
 * Les coups de ce pas : chaque coup en cours touche le plus proche adversaire à portée devant
 * lui. Tous les coups sont cherchés avant d'être appliqués : deux coups qui se croisent au même
 * pas se touchent tous les deux.
 */
function strike(fighters: SumoFighter[]): void {
  const hits = fighters.flatMap((attacker) => {
    if (attacker.striking <= 0) return [];
    const target = fighters
      .filter((other) => other !== attacker && other.downed <= 0 && inReach(attacker, other))
      .sort((a, b) => distance(attacker, a) - distance(attacker, b))[0];
    return target ? [{ attacker, target }] : [];
  });
  for (const { attacker, target } of hits) {
    // Un coup ne touche qu'une fois.
    attacker.striking = 0;
    const gap = distance(attacker, target) || 1;
    const nx = (target.x - attacker.x) / gap;
    const nz = (target.z - attacker.z) / gap;
    if (target.parrying > 0) {
      // Paré : l'attaquant titube, le défenseur peut contre-attaquer tout de suite.
      Object.assign(attacker, { winding: 0, striking: 0, stunned: STAGGER_TIME });
      attacker.vx = -nx * STAGGER_KNOCK;
      attacker.vz = -nz * STAGGER_KNOCK;
      Object.assign(target, { parrying: 0, strikeReady: 0 });
      continue;
    }
    knockDown(target, nx, nz, HIT_KNOCK, DOWN_TIME);
    Object.assign(target, { winding: 0, striking: 0, parrying: 0 });
    target.strikeReady = Math.max(target.strikeReady, DOWN_TIME + GET_UP_STRIKE_DELAY);
  }
}

/** `other` est à portée du coup de `attacker` : assez près, et devant lui. */
function inReach(attacker: SumoFighter, other: SumoFighter): boolean {
  return distance(attacker, other) <= STRIKE_REACH && facesToward(attacker, other, STRIKE_ARC);
}

/** `from` regarde vers `to`, à l'ouverture `arc` près (cosinus de l'angle). */
function facesToward(from: ArenaBody, to: { x: number; z: number }, arc: number): boolean {
  const gap = distance(from, to);
  if (gap === 0) return true;
  const ahead = Math.sin(from.facing) * (to.x - from.x) + Math.cos(from.facing) * (to.z - from.z);
  return ahead / gap >= arc;
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
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

/** La part des coups qu'un bot pare, selon son niveau. */
const PARRY_SKILL: Record<BotLevel, number> = { easy: 0.2, normal: 0.45, expert: 0.7 };
/** Un bot vise moins bien selon son niveau (radians d'écart au hasard). */
const AIM_NOISE: Record<BotLevel, number> = { easy: 0.6, normal: 0.3, expert: 0.1 };
/**
 * Il ne frappe pas à la première occasion : une chance par pas, selon son niveau (il hésite,
 * il guette). Contre un adversaire qui titube, il ne rate pas l'occasion.
 */
const STRIKE_EAGERNESS: Record<BotLevel, number> = { easy: 0.05, normal: 0.08, expert: 0.12 };
const COUNTER_EAGERNESS = 0.5;
/** Il frappe quand sa cible est à cette distance et bien en face. */
const STRIKE_RANGE = 1.2;
const STRIKE_AIM = Math.cos((25 * Math.PI) / 180);
/** Il reste à cette distance du bord, et se place de ce côté-ci de sa cible. */
const SAFE_EDGE = 1.4;
const BEHIND_TARGET = 0.9;
/** Un coup qui arrive : un adversaire tout près qui arme, tourné vers lui. */
const THREAT_RANGE = 1.8;

/**
 * Le bot (02-mini-jeux.md, fiche 2) : il vise le joueur le plus près du bord, se place entre
 * lui et le centre, frappe quand il est en face, pare un coup qui arrive (plus ou moins souvent
 * selon son niveau) et contre-attaque celui qui titube. Quand le plateau rétrécit, il reste loin
 * du bord.
 */
function botInput(state: SumoState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || !isSteady(me)) return IDLE_INPUT;
  const radius = sumoRadius(state);
  const others = standing(state).filter((fighter) => fighter.id !== player);
  const canAct = me.winding <= 0 && me.striking <= 0;

  // Un coup arrive : il pare, s'il le voit venir. Décidé une fois par pas, avec une chance
  // ramenée au pas pour que la réussite sur un coup entier vaille PARRY_SKILL.
  const threat = others.find(
    (other) =>
      (other.winding > 0 || other.striking > 0) &&
      distance(me, other) < THREAT_RANGE &&
      facesToward(other, me, STRIKE_ARC),
  );
  if (threat && canAct && me.parryReady <= 0 && me.parrying <= 0) {
    const perStep = 1 - (1 - PARRY_SKILL[level]) ** (1 / (STRIKE_WINDUP / ARENA_STEP));
    if (rng.chance(perStep)) return { move: { x: 0, z: 0 }, primary: false, secondary: true };
  }

  // Trop près du bord : il revient vers le centre avant tout.
  if (Math.hypot(me.x, me.z) > radius - SAFE_EDGE) {
    return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };
  }
  // La cible : un adversaire qui titube s'il y en a un tout près, sinon près du bord et pas trop
  // loin de lui. Chaque bot a ses têtes (une préférence par paire, tirée pour la partie) : sans
  // elle, à égalité au départ, tous visaient le même.
  const staggered = others.find(
    (other) => other.stunned > 0 && other.downed <= 0 && distance(me, other) < STRIKE_RANGE * 1.5,
  );
  const score = (other: SumoFighter) =>
    Math.hypot(other.x, other.z) -
    0.3 * distance(me, other) +
    hashUnit(`${state.seed}:${player}>${other.id}`) * 1.5;
  const upright = others.filter((other) => other.downed <= 0);
  const target = staggered ?? upright.sort((a, b) => score(b) - score(a))[0];
  if (!target) return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };

  const aimed =
    Math.atan2(target.x - me.x, target.z - me.z) + (rng.next() - 0.5) * AIM_NOISE[level];
  // Une petite poussée vers la cible : il se tourne vers elle sans foncer dedans.
  const face = { x: Math.sin(aimed) * 0.3, z: Math.cos(aimed) * 0.3 };
  const isInFront = distance(me, target) < STRIKE_RANGE && facesToward(me, target, STRIKE_AIM);
  const eagerness = staggered ? COUNTER_EAGERNESS : STRIKE_EAGERNESS[level];
  if (isInFront && canAct && me.strikeReady <= 0 && rng.chance(eagerness)) {
    return { move: face, primary: true, secondary: false };
  }
  // Il se place entre le centre et sa cible, pour la frapper vers le bord.
  const out = Math.hypot(target.x, target.z) || 1;
  const spot = {
    x: target.x - (target.x / out) * BEHIND_TARGET,
    z: target.z - (target.z / out) * BEHIND_TARGET,
  };
  const isPlaced = distance(me, spot) < 0.5;
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
