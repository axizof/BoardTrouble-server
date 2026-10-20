import type { Board } from '../board/board';
import { bonusDieForRank, breakTies, rollDice } from '../dice/dice';
import { Rng } from '../random/rng';
import { type Context, getPlayer } from './context';
import { moveWithDice, testGate } from './movement';
import type {
  Actor,
  ApplyResult,
  GameConfig,
  GameEvent,
  GameState,
  Intent,
  IntentError,
  PlayerId,
} from './types';

/**
 * Crée une partie et joue le tirage de l'ordre. La première manche n'a pas de mini-jeu :
 * elle se joue dans l'ordre du tirage, sans dé bonus, pour lancer la partie tout de suite.
 */
export function createGame(
  board: Board,
  config: GameConfig,
): { state: GameState; events: GameEvent[] } {
  const ids = config.players.map((player) => player.id);
  if (ids.length !== config.tableSize) {
    throw new Error(`Il faut ${config.tableSize} joueurs (bots compris), reçu ${ids.length}`);
  }
  if (new Set(ids).size !== ids.length) throw new Error('Identifiants de joueurs en double');

  const rng = new Rng(config.seed);
  const rolls = ids.map((playerId) => ({ playerId, value: rng.int(1, 6) }));
  const groups = [6, 5, 4, 3, 2, 1]
    .map((value) => rolls.filter((roll) => roll.value === value).map((roll) => roll.playerId))
    .filter((group) => group.length > 0);
  const { order, tieBreaks } = breakTies(groups, rng);

  const state: GameState = {
    version: 1,
    boardId: board.definition.id,
    tableSize: config.tableSize,
    players: config.players.map(({ id, name }) => ({
      id,
      name,
      position: board.definition.start,
      atGate: false,
      trail: [],
      gateFailures: {},
    })),
    round: 1,
    turnOrder: order,
    turnIndex: 0,
    bonusDice: Object.fromEntries(ids.map((id) => [id, null])),
    finalGateOpenedBy: [],
    phase: { type: 'minigame' },
    rngState: 0,
  };
  const ctx: Context = { board, state, rng, events: [], coinFlipUsed: false };
  ctx.events.push({ type: 'orderDrawn', rolls, tieBreaks, order });
  ctx.events.push({ type: 'roundStarted', round: 1 });
  startTurn(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/**
 * Applique une intention. Fonction pure : l'état reçu n'est jamais modifié. Une intention
 * invalide (pas ton tour, mauvais moment, choix impossible) est refusée sans effet.
 */
export function applyIntent(
  board: Board,
  state: GameState,
  actor: Actor,
  intent: Intent,
): ApplyResult {
  const error = checkIntent(state, actor, intent);
  if (error) return { ok: false, error };

  const draft = structuredClone(state);
  const ctx: Context = {
    board,
    state: draft,
    rng: new Rng(draft.rngState),
    events: [],
    coinFlipUsed: false,
  };

  switch (intent.type) {
    case 'submitMinigameResult':
      startRound(ctx, intent.ranking);
      break;
    case 'submitFinaleResult':
      finishFinale(ctx, intent.ranking);
      break;
    case 'roll':
      roll(ctx);
      break;
    case 'chooseBranch':
      continueAfterBranch(ctx, intent.spaceId);
      break;
  }

  draft.rngState = ctx.rng.state;
  return { ok: true, state: draft, events: ctx.events };
}

function checkIntent(state: GameState, actor: Actor, intent: Intent): IntentError | null {
  const { phase } = state;
  switch (intent.type) {
    case 'submitMinigameResult':
      if (actor.type !== 'system') return 'notAllowed';
      if (phase.type !== 'minigame') return 'wrongPhase';
      return isCompleteRanking(
        intent.ranking,
        state.players.map((player) => player.id),
      )
        ? null
        : 'invalidRanking';
    case 'submitFinaleResult':
      if (actor.type !== 'system') return 'notAllowed';
      if (phase.type !== 'finale') return 'wrongPhase';
      return isCompleteRanking(intent.ranking, phase.contenders) ? null : 'invalidRanking';
    case 'roll':
    case 'chooseBranch': {
      if (actor.type !== 'player') return 'notAllowed';
      if (phase.type !== 'turn') return 'wrongPhase';
      if (phase.playerId !== actor.playerId) return 'notYourTurn';
      if (intent.type === 'roll') return phase.step.type === 'awaitRoll' ? null : 'wrongPhase';
      if (phase.step.type !== 'awaitBranch') return 'wrongPhase';
      return phase.step.options.includes(intent.spaceId) ? null : 'invalidChoice';
    }
  }
}

/** Chaque joueur attendu apparaît exactement une fois. */
function isCompleteRanking(ranking: PlayerId[][], expected: PlayerId[]): boolean {
  const ranked = ranking.flat();
  return (
    ranking.every((group) => group.length > 0) &&
    ranked.length === expected.length &&
    new Set(ranked).size === ranked.length &&
    expected.every((id) => ranked.includes(id))
  );
}

function startRound(ctx: Context, ranking: PlayerId[][]): void {
  const { state } = ctx;
  const { order, tieBreaks } = breakTies(ranking, ctx.rng);
  state.turnOrder = order;
  state.turnIndex = 0;
  state.finalGateOpenedBy = [];
  state.bonusDice = Object.fromEntries(
    order.map((id, rank) => [id, bonusDieForRank(rank, state.tableSize)]),
  );
  ctx.events.push({ type: 'roundStarted', round: state.round });
  ctx.events.push({ type: 'minigameRanked', order, tieBreaks, bonusDice: { ...state.bonusDice } });
  startTurn(ctx);
}

function startTurn(ctx: Context): void {
  const playerId = ctx.state.turnOrder[ctx.state.turnIndex];
  if (playerId === undefined) throw new Error('Aucun joueur pour ce tour');
  ctx.state.phase = { type: 'turn', playerId, step: { type: 'awaitRoll' } };
  ctx.events.push({ type: 'turnStarted', playerId });
}

function roll(ctx: Context): void {
  const player = getPlayer(ctx.state, currentPlayerId(ctx));
  const dice = rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null);

  // Un joueur arrêté devant une porte utilise son lancer pour la tenter ; s'il la passe,
  // il avance du même total au-delà de la porte.
  if (player.atGate) {
    ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'gate', roll: dice });
    if (testGate(ctx, player, dice.total) !== 'passed') {
      endTurn(ctx);
      return;
    }
  } else {
    ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'move', roll: dice });
  }
  if (moveWithDice(ctx, player, dice.total) === 'turnOver') endTurn(ctx);
}

