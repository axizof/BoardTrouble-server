import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Tapis express (02-mini-jeux.md, fiche 46) : chacun devant son tapis roulant d'usine. Les
// articles arrivent un par un, les mêmes pour tous dans le même ordre ; un panneau montre
// l'article à pousser. Pour chaque article : le pousser dans le bac (le bon : +1, un mauvais :
// -1) ou le laisser passer (rien). L'article suivant glisse dès qu'on a décidé : le rythme est
// le sien. Le panneau change de temps en temps, au même article pour tous. Le plus de points en
// 60 s gagne ; on peut finir en négatif.

/** Le chrono (secondes). */
export const SORT_TIME_LIMIT = 60;
/** La fin du rouleau, inatteignable : un joueur très rapide en traite peut-être 150 en 60 s. */
export const SORT_ITEMS = 500;
/** Les formes et les couleurs des articles : un article, c'est une forme et une couleur. */
export const SORT_SHAPES = 5;
export const SORT_COLORS = 3;
/**
 * L'article suivant arrive sur le tapis en tant de secondes après une décision : on ne peut pas
 * décider avant. C'est aussi la limite contre les macros (deux décisions trop rapprochées).
 */
export const ITEM_ARRIVE = 0.18;
/** Le panneau change après FIRST_CHANGE à FIRST_CHANGE + CHANGE_SPREAD articles, puis tous les CHANGE_GAP à + CHANGE_SPREAD. */
const FIRST_CHANGE = 14;
const CHANGE_GAP = 16;
const CHANGE_SPREAD = 10;
/**
 * Parmi les articles : TARGET_SHARE sont le bon ; parmi les autres, NEAR_SHARE lui ressemblent
 * (même forme ou même couleur), pour piéger ceux qui vont trop vite.
 */
const TARGET_SHARE = 0.45;
const NEAR_SHARE = 0.7;

/** Un article : sa forme (0 à SORT_SHAPES - 1) et sa couleur (0 à SORT_COLORS - 1). */
export type SortItem = { shape: number; color: number };

/** La dernière décision d'un joueur, pour l'animer : l'article, poussé ou non, et si c'était juste. */
export type SortDecision = {
  index: number;
  item: SortItem;
  pushed: boolean;
  good: boolean;
  at: number;
};

export type SortFighter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** L'article devant lui (son rang dans le rouleau). */
  index: number;
  /** Le pas à partir duquel il peut décider pour cet article (il vient d'arriver). */
  readyAt: number;
  score: number;
  /** Articles bien poussés et erreurs (poussé à tort), pour le résultat et les bots. */
  good: number;
  mistakes: number;
  last: SortDecision | null;
  /** Les commandes tenues au pas précédent : on compte un appui, pas une touche tenue. */
  held: { push: boolean; pass: boolean };
};

export type SortState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: SortFighter[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const pick = (unit: number, count: number) => Math.min(count - 1, Math.floor(unit * count));

/** Les rangs où le panneau change, dans cette partie (le premier article : 0). */
function changesOf(seed: number): number[] {
  const changes = [0];
  let at = FIRST_CHANGE + pick(hashUnit(`${seed}:first`), CHANGE_SPREAD + 1);
  while (at < SORT_ITEMS) {
    changes.push(at);
    at += CHANGE_GAP + pick(hashUnit(`${seed}:gap:${at}`), CHANGE_SPREAD + 1);
  }
  return changes;
}

const CHANGES = new Map<number, number[]>();
function cachedChanges(seed: number): number[] {
  const known = CHANGES.get(seed);
  if (known) return known;
  const changes = changesOf(seed);
  CHANGES.set(seed, changes);
  return changes;
}

/** Le numéro du panneau en vigueur pour l'article `index` (0 : le premier panneau). */
export function signOf(seed: number, index: number): number {
  const changes = cachedChanges(seed);
  let sign = 0;
  for (let k = 1; k < changes.length && (changes[k] ?? Infinity) <= index; k++) sign = k;
  return sign;
}

/** Le premier article d'un nouveau panneau : le panneau vient de changer. */
export function isSignChange(seed: number, index: number): boolean {
  return index > 0 && signOf(seed, index) !== signOf(seed, index - 1);
}

/** L'article à pousser pour l'article `index` : jamais deux fois de suite le même panneau. */
export function targetOf(seed: number, index: number): SortItem {
  const sign = signOf(seed, index);
  const kinds = SORT_SHAPES * SORT_COLORS;
  let kind = pick(hashUnit(`${seed}:sign:0`), kinds);
  for (let k = 1; k <= sign; k++) {
    // Un autre article que le panneau d'avant (un décalage de 1 à kinds - 1).
    kind = (kind + 1 + pick(hashUnit(`${seed}:sign:${k}`), kinds - 1)) % kinds;
  }
  return { shape: Math.floor(kind / SORT_COLORS), color: kind % SORT_COLORS };
}

/** L'article de rang `index` du rouleau : le bon, un presque pareil, ou un autre. */
export function itemOf(seed: number, index: number): SortItem {
  const target = targetOf(seed, index);
  const key = `${seed}:item:${index}`;
  if (hashUnit(key) < TARGET_SHARE) return target;
  const other = (of: number, count: number, unit: number) =>
    (of + 1 + pick(unit, count - 1)) % count;
  const near = hashUnit(`${key}:near`) < NEAR_SHARE;
  const unit = hashUnit(`${key}:which`);
  if (near && hashUnit(`${key}:side`) < 0.5) {
    return { shape: target.shape, color: other(target.color, SORT_COLORS, unit) };
  }
  if (near) return { shape: other(target.shape, SORT_SHAPES, unit), color: target.color };
  return {
    shape: other(target.shape, SORT_SHAPES, unit),
    color: other(target.color, SORT_COLORS, hashUnit(`${key}:color`)),
  };
}

export const sameItem = (a: SortItem, b: SortItem) => a.shape === b.shape && a.color === b.color;

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SortState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      index: 0,
      readyAt: 0,
      score: 0,
      good: 0,
      mistakes: 0,
      last: null,
      held: { push: false, pass: false },
    })),
  };
}

