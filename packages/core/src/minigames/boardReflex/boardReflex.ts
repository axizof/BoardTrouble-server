import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Réflexe du Plateau (02-mini-jeux.md, fiche 12) : le Plateau fait des feintes, puis donne le
// vrai signal. Le plus rapide marque un point ; appuyer avant le signal (une feinte comprise)
// fait perdre la manche. Le premier à REFLEX_TARGET points gagne ; classement aux points (les
// ex aequo, aux dés). Tout se joue sur la touche principale. La mesure se fait au pas de l'arène
// (1/30 s) : deux appuis au même pas sont ex aequo, et marquent tous les deux.

export const REFLEX_TARGET = 3;
/** Au plus tant de manches (si personne ne marque, la partie finit quand même). */
export const REFLEX_MAX_ROUNDS = 9;
/** Le vrai signal arrive au hasard entre WAIT_MIN et WAIT_MAX secondes après le début de la manche. */
const WAIT_MIN = 2;
const WAIT_MAX = 5;
/**
 * Avant le signal, 0 à MAX_FEINTS feintes, chacune montrée FEINT_SHOWN secondes, à FEINT_GAP
 * secondes au moins l'une de l'autre, ni dans la première FEINT_FROM seconde, ni dans la
 * dernière FEINT_CLEAR seconde avant le signal (pour qu'on ne les confonde pas).
 */
const MAX_FEINTS = 3;
export const FEINT_SHOWN = 0.7;
const FEINT_GAP = 0.9;
const FEINT_FROM = 0.8;
const FEINT_CLEAR = 0.5;
/** Les sortes de feintes (le client leur donne un mot et une couleur). */
export const FEINT_KINDS = 6;
/** Après le signal, on a ANSWER_TIME secondes pour appuyer. */
export const ANSWER_TIME = 1.5;
/** La manche finie, ses résultats restent affichés ce temps-là avant la suivante. */
export const SCORED_TIME = 2.2;

export type ReflexFeint = { at: number; kind: number };

export type ReflexRound = {
  index: number;
  startAt: number;
  signalAt: number;
  feints: ReflexFeint[];
  /** Le pas où la manche s'est jouée (tout le monde a appuyé, ou le temps est passé), ou null. */
  closedAt: number | null;
};

export type ReflexFighter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  points: number;
  /** Cette manche : le pas de son appui après le signal, ou null ; parti trop tôt. */
  pressedAt: number | null;
  falseStart: boolean;
  /** Il a gagné cette manche (une fois jouée). */
  won: boolean;
  /** La touche tenue au pas précédent : on compte un appui, pas une touche tenue. */
  held: boolean;
};

export type ReflexState = {
  tick: number;
  practice: boolean;
  seed: number;
  round: ReflexRound;
  fighters: ReflexFighter[];
};

/** Ce que montre le Plateau à ce pas. */
export type ReflexShown =
  | { type: 'waiting' }
  | { type: 'feint'; kind: number }
  | { type: 'signal' }
  | { type: 'scored'; best: number | null };

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** Une manche qui commence à `startAt` : son signal et ses feintes, au hasard de la partie. */
function planRound(seed: number, index: number, startAt: number): ReflexRound {
  const key = `${seed}:round:${index}`;
  const wait = WAIT_MIN + hashUnit(key) * (WAIT_MAX - WAIT_MIN);
  // La place pour les feintes, et combien y tiennent.
  const room = wait - FEINT_FROM - FEINT_CLEAR - FEINT_SHOWN;
  const fits = room < 0 ? 0 : 1 + Math.floor(room / FEINT_GAP);
  const count = Math.min(fits, Math.floor(hashUnit(`${key}:count`) * (MAX_FEINTS + 1)));
  // Le reste de la place, partagé au hasard avant, entre et après les feintes.
  const spare = room - (count - 1) * FEINT_GAP;
  const weights = Array.from({ length: count + 1 }, (_, k) => hashUnit(`${key}:gap:${k}`) + 0.1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const feints: ReflexFeint[] = [];
  let at = FEINT_FROM;
  for (let k = 0; k < count; k++) {
    at += (spare * (weights[k] ?? 0)) / total;
    feints.push({
      at: startAt + steps(at),
      kind: Math.floor(hashUnit(`${key}:kind:${k}`) * FEINT_KINDS),
    });
    at += FEINT_GAP;
  }
  return { index, startAt, signalAt: startAt + steps(wait), feints, closedAt: null };
}

/** Ce que montre le Plateau. */
export function reflexShown(state: ReflexState): ReflexShown {
  const { round, tick } = state;
  if (round.closedAt !== null) {
    const times = state.fighters
      .filter((fighter) => fighter.pressedAt !== null)
      .map((fighter) => (fighter.pressedAt ?? 0) - round.signalAt);
    return { type: 'scored', best: times.length > 0 ? Math.min(...times) * ARENA_STEP : null };
  }
  if (tick >= round.signalAt) return { type: 'signal' };
  const feint = round.feints.find((f) => tick >= f.at && tick < f.at + steps(FEINT_SHOWN));
  return feint ? { type: 'feint', kind: feint.kind } : { type: 'waiting' };
}

/** Le temps de réaction d'un joueur à cette manche (secondes), une fois qu'il a appuyé. */
export function reactionOf(state: ReflexState, fighter: ReflexFighter): number | null {
  return fighter.pressedAt === null
    ? null
    : (fighter.pressedAt - state.round.signalAt) * ARENA_STEP;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): ReflexState {
  return {
    tick: 0,
    practice,
    seed,
    round: planRound(seed, 0, 0),
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      points: 0,
      pressedAt: null,
      falseStart: false,
      won: false,
      held: false,
    })),
  };
}

