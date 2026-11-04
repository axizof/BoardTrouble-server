import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Enchères secrètes (02-mini-jeux.md, fiche 22) : chacun a AUCTION_TOKENS jetons. Les lots de
// points passent aux enchères l'un après l'autre, leurs valeurs visibles d'avance. Chacun mise
// en secret ; à la révélation, le plus offrant remporte le lot, et tout le monde perd sa mise.
// Deux plus offrants à égalité : personne ne l'a (mais chacun paie). Classement aux points, puis
// aux jetons restants. Tant que la mise n'est pas révélée, l'hôte ne l'envoie qu'à son joueur.

export const AUCTION_TOKENS = 15;
/** Les lots, mis aux enchères dans un ordre tiré au hasard. */
const LOT_VALUES = [1, 2, 3, 4, 5];
/** Le temps pour miser (secondes) ; la mise affichée compte s'il est écoulé. */
export const BID_TIME = 12;
/** Les mises restent révélées ce temps-là avant le lot suivant. */
export const REVEAL_TIME = 3.5;
/** Les boutons visés à la souris (`target`). */
export const BID_LESS = 0;
export const BID_MORE = 1;
export const BID_CONFIRM = 2;
/** Au clavier : gauche et droite changent la mise de 1, haut et bas de BID_JUMP. */
const BID_JUMP = 5;
/** Une mise cachée, dans ce qu'on envoie aux autres joueurs. */
export const HIDDEN_BID = -1;
const DEAD_ZONE = 0.5;

export type AuctionPhase = 'bidding' | 'reveal';

export type Bidder = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  tokens: number;
  points: number;
  /** La mise en cours (HIDDEN_BID pour les autres, tant qu'elle n'est pas révélée). */
  bid: number;
  /** Il a validé sa mise. */
  isLocked: boolean;
  /** Sa mise révélée au dernier lot, ou null. */
  lastBid: number | null;
  heldDirection: { x: number; z: number };
  held: boolean;
};

export type AuctionState = {
  tick: number;
  practice: boolean;
  seed: number;
  lots: number[];
  /** Le lot en jeu, et où en est son enchère. */
  lot: number;
  phase: AuctionPhase;
  phaseAt: number;
  /** Qui a remporté le dernier lot révélé (null : personne). */
  winner: PlayerId | null;
  /** Qui a remporté chaque lot déjà joué, dans l'ordre (null : personne). */
  wins: (PlayerId | null)[];
  fighters: Bidder[];
};

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

function shuffledLots(seed: number, round: number): number[] {
  return new Rng(Math.floor(hashUnit(`${seed}:lots:${round}`) * 2 ** 31)).shuffle(LOT_VALUES);
}

