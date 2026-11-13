import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Chifoumi du sommet (02-mini-jeux.md, fiche 55), une finale : pierre, feuille, ciseaux en
// face-à-face. Chaque manche : chacun choisit en secret un geste à annoncer, puis les deux
// annonces sont dévoilées ensemble (on peut mentir) ; chacun choisit ensuite en secret son vrai
// geste ; chi-fou-mi, on révèle. Gagner la manche vaut 1 point, et 2 si on gagne avec le geste
// qu'on avait annoncé : du bluff et de la lecture, plus que la chance. Une manche nulle se
// rejoue. À deux finalistes, un seul duel ; à plus (rare), un tableau à élimination directe
// (idée de l'utilisateur) : des duels l'un après l'autre, les autres regardent, jusqu'à la
// finale des deux derniers.

export type Gesture = 'rock' | 'paper' | 'scissors';
export const GESTURES: readonly Gesture[] = ['rock', 'paper', 'scissors'];
/** Ce que chaque geste bat. */
export const BEATS: Record<Gesture, Gesture> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};

/**
 * Les points pour gagner un duel : la finale en 3 (avec l'annonce, en 2 une seule manche la
 * décidait trop souvent), les duels d'avant en 2 (le tableau ne doit pas traîner).
 */
export const FINAL_POINTS = 3;
const EARLY_POINTS = 2;
/** Un duel s'annonce ce temps-là (« Demi-finale : A contre B ») avant sa première manche. */
export const CHIFOUMI_MATCH = 2.4;
/** Le temps d'annoncer, de lire les annonces, de choisir, puis le chi-fou-mi et la révélation. */
export const CHIFOUMI_ANNOUNCE = 4;
export const CHIFOUMI_READ = 1.6;
export const CHIFOUMI_CHOOSE = 5;
export const CHIFOUMI_SHAKE = 1.5;
export const CHIFOUMI_RESULT = 2.6;
/** Au-delà de tant de manches dans un duel (des nulles à la chaîne), le plus de points l'emporte. */
const MAX_ROUNDS = 15;
/** Dans le tableau : une place encore à jouer, et une place vide (un qualifié d'office en face). */
const PENDING = '';
const BYE = '-';

export type ChifoumiPhase = 'match' | 'announce' | 'read' | 'choose' | 'shake' | 'result';

/**
 * Le duel en cours : son tour dans le tableau (0 le premier) et sa place dans ce tour, les deux
 * finalistes qui s'affrontent, les points pour l'emporter, et le nombre de manches jouées.
 */
export type ChifoumiMatch = {
  round: number;
  slot: number;
  players: [PlayerId, PlayerId];
  target: number;
  rounds: number;
};

export type ChifoumiPlayer = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  points: number;
  /** Son annonce de la manche (cachée à l'autre jusqu'à la fin de l'annonce ; null : pas d'annonce). */
  announce: Gesture | null;
  /** Son geste (caché à l'autre jusqu'à la révélation). */
  gesture: Gesture | null;
  /** Il a validé son choix de cette étape. */
  locked: boolean;
  /**
   * Le geste qu'il montre aux flèches, avant de valider ; null tant qu'il n'a rien montré dans
   * cette étape (retour de test : un geste montré d'office passait pour déjà choisi).
   */
  cursor: number | null;
  stick: number;
  held: boolean;
};

export type ChifoumiRound = {
  index: number;
  phase: ChifoumiPhase;
  /** Le pas où l'étape en cours a commencé. */
  phaseAt: number;
  /** Une fois révélée : qui l'a gagnée (null : nulle), et combien de points (1, ou 2 avec l'annonce). */
  winner: PlayerId | null;
  gain: number;
};

