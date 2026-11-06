import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Duel au soleil (02-mini-jeux.md, fiche 32), un duel (et une finale) : deux cow-boys face à
// face. Le Plateau fait monter la tension, feinte (des mots qui sonnent comme "Feu !", un
// corbeau, la cloche, une boule d'herbe), puis crie "Feu !" : une cible apparaît à gauche, à
// droite ou en haut, et il faut tirer dans sa direction. Le premier qui vise juste gagne la
// manche ; une mauvaise direction enraye son arme pour la manche (l'autre peut encore tirer) ;
// tirer avant le signal donne la manche à l'autre. Le premier à DUEL_TARGET manches gagne.

/** Les manches gagnées qu'il faut ; au plus DUEL_MAX_ROUNDS manches. */
export const DUEL_TARGET = 3;
export const DUEL_MAX_ROUNDS = 9;
/** Le signal arrive au hasard entre WAIT_MIN et WAIT_MAX secondes après le début de la manche. */
const WAIT_MIN = 2;
const WAIT_MAX = 6;
/**
 * Avant le signal, 0 à MAX_FEINTS feintes, montrées DUEL_FEINT_SHOWN secondes, à FEINT_GAP au moins
 * l'une de l'autre, ni dans la première FEINT_FROM seconde, ni dans la dernière FEINT_CLEAR
 * seconde avant le signal.
 */
const MAX_FEINTS = 3;
export const DUEL_FEINT_SHOWN = 0.8;
const FEINT_GAP = 1;
const FEINT_FROM = 0.8;
const FEINT_CLEAR = 0.6;
/** Les sortes de feintes : d'abord les mots (le client leur donne un texte), puis le décor. */
export const WORD_FEINTS = 5;
export const SCENERY_FEINTS = ['crow', 'bell', 'tumbleweed'] as const;
/** Après le signal, on a DUEL_ANSWER_TIME secondes pour tirer. */
export const DUEL_ANSWER_TIME = 1.5;
/** La manche jouée, son résultat reste ce temps-là avant la suivante. */
export const DUEL_SCORED_TIME = 2.4;
/** Le stick ou les flèches ne tirent qu'au-delà de cette inclinaison. */
const AIM_DEAD_ZONE = 0.5;

/** Où apparaît la cible, et où l'on tire. */
export type DuelDirection = 'left' | 'right' | 'up';
const DIRECTIONS: readonly DuelDirection[] = ['left', 'right', 'up'];

export type DuelFeint = { at: number; kind: number };

export type DuelRound = {
  index: number;
  startAt: number;
  signalAt: number;
  target: DuelDirection;
  feints: DuelFeint[];
  /** Le pas où la manche s'est jouée, ou null ; et son gagnant (null : personne). */
  closedAt: number | null;
  winner: PlayerId | null;
};

export type Duelist = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  points: number;
  /** Cette manche : le pas et la direction de son tir, ou null ; parti trop tôt. */
  shotAt: number | null;
  shot: DuelDirection | null;
  falseStart: boolean;
  /** La direction tenue au pas précédent : on tire quand on pousse, pas en tenant. */
  aiming: DuelDirection | null;
};

export type DuelState = {
  tick: number;
  practice: boolean;
  seed: number;
  round: DuelRound;
  fighters: Duelist[];
};

