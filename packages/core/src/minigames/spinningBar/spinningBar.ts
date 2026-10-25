import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  type BodyTuning,
  createBody,
  isAirborne,
  jumpBody,
  knockDown,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';

// Barre tournante (02-mini-jeux.md, fiche 6) : deux barres tournent autour d'un pilier, au
// centre d'un plateau rond. La basse se saute, la haute se passe baissé. Elles accélèrent, se
// rapprochent l'une de l'autre et changent parfois de sens. Chacun a sa place sur le pourtour,
// où il peut bouger un peu ; une barre qui le touche le balaie hors du plateau. Dernier debout
// gagne.

/** Le plateau, et le cercle des places des joueurs (mètres). */
export const SPIN_PLATFORM_RADIUS = 6.5;
export const SPOT_RADIUS = 4.5;
/** On bouge autour de sa place, jusqu'à cette distance. */
export const PAD_RADIUS = 0.9;
/** Le pilier du centre ; les barres vont de lui jusqu'au-delà du bord. */
export const PILLAR_RADIUS = 0.45;
/** La barre basse, du sol à LOW_BAR_TOP ; la haute, de HIGH_BAR_BOTTOM à HIGH_BAR_TOP. */
export const LOW_BAR_TOP = 0.55;
export const HIGH_BAR_BOTTOM = 1;
export const HIGH_BAR_TOP = 1.4;
/** La demi-épaisseur d'une barre, sur le plan. */
export const BAR_HALF_WIDTH = 0.18;
/** La hauteur d'un joueur debout et baissé. */
const STAND_HEIGHT = 1.4;
const DUCK_HEIGHT = 0.75;
/**
 * La vitesse des barres (radians par seconde) : de SPIN_START à SPIN_MAX en SPIN_RAMP secondes.
 * SPIN_MAX reste sous ce que le contrôle des contacts suit : une barre avance de moins que la
 * largeur où elle touche (2 × (BAR_HALF_WIDTH + rayon) au bord de la place) à chaque pas.
 */
const SPIN_START = 1.1;
const SPIN_MAX = 3.2;
const SPIN_RAMP = 60;
/** Au bac à sable, les barres tournent lentement, sans accélérer ni changer de sens. */
const PRACTICE_SPIN = 1.2;
/**
 * L'écart entre les deux barres (radians) : opposées au départ, puis plus proches. Au plus près
 * et au plus vite, il reste 0,78 s entre la basse et la haute qui la suit : le temps de
 * retomber d'un saut et de se baisser (un saut dure 0,7 s).
 */
const GAP_START = Math.PI;
const GAP_MIN = Math.PI * 0.8;
/**
 * Changer de sens : les barres freinent puis repartent, à cette accélération (rad/s²). Vive :
 * une barre qui s'arrête sur quelqu'un ne reste au-dessus de lui qu'un quart de seconde (un
 * saut le passe) ; plus douce, elle s'y attardait plus longtemps qu'un saut.
 */
const REVERSE_ACCEL = 12;
/** Le changement de sens s'annonce tant de secondes avant. */
export const REVERSE_WARNING = 1;
/** Le premier changement de sens (secondes), puis un toutes les 10 à 16 s. */
const FIRST_REVERSE = 18;
const REVERSE_EVERY = 10;
const REVERSE_SPREAD = 6;
/** Le chrono (secondes) : ceux encore debout sont ex aequo, les dés les départagent. */
export const SPIN_TIME_LIMIT = 90;
/**
 * Balayé : il part à cette vitesse dans le sens de la barre, un peu vers l'extérieur, et monte
 * à SWEEP_UP (l'affichage ajoute sa chute : il passe ainsi le bord avant de tomber, au lieu de
 * s'enfoncer dans le plateau).
 */
const SWEEP_SPEED = 8;
const SWEEP_OUT = 2.5;
const SWEEP_UP = 3;
/** Au bac à sable, la barre le renverse au lieu de l'éliminer : il reste au sol tant. */
const PRACTICE_DOWN = 1;
/** Un petit déplacement, et un saut assez haut pour passer la barre basse. */
const SPIN_WALKER: BodyTuning = { ...WALKER, radius: 0.4, walkSpeed: 2.5, jumpSpeed: 7 };
/** Baissé, on se déplace à peine. */
const DUCK_CONTROL = 0.3;

