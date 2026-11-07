import { type Board, distanceToGoal } from '../board/board';
import { progressRanking } from '../game/progress';
import type { Actor, GameEvent, GameState, PlayerId } from '../game/types';

// La chronique d'une partie (01-vision-et-plateau.md, section 18) : ce que le récap montrera à la
// fin. La session la tient à jour après chaque action, à partir de l'état avant et après, et la
// garde dans la sauvegarde. Fonctions pures : testées sans session.

/** Les moments forts, marqués sur le graphe de la partie. */
export type MomentKind = 'fall' | 'swap' | 'trouble' | 'duel' | 'jail';

/** `playerId` : à qui c'est arrivé (le gagnant d'un duel, celui qui a choisi le TROUBLE). */
export type ChronicleMoment = { round: number; kind: MomentKind; playerId: PlayerId | null };

/** Ce qu'a fait un joueur pendant la partie. */
export type PlayerChronicle = {
  /** Cases parcourues depuis le départ, et place, au départ puis à la fin de chaque manche. */
  progress: number[];
  ranks: number[];
  minigamesPlayed: number;
  /** Mini-jeux de manche et bonus gagnés, 1 contre tous gagnés seul, finale gagnée. */
  minigamesWon: number;
  /** Somme des places aux mini-jeux de manche (1 pour le premier), pour la place moyenne. */
  minigamePlaces: number;
  duelsPlayed: number;
  duelsWon: number;
  rolls: number;
  rollTotal: number;
  doubles: number;
  itemsGained: number;
  itemsUsed: number;
  /** Cases gagnées, et perdues par malchance ou à cause d'un autre joueur. */
  spacesGained: number;
  spacesLostToLuck: number;
  spacesLostToOthers: number;
  /** Cases que ce joueur a fait perdre aux autres. */
  spacesInflicted: number;
  biggestJump: number;
  biggestFall: number;
  jailStays: number;
  swapsAndThefts: number;
  troublesChosen: number;
};

export type GameChronicle = {
  players: Record<PlayerId, PlayerChronicle>;
  moments: ChronicleMoment[];
};

/** Ce qui fait reculer un joueur par la main d'un autre (le joueur du tour, ou le gagnant du duel). */
const HOSTILE = new Set<GameEvent['type']>([
  'targetChosen',
  'swapped',
  'jostled',
  'squallHit',
  'duelEnded',
  'itemUsed',
]);

export function startChronicle(board: Board, state: GameState): GameChronicle {
  const ranking = progressRanking(board, state);
  const players = Object.fromEntries(
    state.players.map((player): [PlayerId, PlayerChronicle] => [
      player.id,
      {
        progress: [progressOf(board, state, player.id)],
        ranks: [ranking.indexOf(player.id) + 1],
        minigamesPlayed: 0,
        minigamesWon: 0,
        minigamePlaces: 0,
        duelsPlayed: 0,
        duelsWon: 0,
        rolls: 0,
        rollTotal: 0,
        doubles: 0,
        itemsGained: 0,
        itemsUsed: 0,
        spacesGained: 0,
        spacesLostToLuck: 0,
        spacesLostToOthers: 0,
        spacesInflicted: 0,
        biggestJump: 0,
        biggestFall: 0,
        jailStays: 0,
        swapsAndThefts: 0,
        troublesChosen: 0,
      },
    ]),
  );
  return { players, moments: [] };
}

/** La chronique après une action : `before` et `after` sont les états autour de ses `events`. */
export function recordAction(
  chronicle: GameChronicle,
  board: Board,
  actor: Actor,
  before: GameState,
  after: GameState,
  events: GameEvent[],
): GameChronicle {
  const next: GameChronicle = structuredClone(chronicle);
  const round = before.round;
  const turnPlayer =
    actor.type === 'player'
      ? actor.playerId
      : before.phase.type === 'turn'
        ? before.phase.playerId
        : null;
  const isTrouble = events.some((event) => event.type === 'troubleApplied');
  const isFinale = before.phase.type === 'finale';
  const of = (id: PlayerId) => next.players[id];
  for (const event of events) recordEvent(next, event, { round, turnPlayer, isTrouble, isFinale });
  recordMoves(next, board, before, after, events, turnPlayer);
  if (events.some((event) => event.type === 'roundEnded')) {
    const ranking = progressRanking(board, after);
    for (const player of after.players) {
      const mine = of(player.id);
      if (!mine) continue;
      mine.progress.push(progressOf(board, after, player.id));
      mine.ranks.push(ranking.indexOf(player.id) + 1);
    }
  }
  return next;
}

