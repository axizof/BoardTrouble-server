import {
  type Board,
  distanceToGoal,
  floorRules,
  getSpace,
  type Space,
  type SpaceId,
} from '../board/board';
import { type Context, type Flow, removeItem } from './context';
import { advanceByEffect, recoil } from './effects';
import type { GameState, PlayerId, PlayerState } from './types';

// Mécaniques d'étage (01-vision-et-plateau.md, section 7).
const MUD_EXTRA = 2;
// Proportions à régler au simulateur.
export const WIND_CHANCE = 0.25;
const WIND_MIN = 1;
const WIND_MAX = 2;

/**
 * Poussée : une force extérieure (Bourrasque, Souffleur, Bousculade, coup de vent) fait
 * reculer le joueur, 2 cases de plus dans la boue. Poussé depuis une case de bord, il tombe
 * d'un étage, sauf si un Parachute le retient : il est alors poussé normalement. Les autres
 * reculs (malus, statue...) ne sont pas des poussées. `attacker` : voir `recoil`.
 */
export function push(ctx: Context, player: PlayerState, amount: number, attacker?: PlayerId): Flow {
  if (fallFromEdge(ctx, player, attacker)) return 'continue';
  const { floor } = getSpace(ctx.board, player.position);
  const mud = floorRules(ctx.board, floor).muddy ? MUD_EXTRA : 0;
  return recoil(ctx, player, amount + mud, attacker);
}

/** Le joueur est sur une case de bord : une poussée ou un Séisme le ferait tomber. */
export function isOnEdge(board: Board, player: PlayerState): boolean {
  return getSpace(board, player.position).fallsTo !== undefined;
}

/**
 * Un joueur sur une case de bord tombe d'un étage, à la verticale, sauf si un Parachute
 * (consommé) le retient. La case d'arrivée ne se déclenche jamais (pas de chute en chaîne)
 * et le chemin parcouru repart de zéro pour les reculs. Renvoie true s'il est tombé.
 */
export function fallFromEdge(ctx: Context, player: PlayerState, attacker?: PlayerId): boolean {
  const from = player.position;
  const to = getSpace(ctx.board, from).fallsTo;
  if (to === undefined) return false;
  if (player.inventory.includes('parachute')) {
    removeItem(player, 'parachute');
    ctx.events.push({ type: 'parachuteOpened', playerId: player.id });
    return false;
  }
  const lost = distanceToGoal(ctx.board, to) - distanceToGoal(ctx.board, from);
  player.position = to;
  player.trail = [];
  player.atGate = false;
  ctx.events.push({ type: 'fell', playerId: player.id, from, to });
  if (attacker !== undefined) player.lastAttack = { by: attacker, spaces: lost };
  return true;
}

export function isIce(board: Board, spaceId: SpaceId): boolean {
  return getSpace(board, spaceId).kind.type === 'ice';
}

/** Les ponts-levis sont ouverts une manche sur deux : les manches impaires. */
export function drawbridgeOpen(round: number): boolean {
  return round % 2 === 1;
}

/** Cases où l'on peut s'engager depuis `space` : sans les ponts-levis fermés. */
export function openNext(board: Board, state: GameState, space: Space): SpaceId[] {
  return space.next.filter(
    (id) => getSpace(board, id).kind.type !== 'drawbridge' || drawbridgeOpen(state.round),
  );
}

/**
 * Fin de manche : les tapis roulants déplacent les pions posés dessus. C'est le terrain,
 * visible à l'avance, pas une attaque : le Bouclier ne s'en mêle pas. Les passagers sont
 * notés avant de bouger, pour qu'un pion déposé sur un autre tapis n'y reparte pas.
 */
export function runConveyors(ctx: Context): void {
  const riders = ctx.state.players.filter(
    (player) =>
      player.jail === null && getSpace(ctx.board, player.position).kind.type === 'conveyor',
  );
  for (const player of riders) {
    const { kind } = getSpace(ctx.board, player.position);
    if (kind.type !== 'conveyor') continue;
    ctx.events.push({ type: 'conveyorMoved', playerId: player.id, spaceId: player.position });
    if (kind.direction === 'forward') advanceByEffect(ctx, player, kind.amount);
    else recoil(ctx, player, kind.amount);
  }
}

/**
 * Fin de manche, sur un étage venteux : parfois un coup de vent pousse tous les joueurs de
 * l'étage de 1 à 2 cases. C'est la météo du Plateau : le Bouclier ne protège pas.
 */
export function blowWind(ctx: Context): void {
  const free = ctx.state.players.filter((player) => player.jail === null);
  const floorOf = (player: PlayerState) => getSpace(ctx.board, player.position).floor;
  // Du bas vers le haut : un joueur tombé d'un étage venteux ne subit pas un second coup.
  const floors = [...new Set(free.map(floorOf))].sort((a, b) => a - b);
  for (const floor of floors) {
    if (!floorRules(ctx.board, floor).windy || !ctx.rng.chance(WIND_CHANCE)) continue;
    const exposed = free.filter((player) => floorOf(player) === floor);
    const strength = ctx.rng.int(WIND_MIN, WIND_MAX);
    ctx.events.push({
      type: 'windBlew',
      floor,
      strength,
      pushed: exposed.map((player) => player.id),
    });
    for (const player of exposed) push(ctx, player, strength);
  }
}
