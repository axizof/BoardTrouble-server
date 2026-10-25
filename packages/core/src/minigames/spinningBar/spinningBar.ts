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

// Barre tournante (02-mini-jeux.md, fiche 6) : deux barres tournent autour d'un pilier central,
// au-dessus du vide. Chacun se tient sur son propre pilier, où il peut bouger un peu. La barre
// basse se saute, la haute se passe baissé ; une barre qui te prend te pousse, et poussé hors de
// ton pilier, tu tombes. Elles accélèrent, se rapprochent l'une de l'autre et changent parfois de
// sens, en l'annonçant par des bips. Dernier debout gagne.

/** Le cercle des piliers des joueurs, et le dessus de chaque pilier (mètres). */
export const SPOT_RADIUS = 4.5;
export const SPOT_PILLAR_RADIUS = 1.3;
/** On marche autour du centre de son pilier jusqu'à cette distance (on ne saute pas du bord). */
export const PAD_RADIUS = 0.9;
/** Le pilier du centre ; les barres vont de lui jusqu'au-delà des piliers des joueurs. */
export const PILLAR_RADIUS = 0.45;
export const BAR_REACH = SPOT_RADIUS + SPOT_PILLAR_RADIUS + 0.3;
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
 * largeur où elle touche (2 × (BAR_HALF_WIDTH + rayon) au bord de la zone) à chaque pas.
 */
const SPIN_START = 1.1;
const SPIN_MAX = 3.2;
const SPIN_RAMP = 60;
/** Au départ, les barres sont à cet angle après un pilier (radians). */
const START_AFTER = 0.3;
/** Au bac à sable, les barres tournent lentement, sans accélérer. */
const PRACTICE_SPIN = 1.2;
/**
 * L'écart entre les deux barres (radians) : opposées au départ, puis plus proches. Au plus près
 * et au plus vite, il reste 0,78 s entre la basse et la haute qui la suit : le temps de
 * retomber d'un saut et de se baisser (un saut dure 0,7 s).
 */
const GAP_START = Math.PI;
const GAP_MIN = Math.PI * 0.8;
/**
 * Changer de sens : les barres freinent puis repartent, à cette accélération (rad/s²), sans
 * à-coup. Pas plus douce : une barre qui s'arrête sur quelqu'un reste au-dessus de lui à peine
 * moins longtemps qu'un saut (0,46 s contre 0,52), il peut encore la passer.
 */
const REVERSE_ACCEL = 5;
/**
 * Le premier changement de sens, au hasard entre FIRST_REVERSE et + REVERSE_SPREAD secondes,
 * puis un toutes les REVERSE_EVERY à + REVERSE_SPREAD secondes. Au hasard de chaque partie : un
 * moment fixe faisait toujours tomber le demi-tour sur les mêmes places.
 */
const FIRST_REVERSE = 12;
const REVERSE_EVERY = 9;
const REVERSE_SPREAD = 9;
/**
 * Un changement de sens s'annonce par des bips, un toutes les BEEP_EVERY secondes, le dernier
 * juste avant : trois au début, deux après TWO_BEEPS_AT, un seul après ONE_BEEP_AT.
 */
export const BEEP_EVERY = 0.5;
const TWO_BEEPS_AT = 30;
const ONE_BEEP_AT = 60;
/** Le chrono (secondes) : ceux encore debout sont ex aequo, les dés les départagent. */
export const SPIN_TIME_LIMIT = 90;
/**
 * Une barre qui te prend te pousse devant elle, un peu plus vite qu'elle (et un peu vers
 * l'extérieur), et te renverse : tu glisses jusqu'à tomber de ton pilier, ou elle te rattrape.
 */
const PUSH_MARGIN = 1.5;
const PUSH_MIN = 4.5;
const PUSH_OUT = 0.25;
const PUSH_DOWN = 0.8;
/** Plus bas que ça, on est tombé dans le vide. */
const OUT_BELOW = -3;
/** Un petit déplacement, et un saut assez haut pour passer la barre basse. */
const SPIN_WALKER: BodyTuning = { ...WALKER, radius: 0.4, walkSpeed: 2.5, jumpSpeed: 7 };
/** Baissé, on se déplace à peine. */
const DUCK_CONTROL = 0.3;

