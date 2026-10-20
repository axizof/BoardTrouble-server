import { type Board, distanceToGoal, getSpace } from '../board/board';
import { type Context, type Flow, getPlayer, removeItem } from '../game/context';
import {
  advanceByEffect,
  applyHostile,
  isGate,
  opponentOf,
  recoil,
  stealRandomItem,
  swapPlaces,
} from '../game/effects';
import type { GameState, IntentError, PlayerId, PlayerState } from '../game/types';
import { ITEMS, type ItemId } from './catalog';

const ROCKET_STEPS = 6;
const BLOWER_RANGE = 6;
const BLOWER_PUSH = 4;

/** Cibles valides d'un objet ciblé. Sert au moteur (validation), aux bots et à l'interface. */
export function validTargets(
  board: Board,
  state: GameState,
  userId: PlayerId,
  item: ItemId,
): PlayerId[] {
  const user = getPlayer(state, userId);
  const userDistance = distanceToGoal(board, user.position);
  // Un joueur qui a ouvert la porte finale est intouchable jusqu'à la fin de la manche.
  const others = state.players.filter(
    (player) => player.id !== userId && !state.finalGateOpenedBy.includes(player.id),
  );
  const distanceOf = (player: PlayerState) => distanceToGoal(board, player.position);

  switch (item) {
    case 'blower':
      return others
        .filter((player) => Math.abs(distanceOf(player) - userDistance) <= BLOWER_RANGE)
        .map((player) => player.id);
    case 'hourglass': {
      const stillToPlay = state.turnOrder.slice(state.turnIndex + 1);
      return others
        .filter((player) => stillToPlay.includes(player.id) && state.bonusDice[player.id])
        .map((player) => player.id);
    }
    case 'pickpocket':
      return others.filter((player) => player.inventory.length > 0).map((player) => player.id);
    case 'grapple': {
      // Le joueur juste devant, sur le même étage.
      const floor = getSpace(board, user.position).floor;
      const ahead = others.filter(
        (player) =>
          distanceOf(player) < userDistance && getSpace(board, player.position).floor === floor,
      );
      const nearest = Math.max(...ahead.map(distanceOf));
      return ahead.filter((player) => distanceOf(player) === nearest).map((player) => player.id);
    }
    default:
      return [];
  }
}

/** Pourquoi l'objet ne peut pas être utilisé maintenant, ou null s'il le peut. */
export function itemUseError(
  board: Board,
  state: GameState,
  userId: PlayerId,
  item: ItemId,
  target: PlayerId | undefined,
): IntentError | null {
  const user = getPlayer(state, userId);
  if (state.turn.itemUsed) return 'itemAlreadyUsed';
  if (!user.inventory.includes(item)) return 'itemNotOwned';
  const { use } = ITEMS[item];
  if (use === 'passive') return 'itemNotUsable';
  if (item === 'mirror' && user.mirrorArmed) return 'itemNotUsable';
  if (item === 'glue' || item === 'firecracker') {
    const space = getSpace(board, user.position);
    const blocked = space.kind.type === 'start' || isGate(space.kind) || state.traps[space.id];
    if (blocked) return 'itemNotUsable';
  }
  if (use === 'target') {
    return target !== undefined && validTargets(board, state, userId, item).includes(target)
      ? null
      : 'invalidTarget';
  }
  return target === undefined ? null : 'invalidTarget';
}

/** Utilise un objet avant de lancer. L'intention a déjà été validée par `itemUseError`. */
export function useItem(ctx: Context, user: PlayerState, item: ItemId, targetId?: PlayerId): Flow {
  const { state } = ctx;
  state.turn.itemUsed = true;

  // Le Miroir s'active en secret : il reste dans l'inventaire et seul son propriétaire
  // reçoit l'événement.
  if (item === 'mirror') {
    user.mirrorArmed = true;
    ctx.events.push({ type: 'mirrorArmed', playerId: user.id });
    return 'continue';
  }

  removeItem(user, item);
  ctx.events.push({
    type: 'itemUsed',
    playerId: user.id,
    item,
    ...(targetId === undefined ? {} : { target: targetId }),
  });

  switch (item) {
    case 'turboDie':
      state.turn.extraDie = true;
      return 'continue';
    case 'reroll':
      state.turn.rerollArmed = true;
      return 'continue';
    case 'rocket':
      state.bonusDice[user.id] = null;
      return advanceByEffect(ctx, user, ROCKET_STEPS);
    case 'glue':
    case 'firecracker':
      state.traps[user.position] = { type: item, owner: user.id };
      ctx.events.push({
        type: 'trapPlaced',
        playerId: user.id,
        spaceId: user.position,
        trap: item,
      });
      if (item === 'glue') state.turn.shortNormalDie = true;
      return 'continue';
    default:
      if (targetId === undefined) throw new Error(`Cible manquante pour ${item}`);
      return useOnTarget(ctx, user, item, getPlayer(state, targetId));
  }
}

function useOnTarget(ctx: Context, user: PlayerState, item: ItemId, target: PlayerState): Flow {
  const source = { player: user, via: item };
  switch (item) {
    case 'blower':
      return applyHostile(ctx, target, source, (victim) =>
        recoil(ctx, victim, BLOWER_PUSH, opponentOf(victim, user, target).id),
      );
    case 'hourglass':
      return applyHostile(ctx, target, source, (victim) => {
        ctx.state.bonusDice[victim.id] = null;
        ctx.events.push({ type: 'bonusDieLost', playerId: victim.id });
        return 'continue';
      });
    case 'pickpocket':
      return applyHostile(ctx, target, source, (victim) =>
        stealRandomItem(ctx, victim, opponentOf(victim, user, target)),
      );
    case 'grapple':
      return applyHostile(ctx, target, source, (victim) => {
        // Renvoyé par un Miroir, l'échange n'a plus de sens : il est simplement annulé.
        if (victim !== target) return 'continue';
        swapPlaces(ctx, user, target);
        return 'continue';
      });
    default:
      throw new Error(`Objet sans cible : ${item}`);
  }
}
