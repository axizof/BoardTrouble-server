import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Jauge parfaite (02-mini-jeux.md, fiche 38), un défi solo de la porte d'adresse : la porte a
// trois verrous, chacun avec son cadran. L'aiguille ne garde jamais son allure (elle accélère,
// ralentit, repart en arrière) : impossible de prendre le rythme. On l'arrête dans la zone verte,
// un verrou après l'autre, et la zone rétrécit d'un verrou à l'autre. Un appui à côté, ou trop
// d'attente, et la porte reste fermée. Le cadran va de 0 (à gauche) à 1 (à droite).

export const GAUGE_LOCKS = 3;
/** La demi-largeur de la zone verte de chaque verrou (en part du cadran). */
export const ZONE_HALVES = [0.1, 0.08, 0.06] as const;
/** Un verrou ouvert, le suivant se met en marche au bout de ce temps (secondes). */
const NEXT_LOCK_PAUSE = 0.6;
/** Sans appui, le verrou résiste : au bout de ce temps, c'est raté. */
export const LOCK_TIME = 4;
/**
 * L'aiguille change d'allure toutes les CHANGE_MIN à CHANGE_MAX secondes : une vitesse de
 * SPEED_MIN à SPEED_MAX (cadrans par seconde), et une fois sur REVERSE_SHARE elle repart en
 * arrière. Elle rebondit aux bouts du cadran.
 */
const CHANGE_MIN = 0.35;
const CHANGE_MAX = 0.9;
const SPEED_MIN = 0.35;
const SPEED_MAX = 1.4;
const REVERSE_SHARE = 0.35;
/** Le défi fini, son issue reste montrée ce temps-là (secondes). */
const END_PAUSE = 1.4;

export type GaugeLock = { center: number; half: number; openedAt: number | null };

