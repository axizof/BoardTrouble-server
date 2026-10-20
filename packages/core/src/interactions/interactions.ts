import { type Board, distanceToGoal, getSpace, type SpaceId } from '../board/board';
import { type Context, type Flow, getPlayer } from '../game/context';
import {
  advanceByEffect,
  applyHostile,
  opponentOf,
  recoil,
  stealRandomItem,
  swapPlaces,
} from '../game/effects';
import { push } from '../game/floors';
import type { GameState, PlayerId, PlayerState, TargetedInteraction } from '../game/types';

export type InteractionKind =
  | TargetedInteraction
  | 'squall'
  | 'swap'
  | 'oneVsAll'
  | 'vendetta'
  | 'jostle';

const SQUALL_MIN = 4;
const SQUALL_MAX = 6;
const MAGNET_PULL = 4;
const DUEL_STAKE = 6;
const ONE_VS_ALL_REWARD = 10;
const JOSTLE_REACH = 2;
const JOSTLE_PUSH = 1;

export function isInteraction(type: string): type is InteractionKind {
  return ['squall', 'swap', 'magnet', 'steal', 'duel', 'oneVsAll', 'vendetta', 'jostle'].includes(
    type,
  );
}

/**
 * Adversaires possibles : tous les autres, sauf les intouchables (porte finale ouverte,
 * Cachot des Filous).
 */
function opponents(state: GameState, playerId: PlayerId): PlayerState[] {
  return state.players.filter(
    (player) =>
      player.id !== playerId &&
      player.jail === null &&
      !state.finalGateOpenedBy.includes(player.id),
  );
}

/** Cibles qu'un joueur peut choisir pour une interaction (moteur, bots, interface). */
export function interactionTargets(
  board: Board,
  state: GameState,
  playerId: PlayerId,
  interaction: TargetedInteraction,
): PlayerId[] {
  const me = getPlayer(state, playerId);
  const floor = getSpace(board, me.position).floor;
  const eligible: Record<TargetedInteraction, (player: PlayerState) => boolean> = {
    // Jamais d'un étage à l'autre d'un coup, et rien à attirer sur sa propre case.
    magnet: (player) =>
      player.position !== me.position && getSpace(board, player.position).floor === floor,
    steal: (player) => player.inventory.length > 0,
    duel: () => true,
  };
  return opponents(state, playerId)
    .filter(eligible[interaction])
    .map((player) => player.id);
}

/** La case Vendetta ne fait rien si personne ne nous a fait reculer (ou s'il est intouchable). */
export function vendettaOpponent(state: GameState, player: PlayerState): PlayerId | null {
  const by = player.lastAttack?.by;
  return by !== undefined && opponents(state, player.id).some((other) => other.id === by)
    ? by
    : null;
}

/** Le joueur dont c'est le tour arrive sur une case d'interaction. */
export function startInteraction(ctx: Context, player: PlayerState, kind: InteractionKind): Flow {
  const { state, rng } = ctx;
  switch (kind) {
    case 'squall': {
      const candidates = opponents(state, player.id);
      if (candidates.length === 0) return 'continue';
      const target = rng.pick(candidates);
      const spaces = rng.int(SQUALL_MIN, SQUALL_MAX);
      ctx.events.push({
        type: 'targetChosen',
        playerId: player.id,
        target: target.id,
        interaction: 'squall',
      });
      ctx.events.push({ type: 'squallHit', playerId: target.id, spaces });
      return applyHostile(ctx, target, null, (victim) => push(ctx, victim, spaces));
    }
    case 'jostle': {
      const around = spacesAround(ctx.board, player.position, JOSTLE_REACH);
      const jostled = opponents(state, player.id).filter((other) => around.has(other.position));
      if (jostled.length === 0) return 'continue';
      ctx.events.push({
        type: 'jostled',
        playerId: player.id,
        players: jostled.map((other) => other.id),
      });
      // Effet venu d'une case, comme la Bourrasque : le Bouclier protège, pas le Miroir.
      const flows = jostled.map((other) =>
        applyHostile(ctx, other, null, (victim) => push(ctx, victim, JOSTLE_PUSH)),
      );
      return flows.includes('paused') ? 'paused' : 'continue';
    }
    case 'swap': {
      const candidates = opponents(state, player.id).filter(
        (other) => other.position !== player.position,
      );
      if (candidates.length === 0) return 'continue';
      const target = rng.pick(candidates);
      ctx.events.push({
        type: 'targetChosen',
        playerId: player.id,
        target: target.id,
        interaction: 'swap',
      });
      // Le Bouclier du joueur désigné le protège seulement si l'échange le ferait reculer.
      const targetLoses =
        distanceToGoal(ctx.board, target.position) < distanceToGoal(ctx.board, player.position);
      if (!targetLoses) {
        swapPlaces(ctx, player, target);
        return 'continue';
      }
      return applyHostile(ctx, target, null, () => {
        swapPlaces(ctx, player, target);
        return 'continue';
      });
    }
    case 'magnet':
    case 'steal':
    case 'duel': {
      const options = interactionTargets(ctx.board, state, player.id, kind);
      if (options.length === 0) return 'continue';
      state.phase = {
        type: 'turn',
        playerId: player.id,
        step: { type: 'awaitTarget', interaction: kind, options, resume: ctx.resume },
      };
      return 'paused';
    }
    case 'oneVsAll':
      ctx.events.push({ type: 'oneVsAllStarted', solo: player.id });
      state.phase = {
        type: 'turn',
        playerId: player.id,
        step: { type: 'awaitOneVsAllResult', resume: ctx.resume },
      };
      return 'paused';
    case 'vendetta': {
      const opponent = vendettaOpponent(state, player);
      if (opponent === null) return 'continue';
      startDuel(ctx, player, opponent, 'vendetta');
      return 'paused';
    }
  }
}