export type ChifoumiState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: ChifoumiPlayer[];
  round: ChifoumiRound;
  /** Les manches finies : les gestes et annonces de chacun, et qui l'a gagnée. */
  history: {
    moves: Record<PlayerId, { announce: Gesture | null; gesture: Gesture }>;
    winner: PlayerId | null;
    gain: number;
  }[];
  /**
   * Le tableau : tour par tour, qui occupe chaque place (PENDING : à jouer ; BYE : personne). Le
   * dernier tour n'a qu'une place : le vainqueur.
   */
  bracket: string[][];
  match: ChifoumiMatch;
  /** Le tour où chaque perdant a été éliminé. */
  eliminated: Record<PlayerId, number>;
  /** Le vainqueur, une fois décidé. */
  winner: PlayerId | null;
};

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);
const PHASE_TIME: Record<ChifoumiPhase, number> = {
  match: CHIFOUMI_MATCH,
  announce: CHIFOUMI_ANNOUNCE,
  read: CHIFOUMI_READ,
  choose: CHIFOUMI_CHOOSE,
  shake: CHIFOUMI_SHAKE,
  result: CHIFOUMI_RESULT,
};

/** Le vainqueur d'un face-à-face de gestes : 1 si `a` gagne, -1 si `b` gagne, 0 si nul. */
export function duel(a: Gesture, b: Gesture): number {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

/** Les secondes qui restent dans l'étape en cours. */
export function phaseLeft(state: ChifoumiState): number {
  const { phase, phaseAt } = state.round;
  return Math.max(0, PHASE_TIME[phase] - (state.tick - phaseAt) * ARENA_STEP);
}

function freshPlayer(id: PlayerId): ChifoumiPlayer {
  return {
    id,
    fellAt: null,
    points: 0,
    announce: null,
    gesture: null,
    locked: false,
    cursor: null,
    stick: 0,
    held: false,
  };
}

/**
 * L'ordre des têtes de série sur le tableau (1 contre le dernier, 2 contre l'avant-dernier...),
 * pour que les qualifiés d'office soient les premiers et ne se croisent pas trop tôt.
 */
function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const width = order.length * 2;
    order = order.flatMap((seed) => [seed, width + 1 - seed]);
  }
  return order;
}

/** Le tableau de départ : les finalistes dans l'ordre reçu, des places vides pour compléter. */
function bracketOf(players: PlayerId[]): string[][] {
  let size = 2;
  while (size < players.length) size *= 2;
  const rounds = [seedOrder(size).map((seed) => players[seed - 1] ?? BYE)];
  for (let width = size / 2; width >= 1; width /= 2) rounds.push(Array(width).fill(PENDING));
  return rounds;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): ChifoumiState {
  const state: ChifoumiState = {
    tick: 0,
    practice,
    seed,
    fighters: players.map(freshPlayer),
    round: { index: 0, phase: 'match', phaseAt: 0, winner: null, gain: 0 },
    history: [],
    bracket: bracketOf(players),
    match: {
      round: 0,
      slot: 0,
      players: [players[0] ?? '', players[1] ?? ''],
      target: FINAL_POINTS,
      rounds: 0,
    },
    eliminated: {},
    winner: null,
  };
  nextMatch(state);
  return state;
}

/** Le dernier tour du tableau : la finale. */
export function isFinal(state: ChifoumiState, round = state.match.round): boolean {
  return round === state.bracket.length - 2;
}

/**
 * Le prochain duel du tableau : le premier dont les deux places sont connues. Un finaliste face à
 * une place vide passe tout seul au tour suivant. Plus de duel : le vainqueur est en haut.
 */
function nextMatch(state: ChifoumiState): void {
  const { bracket } = state;
  for (let round = 0; round < bracket.length - 1; round++) {
    const places = bracket[round] ?? [];
    const next = bracket[round + 1] ?? [];
    for (let slot = 0; slot < next.length; slot++) {
      const a = places[slot * 2] ?? BYE;
      const b = places[slot * 2 + 1] ?? BYE;
      if (next[slot] !== PENDING || a === PENDING || b === PENDING) continue;
      if (a === BYE || b === BYE) {
        next[slot] = a === BYE ? b : a;
        nextMatch(state);
        return;
      }
      state.match = {
        round,
        slot,
        players: [a, b],
        target: isFinal(state, round) ? FINAL_POINTS : EARLY_POINTS,
        rounds: 0,
      };
      for (const player of state.fighters) player.points = 0;
      return;
    }
  }
  state.winner = bracket.at(-1)?.[0] ?? null;
}

/** Ce joueur joue le duel en cours. */
export function isInMatch(state: ChifoumiState, player: PlayerId): boolean {
  return state.match.players.includes(player);
}

