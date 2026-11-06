import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { type ArenaBody, createBody } from '../arena/body';

// Le Rempart (02-mini-jeux.md, fiche 31), un 1 contre tous : le joueur seul tient le centre, les
// autres tournent autour de lui sur un anneau et lui lancent de grosses pierres. Il se tourne et
// frappe : le coup casse les pierres devant lui, au plus près ; un coup dans le vide le fait
// trébucher. Deux pierres qui se touchent en vol se cassent : les lanceurs doivent étaler leurs
// lancers, et faire arriver leurs pierres l'une après l'autre, de directions différentes. Trois
// pierres reçues, le joueur seul perd ; s'il tient jusqu'au bout du chrono, il gagne.

/** Le chrono (secondes) : le joueur seul gagne s'il tient jusque-là. */
export const RAMPART_TIME_LIMIT = 40;
/** Les pierres que le joueur seul peut recevoir : à la dernière, il perd. */
export const RAMPART_LIVES = 3;
/** L'anneau des lanceurs, autour du centre (m), et leur pas dessus (m/s). */
export const RING_RADIUS = 6.5;
const THROWER_SPEED = 3.5;
/** Deux lanceurs ne s'approchent pas plus que ça sur l'anneau (m). */
const THROWER_GAP = 1.1;
/**
 * Le lancer : on maintient la touche pour prendre de l'élan (THROW_CHARGE_TIME au plus, puis la pierre
 * part toute seule), elle part au lâcher. Tapotée, elle file à SLOW_STONE ; chargée à fond, à
 * FAST_STONE. Ensuite, il faut RELOAD_TIME pour ramasser une nouvelle pierre.
 */
export const THROW_CHARGE_TIME = 0.8;
export const SLOW_STONE = 5.5;
export const FAST_STONE = 10.5;
export const RELOAD_TIME = 1.4;
/**
 * À plus de RELOAD_THROWERS lanceurs, ramasser prend plus longtemps, d'autant : le joueur seul
 * reçoit à peu près autant de pierres à 4 qu'à 6 (sans ça, il ne gagnait presque plus à 6).
 */
const RELOAD_THROWERS = 3;
/** Le rayon d'une pierre : deux pierres plus près que deux rayons se cassent l'une l'autre. */
export const STONE_RADIUS = 0.4;
/** Une pierre à cette distance du centre touche le joueur seul. */
export const HIT_DISTANCE = 0.9;
/**
 * Toutes les pierres visent le même point : deux qui y arrivent à moins de CLASH_WINDOW secondes
 * l'une de l'autre s'entrechoquent au-dessus de la tête du joueur seul, sans le toucher. Sans
 * ça, deux lanceurs qui tiraient en même temps de deux côtés touchaient presque à coup sûr ;
 * avec, il faut que les pierres arrivent l'une après l'autre.
 */
export const CLASH_WINDOW = 0.12;
/**
 * Le coup : il dure SWING_TICKS pas ; il casse les pierres à STRIKE_REACH du centre au plus, et à
 * STRIKE_ARC radians au plus de part et d'autre de là où il regarde. Frapper trop tôt rate.
 * Une pierre cassée, il peut refrapper aussitôt ; un coup dans le vide le fait trébucher
 * STUMBLE_TIME secondes (ni coup ni demi-tour).
 */
export const SWING_TICKS = 5;
export const STRIKE_REACH = 2.6;
export const STRIKE_ARC = Math.PI / 3;
export const STUMBLE_TIME = 1;
/** Il se tourne à cette vitesse (radians par seconde) : vite, mais pas d'un coup. */
const SOLO_TURN_RATE = 12;
/** Une pierre cassée reste dans l'état ce temps-là : le client montre ses éclats. */
const BROKEN_KEPT = 1;
/** Au bac à sable, le lanceur mannequin lance tant de secondes après avoir ramassé sa pierre. */
const DUMMY_THROW_DELAY = 0.8;

