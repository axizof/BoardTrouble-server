import { type Board, distanceToGoal } from '../board/board';
import {
  bonusDieForRank,
  breakTies,
  type DiceRoll,
  rollDice,
  SPECIAL_DICE,
  type SpecialDieKind,
} from '../dice/dice';
import { resolveDuel, resolveOneVsAll, resolveTarget } from '../interactions/interactions';
import { drawItem, type ItemId } from '../items/catalog';
import { itemUseError, useItem } from '../items/useItem';
import { advanceInJail, openTrapdoor, spinWheel, startJailTurn } from '../jail/jail';
import { Rng } from '../random/rng';
import {
  applyTrouble,
  drawSpaceEvent,
  drawTroubleOptions,
  rewardBonusMinigame,
  type TroubleEventId,
  troubleRanking,
} from '../trouble/events';
import {
  addGauge,
  DOUBLE_GAIN,
  GAP_GAIN,
  GAP_THRESHOLD,
  GAUGE_MAX,
  ROUND_GAIN,
} from '../trouble/gauge';
import { type Context, type Flow, getPlayer, removeItem } from './context';
import { advanceByEffect, gainItem, gainSpecialDie, openChest, recoil } from './effects';
import { attemptGate, chooseDoor, payToll, resolveSkillGate } from './gates';
import { moveWithDice } from './movement';
import { applyWheelSegment, MAX_BET, placeBet, settleBets } from './spaces';
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
  TurnStep,
} from './types';

