import type { Board } from '../board/board';
import { bonusDieForRank, breakTies, type DiceRoll, rollDice } from '../dice/dice';
import { itemUseError, useItem } from '../items/useItem';
import { Rng } from '../random/rng';
import { type Context, type Flow, getPlayer, removeItem } from './context';
import { openChest } from './effects';
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
  PlayerState,
  Resume,
  TurnModifiers,
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
      inventory: [],
      mirrorArmed: false,
    })),
    round: 1,
    turnOrder: order,
    turnIndex: 0,
    bonusDice: Object.fromEntries(ids.map((id) => [id, null])),
    turn: freshTurn(),
    traps: {},
    finalGateOpenedBy: [],
    phase: { type: 'minigame' },
    rngState: 0,
  };
  const ctx: Context = { board, state, rng, events: [], resume: 'endTurn' };
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
  const error = checkIntent(board, state, actor, intent);
  if (error) return { ok: false, error };

  const draft = structuredClone(state);
  const ctx: Context = {
    board,
    state: draft,
    rng: new Rng(draft.rngState),
    events: [],
    resume: 'endTurn',
  };

  switch (intent.type) {
    case 'submitMinigameResult':
      startRound(ctx, intent.ranking);
      break;
    case 'submitFinaleResult':
      finishFinale(ctx, intent.ranking);
      break;
    case 'useItem':
      // Une pause pendant l'objet (coffre atteint par la Fusée...) ramène ensuite au lancer.
      ctx.resume = 'roll';
      afterAction(ctx, useItem(ctx, activePlayer(ctx), intent.item, intent.target), 'roll');
      break;
    case 'roll':
      roll(ctx);
      break;
    case 'keepRoll':
    case 'reroll':
      resolveReroll(ctx, intent.type === 'reroll');
      break;
    case 'chooseBranch':
      continueAfterBranch(ctx, intent.spaceId);
      break;
    case 'chooseChest':
      resolvePause(ctx, (player) => openChest(ctx, player, intent.chest));
      break;
    case 'resolveItemSwap':
      resolvePause(ctx, (player) => swapItem(ctx, player, intent.discard));
      break;
  }

  draft.rngState = ctx.rng.state;
  return { ok: true, state: draft, events: ctx.events };
}

function checkIntent(
  board: Board,
  state: GameState,
  actor: Actor,
  intent: Intent,
): IntentError | null {
  const { phase } = state;
  if (intent.type === 'submitMinigameResult' || intent.type === 'submitFinaleResult') {
    if (actor.type !== 'system') return 'notAllowed';
    if (intent.type === 'submitMinigameResult') {
      if (phase.type !== 'minigame') return 'wrongPhase';
      const everyone = state.players.map((player) => player.id);
      return isCompleteRanking(intent.ranking, everyone) ? null : 'invalidRanking';
    }
    if (phase.type !== 'finale') return 'wrongPhase';
    return isCompleteRanking(intent.ranking, phase.contenders) ? null : 'invalidRanking';
  }

  if (actor.type !== 'player') return 'notAllowed';
  if (phase.type !== 'turn') return 'wrongPhase';
  if (phase.playerId !== actor.playerId) return 'notYourTurn';
  const { step } = phase;

  switch (intent.type) {
    case 'useItem':
      if (step.type !== 'awaitRoll') return 'wrongPhase';
      return itemUseError(board, state, actor.playerId, intent.item, intent.target);
    case 'roll':
      return step.type === 'awaitRoll' ? null : 'wrongPhase';
    case 'keepRoll':
    case 'reroll':
      return step.type === 'awaitRerollChoice' ? null : 'wrongPhase';
    case 'chooseBranch':
      if (step.type !== 'awaitBranch') return 'wrongPhase';
      return step.options.includes(intent.spaceId) ? null : 'invalidChoice';
    case 'chooseChest':
      if (step.type !== 'awaitChest') return 'wrongPhase';
      return intent.chest === 0 || intent.chest === 1 ? null : 'invalidChoice';
    case 'resolveItemSwap': {
      if (step.type !== 'awaitItemSwap') return 'wrongPhase';
      const player = getPlayer(state, actor.playerId);
      const known = intent.discard === step.offered || player.inventory.includes(intent.discard);
      return known ? null : 'invalidChoice';
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
  ctx.state.turn = freshTurn();
  ctx.state.phase = { type: 'turn', playerId, step: { type: 'awaitRoll' } };
  ctx.events.push({ type: 'turnStarted', playerId });

  // Le Miroir reste actif une manche complète : il expire au début du tour suivant de son
  // propriétaire, en secret comme il a été activé.
  const player = getPlayer(ctx.state, playerId);
  if (player.mirrorArmed) {
    removeItem(player, 'mirror');
    ctx.events.push({ type: 'mirrorExpired', playerId });
  }
}

function freshTurn(): TurnModifiers {
  return {
    itemUsed: false,
    extraDie: false,
    rerollArmed: false,
    shortNormalDie: false,
    coinFlipped: [],
  };
}

function roll(ctx: Context): void {
  const player = activePlayer(ctx);
  const dice = rollForTurn(ctx, player);
  ctx.events.push({
    type: 'diceRolled',
    playerId: player.id,
    purpose: purposeOf(player),
    roll: dice,
  });
  if (ctx.state.turn.rerollArmed) {
    ctx.state.phase = {
      type: 'turn',
      playerId: player.id,
      step: { type: 'awaitRerollChoice', roll: dice },
    };
    return;
  }
  playRoll(ctx, player, dice);
}

function resolveReroll(ctx: Context, reroll: boolean): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || phase.step.type !== 'awaitRerollChoice') {
    throw new Error('Pas de relance en attente');
  }
  const player = activePlayer(ctx);
  const previous = phase.step.roll;
  if (!reroll) {
    playRoll(ctx, player, previous);
    return;
  }
  const dice = rollForTurn(ctx, player);
  ctx.events.push({ type: 'rerolled', playerId: player.id, previous, roll: dice });
  playRoll(ctx, player, dice);
}

