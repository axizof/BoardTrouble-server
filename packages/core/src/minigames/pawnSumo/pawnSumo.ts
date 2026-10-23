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
 * (WALK_FORCE, de moins en moins à mesure qu'il approche de sa vitesse de marche) et tient
 * sur ses pieds (BRAKE_FORCE, en m/s²). Les deux se valent presque : en marchant dans
 * quelqu'un, on le fait à peine reculer, et deux qui poussent l'un contre l'autre ne bougent
 * pas. Pour vraiment pousser, il faut charger.
 */
const WALK_FORCE = 32;
const BRAKE_FORCE = 30;
/**
 * Celui qui reste planté sur ses pieds (sans marcher) s'arc-boute : il compte pour BRACE_WEIGHT
 * dans un contact. Sans ça, son freinage n'agissait qu'après coup et on le poussait comme rien.
 */
const BRACE_WEIGHT = 3;
/** Après un choc, on a moins d'appui le temps de se rattraper : on glisse. */
const STUN_TIME = 0.35;
const STUN_FOOTING = 0.15;
/** La charge : un élan vers l'avant, puis une recharge. */
const CHARGE_SPEED = 13;
const CHARGE_TIME = 0.25;
export const CHARGE_COOLDOWN = 2;
/**
 * Chargé de côté ou de dos, on est projeté à 1,5 ou 2 m : il faut plusieurs charges, ou une
 * cible déjà près du bord, pour faire tomber quelqu'un.
 */
const CHARGE_KNOCK = 5.5;
/**
 * Projeté, on tombe à la renverse, on glisse puis on se relève : pas de commandes pendant
 * DOWN_TIME, et pas de charge tout de suite après (pas de riposte immédiate).
 */
export const DOWN_TIME = 1;
const DOWN_FOOTING = 0.4;
const GET_UP_CHARGE_DELAY = 0.6;
/** La parade : une fenêtre très courte. Une charge parée projette l'attaquant. */
const PARRY_TIME = 0.25;
export const PARRY_COOLDOWN = 1;
const PARRY_KNOCK = 6.5;
/**
 * Chargé de face (il regarde l'attaquant, à 70 degrés près), c'est un duel au timing : une
 * aiguille fait le tour d'un cercle en CLASH_TIME et chacun appuie une fois. La zone à viser
 * tombe au hasard sur le tour ; plus on appuie près de son centre, meilleure est la note.
 */
export const CLASH_TIME = 1.6;
const CLASH_FACING = Math.cos((70 * Math.PI) / 180);
/** Demi-largeurs des zones, en part d'un tour : parfait, bien, juste (au-delà, raté). */
export const CLASH_ZONES = [0.02, 0.05, 0.1] as const;
/** Le centre de la zone tombe entre ces parts du tour : ni tout de suite, ni à la toute fin. */
const CLASH_ZONE_FROM = 0.3;
const CLASH_ZONE_TO = 0.85;
/**
 * Le meilleur projette l'autre, d'autant plus loin que sa note est haute (indice = note,
 * de 1 juste à 3 parfait : de 1,5 à 3,8 m) ; à égalité, ils rebondissent l'un contre l'autre.
 */
const CLASH_KNOCK = [0, 5, 6.5, 8.5] as const;
const CLASH_TIE_KNOCK = 3.5;
/** Un duel joué reste affiché ce temps-là, avec les notes. */
export const CLASH_RESULT_TIME = 0.8;
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
  /** Secondes restantes de charge, de parade, de choc, à terre. */
  charging: number;
  parrying: number;
  stunned: number;
  downed: number;
  /** Secondes avant de pouvoir recharger ou reparer. */
  chargeReady: number;
  parryReady: number;
  /** Les touches tenues au pas précédent : une action part quand on appuie, pas en tenant. */
  held: { primary: boolean; secondary: boolean };
  /** Le pas où il est tombé, ou null s'il est encore sur le plateau. */
  fellAt: number | null;
};

/** Un duel au timing : `a` a chargé `b` de face ; les deux restent figés le temps du duel. */
export type SumoClash = {
  a: PlayerId;
  b: PlayerId;
  startTick: number;
  /** Le centre de la zone à viser, en part d'un tour (0 en haut, dans le sens des aiguilles). */
  zone: number;
  /** Où était l'aiguille quand chacun a appuyé. */
  presses: Partial<Record<PlayerId, number>>;
  /** Une fois joué : quand, et la note de chacun (3 parfait, 2 bien, 1 juste, 0 raté). */
  result: { tick: number; scores: Record<PlayerId, number> } | null;
};

export type SumoState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: SumoFighter[];
  /** Les duels en cours, et ceux tout juste joués (le temps d'afficher les notes). */
  clashes: SumoClash[];
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