export type SpinBar = 'low' | 'high';

export type SpinFighter = ArenaBody & {
  /** L'angle de son pilier sur le cercle (comme `atan2(x, z)`). */
  spot: number;
  /** La touche de saut tenue au pas précédent : il saute quand on appuie, pas en tenant. */
  held: boolean;
  ducking: boolean;
  /** Le pas où il est tombé dans le vide, ou null. */
  fellAt: number | null;
};

/** Ce qui fait tourner les barres. */
type Bars = {
  /** L'angle de la barre basse, sans tour complet retiré ; la haute suit à `gap` derrière. */
  angle: number;
  gap: number;
  /** La vitesse de rotation, signée (positive : dans le sens des angles croissants). */
  spin: number;
  /** Le sens voulu (1 ou -1) : différent du signe de `spin`, les barres changent de sens. */
  direction: 1 | -1;
  /** Le pas du prochain changement de sens. */
  reverseAt: number;
};

export type SpinState = Bars & {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: SpinFighter[];
};

/** L'angle d'une barre. */
export function barAngle(bars: Bars, bar: SpinBar): number {
  return bar === 'low' ? bars.angle : bars.angle - bars.gap;
}

/** Les barres changent de sens en ce moment (elles freinent ou repartent). */
export function isReversing(bars: Bars): boolean {
  return Math.sign(bars.spin) !== bars.direction;
}

/** Combien de bips annoncent un changement de sens qui arrive à ce pas. */
export function beepsBefore(reverseAt: number): number {
  const time = reverseAt * ARENA_STEP;
  return time < TWO_BEEPS_AT ? 3 : time < ONE_BEEP_AT ? 2 : 1;
}

/** Un bip d'annonce à ce pas (il y en a BEEP_EVERY secondes avant, et avant encore). */
export function isBeep(state: SpinState): boolean {
  const left = state.reverseAt - state.tick;
  const every = Math.round(BEEP_EVERY / ARENA_STEP);
  return left > 0 && left % every === 0 && left / every <= beepsBefore(state.reverseAt);
}

/**
 * Le changement de sens annoncé (depuis le premier bip) ou en cours, et le sens où les barres
 * vont repartir ; null sinon.
 */