function step(state: ChifoumiState, inputs: Partial<Record<PlayerId, ArenaInput>>): ChifoumiState {
  const tick = state.tick + 1;
  const next: ChifoumiState = {
    ...state,
    tick,
    fighters: state.fighters.map((one) => ({ ...one })),
    round: { ...state.round },
  };
  if (next.winner !== null) return next;
  const { round } = next;
  const isPicking = round.phase === 'announce' || round.phase === 'choose';
  const duelists = next.fighters.filter((one) => isInMatch(next, one.id));
  for (const player of duelists) {
    const input = inputs[player.id] ?? (state.practice ? dummyInput(next, player.id) : IDLE_INPUT);
    if (isPicking && !player.locked) pick(player, input, round.phase === 'announce');
    player.stick = input.move.x;
    player.held = input.primary;
  }
  const isDue = (tick - round.phaseAt) * ARENA_STEP >= PHASE_TIME[round.phase];
  const allLocked = duelists.every((one) => one.locked);
  if (isDue || (isPicking && allLocked)) advance(next);
  return next;
}

/**
 * Choisir : les flèches gauche et droite font tourner les trois gestes, Action valide ; ou un
 * clic sur un geste (`target` 0 à 2), qui choisit et valide d'un coup.
 */
function pick(player: ChifoumiPlayer, input: ArenaInput, isAnnounce: boolean): void {
  let choice: number | null = null;
  if (input.target != null && input.target >= 0 && input.target < GESTURES.length) {
    player.cursor = input.target;
    choice = input.target;
  } else {
    // La première poussée montre le geste du bord : la pierre à gauche, les ciseaux à droite.
    const shown = player.cursor;
    if (input.move.x > 0.5 && player.stick <= 0.5)
      player.cursor = shown === null ? 2 : (shown + 1) % 3;
    if (input.move.x < -0.5 && player.stick >= -0.5)
      player.cursor = shown === null ? 0 : (shown + 2) % 3;
    if (input.primary && !player.held) choice = player.cursor;
  }
  if (choice === null) return;
  const gesture = GESTURES[choice] ?? 'rock';
  if (isAnnounce) player.announce = gesture;
  else player.gesture = gesture;
  player.locked = true;
}

/** L'étape suivante : les annonces dévoilées, le choix, le chi-fou-mi, la révélation, la manche suivante. */
function advance(state: ChifoumiState): void {
  const { round, tick } = state;
  const unlock = () => {
    for (const player of state.fighters) Object.assign(player, { locked: false, cursor: null });
  };
  /** Pas validé à temps : le geste qu'il montrait, s'il en montrait un. */
  const shown = (player: ChifoumiPlayer) =>
    player.cursor === null ? null : (GESTURES[player.cursor] ?? null);
  if (round.phase === 'match') {
    Object.assign(round, { phase: 'announce', phaseAt: tick });
  } else if (round.phase === 'announce') {
    // Ni validée ni montrée à temps : pas d'annonce (il ne pourra pas doubler).
    for (const player of state.fighters) if (!player.locked) player.announce = shown(player);
    Object.assign(round, { phase: 'read', phaseAt: tick });
    unlock();
  } else if (round.phase === 'read') {
    Object.assign(round, { phase: 'choose', phaseAt: tick });
  } else if (round.phase === 'choose') {
    // Ni validé ni montré à temps : un au hasard (02-mini-jeux.md, fiche 55).
    for (const [index, player] of state.fighters.entries()) {
      if (!isInMatch(state, player.id)) continue;
      player.gesture ??=
        shown(player) ??
        GESTURES[Math.floor(forestUnit(state.seed, round.index, 161 + index) * 3)] ??
        'rock';
      player.locked = true;
    }
    Object.assign(round, { phase: 'shake', phaseAt: tick });
  } else if (round.phase === 'shake') {
    reveal(state);
    Object.assign(round, { phase: 'result', phaseAt: tick });
  } else {
    nextRound(state);
  }
}

