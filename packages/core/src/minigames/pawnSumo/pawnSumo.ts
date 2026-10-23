import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Sumo des pions (02-mini-jeux.md, fiche 2) : pousser les autres hors d'un plateau rond qui
// rétrécit. Des disques qui glissent et se poussent sur un plan (x, z), en mètres et en
// secondes. Le plateau s'effrite anneau par anneau jusqu'à disparaître : il y a toujours un
// dernier debout. Un temps de sécurité très long termine quand même la partie si quelque
// chose tourne mal ; il n'est jamais atteint en jeu normal.

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

const BODY_RADIUS = 0.5;
const WALK_SPEED = 4.5;
/**
 * La marche est une force, pas une vitesse imposée : chacun pousse avec ses jambes
 * (WALK_FORCE, de moins en moins à mesure qu'il approche de sa vitesse de marche) et freine
 * avec ses pieds (BRAKE_FORCE, en m/s²). Seul, on part et on s'arrête vite. Contre quelqu'un,
 * on le pousse : il recule en freinant, on avance ensemble plus lentement ; s'il pousse en
 * face, c'est un bras de fer. (Une vitesse imposée faisait de l'autre un mur.)
 */
const WALK_FORCE = 32;
const BRAKE_FORCE = 20;
/** Après un choc, on a moins d'appui le temps de se rattraper : on glisse. */
const STUN_TIME = 0.35;
const STUN_FOOTING = 0.15;
/** La charge : un élan vers l'avant, puis une recharge. */
const CHARGE_SPEED = 13;
const CHARGE_TIME = 0.25;
export const CHARGE_COOLDOWN = 2;
/**
 * Celui qui prend une charge est repoussé de 2 à 3 m : il faut plusieurs charges, ou une
 * cible déjà près du bord, pour faire tomber quelqu'un (une seule envoyait hors du plateau).
 */
const CHARGE_KNOCK = 5.2;
/** La parade : une fenêtre très courte. Une charge parée renvoie l'attaquant. */
const PARRY_TIME = 0.25;
export const PARRY_COOLDOWN = 1;
const PARRY_KNOCK = 6.5;
/** Se rentrer dedans en marchant : un choc mou, presque sans rebond (on se colle, on pousse). */
const BUMP_RESTITUTION = 0.1;
/** Positions de départ : en cercle, à cette part du rayon. */
const START_RING = 0.45;

