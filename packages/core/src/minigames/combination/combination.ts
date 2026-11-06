import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Combinaison (02-mini-jeux.md, fiche 39), un défi solo de la porte d'adresse : cinq runes en
// croix sur la porte (haut, gauche, centre, droite, bas). Une suite de cinq s'allume, une rune
// après l'autre, chacune avec sa note ; puis on la rejoue (flèches, ZQSD ou stick pour les
// quatre du bord, Espace pour le centre, ou un clic sur la rune), avant la fin du chrono. Une
// rune de travers, et la porte reste fermée.

/** Les runes, rangées en croix (leur indice sert aussi au clic). */
export const RUNES = ['up', 'left', 'center', 'right', 'down'] as const;
export type Rune = (typeof RUNES)[number];
export const SEQUENCE_LENGTH = 5;
/** Avant la suite, un temps pour se préparer ; chaque rune s'allume RUNE_SHOWN, puis RUNE_GAP de noir. */
const START_DELAY = 0.8;
export const RUNE_SHOWN = 0.45;
export const RUNE_GAP = 0.15;
/** Le temps pour rejouer toute la suite (secondes). */
export const INPUT_TIME = 6;
/** Le défi fini, son issue reste montrée ce temps-là (secondes). */
const END_PAUSE = 1.4;
/** Le stick ou les flèches ne comptent qu'au-delà de cette inclinaison. */
const DEAD_ZONE = 0.5;