/** Pousser : l'action principale, ou vers le bac (vers le haut). Laisser passer : la secondaire, ou dans le sens du tapis (vers la droite). */
const DIRECTION = 0.6;
function decisionOf(input: ArenaInput): { push: boolean; pass: boolean } {
  return {
    push: input.primary || input.move.z < -DIRECTION,
    pass: input.secondary || input.move.x > DIRECTION,
  };
}

function step(state: SortState, inputs: Partial<Record<PlayerId, ArenaInput>>): SortState {
  const tick = state.tick + 1;
  const isRunning = state.practice || tick * ARENA_STEP < SORT_TIME_LIMIT;
  const fighters = state.fighters.map((fighter) => {
    const now = decisionOf(inputs[fighter.id] ?? IDLE_INPUT);
    const next = { ...fighter, held: now };
    const isPush = now.push && !fighter.held.push;
    const isPass = now.pass && !fighter.held.pass && !isPush;
    const isDone = !state.practice && fighter.index >= SORT_ITEMS;
    if ((!isPush && !isPass) || !isRunning || isDone || tick < fighter.readyAt) return next;
    const item = itemOf(state.seed, fighter.index);
    const isTarget = sameItem(item, targetOf(state.seed, fighter.index));
    const points = isPush ? (isTarget ? 1 : -1) : 0;
    return {
      ...next,
      // Au bac à sable, le rouleau recommence (il ne finit jamais).
      index: state.practice ? (fighter.index + 1) % SORT_ITEMS : fighter.index + 1,
      readyAt: tick + steps(ITEM_ARRIVE),
      score: fighter.score + points,
      good: fighter.good + (points > 0 ? 1 : 0),
      mistakes: fighter.mistakes + (points < 0 ? 1 : 0),
      last: { index: fighter.index, item, pushed: isPush, good: isPush === isTarget, at: tick },
    };
  });
  return { ...state, tick, fighters };
}

function timeLeft(state: SortState): number | null {
  return state.practice ? null : Math.max(0, SORT_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: SortState): boolean {
  if (state.practice) return false;
  return (
    (timeLeft(state) ?? 1) <= 0 || state.fighters.every((fighter) => fighter.index >= SORT_ITEMS)
  );
}

/** Le classement aux points ; à points égaux, ex aequo (les dés départagent). */
function ranking(state: SortState): PlayerId[][] {
  const byScore = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    byScore.set(fighter.score, [...(byScore.get(fighter.score) ?? []), fighter.id]);
  }
  return [...byScore.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/**
 * Le bot décide après son temps de réaction (REACTION, plus REACTION_SPREAD au hasard), et se
 * trompe parfois (MISTAKE), deux fois plus sur les premiers articles après un changement de
 * panneau (il ne l'a pas encore bien vu).
 */
const REACTION: Record<BotLevel, number> = { easy: 0.75, normal: 0.55, expert: 0.4 };
const REACTION_SPREAD: Record<BotLevel, number> = { easy: 0.45, normal: 0.3, expert: 0.2 };
const MISTAKE: Record<BotLevel, number> = { easy: 0.12, normal: 0.06, expert: 0.03 };
const SURPRISED_ITEMS = 3;

function botInput(state: SortState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || (!state.practice && me.index >= SORT_ITEMS)) return IDLE_INPUT;
  const key = `${state.seed}:${player}:${me.index}`;
  const decideAt = me.readyAt + steps(REACTION[level] + hashUnit(key) * REACTION_SPREAD[level]);
  if (state.tick + 1 < decideAt || me.held.push || me.held.pass) return IDLE_INPUT;
  const sinceChange = me.index - lastChangeBefore(state.seed, me.index);
  const mistake = MISTAKE[level] * (sinceChange < SURPRISED_ITEMS ? 2 : 1);
  const isTarget = sameItem(itemOf(state.seed, me.index), targetOf(state.seed, me.index));
  const wrong = hashUnit(`${key}:mistake`) < mistake;
  const push = isTarget !== wrong;
  return { ...IDLE_INPUT, primary: push, secondary: !push };
}

/** Le rang du dernier changement de panneau avant (ou à) l'article `index`. */
function lastChangeBefore(seed: number, index: number): number {
  const changes = cachedChanges(seed);
  return changes[signOf(seed, index)] ?? 0;
}

export const CONVEYOR_SORT: ArenaGame<SortState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  // Proches : 2 points d'écart au plus ; écrasant : 12 points d'avance.
  reveal: {
    score: (state, player) => state.fighters.find((one) => one.id === player)?.score ?? 0,
    close: 2,
    crushing: 12,
  },
};