export type GaugeState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** L'essai (au bac à sable, on recommence sans fin). */
  attempt: number;
  locks: GaugeLock[];
  /** Le verrou en cours, et le pas où son aiguille s'est mise en marche. */
  current: number;
  lockStartAt: number;
  needle: { position: number; speed: number; changeAt: number; changes: number };
  /** L'issue : le pas où c'est raté (et pourquoi), ou où les trois verrous sont ouverts. */
  failedAt: number | null;
  failure: 'missed' | 'slow' | null;
  openedAt: number | null;
  /** Le dernier appui (pour le client : où était l'aiguille). */
  pressedAt: number | null;
  pressedPosition: number;
  fighters: { id: PlayerId; fellAt: null; held: boolean }[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const between = (key: string, min: number, max: number) => min + hashUnit(key) * (max - min);

function planLocks(seed: number, attempt: number): GaugeLock[] {
  return ZONE_HALVES.map((half, index) => ({
    center: between(`${seed}:gauge:${attempt}:${index}`, 0.25, 0.75),
    half,
    openedAt: null,
  }));
}

/** L'allure suivante de l'aiguille, au hasard de la partie. */
function nextPace(state: GaugeState, tick: number, changes: number, speed: number) {
  const key = `${state.seed}:needle:${state.attempt}:${state.current}:${changes}`;
  const magnitude = between(`${key}:speed`, SPEED_MIN, SPEED_MAX);
  const sign =
    hashUnit(`${key}:reverse`) < REVERSE_SHARE ? -Math.sign(speed || 1) : Math.sign(speed || 1);
  return {
    speed: sign * magnitude,
    changeAt: tick + steps(between(`${key}:at`, CHANGE_MIN, CHANGE_MAX)),
    changes: changes + 1,
  };
}

function freshAttempt(state: GaugeState, attempt: number, tick: number): GaugeState {
  const next: GaugeState = {
    ...state,
    attempt,
    locks: planLocks(state.seed, attempt),
    current: 0,
    lockStartAt: tick + steps(NEXT_LOCK_PAUSE),
    failedAt: null,
    failure: null,
    openedAt: null,
    pressedAt: null,
    pressedPosition: 0,
  };
  return { ...next, needle: { position: 0, ...nextPace(next, tick, 0, 1) } };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): GaugeState {
  const empty: GaugeState = {
    tick: 0,
    practice,
    seed,
    attempt: 0,
    locks: [],
    current: 0,
    lockStartAt: 0,
    needle: { position: 0, speed: 0, changeAt: 0, changes: 0 },
    failedAt: null,
    failure: null,
    openedAt: null,
    pressedAt: null,
    pressedPosition: 0,
    fighters: players.slice(0, 1).map((id) => ({ id, fellAt: null, held: false })),
  };
  return freshAttempt(empty, 0, 0);
}

/** Le défi est joué : raté, ou les trois verrous ouverts. */
function endOf(state: GaugeState): number | null {
  return state.failedAt ?? state.openedAt;
}

function step(state: GaugeState, inputs: Partial<Record<PlayerId, ArenaInput>>): GaugeState {
  const tick = state.tick + 1;
  const ended = endOf(state);
  // Au bac à sable, on recommence une fois l'issue montrée.
  if (state.practice && ended !== null && tick >= ended + steps(END_PAUSE)) {
    return { ...freshAttempt(state, state.attempt + 1, tick), tick };
  }
  const fighter = state.fighters[0];
  const input = (fighter && inputs[fighter.id]) ?? IDLE_INPUT;
  const isPress = input.primary && !fighter?.held;
  const fighters = state.fighters.map((one) => ({ ...one, held: input.primary }));
  const next: GaugeState = { ...state, tick, fighters, needle: { ...state.needle } };
  if (ended !== null || tick < next.lockStartAt) return next;
  moveNeedle(next, tick);
  const lock = next.locks[next.current];
  if (!lock) return next;
  if (isPress) {
    next.pressedAt = tick;
    next.pressedPosition = next.needle.position;
    if (Math.abs(next.needle.position - lock.center) > lock.half) {
      return { ...next, failedAt: tick, failure: 'missed' };
    }
    next.locks = next.locks.map((one, index) =>
      index === next.current ? { ...one, openedAt: tick } : one,
    );
    if (next.current + 1 >= GAUGE_LOCKS) return { ...next, openedAt: tick };
    // Le verrou suivant : son aiguille repart du bord gauche, à sa propre allure.
    const following = {
      ...next,
      current: next.current + 1,
      lockStartAt: tick + steps(NEXT_LOCK_PAUSE),
    };
    return { ...following, needle: { position: 0, ...nextPace(following, tick, 0, 1) } };
  }
  if (tick >= next.lockStartAt + steps(LOCK_TIME))
    return { ...next, failedAt: tick, failure: 'slow' };
  return next;
}

/** L'aiguille avance à son allure, rebondit aux bouts, et change d'allure quand c'est l'heure. */
function moveNeedle(state: GaugeState, tick: number): void {
  const needle = state.needle;
  if (tick >= needle.changeAt)
    Object.assign(needle, nextPace(state, tick, needle.changes, needle.speed));
  needle.position += needle.speed * ARENA_STEP;
  if (needle.position < 0 || needle.position > 1) {
    needle.position = Math.max(0, Math.min(1, needle.position));
    needle.speed = -needle.speed;
  }
}

function isOver(state: GaugeState): boolean {
  const ended = endOf(state);
  return !state.practice && ended !== null && state.tick >= ended + steps(END_PAUSE);
}

function succeeded(state: GaugeState): boolean {
  return state.openedAt !== null;
}

/**
 * Le bot réussit chaque verrou avec une chance selon son niveau (tirée une fois par verrou), de
 * quoi ouvrir la porte environ 40, 60 ou 80 % du temps : il appuie quand l'aiguille est bien dans
 * la zone ; s'il doit rater, juste à côté. Il attend un peu avant (il regarde l'aiguille).
 */
const LOCK_CHANCE: Record<BotLevel, number> = { easy: 0.74, normal: 0.84, expert: 0.93 };
const BOT_WAIT = 0.6;

function botInput(state: GaugeState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const fighter = state.fighters.find((one) => one.id === player);
  const lock = state.locks[state.current];
  if (!fighter || !lock || endOf(state) !== null || fighter.held) return IDLE_INPUT;
  if (state.tick < state.lockStartAt + steps(BOT_WAIT)) return IDLE_INPUT;
  const willOpen =
    hashUnit(`lock${state.current}:${state.seed}:bot:${state.attempt}`) < LOCK_CHANCE[level];
  // L'aiguille au prochain pas ; pas au pas où elle change d'allure (elle partirait ailleurs).
  if (state.tick + 1 >= state.needle.changeAt) return IDLE_INPUT;
  const next = state.needle.position + state.needle.speed * ARENA_STEP;
  const gap = Math.abs(next - lock.center);
  // Pas une fenêtre trop étroite : l'aiguille rapide sauterait par-dessus en un pas.
  const isPress = willOpen
    ? gap <= lock.half * 0.8
    : gap > lock.half * 1.1 && gap <= lock.half * 1.8;
  return { ...IDLE_INPUT, primary: isPress };
}

export const PERFECT_GAUGE: ArenaGame<GaugeState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: (state) =>
    state.practice || endOf(state) !== null
      ? null
      : Math.max(0, (state.lockStartAt + steps(LOCK_TIME) - state.tick) * ARENA_STEP),
  ranking: (state) => [state.fighters.map((fighter) => fighter.id)],
  succeeded,
};