export type RampartSolo = ArenaBody & {
  lives: number;
  /** La touche tenue au pas précédent : il frappe quand on appuie, pas en tenant. */
  held: boolean;
  /** Le pas où son coup en cours a commencé, ou null ; et s'il a déjà cassé une pierre. */
  swingAt: number | null;
  swingHit: boolean;
  /** Il a trébuché : le pas jusqu'où il ne peut plus rien faire, ou null. */
  stumbleUntil: number | null;
  /** Les pierres qu'il a cassées (stats). */
  broken: number;
};

export type RampartThrower = ArenaBody & {
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Sa place sur l'anneau (angle autour du centre, comme `atan2(x, z)`). */
  angle: number;
  held: boolean;
  /** Secondes d'élan, tant qu'il charge un lancer ; null sinon. */
  charge: number | null;
  /** Le pas où il aura une pierre en main (déjà passé : il en a une). */
  stoneAt: number;
  /** Les pierres qu'il a lancées, et celles qui ont touché le joueur seul (stats). */
  thrown: number;
  hits: number;
};

/** Une pierre : d'où elle vient, où elle en est, et comment elle a fini (ou null en vol). */
export type RampartStone = {
  id: number;
  thrower: PlayerId;
  x: number;
  z: number;
  /** Sa direction (vers le centre) et sa vitesse (m/s). */
  dx: number;
  dz: number;
  speed: number;
  /** Le pas où elle est partie, et sa distance au centre au départ (pour l'arc de son vol). */
  thrownAt: number;
  from: number;
  endedAt: number | null;
  end: 'struck' | 'clash' | 'hit' | null;
};

export type RampartState = {
  tick: number;
  practice: boolean;
  seed: number;
  solo: RampartSolo;
  fighters: RampartThrower[];
  stones: RampartStone[];
  nextStone: number;
};

/** Distance d'un point au centre. */
function reach(point: { x: number; z: number }): number {
  return Math.hypot(point.x, point.z);
}

