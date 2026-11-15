import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Bras de fer (02-mini-jeux.md, fiche 36), un duel à la taverne du Mont Trouble. Le bras penche
// d'un côté ou de l'autre (`arm`, de -1 à 1 : à 1, le premier a couché le bras du second ; à
// -1, l'inverse). Deux temps qui alternent :
//   - la force : on alterne gauche et droite le plus vite possible (deux fois le même côté ne
//     compte pas) ; le bras penche du côté de celui qui va le plus vite ;
//   - les coups décisifs (CLASHES fois) : la force s'arrête, une aiguille fait le tour d'un
//     cadran et chacun appuie une fois, au mieux dans la zone (parfait, bien, juste, raté) ; un
//     parfait pousse fort, un raté pousse pour l'autre.
// Le premier qui couche le bras de l'autre gagne ; au bout du temps, celui qui mène.

/** La mise en place avant le premier effort, et le temps de la manche (sans les coups décisifs). */
export const WRESTLE_READY = 2;
export const WRESTLE_TIME = 30;
/** La vitesse de martelage : une moyenne glissante sur RATE_MEMORY secondes. */
const RATE_MEMORY = 0.6;
/** Un écart d'un appui par seconde fait pencher le bras de tant par seconde. */
const PUSH = 0.025;
/**
 * Le bras résiste près de la table : celui qui mène avance d'autant moins que le bras est déjà
 * couché (à |arm| = 1, de RESIST en moins). Sans ça, le plus rapide couchait l'autre en 15 s, et
 * les coups décisifs ne retournaient plus rien (retour de simulation).
 */
const RESIST = 0.6;
/** Les coups décisifs : à ces secondes de force (plus un peu de hasard), CLASH_TIME chacun. */
const CLASHES_AT = [7, 15, 23] as const;
const CLASH_JITTER = 1.5;
export const WRESTLE_CLASH_TIME = 1.6;
/** La zone : ses demi-largeurs (parfait, bien, juste), en part du tour, et où elle tombe. */
export const WRESTLE_ZONES = [0.025, 0.06, 0.11] as const;
const ZONE_FROM = 0.3;
const ZONE_TO = 0.85;
/** Ce que pousse chaque note (raté, juste, bien, parfait) : un raté pousse pour l'autre. */
const CLASH_PUSH = [-0.15, 0.05, 0.15, 0.3] as const;
/** Le résultat d'un coup décisif reste affiché tant de secondes, la force arrêtée. */
export const CLASH_SHOWN = 1;

export type WrestlePhase = 'ready' | 'force' | 'clash' | 'result';

export type Wrestler = {
  id: PlayerId;
  fellAt: null;
  /** Le dernier côté tenu (-1, 1, ou 0 au milieu) et le dernier côté qui a compté. */
  side: -1 | 0 | 1;
  lastTap: -1 | 0 | 1;
  /** Sa vitesse de martelage (appuis par seconde, en moyenne glissante), et ses appuis. */
  rate: number;
  taps: number;
  heldPrimary: boolean;
};

/** Un coup décisif : sa zone (part du tour), l'appui de chacun (part du tour) et les notes. */
export type WrestleClash = {
  index: number;
  zone: number;
  startAt: number;
  presses: Record<PlayerId, number>;
  scores: Record<PlayerId, number> | null;
  endAt: number | null;
};

export type WrestleState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: Wrestler[];
  /** Le bras : 1, le premier a couché celui du second ; -1, l'inverse. */
  arm: number;
  phase: WrestlePhase;
  phaseAt: number;
  /** Les secondes de force déjà jouées (le chrono de la manche). */
  forceTime: number;
  clash: WrestleClash | null;
  clashes: number;
  winner: PlayerId | null;
  /** La fin : un bras couché, ou le temps (celui qui mène, ou personne). */
  endedAt: number | null;
};

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): WrestleState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.slice(0, 2).map((id) => ({
      id,
      fellAt: null,
      side: 0,
      lastTap: 0,
      rate: 0,
      taps: 0,
      heldPrimary: false,
    })),
    arm: 0,
    phase: 'ready',
    phaseAt: 0,
    forceTime: 0,
    clash: null,
    clashes: 0,
    winner: null,
    endedAt: null,
  };
}

/** Quand tombe ce coup décisif (en secondes de force). */
export function clashAt(state: WrestleState, index: number): number {
  const base = CLASHES_AT[index] ?? Number.POSITIVE_INFINITY;
  return base + (forestUnit(state.seed, index, 701) - 0.5) * CLASH_JITTER;
}

