import { getSpace, type SpaceId, type WheelSegment } from '../board/board';
import { SPECIAL_DICE } from '../dice/dice';
import { startInteraction } from '../interactions/interactions';
import { catchUpFactor, drawItem } from '../items/catalog';
import { applyTrouble, drawSpaceEvent } from '../trouble/events';
import { type Context, type Flow, getPlayer } from './context';
import { advanceByEffect, applyHostile, gainItem, gainSpecialDie, isGate, recoil } from './effects';
import type { GiantDieFace, PlayerId, PlayerState } from './types';

const SEESAW_LAUNCH = 4;
const BIRD_STEPS = 10;
const MONSTER_RECOIL = 6;
export const MAX_BET = 5;

const GIANT_DIE_FACES: GiantDieFace[] = [
  'bird',
  'monster',
  'item',
  'squall',
  'trouble',
  'specialDie',
];

/**
 * Ascenseur, monte-charge, toboggan, téléporteur : le joueur est transporté jusqu'à la case
 * `to`. Il n'y déclenche rien (on ne sort pas d'un transport sur une case active), et son
 * chemin parcouru repart de zéro pour les reculs.
 */
export function transport(
  ctx: Context,
  player: PlayerState,
  to: SpaceId,
  via: 'elevator' | 'freightLift' | 'slide' | 'teleporter',
): Flow {
  const from = player.position;
  player.position = to;
  player.trail = [];
  player.atGate = isGate(getSpace(ctx.board, to).kind);
  ctx.events.push({ type: 'teleported', playerId: player.id, from, to, via });
  return 'continue';
}

/** Le monte-charge ne marche qu'une manche sur deux : les manches paires. */
export function freightLiftWorks(round: number): boolean {
  return round % 2 === 0;
}

/** Bascule : les joueurs posés sur l'autre bout sont projetés de 4 cases en avant. */
export function launchSeesaw(ctx: Context, player: PlayerState, partner: SpaceId): Flow {
  const launched = ctx.state.players.filter(
    (other) => other !== player && other.jail === null && other.position === partner,
  );
  ctx.events.push({
    type: 'seesawLaunched',
    playerId: player.id,
    launched: launched.map((other) => other.id),
  });
  for (const other of launched) advanceByEffect(ctx, other, SEESAW_LAUNCH);
  return 'continue';
}

/** Dé géant : une face au hasard décide du sort du joueur. */
export function rollGiantDie(ctx: Context, player: PlayerState): Flow {
  const face = ctx.rng.pick(GIANT_DIE_FACES);
  ctx.events.push({ type: 'giantDieRolled', playerId: player.id, face });
  switch (face) {
    case 'bird':
      return advanceByEffect(ctx, player, BIRD_STEPS);
    case 'monster':
      return applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, MONSTER_RECOIL));
    case 'item':
      return gainItem(
        ctx,
        player,
        drawItem(ctx.rng, catchUpFactor(ctx.board, ctx.state, player.id)),
        'itemSpace',
      );
    case 'squall':
      return startInteraction(ctx, player, 'squall');
    case 'trouble': {
      const event = drawSpaceEvent(ctx.board, ctx.state, ctx.rng);
      return event === null ? 'continue' : applyTrouble(ctx, event, null, player);
    }
    case 'specialDie':
      return gainSpecialDie(ctx, player, ctx.rng.pick(SPECIAL_DICE));
  }
}

/** Issue de la roue arrêtée par le joueur. */
export function applyWheelSegment(ctx: Context, player: PlayerState, segment: WheelSegment): Flow {
  switch (segment.type) {
    case 'advance':
      return advanceByEffect(ctx, player, segment.amount);
    case 'recoil':
      return recoil(ctx, player, segment.amount);
    case 'item':
      return gainItem(
        ctx,
        player,
        drawItem(ctx.rng, catchUpFactor(ctx.board, ctx.state, player.id)),
        'itemSpace',
      );
    case 'trouble': {
      const event = drawSpaceEvent(ctx.board, ctx.state, ctx.rng);
      return event === null ? 'continue' : applyTrouble(ctx, event, null, player);
    }
    case 'nothing':
      return 'continue';
  }
}

/** Un pari est réglé au classement du mini-jeu suivant. */
export function placeBet(ctx: Context, player: PlayerState, on: PlayerId, stake: number): Flow {
  ctx.state.bets.push({ playerId: player.id, on, stake });
  ctx.events.push({ type: 'betPlaced', playerId: player.id, on, stake });
  return 'continue';
}

/**
 * Règle les paris avec le vainqueur du mini-jeu : gagné, on avance de la mise ; perdu, on
 * recule d'autant. C'est son propre pari : le Bouclier ne protège pas. Un parieur au Cachot
 * est remboursé (il n'est pas sur le plateau).
 */
export function settleBets(ctx: Context, winner: PlayerId): void {
  const bets = ctx.state.bets;
  ctx.state.bets = [];
  for (const { playerId, on, stake } of bets) {
    const won = on === winner;
    ctx.events.push({ type: 'betResolved', playerId, on, stake, won });
    const bettor = getPlayer(ctx.state, playerId);
    if (bettor.jail) continue;
    if (won) advanceByEffect(ctx, bettor, stake);
    else recoil(ctx, bettor, stake);
  }
}