/** Ce que montre le Plateau à cet instant. */
export type DuelShown =
  | { type: 'waiting' }
  | { type: 'feint'; kind: number }
  | { type: 'signal'; target: DuelDirection }
  | { type: 'scored'; winner: PlayerId | null };

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** Une manche qui commence à `startAt` : son signal, sa cible et ses feintes, au hasard de la partie. */
function planRound(seed: number, index: number, startAt: number): DuelRound {
  const key = `${seed}:duel:${index}`;
  const wait = WAIT_MIN + hashUnit(key) * (WAIT_MAX - WAIT_MIN);
  const room = wait - FEINT_FROM - FEINT_CLEAR - DUEL_FEINT_SHOWN;
  const fits = room < 0 ? 0 : 1 + Math.floor(room / FEINT_GAP);
  const count = Math.min(fits, Math.floor(hashUnit(`${key}:count`) * (MAX_FEINTS + 1)));
  // Le reste de la place, partagé au hasard avant, entre et après les feintes.
  const spare = room - (count - 1) * FEINT_GAP;
  const weights = Array.from({ length: count + 1 }, (_, k) => hashUnit(`${key}:gap:${k}`) + 0.1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const kinds = WORD_FEINTS + SCENERY_FEINTS.length;
  const feints: DuelFeint[] = [];
  let at = FEINT_FROM;
  for (let k = 0; k < count; k++) {
    at += (spare * (weights[k] ?? 0)) / total;
    feints.push({
      at: startAt + steps(at),
      kind: Math.floor(hashUnit(`${key}:kind:${k}`) * kinds),
    });
    at += FEINT_GAP;
  }
  const target = DIRECTIONS[Math.floor(hashUnit(`${key}:target`) * DIRECTIONS.length)] ?? 'up';
  return {
    index,
    startAt,
    signalAt: startAt + steps(wait),
    target,
    feints,
    closedAt: null,
    winner: null,
  };
}

/** La feinte d'une sorte de décor (le corbeau...), ou null pour une feinte en mots. */
export function sceneryOf(kind: number): (typeof SCENERY_FEINTS)[number] | null {
  return kind < WORD_FEINTS ? null : (SCENERY_FEINTS[kind - WORD_FEINTS] ?? null);
}

export function duelShown(state: DuelState): DuelShown {
  const { round, tick } = state;
  if (round.closedAt !== null) return { type: 'scored', winner: round.winner };
  if (tick >= round.signalAt) return { type: 'signal', target: round.target };
  const feint = round.feints.find((f) => tick >= f.at && tick < f.at + steps(DUEL_FEINT_SHOWN));
  return feint ? { type: 'feint', kind: feint.kind } : { type: 'waiting' };
}

/** La direction où pousse cette commande, ou null (bas ne tire nulle part). */
export function aimOf(input: ArenaInput): DuelDirection | null {
  const { x, z } = input.move;
  if (Math.abs(x) >= AIM_DEAD_ZONE && Math.abs(x) >= -z) return x < 0 ? 'left' : 'right';
  return z <= -AIM_DEAD_ZONE ? 'up' : null;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): DuelState {
  return {
    tick: 0,
    practice,
    seed,
    round: planRound(seed, 0, 0),
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      points: 0,
      shotAt: null,
      shot: null,
      falseStart: false,
      aiming: null,
    })),
  };
}

function step(state: DuelState, inputs: Partial<Record<PlayerId, ArenaInput>>): DuelState {
  const tick = state.tick + 1;
  let round = state.round;
  let fighters = state.fighters.map((fighter) => ({ ...fighter }));
  // La manche jouée et son résultat montré : la suivante (au bac à sable, sans fin).
  const isNext =
    round.closedAt !== null &&
    tick >= round.closedAt + steps(DUEL_SCORED_TIME) &&
    (state.practice || !isLastRound(state));
  if (isNext) {
    round = planRound(state.seed, round.index + 1, tick);
    fighters = fighters.map((fighter) => ({
      ...fighter,
      shotAt: null,
      shot: null,
      falseStart: false,
    }));
  }
  if (round.closedAt === null) round = shoot(round, fighters, inputs, tick);
  else for (const fighter of fighters) fighter.aiming = aimOf(inputs[fighter.id] ?? IDLE_INPUT);
  return { ...state, tick, round, fighters };
}

/**
 * Les tirs de ce pas. Avant le signal, tirer donne la manche à l'autre ; après, le premier qui
 * vise juste la gagne (les deux au même pas : personne). Si personne ne peut plus la gagner
 * (armes enrayées, temps écoulé), elle se joue sans gagnant.
 */