/** Cases à `radius` pas ou moins de `origin` sur le chemin, devant comme derrière. */
function spacesAround(board: Board, origin: SpaceId, radius: number): Set<SpaceId> {
  const seen = new Set([origin]);
  let frontier = [origin];
  for (let step = 0; step < radius; step++) {
    frontier = frontier
      .flatMap((id) => [...getSpace(board, id).next, ...(board.predecessors.get(id) ?? [])])
      .filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
  return seen;
}

/** Le joueur a choisi sa cible. */
export function resolveTarget(
  ctx: Context,
  player: PlayerState,
  target: PlayerState,
  interaction: TargetedInteraction,
): Flow {
  ctx.events.push({ type: 'targetChosen', playerId: player.id, target: target.id, interaction });
  const source = { player, via: interaction };
  switch (interaction) {
    case 'magnet':
      return applyHostile(ctx, target, source, (victim) =>
        pull(ctx, victim, opponentOf(victim, player, target)),
      );
    case 'steal':
      return applyHostile(ctx, target, source, (victim) =>
        stealRandomItem(ctx, victim, opponentOf(victim, player, target)),
      );
    case 'duel':
      startDuel(ctx, player, target.id, 'duel');
      return 'paused';
  }
}

/** Aimant : `victim` se rapproche de `magnet`, de 4 cases au plus, sans le dépasser. */
function pull(ctx: Context, victim: PlayerState, magnet: PlayerState): Flow {
  const gap =
    distanceToGoal(ctx.board, magnet.position) - distanceToGoal(ctx.board, victim.position);
  const spaces = Math.min(MAGNET_PULL, Math.abs(gap));
  if (spaces === 0) return 'continue';
  return gap < 0 ? advanceByEffect(ctx, victim, spaces) : recoil(ctx, victim, spaces, magnet.id);
}

function startDuel(
  ctx: Context,
  player: PlayerState,
  opponent: PlayerId,
  kind: 'duel' | 'vendetta',
): void {
  ctx.events.push({ type: 'duelStarted', challenger: player.id, opponent, kind });
  ctx.state.phase = {
    type: 'turn',
    playerId: player.id,
    step: { type: 'awaitDuelResult', opponent, kind, resume: ctx.resume },
  };
}

/**
 * Résultat d'un duel, joué loyalement : ni Miroir ni Bouclier. Duel gagné : +6 pour soi,
 * -6 pour l'adversaire. Vendetta gagnée : on récupère les cases perdues. Défaite ou
 * égalité : rien.
 */
export function resolveDuel(
  ctx: Context,
  player: PlayerState,
  opponentId: PlayerId,
  kind: 'duel' | 'vendetta',
  winner: PlayerId | null,
): Flow {
  ctx.events.push({ type: 'duelEnded', winner });
  if (winner !== player.id) return 'continue';
  if (kind === 'vendetta') {
    const spaces = player.lastAttack?.spaces ?? 0;
    player.lastAttack = null;
    return advanceByEffect(ctx, player, spaces);
  }
  recoil(ctx, getPlayer(ctx.state, opponentId), DUEL_STAKE, player.id);
  return advanceByEffect(ctx, player, DUEL_STAKE);
}

export function resolveOneVsAll(ctx: Context, player: PlayerState, soloWon: boolean): Flow {
  ctx.events.push({ type: 'oneVsAllEnded', solo: player.id, soloWon });
  return soloWon ? advanceByEffect(ctx, player, ONE_VS_ALL_REWARD) : 'continue';
}