function step(state: ReflexState, inputs: Partial<Record<PlayerId, ArenaInput>>): ReflexState {
  const tick = state.tick + 1;
  let round = state.round;
  let fighters = state.fighters.map((fighter) => ({ ...fighter }));
  // La manche jouée et ses résultats montrés : la suivante (au bac à sable, sans fin).
  const isNext =
    round.closedAt !== null &&
    tick >= round.closedAt + steps(SCORED_TIME) &&
    (state.practice || !isLastRound(state));
  if (isNext) {
    round = planRound(state.seed, round.index + 1, tick);
    fighters = fighters.map((fighter) => ({
      ...fighter,
      pressedAt: null,
      falseStart: false,
      won: false,
    }));
  }
  for (const fighter of fighters) {
    const pressing = (inputs[fighter.id] ?? IDLE_INPUT).primary;
    const isPress = pressing && !fighter.held;
    fighter.held = pressing;
    if (!isPress || round.closedAt !== null || fighter.pressedAt !== null || fighter.falseStart) {
      continue;
    }
    // Avant le signal (sur une feinte ou dans le vide) : parti trop tôt, la manche est perdue.
    if (tick < round.signalAt) fighter.falseStart = true;
    else fighter.pressedAt = tick;
  }
  const isWaiting = (fighter: ReflexFighter) => !fighter.falseStart && fighter.pressedAt === null;
  const isPlayed =
    round.closedAt === null &&
    tick >= round.signalAt &&
    (!fighters.some(isWaiting) || tick >= round.signalAt + steps(ANSWER_TIME));
  if (isPlayed) {
    round = { ...round, closedAt: tick };
    const times = fighters.flatMap((f) => (f.pressedAt === null ? [] : [f.pressedAt]));
    const best = times.length > 0 ? Math.min(...times) : null;
    for (const fighter of fighters) {
      fighter.won = fighter.pressedAt !== null && fighter.pressedAt === best;
      if (fighter.won) fighter.points += 1;
    }
  }
  return { ...state, tick, round, fighters };
}

/** La manche jouée est la dernière : quelqu'un a ses REFLEX_TARGET points, ou c'était la dernière permise. */
function isLastRound(state: ReflexState): boolean {
  const { round } = state;
  return (
    round.closedAt !== null &&
    (round.index + 1 >= REFLEX_MAX_ROUNDS ||
      state.fighters.some((fighter) => fighter.points >= REFLEX_TARGET))
  );
}

function isOver(state: ReflexState): boolean {
  const { round } = state;
  return (
    !state.practice &&
    isLastRound(state) &&
    round.closedAt !== null &&
    state.tick >= round.closedAt + steps(SCORED_TIME)
  );
}

/** Le classement aux points ; à points égaux, ex aequo (les dés départagent). */
function ranking(state: ReflexState): PlayerId[][] {
  const byPoints = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    byPoints.set(fighter.points, [...(byPoints.get(fighter.points) ?? []), fighter.id]);
  }
  return [...byPoints.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/**
 * Le bot réagit au signal après son temps de réaction (de REACTION à + REACTION_SPREAD selon son
 * niveau), et se fait parfois avoir par une feinte (FOOLED : il appuie alors après le même
 * temps de réaction). Son tirage ne change pas pendant une manche.
 */
const REACTION: Record<BotLevel, number> = { easy: 0.3, normal: 0.26, expert: 0.25 };
const REACTION_SPREAD: Record<BotLevel, number> = { easy: 0.3, normal: 0.26, expert: 0.2 };
const FOOLED: Record<BotLevel, number> = { easy: 0.25, normal: 0.15, expert: 0.12 };

function botInput(state: ReflexState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  const { round, tick } = state;
  if (!me || round.closedAt !== null || me.pressedAt !== null || me.falseStart) return IDLE_INPUT;
  const key = `${state.seed}:${player}:${round.index}`;
  const reaction = steps(REACTION[level] + hashUnit(key) * REACTION_SPREAD[level]);
  const fooledBy = round.feints.find(
    (feint, k) =>
      hashUnit(`${key}:feint:${k}`) < FOOLED[level] && feint.at + reaction < round.signalAt,
  );
  const pressAt = (fooledBy?.at ?? round.signalAt) + reaction;
  return { ...IDLE_INPUT, primary: tick + 1 >= pressAt };
}

export const BOARD_REFLEX: ArenaGame<ReflexState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