const ROUND_EVENT_CHANCE = 0.15;
const BIRD_STEPS = 3;
const HOLE_STEPS = 2;

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
      lastAttack: null,
      jail: null,
      specialDice: [],
    })),
    round: 1,
    turnOrder: order,
    turnIndex: 0,
    bonusDice: Object.fromEntries(ids.map((id) => [id, null])),
    turn: freshTurn(),
    traps: {},
    trouble: { gauge: 0, chaos: config.chaos ?? 'normal' },
    overlays: { inversionUntil: null, eruptionUntil: null, fog: null },
    finalGateOpenedBy: [],
    bets: [],
    phase: { type: 'minigame' },
    rngState: 0,
  };
  const ctx = newContext(board, state, rng);
  ctx.events.push({ type: 'orderDrawn', rolls, tieBreaks, order });
  ctx.events.push({ type: 'roundStarted', round: 1 });
  startTurn(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/**
 * Qui doit agir maintenant : le serveur (résultats de mini-jeux) ou un joueur précis. Sert à
 * savoir qui attendre, à lancer les chronos et à faire jouer les bots. null : partie finie.
 */
export function whoMustAct(state: GameState): Actor | null {
  const { phase } = state;
  switch (phase.type) {
    case 'minigame':
    case 'finale':
    case 'bonusMinigame':
      return { type: 'system' };
    case 'turn':
      // Résultats de mini-jeux et de tests d'adresse : ils viennent du serveur.
      if (
        ['awaitDuelResult', 'awaitOneVsAllResult', 'awaitSkillGate', 'awaitWheel'].includes(
          phase.step.type,
        )
      ) {
        return { type: 'system' };
      }
      return { type: 'player', playerId: phase.playerId };
    case 'trouble':
      return { type: 'player', playerId: phase.chooser };
    case 'itemChoices': {
      const [next] = phase.queue;
      return next ? { type: 'player', playerId: next.playerId } : null;
    }
    case 'finished':
      return null;
  }
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
  const ctx = newContext(board, draft, new Rng(draft.rngState));

  switch (intent.type) {
    case 'submitMinigameResult':
      startRound(ctx, intent.ranking);
      break;
    case 'submitFinaleResult':
      finishFinale(ctx, intent.ranking);
      break;
    case 'submitBonusMinigameResult':
      finishBonusMinigame(ctx, intent.ranking);
      break;
    case 'chooseTrouble':
      chooseTrouble(ctx, intent.event);
      break;
    case 'useItem':
      // Une pause pendant l'objet (coffre atteint par la Fusée...) ramène ensuite au lancer.
      ctx.resume = 'roll';
      afterAction(ctx, useItem(ctx, activePlayer(ctx), intent.item, intent.target), 'roll');
      break;
    case 'roll':
      roll(ctx, intent);
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
    case 'chooseTarget':
      resolvePause(ctx, (player, step) =>
        step.type === 'awaitTarget'
          ? resolveTarget(ctx, player, getPlayer(ctx.state, intent.playerId), step.interaction)
          : 'continue',
      );
      break;
    case 'submitDuelResult':
      resolvePause(ctx, (player, step) =>
        step.type === 'awaitDuelResult'
          ? resolveDuel(ctx, player, step.opponent, step.kind, intent.winner)
          : 'continue',
      );
      break;
    case 'submitOneVsAllResult':
      resolvePause(ctx, (player) => resolveOneVsAll(ctx, player, intent.soloWon));
      break;
    case 'chooseJailAction':
      playJailAction(ctx, intent.action);
      break;
    case 'chooseDoor':
    case 'payToll':
    case 'submitSkillGateResult':
      resolveGate(ctx, intent);
      break;
    case 'submitWheelResult':
      resolvePause(ctx, (player, step) => {
        const segment = step.type === 'awaitWheel' ? step.segments[intent.segment] : undefined;
        if (!segment) throw new Error('Segment de roue inconnu');
        ctx.events.push({ type: 'wheelStopped', playerId: player.id, segment: intent.segment });
        return applyWheelSegment(ctx, player, segment);
      });
      break;
    case 'placeBet':
      resolvePause(ctx, (player) => placeBet(ctx, player, intent.on, intent.stake));
      break;
    case 'resolveSpecialDieSwap':
      resolvePause(ctx, (player, step) =>
        step.type === 'awaitSpecialDieSwap'
          ? swapSpecialDie(ctx, player, step.offered, intent.discard)
          : 'continue',
      );
      break;
    case 'chooseTrapdoor':
      openTrapdoor(ctx, activePlayer(ctx), intent.trapdoor);
      endTurn(ctx);
      break;
    case 'resolveItemSwap':
      if (ctx.state.phase.type === 'itemChoices') resolveQueuedChoice(ctx, intent.discard);
      else resolvePause(ctx, (player) => swapItem(ctx, player, intent.discard));
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
  const everyone = state.players.map((player) => player.id);
  switch (intent.type) {
    case 'submitMinigameResult':
    case 'submitBonusMinigameResult': {
      if (actor.type !== 'system') return 'notAllowed';
      const expected = intent.type === 'submitMinigameResult' ? 'minigame' : 'bonusMinigame';
      if (phase.type !== expected) return 'wrongPhase';
      return isCompleteRanking(intent.ranking, everyone) ? null : 'invalidRanking';
    }
    case 'submitFinaleResult':
      if (actor.type !== 'system') return 'notAllowed';
      if (phase.type !== 'finale') return 'wrongPhase';
      return isCompleteRanking(intent.ranking, phase.contenders) ? null : 'invalidRanking';
    case 'chooseTrouble':
      if (actor.type !== 'player') return 'notAllowed';
      if (phase.type !== 'trouble') return 'wrongPhase';
      if (phase.chooser !== actor.playerId) return 'notYourTurn';
      return phase.options.includes(intent.event) ? null : 'invalidChoice';
    case 'submitSkillGateResult':
      if (actor.type !== 'system') return 'notAllowed';
      return phase.type === 'turn' && phase.step.type === 'awaitSkillGate' ? null : 'wrongPhase';
    case 'submitWheelResult': {
      if (actor.type !== 'system') return 'notAllowed';
      if (phase.type !== 'turn' || phase.step.type !== 'awaitWheel') return 'wrongPhase';
      const count = phase.step.segments.length;
      return Number.isInteger(intent.segment) && intent.segment >= 0 && intent.segment < count
        ? null
        : 'invalidChoice';
    }
    case 'submitDuelResult':
    case 'submitOneVsAllResult': {
      if (actor.type !== 'system') return 'notAllowed';
      if (phase.type !== 'turn') return 'wrongPhase';
      const { step } = phase;
      if (intent.type === 'submitOneVsAllResult') {
        return step.type === 'awaitOneVsAllResult' ? null : 'wrongPhase';
      }
      if (step.type !== 'awaitDuelResult') return 'wrongPhase';
      const fighters: (PlayerId | null)[] = [phase.playerId, step.opponent, null];
      return fighters.includes(intent.winner) ? null : 'invalidChoice';
    }
    case 'resolveItemSwap': {
      if (phase.type !== 'itemChoices') break;
      if (actor.type !== 'player') return 'notAllowed';
      const [next] = phase.queue;
      if (next?.playerId !== actor.playerId) return 'notYourTurn';
      const player = getPlayer(state, actor.playerId);
      return intent.discard === next.offered || player.inventory.includes(intent.discard)
        ? null
        : 'invalidChoice';
    }
    default:
      break;
  }

  if (actor.type !== 'player') return 'notAllowed';
  if (phase.type !== 'turn') return 'wrongPhase';
  if (phase.playerId !== actor.playerId) return 'notYourTurn';
  const { step } = phase;

  switch (intent.type) {
    case 'useItem':
      if (step.type !== 'awaitRoll') return 'wrongPhase';
      return itemUseError(board, state, actor.playerId, intent.item, intent.target);
    case 'roll': {
      if (step.type !== 'awaitRoll') return 'wrongPhase';
      const { specialDie, call } = intent;
      if (specialDie === undefined) return call === undefined ? null : 'invalidChoice';
      if (!getPlayer(state, actor.playerId).specialDice.includes(specialDie)) return 'itemNotOwned';
      const validCall = call !== undefined && Number.isInteger(call) && call >= 1 && call <= 6;
      return (specialDie === 'trapped') === validCall ? null : 'invalidChoice';
    }
    case 'resolveSpecialDieSwap': {
      if (step.type !== 'awaitSpecialDieSwap') return 'wrongPhase';
      const pouch = getPlayer(state, actor.playerId).specialDice;
      return intent.discard === step.offered || pouch.includes(intent.discard)
        ? null
        : 'invalidChoice';
    }
    case 'keepRoll':
    case 'reroll':
      return step.type === 'awaitRerollChoice' ? null : 'wrongPhase';
    case 'chooseBranch':
      if (step.type !== 'awaitBranch') return 'wrongPhase';
      return step.options.includes(intent.spaceId) ? null : 'invalidChoice';
    case 'chooseChest':
      if (step.type !== 'awaitChest') return 'wrongPhase';
      return intent.chest === 0 || intent.chest === 1 ? null : 'invalidChoice';
    case 'chooseTarget':
      if (step.type !== 'awaitTarget') return 'wrongPhase';
      return step.options.includes(intent.playerId) ? null : 'invalidChoice';
    case 'chooseJailAction':
      if (step.type !== 'awaitJailChoice') return 'wrongPhase';
      return intent.action === 'advance' || intent.action === 'wheel' ? null : 'invalidChoice';
    case 'chooseTrapdoor':
      if (step.type !== 'awaitTrapdoor') return 'wrongPhase';
      return [0, 1, 2].includes(intent.trapdoor) ? null : 'invalidChoice';
    case 'chooseDoor':
      if (step.type !== 'awaitDoor') return 'wrongPhase';
      return intent.door === 0 || intent.door === 1 ? null : 'invalidChoice';
    case 'payToll': {
      if (step.type !== 'awaitToll') return 'wrongPhase';
      const player = getPlayer(state, actor.playerId);
      return intent.item === null || player.inventory.includes(intent.item) ? null : 'itemNotOwned';
    }
    case 'placeBet': {
      if (step.type !== 'awaitBet') return 'wrongPhase';
      const validStake =
        Number.isInteger(intent.stake) && intent.stake >= 1 && intent.stake <= MAX_BET;
      return validStake && everyone.includes(intent.on) ? null : 'invalidChoice';
    }
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
  const [winner] = order;
  if (winner !== undefined) settleBets(ctx, winner);
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
  if (player.jail) startJailTurn(ctx, player);
}

/** Au Cachot : avancer avec ses dés sur le chemin intérieur, ou tenter la roue. */
function playJailAction(ctx: Context, action: 'advance' | 'wheel'): void {
  const player = activePlayer(ctx);
  if (action === 'wheel') {
    afterAction(ctx, spinWheel(ctx, player), 'endTurn');
    return;
  }
  const dice = rollForTurn(ctx, player);
  ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'move', roll: dice });
  noteDouble(ctx, dice);
  afterAction(ctx, advanceInJail(ctx, player, dice), 'endTurn');
}

function freshTurn(): TurnModifiers {
  return {
    itemUsed: false,
    extraDie: false,
    rerollArmed: false,
    shortNormalDie: false,
    coinFlipped: [],
    special: null,
  };
}

function roll(ctx: Context, intent: Extract<Intent, { type: 'roll' }>): void {
  const player = activePlayer(ctx);
  if (intent.specialDie !== undefined) {
    // Le dé spécial est consommé ; la Relance relancera avec le même dé.
    player.specialDice.splice(player.specialDice.indexOf(intent.specialDie), 1);
    ctx.state.turn.special = { kind: intent.specialDie, call: intent.call ?? null };
  }
  const dice = rollForTurn(ctx, player);
  ctx.events.push({
    type: 'diceRolled',
    playerId: player.id,
    purpose: purposeOf(player),
    roll: dice,
  });
  noteDouble(ctx, dice);
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
  noteDouble(ctx, dice);
  playRoll(ctx, player, dice);
}

/** Un double fait monter la jauge TROUBLE. */
function noteDouble(ctx: Context, dice: DiceRoll): void {
  if (dice.extra !== null) addGauge(ctx, DOUBLE_GAIN, 'double');
}

function rollForTurn(ctx: Context, player: PlayerState): DiceRoll {
  const { turn } = ctx.state;
  return rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null, {
    normalFaces: turn.shortNormalDie ? 4 : 6,
    turbo: turn.extraDie,
    special: turn.special,
  });
}