export type ComboState = {
  tick: number;
  practice: boolean;
  seed: number;
  attempt: number;
  sequence: number[];
  /** Le pas où la suite commence à s'allumer, et celui où l'on peut la rejouer. */
  showAt: number;
  inputAt: number;
  entered: number[];
  failedAt: number | null;
  failure: 'wrong' | 'slow' | null;
  doneAt: number | null;
  /** La dernière rune jouée (pour le client : l'allumer, sa note). */
  pressedAt: number | null;
  pressedRune: number | null;
  fighters: { id: PlayerId; fellAt: null; held: boolean; aiming: number | null }[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** La rune allumée de la suite à ce pas, pendant qu'elle s'affiche ; null sinon. */
export function shownRune(state: ComboState, tick: number): number | null {
  const elapsed = (tick - state.showAt) * ARENA_STEP;
  if (elapsed < 0) return null;
  const slot = Math.floor(elapsed / (RUNE_SHOWN + RUNE_GAP));
  const isLit = elapsed - slot * (RUNE_SHOWN + RUNE_GAP) < RUNE_SHOWN;
  return isLit && slot < state.sequence.length ? (state.sequence[slot] ?? null) : null;
}

/** La rune que vise une direction (bas, haut, gauche, droite), ou null. */
function runeOfMove(move: { x: number; z: number }): number | null {
  if (Math.abs(move.x) >= DEAD_ZONE && Math.abs(move.x) >= Math.abs(move.z)) {
    return RUNES.indexOf(move.x < 0 ? 'left' : 'right');
  }
  if (Math.abs(move.z) >= DEAD_ZONE) return RUNES.indexOf(move.z < 0 ? 'up' : 'down');
  return null;
}

function freshAttempt(state: ComboState, attempt: number, tick: number): ComboState {
  const sequence = Array.from({ length: SEQUENCE_LENGTH }, (_, k) =>
    Math.floor(hashUnit(`${state.seed}:combo:${attempt}:${k}`) * RUNES.length),
  );
  const showAt = tick + steps(START_DELAY);
  return {
    ...state,
    attempt,
    sequence,
    showAt,
    inputAt: showAt + steps((RUNE_SHOWN + RUNE_GAP) * SEQUENCE_LENGTH),
    entered: [],
    failedAt: null,
    failure: null,
    doneAt: null,
    pressedAt: null,
    pressedRune: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): ComboState {
  const empty: ComboState = {
    tick: 0,
    practice,
    seed,
    attempt: 0,
    sequence: [],
    showAt: 0,
    inputAt: 0,
    entered: [],
    failedAt: null,
    failure: null,
    doneAt: null,
    pressedAt: null,
    pressedRune: null,
    fighters: players.slice(0, 1).map((id) => ({ id, fellAt: null, held: false, aiming: null })),
  };
  return freshAttempt(empty, 0, 0);
}

function endOf(state: ComboState): number | null {
  return state.failedAt ?? state.doneAt;
}

/** La rune jouée à ce pas (un appui, pas une touche tenue), ou null. */
function pressedRune(fighter: ComboState['fighters'][number], input: ArenaInput): number | null {
  const aimed = runeOfMove(input.move);
  const isMovePress = aimed !== null && aimed !== fighter.aiming;
  const isCenterPress = input.primary && !fighter.held;
  if (input.target != null && input.target < RUNES.length) return input.target;
  if (isMovePress) return aimed;
  return isCenterPress ? RUNES.indexOf('center') : null;
}

function step(state: ComboState, inputs: Partial<Record<PlayerId, ArenaInput>>): ComboState {
  const tick = state.tick + 1;
  const ended = endOf(state);
  if (state.practice && ended !== null && tick >= ended + steps(END_PAUSE)) {
    return { ...freshAttempt(state, state.attempt + 1, tick), tick };
  }
  const fighter = state.fighters[0];
  const input = (fighter && inputs[fighter.id]) ?? IDLE_INPUT;
  const rune = fighter ? pressedRune(fighter, input) : null;
  const fighters = state.fighters.map((one) => ({
    ...one,
    held: input.primary,
    aiming: runeOfMove(input.move),
  }));
  const next: ComboState = { ...state, tick, fighters };
  // On ne joue qu'une fois la suite montrée.
  if (ended !== null || tick < next.inputAt) return next;
  if (rune !== null) {
    const entered = [...next.entered, rune];
    const isRight = next.sequence[entered.length - 1] === rune;
    const played = { ...next, entered, pressedAt: tick, pressedRune: rune };
    if (!isRight) return { ...played, failedAt: tick, failure: 'wrong' };
    return entered.length >= next.sequence.length ? { ...played, doneAt: tick } : played;
  }
  if (tick >= next.inputAt + steps(INPUT_TIME)) return { ...next, failedAt: tick, failure: 'slow' };
  return next;
}

function isOver(state: ComboState): boolean {
  const ended = endOf(state);
  return !state.practice && ended !== null && state.tick >= ended + steps(END_PAUSE);
}

/**
 * Le bot réussit environ 40, 60 ou 80 % du temps selon son niveau (tiré une fois par essai) :
 * il rejoue la suite, une rune toutes les BOT_PACE secondes ; s'il doit rater, il se trompe sur
 * une rune au hasard de la suite.
 */
const SUCCESS: Record<BotLevel, number> = { easy: 0.4, normal: 0.6, expert: 0.8 };
const BOT_PACE = 0.5;

function botInput(state: ComboState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const fighter = state.fighters.find((one) => one.id === player);
  if (!fighter || endOf(state) !== null || state.tick < state.inputAt) return IDLE_INPUT;
  const index = state.entered.length;
  const dueAt = state.inputAt + steps(BOT_PACE) * (index + 1);
  if (state.tick + 1 < dueAt) return IDLE_INPUT;
  const key = `${state.seed}:bot:${state.attempt}`;
  const willSucceed = hashUnit(key) < SUCCESS[level];
  const slip = Math.floor(hashUnit(`${key}:slip`) * SEQUENCE_LENGTH);
  const right = state.sequence[index] ?? 0;
  const rune = !willSucceed && index === slip ? (right + 1) % RUNES.length : right;
  return { ...IDLE_INPUT, target: rune };
}

export const COMBINATION: ArenaGame<ComboState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: (state) =>
    state.practice || endOf(state) !== null || state.tick < state.inputAt
      ? null
      : Math.max(0, (state.inputAt + steps(INPUT_TIME) - state.tick) * ARENA_STEP),
  ranking: (state) => [state.fighters.map((fighter) => fighter.id)],
  succeeded: (state) => state.doneAt !== null,
};