function freshBidder(id: PlayerId): Bidder {
  return {
    id,
    fellAt: null,
    tokens: AUCTION_TOKENS,
    points: 0,
    bid: 0,
    isLocked: false,
    lastBid: null,
    heldDirection: { x: 0, z: 0 },
    held: false,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): AuctionState {
  return {
    tick: 0,
    practice,
    seed,
    lots: shuffledLots(seed, 0),
    lot: 0,
    phase: 'bidding',
    phaseAt: 0,
    winner: null,
    wins: [],
    fighters: players.map(freshBidder),
  };
}

/** Les secondes qui restent pour miser, ou null hors des mises. */
export function bidTimeLeft(state: AuctionState): number | null {
  if (state.phase !== 'bidding') return null;
  return Math.max(0, BID_TIME - (state.tick - state.phaseAt) * ARENA_STEP);
}

/** Le pas d'un joueur pendant les mises : il change sa mise, ou la valide. */
function bidding(bidder: Bidder, input: ArenaInput): Bidder {
  const next = { ...bidder };
  const isPress = input.primary && !bidder.held;
  next.held = input.primary;
  const direction = {
    x: Math.abs(input.move.x) > DEAD_ZONE ? Math.sign(input.move.x) : 0,
    z: Math.abs(input.move.z) > DEAD_ZONE ? Math.sign(input.move.z) : 0,
  };
  const stepX = direction.x !== bidder.heldDirection.x ? direction.x : 0;
  // Haut à l'écran (z négatif) : plus.
  const stepZ = direction.z !== bidder.heldDirection.z ? -direction.z * BID_JUMP : 0;
  next.heldDirection = direction;
  if (next.isLocked) return next;
  const aimed = input.target === BID_LESS ? -1 : input.target === BID_MORE ? 1 : 0;
  next.bid = Math.min(next.tokens, Math.max(0, next.bid + stepX + stepZ + aimed));
  if (isPress || input.target === BID_CONFIRM) next.isLocked = true;
  return next;
}

/** Les mises révélées : le seul plus offrant remporte le lot ; tout le monde paie. */
function reveal(state: AuctionState, fighters: Bidder[], tick: number): AuctionState {
  const best = Math.max(0, ...fighters.map((bidder) => bidder.bid));
  const leaders = fighters.filter((bidder) => bidder.bid === best);
  const winner = best > 0 && leaders.length === 1 ? (leaders[0]?.id ?? null) : null;
  const value = state.lots[state.lot] ?? 0;
  const paid = fighters.map((bidder) => ({
    ...bidder,
    tokens: bidder.tokens - bidder.bid,
    points: bidder.points + (bidder.id === winner ? value : 0),
    lastBid: bidder.bid,
    isLocked: true,
  }));
  const wins = [...state.wins, winner];
  return { ...state, tick, phase: 'reveal', phaseAt: tick, winner, wins, fighters: paid };
}

/** Le lot suivant (au bac à sable, une nouvelle série recommence quand tout est passé). */
function nextLot(state: AuctionState, tick: number): AuctionState {
  const isNewSeries = state.lot + 1 >= state.lots.length;
  const fighters = state.fighters.map((bidder) => ({
    ...(isNewSeries ? freshBidder(bidder.id) : bidder),
    bid: 0,
    isLocked: false,
    heldDirection: bidder.heldDirection,
    held: bidder.held,
  }));
  return {
    ...state,
    tick,
    lots: isNewSeries ? shuffledLots(state.seed, tick) : state.lots,
    lot: isNewSeries ? 0 : state.lot + 1,
    wins: isNewSeries ? [] : state.wins,
    phase: 'bidding',
    phaseAt: tick,
    winner: null,
    fighters,
  };
}

function step(state: AuctionState, inputs: Partial<Record<PlayerId, ArenaInput>>): AuctionState {
  const tick = state.tick + 1;
  if (state.phase === 'reveal') {
    const isLast = state.lot + 1 >= state.lots.length;
    const isShown = tick - state.phaseAt >= steps(REVEAL_TIME);
    if (isShown && (state.practice || !isLast)) return nextLot(state, tick);
    return { ...state, tick };
  }
  const fighters = state.fighters.map((bidder) => bidding(bidder, inputs[bidder.id] ?? IDLE_INPUT));
  const isTimeUp = tick - state.phaseAt >= steps(BID_TIME);
  if (isTimeUp || fighters.every((bidder) => bidder.isLocked)) return reveal(state, fighters, tick);
  return { ...state, tick, fighters };
}

function isOver(state: AuctionState): boolean {
  return (
    !state.practice &&
    state.phase === 'reveal' &&
    state.lot + 1 >= state.lots.length &&
    state.tick - state.phaseAt >= steps(REVEAL_TIME)
  );
}

/** Le classement : aux points, puis aux jetons restants ; égaux en tout, ex aequo (les dés). */
function ranking(state: AuctionState): PlayerId[][] {
  const sorted = [...state.fighters].sort((a, b) => b.points - a.points || b.tokens - a.tokens);
  const groups: PlayerId[][] = [];
  sorted.forEach((bidder, index) => {
    const before = sorted[index - 1];
    const isTied = before && before.points === bidder.points && before.tokens === bidder.tokens;
    if (isTied) groups.at(-1)?.push(bidder.id);
    else groups.push([bidder.id]);
  });
  return groups;
}

/** Pendant les mises, chacun ne voit que la sienne (et qui a validé) ; à la révélation, tout. */
function viewFor(state: AuctionState, viewer: Viewer): AuctionState {
  if (state.phase !== 'bidding') return { ...state, seed: 0 };
  const fighters = state.fighters.map((bidder) => {
    const isOwn = viewer.type === 'player' && viewer.playerId === bidder.id;
    return isOwn ? bidder : { ...bidder, bid: HIDDEN_BID };
  });
  return { ...state, seed: 0, fighters };
}

/**
 * Le bot réfléchit un moment (THINK), décide sa mise (`desiredBid`), monte ou descend jusqu'à
 * elle, puis valide. Il ne voit que ce qui est public : les lots, les jetons et les points.
 */
const THINK: Record<BotLevel, [number, number]> = {
  easy: [1, 3],
  normal: [1.5, 4],
  expert: [2, 5],
};

/**
 * La mise voulue, d'après ce qui est public. Tout le monde paie sa mise : se battre pour chaque
 * lot ruine, et une part de hasard est la stratégie la plus sûre (des bots qui misent pareil
 * s'annulent, et qui économise rafle la fin). Chacun tire donc sa mise autour de sa juste part
 * du lot (BID_SPREAD) ; l'Expert ajoute deux réflexes : un lot qu'il est sûr d'avoir (un jeton de
 * plus que le plus riche des autres) quand il ne s'y ruine pas, et au dernier lot, ce qu'il faut
 * pour gagner à coup sûr, ou tout ce qu'il a s'il ne peut pas en être sûr.
 */
const BID_SPREAD: Record<BotLevel, [number, number]> = {
  easy: [0.2, 1.3],
  normal: [0.5, 1.6],
  expert: [0.4, 1.9],
};

function desiredBid(state: AuctionState, me: Bidder, level: BotLevel): number {
  const remaining = state.lots.slice(state.lot);
  const value = remaining[0] ?? 0;
  const share =
    value /
    Math.max(
      1,
      remaining.reduce((sum, lot) => sum + lot, 0),
    );
  const luck = hashUnit(`${state.seed}:${me.id}:${state.lot}:bid`);
  const others = state.fighters.filter((bidder) => bidder.id !== me.id);
  const richest = Math.max(0, ...others.map((bidder) => bidder.tokens));
  const isLast = remaining.length === 1;
  if (level === 'expert') {
    const sure = richest + 1;
    if (isLast) return Math.min(sure, me.tokens);
    if (sure <= me.tokens && sure <= me.tokens * share * 2.5) return sure;
  }
  if (isLast && level === 'normal') return me.tokens;
  const [least, most] = BID_SPREAD[level];
  return Math.round(me.tokens * share * (least + (most - least) * luck));
}

function botInput(state: AuctionState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((bidder) => bidder.id === player);
  if (!me || state.phase !== 'bidding' || me.isLocked) return IDLE_INPUT;
  const [least, most] = THINK[level];
  const think = least + (most - least) * hashUnit(`${state.seed}:${player}:${state.lot}:think`);
  if ((state.tick - state.phaseAt) * ARENA_STEP < think) return IDLE_INPUT;
  const wanted = Math.min(me.tokens, Math.max(0, desiredBid(state, me, level)));
  const target = me.bid < wanted ? BID_MORE : me.bid > wanted ? BID_LESS : BID_CONFIRM;
  return { ...IDLE_INPUT, target };
}

export const SECRET_AUCTION: ArenaGame<AuctionState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
  viewFor,
};