/** Où est l'aiguille d'un duel au pas `tick`, en part d'un tour (de 0 à 1). */
export function clashNeedle(clash: SumoClash, tick: number): number {
  const at = Math.min(tick, clash.result?.tick ?? tick);
  return Math.min(1, ((at - clash.startTick) * ARENA_STEP) / CLASH_TIME);
}

/** La note d'un appui : 3 parfait, 2 bien, 1 juste, 0 raté ou pas d'appui. */
export function clashScore(zone: number, press: number | undefined): number {
  if (press === undefined) return 0;
  const tier = CLASH_ZONES.findIndex((half) => Math.abs(press - zone) <= half);
  return tier === -1 ? 0 : CLASH_ZONES.length - tier;
}

/** Le duel en cours d'un combattant, s'il en a un. */
export function clashOf(clashes: SumoClash[], player: PlayerId): SumoClash | undefined {
  return clashes.find((clash) => !clash.result && (clash.a === player || clash.b === player));
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SumoState {
  return {
    tick: 0,
    practice,
    seed,
    clashes: [],
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
        downed: 0,
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
  const byId = new Map(fighters.map((fighter) => [fighter.id, fighter]));
  const clashes = playClashes(state.clashes, tick, byId, inputs);
  const braced = new Set<PlayerId>();
  for (const fighter of fighters) {
    if (fighter.fellAt !== null) continue;
    if (clashOf(clashes, fighter.id)) {
      // En duel : figé sur place, planté sur ses pieds.
      fighter.vx = 0;
      fighter.vz = 0;
      braced.add(fighter.id);
      continue;
    }
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    act(fighter, input, dt);
    const isStill = Math.hypot(input.move.x, input.move.z) <= 0.1;
    const isSteady = fighter.stunned <= 0 && fighter.charging <= 0 && fighter.downed <= 0;
    if (isStill && isSteady) braced.add(fighter.id);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas, pour que la
  // place dans la liste ne donne jamais l'avantage (à égalité, une place gagnait 3 fois plus).
  const standingNow = fighters.filter((fighter) => fighter.fellAt === null);
  const shift = tick % Math.max(1, standingNow.length);
  const order = [...standingNow.slice(shift), ...standingNow.slice(0, shift)].reverse();
  const weight = (fighter: SumoFighter) => (braced.has(fighter.id) ? BRACE_WEIGHT : 1);
  collide(order, clashes, weight, state.seed, tick);
  const next: SumoState = { ...state, tick, fighters, clashes };
  const radius = sumoRadius(next);
  for (const fighter of fighters) {
    if (fighter.fellAt !== null) continue;
    fighter.x += fighter.vx * dt;
    fighter.z += fighter.vz * dt;
    if (Math.hypot(fighter.x, fighter.z) <= radius) continue;
    if (state.practice) {
      // Au bac à sable, on revient au centre.
      Object.assign(fighter, { x: 0, z: 0, vx: 0, vz: 0, charging: 0, stunned: 0, downed: 0 });
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
  if (fighter.downed > 0) {
    // À terre : il glisse sur l'élan de la projection, sans commandes, puis se relève.
    fighter.downed = Math.max(0, fighter.downed - dt);
    slow(fighter, BRAKE_FORCE * DOWN_FOOTING * dt);
    return;
  }
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

/** Retire `amount` à la vitesse, sans la faire changer de sens. */
function slow(fighter: SumoFighter, amount: number): void {
  const speed = Math.hypot(fighter.vx, fighter.vz);
  const kept = speed > 0 ? Math.max(0, speed - amount) / speed : 0;
  fighter.vx *= kept;
  fighter.vz *= kept;
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

/**
 * Les chocs entre combattants. Une charge projette sa cible (de face, elle lance un duel) ;
 * parée, elle projette l'attaquant. Les nouveaux duels s'ajoutent à `clashes`.
 */
function collide(
  fighters: SumoFighter[],
  clashes: SumoClash[],
  weight: (fighter: SumoFighter) => number,
  seed: number,
  tick: number,
): void {
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
      // Ils ne se chevauchent pas : chacun recule, le plus léger davantage.
      const shareA = weight(b) / (weight(a) + weight(b));
      const overlap = BODY_RADIUS * 2 - distance;
      a.x -= nx * overlap * shareA;
      a.z -= nz * overlap * shareA;
      b.x += nx * overlap * (1 - shareA);
      b.z += nz * overlap * (1 - shareA);
      if (a.charging > 0 === b.charging > 0) {
        bump(a, b, nx, nz, shareA);
        continue;
      }
      const [attacker, target, sign] = a.charging > 0 ? [a, b, 1] : [b, a, -1];
      // Chargé en plein duel par un troisième : le duel s'arrête là, il est projeté.
      const broken = clashOf(clashes, target.id);
      if (broken) clashes.splice(clashes.indexOf(broken), 1);
      if (charge(attacker, target, nx * sign, nz * sign, !broken)) {
        const zone = hashUnit(`${seed}:${tick}:${attacker.id}`);
        clashes.push({
          a: attacker.id,
          b: target.id,
          startTick: tick,
          zone: CLASH_ZONE_FROM + (CLASH_ZONE_TO - CLASH_ZONE_FROM) * zone,
          presses: {},
          result: null,
        });
      }
    }
  }
}

/**
 * `attacker` charge `target` ; `(nx, nz)` va de l'attaquant vers la cible. Renvoie true si
 * c'est un duel (cible de face, et `canClash`) : les deux sont alors arrêtés net.
 */
function charge(
  attacker: SumoFighter,
  target: SumoFighter,
  nx: number,
  nz: number,
  canClash: boolean,
): boolean {
  attacker.charging = 0;
  if (target.parrying > 0) {
    knockDown(attacker, -nx, -nz, PARRY_KNOCK);
    return false;
  }
  // La cible regarde l'attaquant si son regard va vers (-nx, -nz).
  const facing = -(Math.sin(target.facing) * nx + Math.cos(target.facing) * nz);
  if (canClash && facing > CLASH_FACING && target.downed <= 0 && target.charging <= 0) {
    for (const fighter of [attacker, target]) {
      fighter.vx = 0;
      fighter.vz = 0;
    }
    return true;
  }
  knockDown(target, nx, nz, CHARGE_KNOCK);
  attacker.vx *= 0.2;
  attacker.vz *= 0.2;
  return false;
}

/** Projeté vers `(nx, nz)` : il tombe à la renverse, glisse, puis se relève. */
function knockDown(fighter: SumoFighter, nx: number, nz: number, speed: number): void {
  fighter.vx = nx * speed;
  fighter.vz = nz * speed;
  fighter.charging = 0;
  fighter.parrying = 0;
  fighter.downed = DOWN_TIME;
  fighter.stunned = DOWN_TIME + STUN_TIME;
  fighter.chargeReady = Math.max(fighter.chargeReady, DOWN_TIME + GET_UP_CHARGE_DELAY);
}

/**
 * Un contact sans charge : ils finissent à la même vitesse le long du contact, sans rebond.
 * `shareA` est la part de l'écart que prend `a` (la moitié à poids égal, moins s'il s'arc-boute).
 */
function bump(a: SumoFighter, b: SumoFighter, nx: number, nz: number, shareA: number): void {
  const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (closing <= 0) return;
  a.vx -= nx * closing * shareA;
  a.vz -= nz * closing * shareA;
  b.vx += nx * closing * (1 - shareA);
  b.vz += nz * closing * (1 - shareA);
}

/**
 * Les duels : chacun appuie une fois (sur la touche de charge) ; quand les deux ont appuyé ou
 * que l'aiguille a fait le tour, le meilleur projette l'autre. Un duel joué reste un instant
 * dans la liste, pour afficher les notes, puis disparaît.
 */
function playClashes(
  previous: SumoClash[],
  tick: number,
  byId: Map<PlayerId, SumoFighter>,
  inputs: Partial<Record<PlayerId, ArenaInput>>,
): SumoClash[] {
  return previous.flatMap((old): SumoClash[] => {
    if (old.result) {
      return (tick - old.result.tick) * ARENA_STEP < CLASH_RESULT_TIME ? [old] : [];
    }
    const a = byId.get(old.a);
    const b = byId.get(old.b);
    if (!a || !b || a.fellAt !== null || b.fellAt !== null) return [];
    const clash = { ...old, presses: { ...old.presses } };
    const needle = clashNeedle(clash, tick);
    for (const fighter of [a, b]) {
      const input = inputs[fighter.id] ?? IDLE_INPUT;
      const isPressed = input.primary && !fighter.held.primary;
      if (isPressed && clash.presses[fighter.id] === undefined) clash.presses[fighter.id] = needle;
      fighter.held = { primary: input.primary, secondary: input.secondary };
    }
    const isDone =
      needle >= 1 || (clash.presses[a.id] !== undefined && clash.presses[b.id] !== undefined);
    if (!isDone) return [clash];
    const scores = {
      [a.id]: clashScore(clash.zone, clash.presses[a.id]),
      [b.id]: clashScore(clash.zone, clash.presses[b.id]),
    };
    resolveClash(a, b, scores[a.id] ?? 0, scores[b.id] ?? 0);
    return [{ ...clash, result: { tick, scores } }];
  });
}

/** Le meilleur projette l'autre, d'autant plus loin que sa note est haute ; à égalité, ils rebondissent. */
function resolveClash(a: SumoFighter, b: SumoFighter, scoreA: number, scoreB: number): void {
  const distance = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = (b.x - a.x) / distance;
  const nz = (b.z - a.z) / distance;
  if (scoreA === scoreB) {
    a.vx = -nx * CLASH_TIE_KNOCK;
    a.vz = -nz * CLASH_TIE_KNOCK;
    b.vx = nx * CLASH_TIE_KNOCK;
    b.vz = nz * CLASH_TIE_KNOCK;
    a.stunned = STUN_TIME;
    b.stunned = STUN_TIME;
    return;
  }
  const [loser, score, sign] = scoreA > scoreB ? [b, scoreA, 1] : [a, scoreB, -1];
  knockDown(loser, nx * sign, nz * sign, CLASH_KNOCK[score] ?? CHARGE_KNOCK);
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
/**
 * Au duel, les chances d'un bot (cumulées) de viser le parfait, le bien, le juste ; le reste
 * du temps, il rate. Tirées une fois par duel.
 */
const CLASH_SKILL: Record<BotLevel, readonly [number, number, number]> = {
  easy: [0.1, 0.35, 0.7],
  normal: [0.25, 0.6, 0.88],
  expert: [0.5, 0.85, 0.97],
};
/** Où il appuie, par rapport au centre de la zone, selon ce qu'il a tiré (raté en dernier). */
const CLASH_AIM = [0, 0.035, 0.075, 0.16] as const;
/** Il charge quand sa cible est à cette distance et bien alignée. */
const CHARGE_RANGE = 3.2;
/**
 * Il ne charge pas à la première occasion : une chance par pas, selon son niveau (il hésite,
 * il guette). Sans ça, quatre bots chargeaient toutes les deux secondes et la partie durait 5 s.
 */
const CHARGE_EAGERNESS: Record<BotLevel, number> = { easy: 0.03, normal: 0.05, expert: 0.07 };
/** Il reste à cette distance du bord, et vise de ce côté-ci de sa cible. */
const SAFE_EDGE = 1.4;
const BEHIND_TARGET = 1.2;
/** Une charge qui arrive : assez près, et vers lui. */
const THREAT_RANGE = 2.6;

/**
 * Le bot (02-mini-jeux.md, fiche 2) : il vise le joueur le plus près du bord, se place entre
 * lui et le centre, charge quand il est aligné, et pare une charge qui arrive (plus ou moins
 * souvent selon son niveau). Quand le plateau rétrécit, il reste loin du bord. Il laisse
 * tranquilles ceux qui sont en duel.
 */
function botInput(state: SumoState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || me.downed > 0) return IDLE_INPUT;
  const duel = clashOf(state.clashes, player);
  if (duel) return clashInput(state, duel, player, level);
  const radius = sumoRadius(state);
  const others = standing(state).filter(
    (fighter) => fighter.id !== player && !clashOf(state.clashes, fighter.id),
  );

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
    hashUnit(`${state.seed}:${player}>${other.id}`) * 1.5;
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

/**
 * Au duel, il tire la zone qu'il vise (CLASH_SKILL), d'un côté ou de l'autre du centre, et
 * appuie quand l'aiguille y arrive. Le tirage dépend du duel, pas du pas : il ne change pas
 * d'avis en route.
 */
function clashInput(
  state: SumoState,
  clash: SumoClash,
  player: PlayerId,
  level: BotLevel,
): ArenaInput {
  if (clash.presses[player] !== undefined) return IDLE_INPUT;
  const key = `${state.seed}:${clash.startTick}:${player}`;
  const tier = CLASH_SKILL[level].findIndex((chance) => hashUnit(`${key}:aim`) < chance);
  const offset = CLASH_AIM[tier === -1 ? CLASH_AIM.length - 1 : tier] ?? 0;
  const side = hashUnit(`${key}:side`) < 0.5 ? -1 : 1;
  // L'appui compte au pas suivant : il regarde où sera l'aiguille à ce moment-là.
  const isTime = clashNeedle(clash, state.tick + 1) >= clash.zone + offset * side;
  return { move: { x: 0, z: 0 }, primary: isTime, secondary: false };
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
  const distance = Math.hypot(dx, dz);
  return distance < 0.05 ? { x: 0, z: 0 } : { x: dx / distance, z: dz / distance };
}

export const PAWN_SUMO: ArenaGame<SumoState> = { create, step, botInput, isOver, ranking };