/** Bourse à dés pleine : jeter `discard` pour prendre le dé proposé, ou refuser ce dernier. */
function swapSpecialDie(
  ctx: Context,
  player: PlayerState,
  offered: SpecialDieKind,
  discard: SpecialDieKind,
): Flow {
  if (discard === offered) {
    ctx.events.push({ type: 'specialDieRefused', playerId: player.id, die: offered });
    return 'continue';
  }
  player.specialDice.splice(player.specialDice.indexOf(discard), 1);
  player.specialDice.push(offered);
  ctx.events.push({ type: 'specialDieDiscarded', playerId: player.id, die: discard });
  ctx.events.push({ type: 'specialDieGained', playerId: player.id, die: offered });
  return 'continue';
}

function purposeOf(player: PlayerState): 'move' | 'gate' {
  return player.atGate ? 'gate' : 'move';
}

/**
 * Joue un lancer. Un joueur arrêté devant une porte l'utilise pour la tenter ; s'il la
 * passe, il avance du même total au-delà de la porte.
 */
function playRoll(ctx: Context, player: PlayerState, dice: DiceRoll): void {
  // Dé Piégé tombé sur une face piégée : on n'avance pas, et le Plateau joue un petit tour.
  if (dice.trapped) {
    ctx.events.push({ type: 'specialDieTrapped', playerId: player.id });
    const event = drawSpaceEvent(ctx.board, ctx.state, ctx.rng);
    afterAction(ctx, event ? applyTrouble(ctx, event, null, player) : 'continue', 'endTurn');
    return;
  }
  if (player.atGate) {
    const outcome = attemptGate(ctx, player, dice.total, dice.total);
    if (outcome === 'paused') return;
    if (outcome !== 'passed') {
      endTurn(ctx);
      return;
    }
  }
  afterAction(ctx, moveWithDice(ctx, player, dice.total), 'endTurn');
}

