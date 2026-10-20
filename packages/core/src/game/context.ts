import type { Board } from '../board/board';
import type { ItemId } from '../items/catalog';
import type { Rng } from '../random/rng';
import type { GameEvent, GameState, PlayerId, PlayerState, Resume } from './types';

/** Contexte d'application d'une intention, sur une copie de l'état. */
export type Context = {
  board: Board;
  state: GameState;
  rng: Rng;
  events: GameEvent[];
  /**
   * Ce qui suit une pause (coffre, inventaire plein) : finir le tour, ou revenir au lancer
   * quand la pause est arrivée pendant l'utilisation d'un objet avant de lancer.
   */
  resume: Resume;
  /** Objets reçus hors des tours avec un inventaire plein : chacun choisira quoi jeter. */
  pendingItemChoices: { playerId: PlayerId; offered: ItemId }[];
  /** Enchaînements de cases pendant l'Éruption dans cette action (3 au plus). */
  eruptionChain: number;
};

/**
 * `continue` : le tour suit son cours. `paused` : le moteur attend un choix du joueur
 * (embranchement, coffre, inventaire plein) ; la phase a déjà été mise à jour.
 */
export type Flow = 'continue' | 'paused';

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Joueur inconnu : ${playerId}`);
  return player;
}

/** Joueur dont c'est le tour, ou null hors d'un tour (mini-jeu, finale). */
export function activePlayerId(state: GameState): PlayerId | null {
  return state.phase.type === 'turn' ? state.phase.playerId : null;
}

export function removeItem(player: PlayerState, item: ItemId): void {
  const index = player.inventory.indexOf(item);
  if (index >= 0) player.inventory.splice(index, 1);
  if (item === 'mirror' && !player.inventory.includes('mirror')) player.mirrorArmed = false;
}