/** L'écart le plus court de l'angle `from` à l'angle `to` (radians, entre -π et π). */
function turnTo(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Le joueur seul frappe en ce moment (son coup est dans ses pas actifs). */
export function isSwinging(solo: RampartSolo, tick: number): boolean {
  return solo.swingAt !== null && tick < solo.swingAt + SWING_TICKS;
}

/** Il a trébuché et ne s'est pas encore relevé. */
export function isStumbling(solo: RampartSolo, tick: number): boolean {
  return solo.stumbleUntil !== null && tick < solo.stumbleUntil;
}

/** Une pierre que ce coup casserait : assez près du centre, et devant lui. */
export function isInStrike(solo: RampartSolo, stone: { x: number; z: number }): boolean {
  const toward = Math.atan2(stone.x, stone.z);
  return reach(stone) <= STRIKE_REACH && Math.abs(turnTo(solo.facing, toward)) <= STRIKE_ARC;
}

/** Le temps pour ramasser une pierre, selon le nombre de lanceurs. */
export function reloadTime(state: RampartState): number {
  return RELOAD_TIME * Math.max(1, state.fighters.length / RELOAD_THROWERS);
}

function seat(angle: number): { x: number; z: number } {
  return { x: Math.sin(angle) * RING_RADIUS, z: Math.cos(angle) * RING_RADIUS };
}

function create(
  players: PlayerId[],
  { practice, seed, solo }: { practice: boolean; seed: number; solo?: PlayerId | null },
): RampartState {
  const soloId = solo ?? players[0] ?? '';
  const throwers = players.filter((id) => id !== soloId);
  return {
    tick: 0,
    practice,
    seed,
    // Il regarde la caméra au départ.
    solo: {
      ...createBody(soloId, 0, 0, 0),
      lives: RAMPART_LIVES,
      held: false,
      swingAt: null,
      swingHit: false,
      stumbleUntil: null,
      broken: 0,
    },
    fighters: throwers.map((id, index) => {
      // En cercle, répartis, le premier derrière le joueur seul (en haut de l'écran).
      const angle = Math.PI + (index / throwers.length) * Math.PI * 2;
      const { x, z } = seat(angle);
      return {
        ...createBody(id, x, z, angle + Math.PI),
        fellAt: null,
        angle,
        held: false,
        charge: null,
        stoneAt: 0,
        thrown: 0,
        hits: 0,
      };
    }),
    stones: [],
    nextStone: 0,
  };
}

function step(state: RampartState, inputs: Partial<Record<PlayerId, ArenaInput>>): RampartState {
  const tick = state.tick + 1;
  const next: RampartState = {
    ...state,
    tick,
    solo: { ...state.solo },
    fighters: state.fighters.map((thrower) => ({ ...thrower })),
    stones: state.stones.map((stone) => ({ ...stone })),
  };
  for (const thrower of next.fighters) {
    const input =
      inputs[thrower.id] ?? (state.practice ? dummyThrowerInput(next, thrower) : IDLE_INPUT);
    moveThrower(thrower, input);
    throwStone(next, thrower, input);
  }
  spaceThrowers(next.fighters);
  actSolo(next, inputs[next.solo.id] ?? IDLE_INPUT);
  flyStones(next);
  const kept = Math.round(BROKEN_KEPT / ARENA_STEP);
  next.stones = next.stones.filter(
    (stone) => stone.endedAt === null || tick <= stone.endedAt + kept,
  );
  return next;
}

/** Il tourne sur l'anneau dans le sens où l'on pousse (la part du déplacement le long de l'anneau). */
function moveThrower(thrower: RampartThrower, input: ArenaInput): void {
  // Le sens de l'anneau à sa place : la tangente, angle croissant.
  const along = input.move.x * Math.cos(thrower.angle) - input.move.z * Math.sin(thrower.angle);
  const before = { x: thrower.x, z: thrower.z };
  thrower.angle += (along * THROWER_SPEED * ARENA_STEP) / RING_RADIUS;
  Object.assign(thrower, seat(thrower.angle));
  thrower.vx = (thrower.x - before.x) / ARENA_STEP;
  thrower.vz = (thrower.z - before.z) / ARENA_STEP;
  // Toujours face au centre.
  thrower.facing = thrower.angle + Math.PI;
}

/** Deux lanceurs trop près l'un de l'autre sur l'anneau s'écartent d'autant chacun. */
function spaceThrowers(throwers: RampartThrower[]): void {
  const minimum = THROWER_GAP / RING_RADIUS;
  for (let i = 0; i < throwers.length; i++) {
    for (let j = i + 1; j < throwers.length; j++) {
      const a = throwers[i];
      const b = throwers[j];
      if (!a || !b) continue;
      const gap = turnTo(a.angle, b.angle);
      if (Math.abs(gap) >= minimum) continue;
      const push = ((minimum - Math.abs(gap)) / 2) * (gap >= 0 ? 1 : -1);
      a.angle -= push;
      b.angle += push;
      Object.assign(a, seat(a.angle), { facing: a.angle + Math.PI });
      Object.assign(b, seat(b.angle), { facing: b.angle + Math.PI });
    }
  }
}

/** L'élan : il commence à l'appui, la pierre part au lâcher (ou toute seule, l'élan plein). */
function throwStone(state: RampartState, thrower: RampartThrower, input: ArenaInput): void {
  const pressed = input.primary && !thrower.held;
  thrower.held = input.primary;
  if (pressed && thrower.charge === null && state.tick >= thrower.stoneAt) thrower.charge = 0;
  if (thrower.charge === null) return;
  thrower.charge = Math.min(THROW_CHARGE_TIME, thrower.charge + ARENA_STEP);
  if (input.primary && thrower.charge < THROW_CHARGE_TIME) return;
  const power = thrower.charge / THROW_CHARGE_TIME;
  const from = reach(thrower);
  const dx = -thrower.x / from;
  const dz = -thrower.z / from;
  state.stones.push({
    id: state.nextStone,
    thrower: thrower.id,
    // Elle part un peu devant lui.
    x: thrower.x + dx * 0.6,
    z: thrower.z + dz * 0.6,
    dx,
    dz,
    speed: SLOW_STONE + (FAST_STONE - SLOW_STONE) * power,
    thrownAt: state.tick,
    from: from - 0.6,
    endedAt: null,
    end: null,
  });
  state.nextStone += 1;
  thrower.charge = null;
  thrower.thrown += 1;
  thrower.stoneAt = state.tick + Math.round(reloadTime(state) / ARENA_STEP);
}

/** Le joueur seul : se tourner (pas en trébuchant), frapper à l'appui. */
function actSolo(state: RampartState, input: ArenaInput): void {
  const solo = state.solo;
  const { tick } = state;
  const pressed = input.primary && !solo.held;
  solo.held = input.primary;
  if (isStumbling(solo, tick)) return;
  solo.stumbleUntil = null;
  // Son coup fini sans rien casser : il trébuche.
  if (solo.swingAt !== null && !isSwinging(solo, tick)) {
    if (!solo.swingHit) solo.stumbleUntil = tick + Math.round(STUMBLE_TIME / ARENA_STEP);
    solo.swingAt = null;
    if (solo.stumbleUntil !== null) return;
  }
  if (Math.hypot(input.move.x, input.move.z) > 0.3) {
    const wanted = Math.atan2(input.move.x, input.move.z);
    const turn = turnTo(solo.facing, wanted);
    const most = SOLO_TURN_RATE * ARENA_STEP;
    solo.facing += Math.max(-most, Math.min(most, turn));
  }
  // Un nouveau coup : s'il ne frappe pas déjà, ou si son coup a déjà cassé une pierre.
  const canSwing = solo.swingAt === null || solo.swingHit;
  if (pressed && canSwing) {
    solo.swingAt = tick;
    solo.swingHit = false;
  }
}

/**
 * Les pierres avancent ; deux qui se touchent se cassent ; le coup en cours casse celles devant
 * le joueur seul ; celles qui l'atteignent le touchent.
 */
function flyStones(state: RampartState): void {
  const { tick, solo } = state;
  const flying = state.stones.filter((stone) => stone.endedAt === null);
  for (const stone of flying) {
    stone.x += stone.dx * stone.speed * ARENA_STEP;
    stone.z += stone.dz * stone.speed * ARENA_STEP;
  }
  for (let i = 0; i < flying.length; i++) {
    for (let j = i + 1; j < flying.length; j++) {
      const a = flying[i];
      const b = flying[j];
      if (!a || !b || a.endedAt !== null || b.endedAt !== null) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) >= STONE_RADIUS * 2) continue;
      Object.assign(a, { endedAt: tick, end: 'clash' });
      Object.assign(b, { endedAt: tick, end: 'clash' });
    }
  }
  for (const stone of flying) {
    if (stone.endedAt !== null) continue;
    if (isSwinging(solo, tick) && isInStrike(solo, stone)) {
      Object.assign(stone, { endedAt: tick, end: 'struck' });
      solo.swingHit = true;
      solo.broken += 1;
      continue;
    }
    if (reach(stone) > HIT_DISTANCE) continue;
    const partner = flying.find(
      (other) => other !== stone && other.endedAt === null && stoneArrival(other) <= CLASH_WINDOW,
    );
    if (partner) {
      Object.assign(stone, { endedAt: tick, end: 'clash' });
      Object.assign(partner, { endedAt: tick, end: 'clash' });
      continue;
    }
    Object.assign(stone, { endedAt: tick, end: 'hit' });
    if (!state.practice) solo.lives = Math.max(0, solo.lives - 1);
    const thrower = state.fighters.find((one) => one.id === stone.thrower);
    if (thrower) thrower.hits += 1;
  }
}

