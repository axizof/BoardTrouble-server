import type { Board } from '../board/board';
import type { Rng } from '../random/rng';
import type { GameEvent, GameState, PlayerId, PlayerState } from './types';

/** Contexte d'application d'une intention, sur une copie de l'état. */
export type Context = {
  board: Board;
  state: GameState;
  rng: Rng;
  events: GameEvent[];
  /** Un seul pile ou face par joueur et par tour (01-vision-et-plateau.md, section 8). */
  coinFlipUsed: boolean;
};

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Joueur inconnu : ${playerId}`);
  return player;
}