function continueAfterBranch(ctx: Context, spaceId: string): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || phase.step.type !== 'awaitBranch')
    throw new Error("Pas d'embranchement en attente");
  const player = getPlayer(ctx.state, phase.playerId);
  if (moveWithDice(ctx, player, phase.step.remaining, spaceId) === 'turnOver') endTurn(ctx);
}

function endTurn(ctx: Context): void {
  const { state } = ctx;
  ctx.events.push({ type: 'turnEnded', playerId: currentPlayerId(ctx) });
  state.turnIndex++;
  if (state.turnIndex < state.turnOrder.length) startTurn(ctx);
  else endRound(ctx);
}

/**
 * Fin de manche : la victoire se décide ici. Un seul joueur a ouvert la porte finale : il
 * gagne. Plusieurs : finale en mini-jeu. Personne : nouvelle manche.
 */
function endRound(ctx: Context): void {
  const { state } = ctx;
  ctx.events.push({ type: 'roundEnded', round: state.round });
  const openers = state.finalGateOpenedBy;

  const [onlyOpener] = openers;
  if (openers.length === 1 && onlyOpener !== undefined) {
    finish(ctx, onlyOpener);
    return;
  }
  if (openers.length > 1) {
    state.phase = { type: 'finale', contenders: [...openers] };
    ctx.events.push({ type: 'finaleStarted', contenders: [...openers] });
    return;
  }
  state.round++;
  state.phase = { type: 'minigame' };
}

function finishFinale(ctx: Context, ranking: PlayerId[][]): void {
  const [winner] = breakTies(ranking, ctx.rng).order;
  if (winner === undefined) throw new Error('Finale sans vainqueur');
  finish(ctx, winner);
}

function finish(ctx: Context, winner: PlayerId): void {
  ctx.state.phase = { type: 'finished', winner };
  ctx.events.push({ type: 'gameWon', playerId: winner });
}

function currentPlayerId(ctx: Context): PlayerId {
  const { phase } = ctx.state;
  if (phase.type !== 'turn') throw new Error('Pas de tour en cours');
  return phase.playerId;
}