function rollForTurn(ctx: Context, player: PlayerState): DiceRoll {
  const { turn } = ctx.state;
  return rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null, {
    normalFaces: turn.shortNormalDie ? 4 : 6,
    turbo: turn.extraDie,
  });
}

function purposeOf(player: PlayerState): 'move' | 'gate' {
  return player.atGate ? 'gate' : 'move';
}

/**
 * Joue un lancer. Un joueur arrêté devant une porte l'utilise pour la tenter ; s'il la
 * passe, il avance du même total au-delà de la porte.
 */
function playRoll(ctx: Context, player: PlayerState, dice: DiceRoll): void {
  if (player.atGate && testGate(ctx, player, () => dice.total) !== 'passed') {
    endTurn(ctx);
    return;
  }
  afterAction(ctx, moveWithDice(ctx, player, dice.total), 'endTurn');
}

function continueAfterBranch(ctx: Context, spaceId: string): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || phase.step.type !== 'awaitBranch') {
    throw new Error("Pas d'embranchement en attente");
  }
  const player = activePlayer(ctx);
  afterAction(ctx, moveWithDice(ctx, player, phase.step.remaining, spaceId), 'endTurn');
}

/** Reprend après une pause (coffre, inventaire plein), là où elle s'était arrêtée. */
function resolvePause(ctx: Context, resolve: (player: PlayerState) => Flow): void {
  const { phase } = ctx.state;
  if (
    phase.type !== 'turn' ||
    (phase.step.type !== 'awaitChest' && phase.step.type !== 'awaitItemSwap')
  ) {
    throw new Error('Pas de choix en attente');
  }
  const { resume } = phase.step;
  ctx.resume = resume;
  afterAction(ctx, resolve(activePlayer(ctx)), resume);
}

/** Inventaire plein : jette `discard` pour prendre l'objet proposé, ou refuse ce dernier. */
function swapItem(ctx: Context, player: PlayerState, discard: string): Flow {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || phase.step.type !== 'awaitItemSwap') {
    throw new Error("Pas d'échange d'objet en attente");
  }
  const { offered, source } = phase.step;
  if (discard === offered) {
    ctx.events.push({ type: 'itemRefused', playerId: player.id, item: offered });
    return 'continue';
  }
  const dropped = player.inventory.find((item) => item === discard);
  if (dropped === undefined) throw new Error(`Objet absent : ${discard}`);
  removeItem(player, dropped);
  player.inventory.push(offered);
  ctx.events.push({ type: 'itemDiscarded', playerId: player.id, item: dropped });
  ctx.events.push({ type: 'itemGained', playerId: player.id, item: offered, source });
  return 'continue';
}

/**
 * Suite d'une action : si le moteur attend un choix, on s'arrête là ; sinon on revient au
 * lancer (après un objet) ou on finit le tour.
 */
function afterAction(ctx: Context, flow: Flow, then: Resume): void {
  if (flow === 'paused' || ctx.state.phase.type !== 'turn') return;
  if (then === 'roll') {
    ctx.state.phase = { type: 'turn', playerId: activePlayer(ctx).id, step: { type: 'awaitRoll' } };
    return;
  }
  endTurn(ctx);
}

function endTurn(ctx: Context): void {
  const { state } = ctx;
  ctx.events.push({ type: 'turnEnded', playerId: activePlayer(ctx).id });
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

function activePlayer(ctx: Context): PlayerState {
  const { phase } = ctx.state;
  if (phase.type !== 'turn') throw new Error('Pas de tour en cours');
  return getPlayer(ctx.state, phase.playerId);
}
