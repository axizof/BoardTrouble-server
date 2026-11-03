import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Mémoire des cartes (02-mini-jeux.md, fiche 10) : chacun sa grille de cartes face cachée, les
// mêmes paires pour tous, placées autrement. On retourne deux cartes : une paire reste face
// visible, sinon elles se recachent. Le premier à tout trouver gagne, ou le plus de paires en
// 60 s. On vise une carte à la souris, ou au curseur (flèches, stick) puis Espace / A. Tout se
// joue chez l'hôte : un joueur ne reçoit la face d'une carte qu'une fois retournée (`viewFor`).

export const MEMORY_COLUMNS = 5;
export const MEMORY_ROWS = 4;
export const MEMORY_PAIRS = (MEMORY_COLUMNS * MEMORY_ROWS) / 2;
export const MEMORY_TIME_LIMIT = 60;
/** Deux cartes qui ne vont pas ensemble restent visibles ce temps-là (ou jusqu'à la suivante). */
export const MISMATCH_SHOWN = 0.8;
/** Une face cachée, dans ce qu'on envoie aux joueurs. */
export const HIDDEN_FACE = -1;
/** Le stick ou les flèches ne déplacent le curseur qu'au-delà de cette inclinaison. */
const CURSOR_DEAD_ZONE = 0.5;

export type MemoryBoard = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** La face de chaque carte, rangée par rangée (HIDDEN_FACE si on ne doit pas la voir). */
  faces: number[];
  matched: boolean[];
  /** Les cartes retournées en ce moment (deux au plus), pas encore appariées. */
  up: number[];
  /** Le pas où deux cartes qui ne vont pas ensemble se recachent, ou null. */
  hideAt: number | null;
  cursor: number;
  /** La direction tenue au pas précédent : le curseur avance d'une case par appui. */
  heldDirection: { x: number; z: number };
  held: boolean;
  pairs: number;
  /** Le pas de la dernière paire trouvée, et celui où tout a été trouvé (ou null). */
  lastPairAt: number;
  finishedAt: number | null;
  /** Le pas où chaque carte a été vue pour la dernière fois (ce dont un bot peut se souvenir). */
  seenAt: (number | null)[];
  /** Le pas de sa dernière carte retournée (le rythme des bots). */
  flippedAt: number;
};

export type MemoryState = {
  tick: number;
  practice: boolean;
  /** La graine de la partie : elle dit où sont les cartes, elle n'est jamais envoyée aux joueurs. */
  seed: number;
  /** Les grilles, une par joueur (le cadre des arènes les appelle `fighters`). */
  fighters: MemoryBoard[];
};

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** Une disposition des paires, propre à ce joueur et à cette partie (ou à ce tour d'essai). */
function layout(seed: number, player: PlayerId, round: number): number[] {
  const rng = new Rng(Math.floor(hashUnit(`${seed}:layout:${player}:${round}`) * 2 ** 31));
  const faces = Array.from({ length: MEMORY_PAIRS }, (_, face) => [face, face]).flat();
  return rng.shuffle(faces);
}

function freshBoard(id: PlayerId, faces: number[]): MemoryBoard {
  return {
    id,
    fellAt: null,
    faces,
    matched: faces.map(() => false),
    up: [],
    hideAt: null,
    cursor: 0,
    heldDirection: { x: 0, z: 0 },
    held: false,
    pairs: 0,
    lastPairAt: 0,
    finishedAt: null,
    seenAt: faces.map(() => null),
    flippedAt: 0,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): MemoryState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id) => freshBoard(id, layout(seed, id, 0))),
  };
}

/** Le pas d'un joueur : le curseur, puis la carte visée ou sous le curseur. */
function play(board: MemoryBoard, input: ArenaInput, tick: number): MemoryBoard {
  const next = {
    ...board,
    up: [...board.up],
    matched: [...board.matched],
    seenAt: [...board.seenAt],
  };
  if (next.hideAt !== null && tick >= next.hideAt) {
    next.up = [];
    next.hideAt = null;
  }
  const isPress = input.primary && !board.held;
  next.held = input.primary;
  const direction = {
    x: Math.abs(input.move.x) > CURSOR_DEAD_ZONE ? Math.sign(input.move.x) : 0,
    z: Math.abs(input.move.z) > CURSOR_DEAD_ZONE ? Math.sign(input.move.z) : 0,
  };
  const column = next.cursor % MEMORY_COLUMNS;
  const row = Math.floor(next.cursor / MEMORY_COLUMNS);
  const moveX = direction.x !== board.heldDirection.x ? direction.x : 0;
  const moveZ = direction.z !== board.heldDirection.z ? direction.z : 0;
  next.heldDirection = direction;
  next.cursor =
    Math.min(MEMORY_ROWS - 1, Math.max(0, row + moveZ)) * MEMORY_COLUMNS +
    Math.min(MEMORY_COLUMNS - 1, Math.max(0, column + moveX));
  const target = input.target;
  const isAimed = typeof target === 'number' && target < next.faces.length;
  if (isAimed) next.cursor = target;
  if (next.finishedAt !== null || !(isAimed || isPress)) return next;
  return flip(next, next.cursor, tick);
}

/** Il retourne la carte `card` : une paire reste, sinon les deux se recachent un peu après. */
function flip(board: MemoryBoard, card: number, tick: number): MemoryBoard {
  if (board.matched[card] || board.up.includes(card)) return board;
  // Deux cartes encore visibles : elles se recachent tout de suite, on n'attend pas.
  if (board.up.length >= 2) {
    board.up = [];
    board.hideAt = null;
  }
  board.up.push(card);
  board.seenAt[card] = tick;
  board.flippedAt = tick;
  const [first, second] = board.up;
  if (first === undefined || second === undefined) return board;
  if (board.faces[first] !== board.faces[second]) {
    board.hideAt = tick + Math.round(MISMATCH_SHOWN / ARENA_STEP);
    return board;
  }
  board.matched[first] = true;
  board.matched[second] = true;
  board.up = [];
  board.pairs += 1;
  board.lastPairAt = tick;
  if (board.pairs === MEMORY_PAIRS) board.finishedAt = tick;
  return board;
}