/** La révélation : qui gagne la manche, et combien (2 avec le geste annoncé). */
function reveal(state: ChifoumiState): void {
  const [first, second] = state.match.players;
  const a = state.fighters.find((one) => one.id === first);
  const b = state.fighters.find((one) => one.id === second);
  if (!a || !b) return;
  const result = duel(a.gesture ?? 'rock', b.gesture ?? 'rock');
  const winner = result > 0 ? a : result < 0 ? b : null;
  const gain = winner ? (winner.announce === winner.gesture ? 2 : 1) : 0;
  if (winner) winner.points += gain;
  state.round.winner = winner?.id ?? null;
  state.round.gain = gain;
}

function nextRound(state: ChifoumiState): void {
  const { round, match } = state;
  const duelists = state.fighters.filter((one) => isInMatch(state, one.id));
  state.history = [
    ...state.history,
    {
      moves: Object.fromEntries(
        duelists.map((one) => [one.id, { announce: one.announce, gesture: one.gesture ?? 'rock' }]),
      ),
      winner: round.winner,
      gain: round.gain,
    },
  ];
  match.rounds += 1;
  for (const player of state.fighters) {
    Object.assign(player, { announce: null, gesture: null, locked: false, cursor: null });
  }
  const next = {
    index: round.index + 1,
    phase: 'announce',
    phaseAt: state.tick,
    winner: null,
    gain: 0,
  } as const;
  state.round = { ...next };
  const leader = duelists.find((one) => one.points >= match.target);
  // Des nulles à la chaîne : le plus de points l'emporte (à égalité, le premier du duel).
  const isTooLong = match.rounds >= MAX_ROUNDS;
  if (!leader && !isTooLong) return;
  // Au bac à sable, le duel recommence à zéro une fois gagné.
  if (state.practice) {
    for (const player of state.fighters) player.points = 0;
    return;
  }
  const [a, b] = duelists;
  const winner = leader ?? (a && b && b.points > a.points ? b : a);
  if (!winner) return;
  const loser = match.players.find((id) => id !== winner.id) ?? '';
  const place = state.bracket[match.round + 1];
  if (place) place[match.slot] = winner.id;
  state.eliminated = { ...state.eliminated, [loser]: match.round };
  nextMatch(state);
  if (state.winner === null) state.round = { ...next, phase: 'match' };
}

/** Au bac à sable, le mannequin d'en face joue au hasard, sans traîner. */
function dummyInput(state: ChifoumiState, player: PlayerId): ArenaInput {
  const { round, tick } = state;
  const isPicking = round.phase === 'announce' || round.phase === 'choose';
  if (!isPicking || tick < round.phaseAt + toTick(1.2)) return IDLE_INPUT;
  const salt = round.phase === 'announce' ? 171 : 172;
  const target = Math.floor(forestUnit(state.seed, round.index, salt + player.length) * 3);
  return { move: { x: 0, z: 0 }, primary: false, secondary: false, target };
}

function isOver(state: ChifoumiState): boolean {
  return !state.practice && state.winner !== null;
}

/** Le classement : le vainqueur, puis les éliminés, du dernier tour au premier (ex aequo par tour). */
function ranking(state: ChifoumiState): PlayerId[][] {
  const ids = state.fighters.map((one) => one.id);
  if (!state.winner) return [ids];
  const rounds = [...new Set(Object.values(state.eliminated))].sort((x, y) => y - x);
  return [
    [state.winner],
    ...rounds.map((round) => ids.filter((id) => state.eliminated[id] === round)),
  ];
}

/**
 * Les choix cachés : l'annonce de l'autre n'est montrée qu'une fois l'annonce finie ; son geste,
 * qu'à la révélation. Chacun voit les siens. Un spectateur ne voit rien avant les autres.
 */
function viewFor(state: ChifoumiState, viewer: Viewer): ChifoumiState {
  const { phase } = state.round;
  const id = viewer.type === 'player' ? viewer.playerId : null;
  const hidesAnnounce = phase === 'announce';
  const hidesGesture =
    phase === 'announce' || phase === 'read' || phase === 'choose' || phase === 'shake';
  return {
    ...state,
    fighters: state.fighters.map((one) =>
      one.id === id
        ? one
        : {
            ...one,
            announce: hidesAnnounce ? null : one.announce,
            gesture: hidesGesture ? null : one.gesture,
          },
    ),
  };
}