/** Où en est l'aiguille d'un coup décisif à ce pas (part du tour, 0 à 1). */
export function wrestleNeedle(clash: WrestleClash, tick: number): number {
  const at = Math.min(tick, clash.endAt ?? tick);
  return Math.min(1, ((at - clash.startAt) * ARENA_STEP) / WRESTLE_CLASH_TIME);
}

/** La note d'un appui : 3 parfait, 2 bien, 1 juste, 0 raté (ou pas d'appui). */
export function wrestleScore(zone: number, press: number | undefined): number {
  if (press === undefined) return 0;
  const tier = WRESTLE_ZONES.findIndex((half) => Math.abs(press - zone) <= half);
  return tier === -1 ? 0 : WRESTLE_ZONES.length - tier;
}

function step(state: WrestleState, inputs: Partial<Record<PlayerId, ArenaInput>>): WrestleState {
  const tick = state.tick + 1;
  const next: WrestleState = {
    ...state,
    tick,
    fighters: state.fighters.map((one) => ({ ...one })),
    clash: state.clash ? { ...state.clash, presses: { ...state.clash.presses } } : null,
  };
  if (next.endedAt !== null) return next;
  const since = (tick - next.phaseAt) * ARENA_STEP;
  for (const wrestler of next.fighters) {
    const input = inputs[wrestler.id] ?? (state.practice ? dummyInput(next, wrestler) : IDLE_INPUT);
    tap(next, wrestler, input);
  }
  if (next.phase === 'ready') {
    if (since >= WRESTLE_READY) Object.assign(next, { phase: 'force', phaseAt: tick });
    return next;
  }
  if (next.phase === 'force') {
    force(next);
    return next;
  }
  if (next.phase === 'clash') {
    settleClash(next);
    return next;
  }
  if (since >= CLASH_SHOWN) Object.assign(next, { phase: 'force', phaseAt: tick });
  return next;
}

/**
 * Les commandes d'un lutteur : un appui compte quand il passe d'un côté à l'autre (gauche puis
 * droite, droite puis gauche) ; sa vitesse est une moyenne glissante. Pendant un coup décisif,
 * Action pose son appui sur le cadran.
 */
function tap(state: WrestleState, wrestler: Wrestler, input: ArenaInput): void {
  const pressed = input.primary && !wrestler.heldPrimary;
  wrestler.heldPrimary = input.primary;
  const side = input.move.x > 0.5 ? 1 : input.move.x < -0.5 ? -1 : 0;
  const isTap =
    state.phase === 'force' && side !== 0 && side !== wrestler.side && side !== wrestler.lastTap;
  if (side !== 0 && side !== wrestler.side && state.phase === 'force') wrestler.lastTap = side;
  wrestler.side = side;
  const keep = Math.exp(-ARENA_STEP / RATE_MEMORY);
  wrestler.rate = wrestler.rate * keep + (isTap ? (1 - keep) / ARENA_STEP : 0);
  if (isTap) wrestler.taps += 1;
  const clash = state.clash;
  if (state.phase === 'clash' && clash && pressed && clash.presses[wrestler.id] === undefined) {
    clash.presses[wrestler.id] = wrestleNeedle(clash, state.tick);
  }
}

/** La force : le bras penche vers le plus rapide ; un bras couché finit la manche. */
function force(state: WrestleState): void {
  const [a, b] = state.fighters;
  if (!a || !b) return;
  const push = (a.rate - b.rate) * PUSH * ARENA_STEP;
  const isLeaderPushing = Math.sign(push) === Math.sign(state.arm);
  const resisted = isLeaderPushing ? push * (1 - RESIST * Math.abs(state.arm)) : push;
  state.arm = Math.max(-1, Math.min(1, state.arm + resisted));
  state.forceTime += ARENA_STEP;
  if (Math.abs(state.arm) >= 1) {
    finish(state, state.arm > 0 ? a.id : b.id);
    return;
  }
  if (state.forceTime >= WRESTLE_TIME && !state.practice) {
    finish(state, state.arm > 0 ? a.id : state.arm < 0 ? b.id : null);
    return;
  }
  if (state.clashes < CLASHES_AT.length && state.forceTime >= clashAt(state, state.clashes)) {
    const zone = ZONE_FROM + forestUnit(state.seed, state.clashes, 702) * (ZONE_TO - ZONE_FROM);
    state.clash = {
      index: state.clashes,
      zone,
      startAt: state.tick,
      presses: {},
      scores: null,
      endAt: null,
    };
    state.clashes += 1;
    Object.assign(state, { phase: 'clash', phaseAt: state.tick });
  }
}