function step(state: MemoryState, inputs: Partial<Record<PlayerId, ArenaInput>>): MemoryState {
  const tick = state.tick + 1;
  const isTimeUp = !state.practice && tick * ARENA_STEP >= MEMORY_TIME_LIMIT;
  const fighters = state.fighters.map((board) => {
    if (isTimeUp) return board;
    const played = play(board, inputs[board.id] ?? IDLE_INPUT, tick);
    // Au bac à sable, une grille finie repart, mélangée autrement.
    if (state.practice && played.finishedAt !== null) {
      return freshBoard(board.id, layout(state.seed, board.id, tick));
    }
    return played;
  });
  return { ...state, tick, fighters };
}

function timeLeft(state: MemoryState): number | null {
  return state.practice ? null : Math.max(0, MEMORY_TIME_LIMIT - state.tick * ARENA_STEP);
}

function isOver(state: MemoryState): boolean {
  if (state.practice) return false;
  return (timeLeft(state) ?? 1) <= 0 || state.fighters.every((board) => board.finishedAt !== null);
}

/**
 * Le classement : le plus de paires, puis le premier à avoir tout trouvé (ou, à paires égales
 * sans avoir fini, le premier arrivé à ce nombre de paires) ; sinon ex aequo.
 */
function ranking(state: MemoryState): PlayerId[][] {
  const reachedAt = (board: MemoryBoard) => board.finishedAt ?? board.lastPairAt;
  const sorted = [...state.fighters].sort(
    (a, b) => b.pairs - a.pairs || reachedAt(a) - reachedAt(b),
  );
  const groups: PlayerId[][] = [];
  sorted.forEach((board, index) => {
    const before = sorted[index - 1];
    const isTied = before && before.pairs === board.pairs && reachedAt(before) === reachedAt(board);
    if (isTied) groups.at(-1)?.push(board.id);
    else groups.push([board.id]);
  });
  return groups;
}

/**
 * Ce qu'un joueur voit : sur sa grille, les cartes retournées et les paires trouvées ; sur celles
 * des autres (et pour un spectateur), seulement les paires trouvées, pour que personne ne puisse
 * retenir les cartes d'un autre et les lui souffler. Ni la graine (elle dit où sont les cartes).
 */
function viewFor(state: MemoryState, viewer: Viewer): MemoryState {
  const fighters = state.fighters.map((board) => {
    const isOwn = viewer.type === 'player' && viewer.playerId === board.id;
    const faces = board.faces.map((face, card) => {
      const isShown = board.matched[card] || (isOwn && board.up.includes(card));
      return isShown ? face : HIDDEN_FACE;
    });
    return { ...board, faces, up: isOwn ? board.up : [] };
  });
  return { ...state, seed: 0, fighters };
}

/**
 * Le bot joue à son rythme (une carte toutes les THINK secondes, à peu près) avec une mémoire
 * imparfaite : il se souvient d'une carte vue avec une chance selon son niveau, tirée une fois
 * pour chaque fois qu'il l'a vue. Il retourne une paire qu'il connaît ; sinon une carte jamais
 * vue, puis sa jumelle s'il s'en souvient. Il ne lit une face que s'il l'a vue.
 */
const THINK: Record<BotLevel, number> = { easy: 1.05, normal: 0.85, expert: 0.8 };
const MEMORY: Record<BotLevel, number> = { easy: 0.55, normal: 0.76, expert: 0.8 };

function botInput(state: MemoryState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const board = state.fighters.find((candidate) => candidate.id === player);
  if (!board || board.finishedAt !== null) return IDLE_INPUT;
  const pause = THINK[level] * (0.8 + 0.4 * hashUnit(`${state.seed}:${player}:${board.flippedAt}`));
  if ((state.tick - board.flippedAt) * ARENA_STEP < pause) return IDLE_INPUT;
  // Deux cartes qui ne vont pas ensemble : il les regarde le temps qu'elles se recachent.
  if (board.up.length >= 2) return IDLE_INPUT;
  const remembers = (card: number) => {
    const seen = board.seenAt[card];
    return (
      seen !== null &&
      seen !== undefined &&
      !board.matched[card] &&
      hashUnit(`${state.seed}:${player}:memory:${card}:${seen}`) < MEMORY[level]
    );
  };
  const hidden = board.faces.flatMap((_, card) =>
    board.matched[card] || board.up.includes(card) ? [] : [card],
  );
  const known = hidden.filter(remembers);
  const unseen = hidden.filter((card) => board.seenAt[card] === null);
  const [first] = board.up;
  const twinOf = (card: number) =>
    known.find((other) => other !== card && board.faces[other] === board.faces[card]);
  const knownPair = known.find((card) => twinOf(card) !== undefined);
  const pickUnseen = () =>
    [...unseen].sort(
      (a, b) =>
        hashUnit(`${state.seed}:${player}:${a}:${state.tick}`) -
        hashUnit(`${state.seed}:${player}:${b}:${state.tick}`),
    )[0] ?? hidden[0];
  const choice =
    first !== undefined ? (twinOf(first) ?? pickUnseen()) : (knownPair ?? pickUnseen());
  return choice === undefined ? IDLE_INPUT : { ...IDLE_INPUT, target: choice };
}

export const CARD_MEMORY: ArenaGame<MemoryState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  viewFor,
};