function recordEvent(
  chronicle: GameChronicle,
  event: GameEvent,
  context: { round: number; turnPlayer: PlayerId | null; isTrouble: boolean; isFinale: boolean },
): void {
  const { round, turnPlayer, isTrouble, isFinale } = context;
  const of = (id: PlayerId) => chronicle.players[id];
  const moment = (kind: MomentKind, playerId: PlayerId | null) =>
    chronicle.moments.push({ round, kind, playerId });
  switch (event.type) {
    case 'diceRolled': {
      const mine = of(event.playerId);
      if (!mine || event.purpose !== 'move' || event.roll.trapped) return;
      mine.rolls += 1;
      mine.rollTotal += event.roll.total;
      if (event.roll.extra !== null) mine.doubles += 1;
      return;
    }
    case 'minigameRanked':
      event.order.forEach((id, index) => {
        const mine = of(id);
        if (!mine) return;
        mine.minigamesPlayed += 1;
        mine.minigamePlaces += index + 1;
        if (index === 0) mine.minigamesWon += 1;
      });
      return;
    case 'oneVsAllEnded': {
      const mine = of(event.solo);
      if (mine && event.soloWon) mine.minigamesWon += 1;
      return;
    }
    case 'duelStarted':
      for (const id of [event.challenger, event.opponent]) {
        const mine = of(id);
        if (mine) mine.duelsPlayed += 1;
      }
      return;
    case 'duelEnded': {
      const mine = event.winner === null ? undefined : of(event.winner);
      if (mine) mine.duelsWon += 1;
      moment('duel', event.winner);
      return;
    }
    case 'gameWon': {
      // Gagner la finale compte comme un mini-jeu gagné (pas la porte finale franchie seul).
      const mine = of(event.playerId);
      if (mine && isFinale) mine.minigamesWon += 1;
      return;
    }
    case 'itemGained': {
      const mine = of(event.playerId);
      if (mine) mine.itemsGained += 1;
      return;
    }
    case 'itemUsed': {
      const mine = of(event.playerId);
      if (mine) mine.itemsUsed += 1;
      return;
    }
    case 'itemStolen': {
      const mine = of(event.playerId);
      if (mine) mine.swapsAndThefts += 1;
      return;
    }
    case 'swapped': {
      // Un échange voulu (la case Échange), pas le Grand Échange du Plateau.
      const mine = of(event.playerId);
      if (mine && !isTrouble && event.playerId === turnPlayer) mine.swapsAndThefts += 1;
      moment('swap', event.playerId);
      return;
    }
    case 'kidnapped': {
      const mine = of(event.playerId);
      if (mine) mine.jailStays += 1;
      moment('jail', event.playerId);
      return;
    }
    case 'fell':
      moment('fall', event.playerId);
      return;
    case 'troubleApplied': {
      const mine = event.chooser === null ? undefined : of(event.chooser);
      if (mine) mine.troublesChosen += 1;
      moment('trouble', event.chooser);
      return;
    }
    default:
      return;
  }
}

/**
 * Qui a gagné ou perdu des cases pendant l'action. Un recul vient d'un autre joueur si l'action
 * en contient un effet hostile (le gagnant d'un duel, sinon le joueur du tour) ; sinon, c'est
 * la malchance (case, chute, coup de vent, TROUBLE).
 */
function recordMoves(
  chronicle: GameChronicle,
  board: Board,
  before: GameState,
  after: GameState,
  events: GameEvent[],
  turnPlayer: PlayerId | null,
): void {
  const duel = events.find((event) => event.type === 'duelEnded');
  const attacker = duel?.type === 'duelEnded' && duel.winner !== null ? duel.winner : turnPlayer;
  const isHostile =
    !events.some((event) => event.type === 'troubleApplied') &&
    events.some((event) => HOSTILE.has(event.type));
  const fallen = new Set(
    events.flatMap((event) => (event.type === 'fell' ? [event.playerId] : [])),
  );
  for (const player of after.players) {
    const mine = chronicle.players[player.id];
    if (!mine) continue;
    const change = progressOf(board, after, player.id) - progressOf(board, before, player.id);
    if (change > 0) {
      mine.spacesGained += change;
      mine.biggestJump = Math.max(mine.biggestJump, change);
      continue;
    }
    if (change === 0) continue;
    const lost = -change;
    if (fallen.has(player.id)) mine.biggestFall = Math.max(mine.biggestFall, lost);
    const by = isHostile && attacker !== null && attacker !== player.id ? attacker : null;
    const culprit = by === null ? undefined : chronicle.players[by];
    if (!culprit) {
      mine.spacesLostToLuck += lost;
      continue;
    }
    mine.spacesLostToOthers += lost;
    culprit.spacesInflicted += lost;
  }
}

/** Cases parcourues depuis le départ (le chemin le plus court restant, comparé à celui du départ). */
function progressOf(board: Board, state: GameState, id: PlayerId): number {
  const player = state.players.find((candidate) => candidate.id === id);
  if (!player) return 0;
  const start = distanceToGoal(board, board.definition.start);
  return Math.max(0, start - distanceToGoal(board, player.position));
}