/** Au bac à sable, le lanceur mannequin lance tout seul, tantôt doucement, tantôt fort. */
function dummyThrowerInput(state: RampartState, thrower: RampartThrower): ArenaInput {
  if (thrower.charge !== null) {
    const wish = thrower.thrown % 2 === 0 ? 0 : THROW_CHARGE_TIME;
    return { ...IDLE_INPUT, primary: thrower.charge < wish };
  }
  const delay = Math.round(DUMMY_THROW_DELAY / ARENA_STEP);
  return { ...IDLE_INPUT, primary: state.tick >= thrower.stoneAt + delay && !thrower.held };
}

function timeLeft(state: RampartState): number | null {
  return state.practice ? null : Math.max(0, RAMPART_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: RampartState): boolean {
  if (state.practice) return false;
  return state.solo.lives <= 0 || (timeLeft(state) ?? 1) <= 0;
}

/** Le joueur seul gagne s'il tient debout jusqu'au bout ; sinon le groupe. */
function ranking(state: RampartState): PlayerId[][] {
  const throwers = state.fighters.map((thrower) => thrower.id);
  return state.solo.lives > 0 ? [[state.solo.id], throwers] : [throwers, [state.solo.id]];
}

/** Dans combien de secondes une pierre en vol atteint le joueur seul. */
export function stoneArrival(stone: RampartStone): number {
  return (reach(stone) - HIT_DISTANCE) / stone.speed;
}

/**
 * Le joueur seul en bot : il se tourne vers la pierre qui arrive la première, et frappe quand
 * elle est au plus près, avec une erreur de timing selon son niveau (en secondes, tirée une fois
 * par pierre), et parfois un raté franc. Sans pierre en vol, il regarde le lanceur qui prend son
 * élan.
 */
const SOLO_TIMING: Record<BotLevel, number> = { easy: 0.11, normal: 0.08, expert: 0.05 };
const SOLO_SLIP: Record<BotLevel, number> = { easy: 0.12, normal: 0.08, expert: 0.04 };
/** Le moment visé : la pierre à mi-chemin entre la portée du coup et le joueur seul. */
const STRIKE_AIM = (STRIKE_REACH + HIT_DISTANCE) / 2;

/**
 * Les lanceurs en bot : chacun vise sa place sur l'anneau (répartis, et l'ensemble tourne
 * lentement pour obliger le joueur seul à se retourner) ; quand il a une pierre, il choisit
 * l'élan qui la fera arriver après les pierres déjà en vol, sans les heurter. Il s'en soucie plus
 * ou moins selon son niveau ; l'Expert lance aussitôt sur un joueur seul qui a trébuché.
 */
const THROW_EAGERNESS: Record<BotLevel, number> = { easy: 0.04, normal: 0.06, expert: 0.08 };
const COORDINATION: Record<BotLevel, number> = { easy: 0.3, normal: 0.65, expert: 0.9 };
/** Deux arrivées plus proches que ça se heurtent presque sûrement (s). */
const CLASH_GAP = 0.25;
/** L'arrivée visée après la dernière pierre en vol (s) : assez pour qu'il doive se retourner. */
const FOLLOW_GAP = 0.45;
/** L'anneau des places tourne de tant (radians par seconde). */
const SLOT_DRIFT = 0.25;

function botInput(state: RampartState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  if (player === state.solo.id) return soloBotInput(state, level);
  const me = state.fighters.find((thrower) => thrower.id === player);
  return me ? throwerBotInput(state, me, level, rng) : IDLE_INPUT;
}

function soloBotInput(state: RampartState, level: BotLevel): ArenaInput {
  const { solo, tick } = state;
  if (isStumbling(solo, tick)) return IDLE_INPUT;
  const flying = state.stones.filter((stone) => stone.endedAt === null);
  const next = flying.sort((a, b) => stoneArrival(a) - stoneArrival(b))[0];
  if (!next) {
    const charging = state.fighters.find((thrower) => thrower.charge !== null);
    const move = charging ? toward(charging) : { x: 0, z: 0 };
    return { move, primary: false, secondary: false };
  }
  const move = toward(next);
  const key = `${state.seed}:solo:${next.id}`;
  const slip = hashUnit(`${key}:slip`) < SOLO_SLIP[level] ? 3 : 1;
  const error = (hashUnit(key) * 2 - 1) * SOLO_TIMING[level] * slip;
  const strikeAt = STRIKE_AIM + error * next.speed;
  const canSwing = solo.swingAt === null || solo.swingHit;
  const isFacing = Math.abs(turnTo(solo.facing, Math.atan2(next.x, next.z))) <= STRIKE_ARC;
  const primary = canSwing && !solo.held && isFacing && reach(next) <= strikeAt;
  return { move, primary, secondary: false };
}

function throwerBotInput(
  state: RampartState,
  me: RampartThrower,
  level: BotLevel,
  rng: Rng,
): ArenaInput {
  const index = state.fighters.indexOf(me);
  const drift =
    state.tick * ARENA_STEP * SLOT_DRIFT * (hashUnit(`${state.seed}:drift`) < 0.5 ? 1 : -1);
  const slot = Math.PI + (index / state.fighters.length) * Math.PI * 2 + drift;
  const gap = turnTo(me.angle, slot);
  // Pour aller vers sa place : le long de l'anneau, dans le sens de l'écart.
  const tangent = { x: Math.cos(me.angle), z: -Math.sin(me.angle) };
  const move =
    Math.abs(gap) > 0.08
      ? { x: tangent.x * Math.sign(gap), z: tangent.z * Math.sign(gap) }
      : { x: 0, z: 0 };
  if (me.charge !== null) {
    return {
      move: { x: 0, z: 0 },
      primary: me.charge < wishedCharge(state, me, level),
      secondary: false,
    };
  }
  if (state.tick < me.stoneAt || me.held) return { move, primary: false, secondary: false };
  const isOpening = level === 'expert' && isStumbling(state.solo, state.tick);
  const willThrow = isOpening || rng.chance(THROW_EAGERNESS[level]);
  return { move, primary: willThrow, secondary: false };
}

/**
 * L'élan voulu (secondes) : celui qui fait arriver sa pierre FOLLOW_GAP après la dernière en vol,
 * à au moins CLASH_GAP de chacune ; s'il ne coordonne pas cette fois (selon son niveau), un élan
 * au hasard (le même tout au long de cet élan).
 */
function wishedCharge(state: RampartState, me: RampartThrower, level: BotLevel): number {
  const key = `${state.seed}:${me.id}:${me.thrown}`;
  if (hashUnit(`${key}:care`) >= COORDINATION[level]) return hashUnit(key) * THROW_CHARGE_TIME;
  const elapsed = me.charge ?? 0;
  const distance = reach(me) - 0.6 - HIT_DISTANCE;
  const arrivals = state.stones
    .filter((stone) => stone.endedAt === null)
    .map((stone) => stoneArrival(stone) + elapsed);
  const arrivalWith = (charge: number) =>
    charge + distance / (SLOW_STONE + ((FAST_STONE - SLOW_STONE) * charge) / THROW_CHARGE_TIME);
  const isClear = (charge: number) =>
    arrivals.every((arrival) => Math.abs(arrivalWith(charge) - arrival) >= CLASH_GAP);
  const target = Math.max(0, ...arrivals) + FOLLOW_GAP;
  let best = elapsed;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 8; step++) {
    const charge = elapsed + ((THROW_CHARGE_TIME - elapsed) * step) / 8;
    if (!isClear(charge)) continue;
    const score = Math.abs(arrivalWith(charge) - target);
    if (score < bestScore) {
      best = charge;
      bestScore = score;
    }
  }
  return best;
}

function toward(point: { x: number; z: number }): { x: number; z: number } {
  const length = reach(point) || 1;
  return { x: point.x / length, z: point.z / length };
}

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

export const RAMPART: ArenaGame<RampartState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