/** Suite d'une porte à choix : deux portes, péage, porte d'adresse. */
function resolveGate(
  ctx: Context,
  intent: Extract<Intent, { type: 'chooseDoor' | 'payToll' | 'submitSkillGateResult' }>,
): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn') throw new Error('Pas de porte en attente');
  const player = activePlayer(ctx);
  const { step } = phase;
  let flow: Flow;
  if (intent.type === 'chooseDoor' && step.type === 'awaitDoor') {
    flow = chooseDoor(ctx, player, intent.door, step.remaining);
  } else if (intent.type === 'payToll' && step.type === 'awaitToll') {
    flow = payToll(ctx, player, intent.item, step.remaining, step.roll);
  } else if (intent.type === 'submitSkillGateResult' && step.type === 'awaitSkillGate') {
    flow = resolveSkillGate(ctx, player, intent.success, step.remaining);
  } else {
    throw new Error('Porte en attente incohérente');
  }
  afterAction(ctx, flow, 'endTurn');
}

function continueAfterBranch(ctx: Context, spaceId: string): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || phase.step.type !== 'awaitBranch') {
    throw new Error("Pas d'embranchement en attente");
  }
  const player = activePlayer(ctx);
  const { remaining, mode, resume } = phase.step;
  if (mode === 'dice') {
    afterAction(ctx, moveWithDice(ctx, player, remaining, spaceId), 'endTurn');
    return;
  }
  ctx.resume = resume;
  afterAction(ctx, advanceByEffect(ctx, player, remaining, spaceId), resume);
}