/** Le coup décisif se règle quand les deux ont appuyé, ou au bout du tour : chacun pousse selon sa note. */
function settleClash(state: WrestleState): void {
  const clash = state.clash;
  const [a, b] = state.fighters;
  if (!clash || !a || !b) return;
  const isDone =
    wrestleNeedle(clash, state.tick) >= 1 ||
    (clash.presses[a.id] !== undefined && clash.presses[b.id] !== undefined);
  if (!isDone) return;
  const scoreA = wrestleScore(clash.zone, clash.presses[a.id]);
  const scoreB = wrestleScore(clash.zone, clash.presses[b.id]);
  clash.scores = { [a.id]: scoreA, [b.id]: scoreB };
  clash.endAt = state.tick;
  state.arm = Math.max(
    -1,
    Math.min(1, state.arm + (CLASH_PUSH[scoreA] ?? 0) - (CLASH_PUSH[scoreB] ?? 0)),
  );
  Object.assign(state, { phase: 'result', phaseAt: state.tick });
  if (Math.abs(state.arm) >= 1) finish(state, state.arm > 0 ? a.id : b.id);
}

/** La fin : le gagnant (ou personne) ; au bac à sable, tout recommence. */
function finish(state: WrestleState, winner: PlayerId | null): void {
  if (state.practice) {
    Object.assign(state, { arm: 0, forceTime: 0, clashes: 0, phase: 'ready', phaseAt: state.tick });
    return;
  }
  state.winner = winner;
  state.endedAt = state.tick;
}

function isOver(state: WrestleState): boolean {
  return !state.practice && state.endedAt !== null;
}

function timeLeft(state: WrestleState): number | null {
  if (state.practice) return null;
  return Math.max(0, WRESTLE_TIME - state.forceTime);
}

function ranking(state: WrestleState): PlayerId[][] {
  const ids = state.fighters.map((one) => one.id);
  if (!state.winner) return [ids];
  return [[state.winner], ids.filter((id) => id !== state.winner)];
}

/** Au bac à sable, le mannequin d'en face tire tranquillement et vise le cadran à peu près. */
function dummyInput(state: WrestleState, wrestler: Wrestler): ArenaInput {
  const side = Math.floor(state.tick * ARENA_STEP * 4 * 2) % 2 === 0 ? -1 : 1;
  const clash = state.clash;
  const press =
    state.phase === 'clash' &&
    clash !== null &&
    wrestleNeedle(clash, state.tick) >= clash.zone + 0.05 &&
    clash.presses[wrestler.id] === undefined;
  return { move: { x: side, z: 0 }, primary: press, secondary: false };
}

// Le bot (02-mini-jeux.md, fiche 36) : il alterne à sa cadence (avec des à-coups d'une seconde à
// l'autre), et pose son appui sur le cadran avec une erreur selon son niveau.

const BOT: Record<BotLevel, { rate: number; spread: number; aim: number }> = {
  easy: { rate: 5.6, spread: 2, aim: 0.09 },
  normal: { rate: 6.5, spread: 2, aim: 0.05 },
  expert: { rate: 7.4, spread: 2, aim: 0.03 },
};

/** La forme d'un bot varie d'une partie à l'autre de tant d'appuis par seconde. */
const FORM = 1.2;

function botInput(state: WrestleState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  if (!me) return IDLE_INPUT;
  const bot = BOT[level];
  const second = Math.floor(state.tick * ARENA_STEP);
  const salt = player.length * 7 + (player.charCodeAt(0) || 0);
  // Sa forme du jour (une partie à l'autre), puis des à-coups d'une seconde à l'autre.
  const form = (forestUnit(state.seed, 0, 705 + salt) - 0.5) * 2 * FORM;
  const rate =
    bot.rate + form + (forestUnit(state.seed, second, 703 + salt) - 0.5) * 2 * bot.spread;
  // Une alternance par appui : il change de côté `rate` fois par seconde.
  const beat = Math.floor(state.tick * ARENA_STEP * rate);
  const side = beat % 2 === 0 ? -1 : 1;
  const clash = state.clash;
  if (state.phase !== 'clash' || !clash || clash.presses[player] !== undefined) {
    return { move: { x: side, z: 0 }, primary: false, secondary: false };
  }
  const error = (forestUnit(state.seed, clash.index, 704 + salt) * 2 - 1) * bot.aim;
  const press = wrestleNeedle(clash, state.tick) >= clash.zone + error;
  return { move: { x: 0, z: 0 }, primary: press, secondary: false };
}

export const ARM_WRESTLING: ArenaGame<WrestleState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