/**
 * Les bots, selon leur niveau : la part des fois où ils annoncent leur vrai geste, et comment ils
 * lisent l'autre (la part des fois où ils croient son annonce, ou son habitude de mentir, plutôt
 * que de jouer au hasard). Le Facile joue au hasard ; l'Expert retient si l'autre ment.
 */
const BOT: Record<BotLevel, { honest: number; read: number }> = {
  easy: { honest: 0.33, read: 0 },
  normal: { honest: 0.5, read: 0.45 },
  expert: { honest: 0.5, read: 0.75 },
};
/** Un bot choisit au bout de tant de secondes (tiré entre ces bornes). */
const BOT_THINK: readonly [number, number] = [0.8, 2.6];

/** Un nombre propre à chaque joueur, pour varier les tirages d'un joueur à l'autre. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

/** Le geste qui bat celui-ci. */
function counter(gesture: Gesture): Gesture {
  return GESTURES.find((one) => BEATS[one] === gesture) ?? 'rock';
}

function botInput(state: ChifoumiState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const { round, tick } = state;
  const me = state.fighters.find((one) => one.id === player);
  const rival = state.match.players.find((id) => id !== player);
  const other = isInMatch(state, player) ? state.fighters.find((one) => one.id === rival) : null;
  const isPicking = round.phase === 'announce' || round.phase === 'choose';
  if (!me || !other || !isPicking || me.locked || state.winner !== null) return IDLE_INPUT;
  const unit = (salt: number) => forestUnit(state.seed, round.index, salt + saltOf(player));
  const think = BOT_THINK[0] + (BOT_THINK[1] - BOT_THINK[0]) * unit(181);
  if (tick < round.phaseAt + toTick(think)) return IDLE_INPUT;
  const bot = BOT[level];
  // Le geste qu'il jouera cette manche (tiré dès l'annonce, pour pouvoir l'annoncer ou mentir).
  const planned = plannedGesture(state, me, other, level, unit);
  if (round.phase === 'announce') {
    const isHonest = unit(182) < bot.honest;
    const lie = GESTURES.filter((one) => one !== planned)[unit(183) < 0.5 ? 0 : 1] ?? planned;
    return choice(isHonest ? planned : lie);
  }
  return choice(planned);
}

function choice(gesture: Gesture): ArenaInput {
  return {
    move: { x: 0, z: 0 },
    primary: false,
    secondary: false,
    target: GESTURES.indexOf(gesture),
  };
}

/**
 * Son geste de la manche. Sans lecture : au hasard. Avec : il devine le geste de l'autre (son
 * annonce s'il la croit, sinon autre chose), et joue ce qui le bat. L'Expert croit l'annonce
 * selon que l'autre a dit vrai ou non jusqu'ici.
 */
function plannedGesture(
  state: ChifoumiState,
  me: ChifoumiPlayer,
  other: ChifoumiPlayer,
  level: BotLevel,
  unit: (salt: number) => number,
): Gesture {
  const random = GESTURES[Math.floor(unit(184) * 3)] ?? 'rock';
  const bot = BOT[level];
  // Pendant l'annonce, l'annonce de l'autre n'est pas encore connue : il prévoit au hasard.
  if (state.round.phase === 'announce' || other.announce === null || unit(185) >= bot.read) {
    return me.announce && state.round.phase === 'choose'
      ? keepOrSwitch(me.announce, random, unit)
      : random;
  }
  const said = other.announce;
  const told = state.history.filter((one) => one.moves[other.id]?.announce != null);
  const truths = told.filter(
    (one) => one.moves[other.id]?.announce === one.moves[other.id]?.gesture,
  );
  const truthRate = level === 'expert' && told.length > 0 ? truths.length / told.length : 0.4;
  const guess =
    unit(186) < truthRate
      ? said
      : (GESTURES.filter((one) => one !== said)[unit(187) < 0.5 ? 0 : 1] ?? said);
  return counter(guess);
}

/** Sans lecture, il joue souvent ce qu'il a annoncé (pour doubler), sinon au hasard. */
function keepOrSwitch(
  announced: Gesture,
  random: Gesture,
  unit: (salt: number) => number,
): Gesture {
  return unit(188) < 0.5 ? announced : random;
}

export const CHIFOUMI: ArenaGame<ChifoumiState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
  viewFor,
};