export type SumoFighter = {
  id: PlayerId;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Où il regarde (angle autour de la verticale, comme `atan2(x, z)`). */
  facing: number;
  /** Secondes restantes de charge, de parade, de choc. */
  charging: number;
  parrying: number;
  stunned: number;
  /** Secondes avant de pouvoir recharger ou reparer. */
  chargeReady: number;
  parryReady: number;
  /** Les touches tenues au pas précédent : une action part quand on appuie, pas en tenant. */
  held: { primary: boolean; secondary: boolean };
  /** Le pas où il est tombé, ou null s'il est encore sur le plateau. */
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
        id,
        x,
        z,
        vx: 0,
        vz: 0,
        // Chacun regarde le centre.
        facing: Math.atan2(-x, -z),
        charging: 0,
        parrying: 0,
        stunned: 0,
        chargeReady: 0,
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
  for (const fighter of fighters) {
    if (fighter.fellAt !== null) continue;
    act(fighter, inputs[fighter.id] ?? IDLE_INPUT, dt);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas, pour que la
  // place dans la liste ne donne jamais l'avantage (à égalité, une place gagnait 3 fois plus).
  const standingNow = fighters.filter((fighter) => fighter.fellAt === null);
  const shift = tick % Math.max(1, standingNow.length);
  collide([...standingNow.slice(shift), ...standingNow.slice(0, shift)].reverse());
  const next: SumoState = { ...state, tick, fighters };
  const radius = sumoRadius(next);
  for (const fighter of fighters) {
    if (fighter.fellAt !== null) continue;
    fighter.x += fighter.vx * dt;
    fighter.z += fighter.vz * dt;
    if (Math.hypot(fighter.x, fighter.z) <= radius) continue;
    if (state.practice) {
      // Au bac à sable, on revient au centre.
      Object.assign(fighter, { x: 0, z: 0, vx: 0, vz: 0, charging: 0, stunned: 0 });
    } else {
      fighter.fellAt = tick;
    }
  }
  return next;
}

/** Les commandes d'un combattant : marcher, charger, parer. */
function act(fighter: SumoFighter, input: ArenaInput, dt: number): void {
  const pressedPrimary = input.primary && !fighter.held.primary;
  const pressedSecondary = input.secondary && !fighter.held.secondary;
  fighter.held = { primary: input.primary, secondary: input.secondary };
  fighter.chargeReady = Math.max(0, fighter.chargeReady - dt);
  fighter.parryReady = Math.max(0, fighter.parryReady - dt);
  fighter.parrying = Math.max(0, fighter.parrying - dt);
  fighter.stunned = Math.max(0, fighter.stunned - dt);
  const moving = Math.hypot(input.move.x, input.move.z) > 0.1;
  if (moving && fighter.charging <= 0) fighter.facing = Math.atan2(input.move.x, input.move.z);

  if (pressedSecondary && fighter.parryReady <= 0 && fighter.charging <= 0) {
    fighter.parrying = PARRY_TIME;
    fighter.parryReady = PARRY_COOLDOWN;
  }
  if (pressedPrimary && fighter.chargeReady <= 0 && fighter.stunned <= 0) {
    fighter.charging = CHARGE_TIME;
    fighter.chargeReady = CHARGE_COOLDOWN;
    fighter.vx = Math.sin(fighter.facing) * CHARGE_SPEED;
    fighter.vz = Math.cos(fighter.facing) * CHARGE_SPEED;
  }
  if (fighter.charging > 0) {
    fighter.charging = Math.max(0, fighter.charging - dt);
    return;
  }
  walk(fighter, input, dt);
}

/**
 * La marche : une poussée dans la direction voulue, qui faiblit près de la vitesse de marche,
 * et un freinage de tout le reste (l'élan de côté, ou tout l'élan quand on lâche les touches).
 */
function walk(fighter: SumoFighter, input: ArenaInput, dt: number): void {
  const footing = fighter.stunned > 0 ? STUN_FOOTING : 1;
  const strength = Math.min(1, Math.hypot(input.move.x, input.move.z));
  const dirX = strength > 0.1 ? input.move.x / strength : 0;
  const dirZ = strength > 0.1 ? input.move.z / strength : 0;
  const along = fighter.vx * dirX + fighter.vz * dirZ;
  // Freinage : l'élan qui n'est pas dans la direction voulue (tout l'élan, sans direction).
  let restX = fighter.vx - dirX * Math.max(0, along);
  let restZ = fighter.vz - dirZ * Math.max(0, along);
  const rest = Math.hypot(restX, restZ);
  if (rest > 0) {
    const kept = Math.max(0, rest - BRAKE_FORCE * footing * dt) / rest;
    restX *= kept;
    restZ *= kept;
  }
  // Poussée : forte à l'arrêt, nulle à la vitesse de marche.
  const target = WALK_SPEED * strength;
  const drive = along < target ? WALK_FORCE * footing * (1 - Math.max(0, along) / WALK_SPEED) : 0;
  const forward = Math.min(target, Math.max(0, along) + drive * dt);
  const slowing = along > target ? Math.max(target, along - BRAKE_FORCE * footing * dt) : forward;
  fighter.vx = restX + dirX * slowing;
  fighter.vz = restZ + dirZ * slowing;
}

/** Les chocs entre combattants : une charge envoie loin, parée elle renvoie l'attaquant. */
function collide(fighters: SumoFighter[]): void {
  for (let i = 0; i < fighters.length; i++) {
    for (let j = i + 1; j < fighters.length; j++) {
      const a = fighters[i];
      const b = fighters[j];
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= BODY_RADIUS * 2) continue;
      if (distance === 0) {
        dx = 1;
        dz = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const nz = dz / distance;
      // Ils ne se chevauchent pas : chacun recule de la moitié.
      const overlap = BODY_RADIUS * 2 - distance;
      a.x -= (nx * overlap) / 2;
      a.z -= (nz * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.z += (nz * overlap) / 2;
      if (a.charging > 0 || b.charging > 0) {
        if (a.charging > 0 && b.charging <= 0) charge(a, b, nx, nz);
        else if (b.charging > 0 && a.charging <= 0) charge(b, a, -nx, -nz);
        else bump(a, b, nx, nz);
        continue;
      }
      bump(a, b, nx, nz);
    }
  }
}

/** `attacker` charge `target` ; `(nx, nz)` va de l'attaquant vers la cible. */
function charge(attacker: SumoFighter, target: SumoFighter, nx: number, nz: number): void {
  attacker.charging = 0;
  if (target.parrying > 0) {
    attacker.vx = -nx * PARRY_KNOCK;
    attacker.vz = -nz * PARRY_KNOCK;
    attacker.stunned = STUN_TIME * 1.5;
    return;
  }
  target.vx = nx * CHARGE_KNOCK;
  target.vz = nz * CHARGE_KNOCK;
  target.stunned = STUN_TIME;
  target.charging = 0;
  attacker.vx *= 0.2;
  attacker.vz *= 0.2;
}

/**
 * Un contact sans charge : ils partagent leur élan le long du contact (même poids), presque
 * sans rebond. Celui qui avance entraîne l'autre ; la suite se joue entre leurs jambes (walk).
 */
function bump(a: SumoFighter, b: SumoFighter, nx: number, nz: number): void {
  const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (closing <= 0) return;
  const exchange = (closing * (1 + BUMP_RESTITUTION)) / 2;
  a.vx -= nx * exchange;
  a.vz -= nz * exchange;
  b.vx += nx * exchange;
  b.vz += nz * exchange;
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

/** La part des charges qu'un bot pare, selon son niveau. */
const PARRY_SKILL: Record<BotLevel, number> = { easy: 0.2, normal: 0.5, expert: 0.8 };
/** Un bot vise moins bien selon son niveau (radians d'écart au hasard). */
const AIM_NOISE: Record<BotLevel, number> = { easy: 0.6, normal: 0.3, expert: 0.1 };
/** Il charge quand sa cible est à cette distance et bien alignée. */
const CHARGE_RANGE = 3.2;
/**
 * Il ne charge pas à la première occasion : une chance par pas, selon son niveau (il hésite,
 * il guette). Sans ça, quatre bots chargeaient toutes les deux secondes et la partie durait 5 s.
 */
const CHARGE_EAGERNESS: Record<BotLevel, number> = { easy: 0.04, normal: 0.07, expert: 0.1 };
/** Il reste à cette distance du bord, et vise de ce côté-ci de sa cible. */
const SAFE_EDGE = 1.4;
const BEHIND_TARGET = 1.2;
/** Une charge qui arrive : assez près, et vers lui. */
const THREAT_RANGE = 2.6;

/**
 * Le bot (02-mini-jeux.md, fiche 2) : il vise le joueur le plus près du bord, se place entre
 * lui et le centre, charge quand il est aligné, et pare une charge qui arrive (plus ou moins
 * souvent selon son niveau). Quand le plateau rétrécit, il reste loin du bord.
 */
function botInput(state: SumoState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null) return IDLE_INPUT;
  const radius = sumoRadius(state);
  const others = standing(state).filter((fighter) => fighter.id !== player);

  // Une charge arrive : il pare, s'il la voit venir. Décidé une fois par pas, avec une chance
  // ramenée au pas pour que la réussite sur une charge entière vaille PARRY_SKILL.
  const threat = others.find((other) => {
    if (other.charging <= 0) return false;
    const dx = me.x - other.x;
    const dz = me.z - other.z;
    const distance = Math.hypot(dx, dz);
    return distance < THREAT_RANGE && (other.vx * dx + other.vz * dz) / (distance || 1) > 4;
  });
  if (threat && me.parryReady <= 0) {
    const perStep = 1 - (1 - PARRY_SKILL[level]) ** (1 / (CHARGE_TIME / ARENA_STEP));
    if (rng.chance(perStep)) return { move: { x: 0, z: 0 }, primary: false, secondary: true };
  }

  const fromCenter = Math.hypot(me.x, me.z);
  // Trop près du bord : il revient vers le centre avant tout.
  if (fromCenter > radius - SAFE_EDGE) {
    return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };
  }
  // La cible : près du bord et pas trop loin de lui. Chaque bot a ses têtes (une préférence
  // par paire, tirée pour la partie) : sans elle, à égalité au départ, tous visaient le même.
  const score = (other: SumoFighter) =>
    Math.hypot(other.x, other.z) -
    0.3 * Math.hypot(other.x - me.x, other.z - me.z) +
    preference(state.seed, player, other.id);
  const target = [...others].sort((a, b) => score(b) - score(a))[0];
  if (!target) return { move: toward(me, { x: 0, z: 0 }), primary: false, secondary: false };

  // Il se place entre le centre et sa cible, pour la pousser vers le bord.
  const out = Math.hypot(target.x, target.z) || 1;
  const spot = {
    x: target.x - (target.x / out) * BEHIND_TARGET,
    z: target.z - (target.z / out) * BEHIND_TARGET,
  };
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const distance = Math.hypot(dx, dz);
  const aimed = Math.atan2(dx, dz) + (rng.next() - 0.5) * AIM_NOISE[level];
  const outward = (dx * target.x + dz * target.z) / ((distance || 1) * out);
  const isAligned = distance < CHARGE_RANGE && outward > 0.3;
  if (isAligned && me.chargeReady <= 0 && me.stunned <= 0 && rng.chance(CHARGE_EAGERNESS[level])) {
    // Il se tourne vers la cible et charge dans le même pas.
    return { move: { x: Math.sin(aimed), z: Math.cos(aimed) }, primary: true, secondary: false };
  }
  const close = Math.hypot(spot.x - me.x, spot.z - me.z) < 0.6;
  return {
    move: close ? { x: Math.sin(aimed), z: Math.cos(aimed) } : toward(me, spot),
    primary: false,
    secondary: false,
  };
}

/** La préférence d'un bot pour une cible, entre 0 et 1,5 : fixe pendant une partie. */
function preference(seed: number, me: PlayerId, other: PlayerId): number {
  let hash = 2166136261;
  for (const char of `${seed}:${me}>${other}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (((hash >>> 0) % 1000) / 1000) * 1.5;
}

function toward(from: { x: number; z: number }, to: { x: number; z: number }) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  return distance < 0.05 ? { x: 0, z: 0 } : { x: dx / distance, z: dz / distance };
}

export const PAWN_SUMO: ArenaGame<SumoState> = { create, step, botInput, isOver, ranking };