export type SpinBar = 'low' | 'high';

export type SpinFighter = ArenaBody & {
  /** L'angle de sa place sur le cercle (comme `atan2(x, z)`). */
  spot: number;
  /** La touche de saut tenue au pas précédent : il saute quand on appuie, pas en tenant. */
  held: boolean;
  ducking: boolean;
  /** Le pas où une barre l'a balayé, ou null. */
  fellAt: number | null;
};

export type SpinState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** L'angle de la barre basse, sans tour complet retiré ; la haute suit à `gap` derrière. */
  angle: number;
  gap: number;
  /** La vitesse de rotation, signée (positive : dans le sens des angles croissants). */
  spin: number;
  /** Le sens voulu (1 ou -1) : différent du signe de `spin`, les barres changent de sens. */
  direction: 1 | -1;
  /** Le pas du prochain changement de sens. */
  reverseAt: number;
  fighters: SpinFighter[];
};

/** L'angle d'une barre. */
export function barAngle(state: SpinState, bar: SpinBar): number {
  return bar === 'low' ? state.angle : state.angle - state.gap;
}

/** Les barres changent de sens en ce moment (elles freinent ou repartent). */
export function isReversing(state: SpinState): boolean {
  return Math.sign(state.spin) !== state.direction;
}

/** Les barres vont changer de sens (l'annonce), ou changent de sens. */
export function reversesSoon(state: SpinState): boolean {
  return (
    !state.practice &&
    (isReversing(state) || (state.reverseAt - state.tick) * ARENA_STEP <= REVERSE_WARNING)
  );
}