export function reversal(state: SpinState): { direction: 1 | -1 } | null {
  if (isReversing(state)) return { direction: state.direction };
  const left = (state.reverseAt - state.tick) * ARENA_STEP;
  const announced = left <= beepsBefore(state.reverseAt) * BEEP_EVERY + 1e-6;
  return announced ? { direction: state.direction === 1 ? -1 : 1 } : null;
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

function reverseTick(seed: number, after: number, wait: number): number {
  const spread = hashUnit(`${seed}:reverse:${after}`) * REVERSE_SPREAD;
  return after + Math.round((wait + spread) / ARENA_STEP);
}

/** Les barres un pas plus tard (la vitesse monte, le sens change à l'heure dite). */
function advanceBars(bars: Bars, tick: number, practice: boolean, seed: number): Bars {
  const dt = ARENA_STEP;
  const time = tick * dt;
  let { direction, reverseAt } = bars;
  if (tick >= reverseAt) {
    direction = direction === 1 ? -1 : 1;
    reverseAt = reverseTick(seed, tick, REVERSE_EVERY);
  }
  const ramp = Math.min(1, time / SPIN_RAMP);
  const speed = practice ? PRACTICE_SPIN : SPIN_START + (SPIN_MAX - SPIN_START) * ramp;
  // Vers la vitesse voulue, sans dépasser REVERSE_ACCEL : un changement de sens freine puis
  // repart, et l'accélération ordinaire (bien plus douce) est suivie telle quelle.
  const change = speed * direction - bars.spin;
  const spin = bars.spin + Math.max(-REVERSE_ACCEL * dt, Math.min(REVERSE_ACCEL * dt, change));
  const gap = practice ? GAP_START : GAP_START + (GAP_MIN - GAP_START) * ramp;
  return { angle: bars.angle + spin * dt, gap, spin, direction, reverseAt };
}

function spotOf(spot: number): { x: number; z: number } {
  return { x: Math.sin(spot) * SPOT_RADIUS, z: Math.cos(spot) * SPOT_RADIUS };
}

function standOnSpot(id: PlayerId, spot: number): SpinFighter {
  const { x, z } = spotOf(spot);
  // Chacun regarde le centre, d'où arrivent les barres.
  return {
    ...createBody(id, x, z, Math.atan2(-x, -z)),
    spot,
    held: false,
    ducking: false,
    fellAt: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SpinState {
  const count = Math.max(1, players.length);
  // Les barres partent arrêtées, juste après un pilier tiré au hasard : celui qu'elles
  // atteignent en premier a le temps de les voir venir, et ce n'est pas toujours le même.
  const after = Math.floor(hashUnit(`${seed}:start`) * count);
  return {
    tick: 0,
    practice,
    seed,
    angle: (after / count) * Math.PI * 2 + START_AFTER,
    gap: GAP_START,
    spin: 0,
    direction: 1,
    reverseAt: reverseTick(seed, 0, FIRST_REVERSE),
    fighters: players.map((id, index) => standOnSpot(id, (index / count) * Math.PI * 2)),
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
  const bars = advanceBars(state, tick, state.practice, state.seed);
  const next: SpinState = { ...state, ...bars, tick };
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  for (const fighter of standing) {
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
  // Le sol : le dessus de son propre pilier ; autour, le vide.
  const spots = new Map(standing.map((fighter) => [fighter.id, spotOf(fighter.spot)]));
  moveBodies(standing, SPIN_WALKER, dt, (body) => {
    const spot = spots.get(body.id);
    if (!spot || body.y < -0.1) return null;
    return Math.hypot(body.x - spot.x, body.z - spot.z) <= SPOT_PILLAR_RADIUS ? 0 : null;
  });
  for (const fighter of standing) {
    if (fighter.downed <= 0 && fighter.onGround) keepOnPad(fighter);
    if (fighter.y >= -0.1) push(next, fighter);
    if (fighter.y > OUT_BELOW) continue;
    if (state.practice) Object.assign(fighter, standOnSpot(fighter.id, fighter.spot));
    else fighter.fellAt = tick;
  }
  return { ...next, fighters };
}

/** Il marche autour du centre de son pilier, sans en descendre. */
function keepOnPad(fighter: SpinFighter): void {
  const spot = spotOf(fighter.spot);
  const dx = fighter.x - spot.x;
  const dz = fighter.z - spot.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= PAD_RADIUS) return;
  const nx = dx / distance;
  const nz = dz / distance;
  fighter.x = spot.x + nx * PAD_RADIUS;
  fighter.z = spot.z + nz * PAD_RADIUS;
  const outward = fighter.vx * nx + fighter.vz * nz;
  if (outward > 0) {
    fighter.vx -= nx * outward;
    fighter.vz -= nz * outward;
  }
}

/** Une barre sur lui, à une hauteur qu'il occupe, le pousse devant elle et le renverse. */
function push(state: SpinState, fighter: SpinFighter): void {
  if (!barHitting(state, fighter)) return;
  const distance = Math.hypot(fighter.x, fighter.z);
  const at = Math.atan2(fighter.x, fighter.z);
  // Le sens où la barre avance, là où il est.
  const along = Math.sign(state.spin) || 1;
  const speed = Math.max(PUSH_MIN, Math.abs(state.spin) * distance + PUSH_MARGIN);
  const nx = Math.cos(at) * along + Math.sin(at) * PUSH_OUT;
  const nz = -Math.sin(at) * along + Math.cos(at) * PUSH_OUT;
  const length = Math.hypot(nx, nz);
  knockDown(fighter, nx / length, nz / length, speed, PUSH_DOWN);
  fighter.ducking = false;
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
 * tombés, du dernier au premier. Tombés au même pas : ex aequo.
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
 * Le bot voit venir les barres (il les suit un peu à l'avance, changements de sens compris,
 * comme un joueur qui entend les bips) et regarde la prochaine qui passe sur lui : la basse, il
 * saute quand elle est à JUMP_LEAD secondes (elle passe alors au milieu du temps où ses pieds sont au-dessus d'elle) ; la
 * haute, il se baisse un peu avant et reste baissé tant qu'elle est sur lui. Son niveau règle la
 * justesse de son timing, et combien de fois il confond les barres ; comme un joueur, il se
 * trompe plus quand elles vont vite. Son erreur ne change pas pendant qu'une même barre arrive :
 * il ne change pas d'avis en route.
 */
const JUMP_LEAD = 0.35;
const DUCK_LEAD = 0.3;
/** Jusqu'où il voit venir les barres (secondes). */
const BOT_HORIZON = 1.2;
const TIMING_NOISE: Record<BotLevel, number> = { easy: 0.15, normal: 0.12, expert: 0.11 };
const MIXUP: Record<BotLevel, number> = { easy: 0.08, normal: 0.03, expert: 0.02 };

function botInput(state: SpinState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || isAirborne(me) || me.downed > 0) return IDLE_INPUT;
  const next = nextPass(state, me);
  if (!next) return IDLE_INPUT;
  const thought = `${state.seed}:${player}:${next.bar}:${next.pass}`;
  const haste = Math.abs(state.spin) / SPIN_START;
  const error = (hashUnit(thought) * 2 - 1) * TIMING_NOISE[level] * haste;
  const isMixedUp = hashUnit(`${thought}:mixup`) < MIXUP[level] * haste;
  const action = (next.bar === 'low') !== isMixedUp ? 'jump' : 'duck';
  if (action === 'duck') {
    // Une barre sur lui : il reste baissé, quoi qu'il en pense.
    const isDucking = next.arrival === 0 || next.arrival < DUCK_LEAD + error;
    return { move: { x: 0, z: 0 }, primary: false, secondary: isDucking };
  }
  const isTime = next.arrival < JUMP_LEAD + error && next.arrival > 0;
  return { move: { x: 0, z: 0 }, primary: isTime, secondary: false };
}

/**
 * La prochaine barre qui passe sur lui, d'après les barres suivies pas à pas : dans combien de
 * secondes son milieu passe (0 : elle est sur lui), et ce passage compté en tours (le même tant
 * que cette barre arrive).
 */
function nextPass(
  state: SpinState,
  me: SpinFighter,
): { bar: SpinBar; arrival: number; pass: number } | null {
  const at = Math.atan2(me.x, me.z);
  const reach = (BAR_HALF_WIDTH + SPIN_WALKER.radius) / Math.max(1, Math.hypot(me.x, me.z));
  let bars: Bars = state;
  for (let ahead = 0; ahead * ARENA_STEP <= BOT_HORIZON; ahead++) {
    const later = advanceBars(bars, state.tick + ahead + 1, state.practice, state.seed);
    for (const bar of ['low', 'high'] as const) {
      const before = wrap(at - barAngle(bars, bar));
      const after = wrap(at - barAngle(later, bar));
      const isOnMe = ahead === 0 && Math.abs(before) < reach;
      const crosses = Math.sign(before) !== Math.sign(after) && Math.abs(before) < 1;
      if (!isOnMe && !crosses) continue;
      const pass = Math.round((barAngle(bars, bar) + before - at) / (Math.PI * 2));
      // Le milieu passe pendant ce pas : à la part du pas où il croise sa place.
      const share = Math.abs(before) / (Math.abs(before) + Math.abs(after) || 1);
      return { bar, arrival: isOnMe ? 0 : (ahead + share) * ARENA_STEP, pass };
    }
    bars = later;
  }
  return null;
}

export const SPINNING_BAR: ArenaGame<SpinState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