function shoot(
  round: DuelRound,
  fighters: Duelist[],
  inputs: Partial<Record<PlayerId, ArenaInput>>,
  tick: number,
): DuelRound {
  for (const fighter of fighters) {
    const aim = aimOf(inputs[fighter.id] ?? IDLE_INPUT);
    const isShot = aim !== null && aim !== fighter.aiming;
    fighter.aiming = aim;
    if (!isShot || fighter.shot !== null || fighter.falseStart) continue;
    if (tick < round.signalAt) fighter.falseStart = true;
    else Object.assign(fighter, { shot: aim, shotAt: tick });
  }
  const early = fighters.filter((fighter) => fighter.falseStart);
  if (early.length > 0) {
    const others = fighters.filter((fighter) => !fighter.falseStart);
    const winner = early.length === 1 && others.length === 1 ? (others[0] ?? null) : null;
    return close(round, winner, tick);
  }
  const hits = fighters.filter(
    (fighter) => fighter.shot === round.target && fighter.shotAt === tick,
  );
  if (hits.length > 0) return close(round, hits.length === 1 ? (hits[0] ?? null) : null, tick);
  const canStillShoot = fighters.some((fighter) => fighter.shot === null);
  const isTimeUp = tick >= round.signalAt + steps(DUEL_ANSWER_TIME);
  return tick >= round.signalAt && (!canStillShoot || isTimeUp) ? close(round, null, tick) : round;
}

function close(round: DuelRound, winner: Duelist | null, tick: number): DuelRound {
  if (winner) winner.points += 1;
  return { ...round, closedAt: tick, winner: winner?.id ?? null };
}

/** La manche jouée est la dernière : quelqu'un a ses DUEL_TARGET manches, ou c'était la dernière permise. */
function isLastRound(state: DuelState): boolean {
  const { round } = state;
  return (
    round.closedAt !== null &&
    (round.index + 1 >= DUEL_MAX_ROUNDS ||
      state.fighters.some((fighter) => fighter.points >= DUEL_TARGET))
  );
}

function isOver(state: DuelState): boolean {
  const { round } = state;
  return (
    !state.practice &&
    isLastRound(state) &&
    round.closedAt !== null &&
    state.tick >= round.closedAt + steps(DUEL_SCORED_TIME)
  );
}

/** Le classement aux manches gagnées ; à égalité, ex aequo (les dés départagent). */
function ranking(state: DuelState): PlayerId[][] {
  const byPoints = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    byPoints.set(fighter.points, [...(byPoints.get(fighter.points) ?? []), fighter.id]);
  }
  return [...byPoints.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/**
 * Le bot tire après son temps de réaction (plus long qu'au Réflexe : il faut voir où est la
 * cible), vise parfois à côté (MISS), et se fait parfois avoir par une feinte (FOOLED : il tire
 * alors après le même temps de réaction, dans une direction au hasard). Son tirage ne change
 * pas pendant une manche.
 */
const REACTION: Record<BotLevel, number> = { easy: 0.34, normal: 0.31, expert: 0.29 };
const REACTION_SPREAD: Record<BotLevel, number> = { easy: 0.3, normal: 0.26, expert: 0.22 };
const MISS: Record<BotLevel, number> = { easy: 0.12, normal: 0.06, expert: 0.03 };
const FOOLED: Record<BotLevel, number> = { easy: 0.2, normal: 0.1, expert: 0.06 };

function botInput(state: DuelState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  const { round, tick } = state;
  if (!me || round.closedAt !== null || me.shot !== null || me.falseStart) return IDLE_INPUT;
  const key = `${state.seed}:${player}:${round.index}`;
  const reaction = steps(REACTION[level] + hashUnit(key) * REACTION_SPREAD[level]);
  const fooledBy = round.feints.find(
    (feint, k) =>
      hashUnit(`${key}:feint:${k}`) < FOOLED[level] && feint.at + reaction < round.signalAt,
  );
  const shootAt = (fooledBy?.at ?? round.signalAt) + reaction;
  if (tick + 1 < shootAt) return IDLE_INPUT;
  const isMiss = fooledBy !== undefined || hashUnit(`${key}:miss`) < MISS[level];
  const others = DIRECTIONS.filter((direction) => direction !== round.target);
  const aim = isMiss
    ? (others[Math.floor(hashUnit(`${key}:wrong`) * others.length)] ?? 'up')
    : round.target;
  // Relâché un pas sur deux : une même direction tenue ne tire qu'une fois.
  return me.aiming === null ? { ...IDLE_INPUT, move: toMove(aim) } : IDLE_INPUT;
}

function toMove(direction: DuelDirection): { x: number; z: number } {
  if (direction === 'left') return { x: -1, z: 0 };
  if (direction === 'right') return { x: 1, z: 0 };
  return { x: 0, z: -1 };
}

export const HIGH_NOON: ArenaGame<DuelState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