/** Un angle ramené entre -π et π. */
function wrap(angle: number): number {
  const turn = Math.PI * 2;
  return angle - turn * Math.round(angle / turn);
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

function nextReverse(seed: number, tick: number): number {
  const spread = hashUnit(`${seed}:reverse:${tick}`) * REVERSE_SPREAD;
  return tick + Math.round((REVERSE_EVERY + spread) / ARENA_STEP);
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SpinState {
  return {
    tick: 0,
    practice,
    seed,
    // Les barres partent entre deux places : personne ne l'a sur lui au premier pas.
    angle: Math.PI / Math.max(1, players.length),
    gap: GAP_START,
    spin: practice ? PRACTICE_SPIN : SPIN_START,
    direction: 1,
    reverseAt: Math.round(FIRST_REVERSE / ARENA_STEP),
    fighters: players.map((id, index) => {
      const spot = (index / players.length) * Math.PI * 2;
      const x = Math.sin(spot) * SPOT_RADIUS;
      const z = Math.cos(spot) * SPOT_RADIUS;
      // Chacun regarde le centre, d'où arrivent les barres.
      return {
        ...createBody(id, x, z, Math.atan2(-x, -z)),
        spot,
        held: false,
        ducking: false,
        fellAt: null,
      };
    }),
  };
}

/**
 * Les commandes de déplacement sont celles de sa caméra : derrière lui, tournée vers le centre
 * (haut : vers le pilier ; droite : le long du cercle). On les remet dans le plan.
 */
function worldMove(fighter: SpinFighter, move: { x: number; z: number }): { x: number; z: number } {
  const cos = Math.cos(fighter.spot);
  const sin = Math.sin(fighter.spot);
  return { x: move.x * cos + move.z * sin, z: -move.x * sin + move.z * cos };
}

function step(state: SpinState, inputs: Partial<Record<PlayerId, ArenaInput>>): SpinState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const time = tick * dt;
  let { direction, reverseAt, gap } = state;
  let spin = state.spin;
  if (!state.practice) {
    if (tick >= reverseAt) {
      direction = direction === 1 ? -1 : 1;
      reverseAt = nextReverse(state.seed, tick);
    }
    const speed = SPIN_START + (SPIN_MAX - SPIN_START) * Math.min(1, time / SPIN_RAMP);
    // Vers la vitesse voulue, sans dépasser REVERSE_ACCEL : un changement de sens freine puis
    // repart, et l'accélération ordinaire (bien plus douce) est suivie telle quelle.
    spin += Math.max(-REVERSE_ACCEL * dt, Math.min(REVERSE_ACCEL * dt, speed * direction - spin));
    gap = GAP_START + (GAP_MIN - GAP_START) * Math.min(1, time / SPIN_RAMP);
  }
  const angle = state.angle + spin * dt;
  const next: SpinState = { ...state, tick, angle, gap, spin, direction, reverseAt };
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  for (const fighter of fighters) {
    if (fighter.fellAt !== null) {
      // Balayé : il file hors du plateau (sa chute, l'affichage la montre).
      fighter.x += fighter.vx * dt;
      fighter.y += SWEEP_UP * dt;
      fighter.z += fighter.vz * dt;
      continue;
    }
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    const isDown = fighter.downed > 0;
    fighter.ducking = input.secondary && !isAirborne(fighter) && !isDown;
    walkBody(
      fighter,
      worldMove(fighter, input.move),
      SPIN_WALKER,
      dt,
      fighter.ducking ? DUCK_CONTROL : 1,
    );
    if (input.primary && !fighter.held && !fighter.ducking) jumpBody(fighter, SPIN_WALKER);
    fighter.held = input.primary;
  }
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  moveBodies(standing, SPIN_WALKER, dt);
  for (const fighter of standing) {
    keepOnPad(fighter);
    const bar = barHitting(next, fighter);
    if (!bar || fighter.downed > 0) continue;
    // Le sens où la barre avance, là où il est.
    const at = Math.atan2(fighter.x, fighter.z);
    const along = Math.sign(spin) || 1;
    const nx = Math.cos(at) * along + Math.sin(at) * (SWEEP_OUT / SWEEP_SPEED);
    const nz = -Math.sin(at) * along + Math.cos(at) * (SWEEP_OUT / SWEEP_SPEED);
    if (state.practice) {
      knockDown(fighter, nx, nz, SWEEP_SPEED * 0.4, PRACTICE_DOWN);
      fighter.ducking = false;
    } else {
      fighter.vx = nx * SWEEP_SPEED;
      fighter.vz = nz * SWEEP_SPEED;
      fighter.fellAt = tick;
    }
  }
  return { ...next, fighters };
}

/** Il reste près de sa place : au bord de sa zone, il s'arrête. */
function keepOnPad(fighter: SpinFighter): void {
  const spotX = Math.sin(fighter.spot) * SPOT_RADIUS;
  const spotZ = Math.cos(fighter.spot) * SPOT_RADIUS;
  const dx = fighter.x - spotX;
  const dz = fighter.z - spotZ;
  const distance = Math.hypot(dx, dz);
  if (distance <= PAD_RADIUS) return;
  const nx = dx / distance;
  const nz = dz / distance;
  fighter.x = spotX + nx * PAD_RADIUS;
  fighter.z = spotZ + nz * PAD_RADIUS;
  const outward = fighter.vx * nx + fighter.vz * nz;
  if (outward > 0) {
    fighter.vx -= nx * outward;
    fighter.vz -= nz * outward;
  }
}

/** La barre qui le touche en ce moment : sur lui, à une hauteur qu'il occupe. */
export function barHitting(state: SpinState, fighter: SpinFighter): SpinBar | null {
  const distance = Math.hypot(fighter.x, fighter.z);
  const at = Math.atan2(fighter.x, fighter.z);
  const reach = BAR_HALF_WIDTH + SPIN_WALKER.radius;
  const top = fighter.y + (fighter.ducking ? DUCK_HEIGHT : STAND_HEIGHT);
  for (const bar of ['low', 'high'] as const) {
    if (Math.abs(wrap(at - barAngle(state, bar))) * distance >= reach) continue;
    const isHit =
      bar === 'low' ? fighter.y < LOW_BAR_TOP : top > HIGH_BAR_BOTTOM && fighter.y < HIGH_BAR_TOP;
    if (isHit) return bar;
  }
  return null;
}

function standingFighters(state: SpinState): SpinFighter[] {
  return state.fighters.filter((fighter) => fighter.fellAt === null);
}

function timeLeft(state: SpinState): number | null {
  return state.practice ? null : Math.max(0, SPIN_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: SpinState): boolean {
  if (state.practice) return false;
  const alive = standingFighters(state).length;
  return alive === 0 || (state.fighters.length > 1 && alive <= 1) || (timeLeft(state) ?? 1) <= 0;
}

/**
 * Le classement : ceux encore debout, ex aequo (au chrono, les dés les départagent), puis les
 * balayés, du dernier au premier. Balayés au même pas : ex aequo.
 */
function ranking(state: SpinState): PlayerId[][] {
  const alive = standingFighters(state).map((fighter) => fighter.id);
  const fallen = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    if (fighter.fellAt === null) continue;
    fallen.set(fighter.fellAt, [...(fallen.get(fighter.fellAt) ?? []), fighter.id]);
  }
  const byFall = [...fallen.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return alive.length > 0 ? [alive, ...byFall] : byFall;
}

/**
 * Le bot regarde la prochaine barre qui arrive sur lui : la basse, il saute quand elle est à
 * JUMP_LEAD secondes (elle passe alors au plus haut de son saut) ; la haute, il se baisse un
 * peu avant et reste baissé tant qu'elle est sur lui. Son niveau règle la justesse de son
 * timing, et combien de fois il confond les barres ; comme un joueur, il se trompe plus quand
 * elles vont vite (erreur et confusions croissent avec la vitesse). Son erreur ne change pas
 * pendant qu'une même barre arrive : il ne change pas d'avis en route.
 */
const JUMP_LEAD = 0.33;
const DUCK_LEAD = 0.3;
const TIMING_NOISE: Record<BotLevel, number> = { easy: 0.15, normal: 0.12, expert: 0.1 };
const MIXUP: Record<BotLevel, number> = { easy: 0.08, normal: 0.03, expert: 0.015 };

function botInput(state: SpinState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || isAirborne(me)) return IDLE_INPUT;
  const speed = Math.abs(state.spin);
  if (speed < 0.05) return IDLE_INPUT;
  const at = Math.atan2(me.x, me.z);
  const along = Math.sign(state.spin);
  const distance = Math.hypot(me.x, me.z);
  const reach = (BAR_HALF_WIDTH + SPIN_WALKER.radius) / distance;
  let next: { bar: SpinBar; arrival: number; pass: number } | null = null;
  for (const bar of ['low', 'high'] as const) {
    const angle = barAngle(state, bar);
    const gap = wrap(at - angle) * along;
    // Une barre sur lui : elle compte encore (il reste baissé dessous).
    const ahead = gap < -reach ? gap + Math.PI * 2 : gap;
    const arrival = ahead / speed;
    // Le passage, compté en tours : le même tant que cette barre arrive.
    const pass = Math.round((angle + ahead * along - at) / (Math.PI * 2));
    if (!next || arrival < next.arrival) next = { bar, arrival, pass };
  }
  if (!next) return IDLE_INPUT;
  const thought = `${state.seed}:${player}:${next.bar}:${next.pass}`;
  const haste = speed / SPIN_START;
  const error = (hashUnit(thought) * 2 - 1) * TIMING_NOISE[level] * haste;
  const isMixedUp = hashUnit(`${thought}:mixup`) < MIXUP[level] * haste;
  const action = (next.bar === 'low') !== isMixedUp ? 'jump' : 'duck';
  if (action === 'duck') {
    return { move: { x: 0, z: 0 }, primary: false, secondary: next.arrival < DUCK_LEAD + error };
  }
  const isTime = next.arrival < JUMP_LEAD + error && next.arrival > 0;
  return { move: { x: 0, z: 0 }, primary: isTime, secondary: false };
}

export const SPINNING_BAR: ArenaGame<SpinState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
