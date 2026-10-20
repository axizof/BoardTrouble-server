import type { BoardDefinition } from '../board/board';
import type { GameEvent, GameState, Intent, IntentError, PlayerId } from '../game/types';

// Messages entre un client et l'hôte de la partie : le serveur en multi, un Web Worker en
// solo. Les deux parlent exactement ce protocole (01-architecture.md, section 5).
export const PROTOCOL_VERSION = 1;

export type ClientMessage = { type: 'intent'; intent: Intent };

/** Qui joue chaque place : un humain, ou un bot. */
export type SeatKind = 'human' | 'bot';

/**
 * `decisionEndsIn` : millisecondes restantes, au moment de l'envoi, avant que l'hôte joue le
 * choix par défaut d'un joueur qui ne répond pas (animations en cours comprises), ou null
 * si personne n'a de chrono.
 */
export type HostMessage =
  /** À l'arrivée dans la partie : tout ce qu'il faut pour l'afficher directement. */
  | {
      type: 'snapshot';
      protocol: number;
      board: BoardDefinition;
      you: PlayerId | null;
      seats: Record<PlayerId, SeatKind>;
      state: GameState;
      decisionEndsIn: number | null;
    }
  /** Ce qui vient de se passer, à animer, et l'état qui en résulte. */
  | { type: 'events'; events: GameEvent[]; state: GameState; decisionEndsIn: number | null }
  /** L'intention du client a été refusée. */
  | { type: 'rejected'; error: IntentError };