/** Étapes où le tour attend un choix ou un résultat avant de reprendre. */
type PausedStep = Extract<
  TurnStep,
  {
    type:
      | 'awaitChest'
      | 'awaitItemSwap'
      | 'awaitTarget'
      | 'awaitDuelResult'
      | 'awaitOneVsAllResult'
      | 'awaitWheel'
      | 'awaitBet'
      | 'awaitSpecialDieSwap';
  }
>;

/**
 * Reprend après une pause (coffre, inventaire plein, choix de cible, résultat de duel ou de
 * 1 contre tous), là où elle s'était arrêtée.
 */
function resolvePause(
  ctx: Context,
  resolve: (player: PlayerState, step: PausedStep) => Flow,
): void {
  const { phase } = ctx.state;
  if (phase.type !== 'turn' || !isPausedStep(phase.step)) {
    throw new Error('Pas de choix en attente');
  }
  const { step } = phase;
  ctx.resume = step.resume;
  afterAction(ctx, resolve(activePlayer(ctx), step), step.resume);
}

function isPausedStep(step: TurnStep): step is PausedStep {
  return [
    'awaitChest',
    'awaitItemSwap',
    'awaitTarget',
    'awaitDuelResult',
    'awaitOneVsAllResult',
    'awaitWheel',
    'awaitBet',
    'awaitSpecialDieSwap',
  ].includes(step.type);
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
  // Enlevé par les Filous pendant un objet (une Fusée...) : son tour s'arrête là.
  if (then === 'roll' && !activePlayer(ctx).jail) {
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
 * gagne. Plusieurs : finale en mini-jeu. Personne : petit événement de manche, jauge
 * TROUBLE, réveil du Plateau si elle est pleine, puis nouvelle manche.
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

  // Les effets de fin de manche ont leur propre pile ou face, hors de tout tour.
  state.phase = { type: 'minigame' };
  state.turn = freshTurn();
  playRoundEvent(ctx);
  addGauge(ctx, ROUND_GAIN, 'round');
  if (gapBetweenFirstAndLast(ctx) > GAP_THRESHOLD) addGauge(ctx, GAP_GAIN, 'gap');

  const chooser = troubleRanking(ctx.board, state).at(-1);
  if (state.trouble.gauge >= GAUGE_MAX && chooser !== undefined) {
    const options = drawTroubleOptions(ctx.board, state, ctx.rng);
    state.trouble.gauge = 0;
    if (options.length > 0) {
      state.phase = { type: 'trouble', chooser, options };
      ctx.events.push({ type: 'troubleAwakened', chooser, options });
      return;
    }
  }
  proceedToNextRound(ctx);
}

/** Environ une manche sur sept, un petit événement sur un joueur au hasard. */
function playRoundEvent(ctx: Context): void {
  if (!ctx.rng.chance(ROUND_EVENT_CHANCE)) return;
  // Les joueurs au Cachot ne sont pas sur le plateau : ils sont épargnés.
  const free = ctx.state.players.filter((candidate) => candidate.jail === null);
  if (free.length === 0) return;
  const player = ctx.rng.pick(free);
  const event = ctx.rng.pick(['bird', 'hole', 'foundItem', 'foundSpecialDie'] as const);
  ctx.events.push({ type: 'roundEvent', event, playerId: player.id });
  if (event === 'bird') advanceByEffect(ctx, player, BIRD_STEPS);
  else if (event === 'hole') recoil(ctx, player, HOLE_STEPS);
  else if (event === 'foundItem') gainItem(ctx, player, drawItem(ctx.rng, 0), 'roundEvent');
  else gainSpecialDie(ctx, player, ctx.rng.pick(SPECIAL_DICE));
}

function gapBetweenFirstAndLast(ctx: Context): number {
  const ranking = troubleRanking(ctx.board, ctx.state);
  const [first] = ranking;
  const last = ranking.at(-1);
  if (first === undefined || last === undefined) return 0;
  const distanceOf = (id: PlayerId) => distanceToGoal(ctx.board, getPlayer(ctx.state, id).position);
  return distanceOf(last) - distanceOf(first);
}

function chooseTrouble(ctx: Context, event: TroubleEventId): void {
  const { phase } = ctx.state;
  if (phase.type !== 'trouble') throw new Error('Pas de TROUBLE en attente');
  applyTrouble(ctx, event, phase.chooser, null);
  if (ctx.state.phase.type === 'trouble') proceedToNextRound(ctx);
}

function finishBonusMinigame(ctx: Context, ranking: PlayerId[][]): void {
  const [winner] = breakTies(ranking, ctx.rng).order;
  if (winner === undefined) throw new Error('Mini-jeu bonus sans vainqueur');
  rewardBonusMinigame(ctx, getPlayer(ctx.state, winner));
  proceedToNextRound(ctx);
}

/** Objets reçus en fin de manche avec un inventaire plein : la file se traite dans l'ordre. */
function resolveQueuedChoice(ctx: Context, discard: ItemId): void {
  const { phase } = ctx.state;
  if (phase.type !== 'itemChoices') throw new Error("Pas de choix d'objet en attente");
  const [next, ...rest] = phase.queue;
  if (!next) throw new Error("File de choix d'objets vide");
  const player = getPlayer(ctx.state, next.playerId);
  if (discard === next.offered) {
    ctx.events.push({ type: 'itemRefused', playerId: player.id, item: next.offered });
  } else {
    removeItem(player, discard);
    player.inventory.push(next.offered);
    ctx.events.push({ type: 'itemDiscarded', playerId: player.id, item: discard });
    ctx.events.push({
      type: 'itemGained',
      playerId: player.id,
      item: next.offered,
      source: 'trouble',
    });
  }
  ctx.state.phase = { type: 'itemChoices', queue: rest };
  proceedToNextRound(ctx);
}

/**
 * Passe à la manche suivante, sauf s'il reste des choix d'objets à faire. Les modifications
 * du plateau arrivées à leur terme disparaissent.
 */
function proceedToNextRound(ctx: Context): void {
  const { state } = ctx;
  const queue = [
    ...(state.phase.type === 'itemChoices' ? state.phase.queue : []),
    ...ctx.pendingItemChoices,
  ];
  ctx.pendingItemChoices = [];
  if (queue.length > 0) {
    state.phase = { type: 'itemChoices', queue };
    return;
  }

  state.round++;
  state.phase = { type: 'minigame' };
  const { overlays } = state;
  if (overlays.inversionUntil !== null && overlays.inversionUntil < state.round) {
    overlays.inversionUntil = null;
    ctx.events.push({ type: 'overlayEnded', overlay: 'inversion' });
  }
  if (overlays.eruptionUntil !== null && overlays.eruptionUntil < state.round) {
    overlays.eruptionUntil = null;
    ctx.events.push({ type: 'overlayEnded', overlay: 'eruption' });
  }
  if (overlays.fog !== null && overlays.fog.until < state.round) {
    overlays.fog = null;
    ctx.events.push({ type: 'overlayEnded', overlay: 'fog' });
  }
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

function newContext(board: Board, state: GameState, rng: Rng): Context {
  return {
    board,
    state,
    rng,
    events: [],
    resume: 'endTurn',
    pendingItemChoices: [],
    eruptionChain: 0,
  };
}

function activePlayer(ctx: Context): PlayerState {
  const { phase } = ctx.state;
  if (phase.type !== 'turn') throw new Error('Pas de tour en cours');
  return getPlayer(ctx.state, phase.playerId);
}
