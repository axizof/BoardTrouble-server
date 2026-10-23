import type { BoardDefinition } from '../board/board';
import type { GameEvent, GameState, Intent, IntentError, PlayerId } from '../game/types';
import type { Appearance } from '../lobby/players';
import type { ArenaInput } from '../minigames/arena/arena';
import type { ArenaRunView } from '../minigames/arena/arenaRun';

// Messages entre un client et l'hôte de la partie : le serveur en multi, un Web Worker en
// solo. Les deux parlent exactement ce protocole (01-architecture.md, section 5).
export const PROTOCOL_VERSION = 3;

export type ClientMessage =
  | { type: 'intent'; intent: Intent }
  /** Pendant un mini-jeu d'arène : se dire prêt, puis envoyer ses commandes. */
  | { type: 'arenaReady' }
  | { type: 'arenaInput'; input: ArenaInput };

/** Qui joue chaque place : un humain, ou un bot. */
export type SeatKind = 'human' | 'bot';

/** Ce que tout le monde voit d'une place : qui la joue, et avec quelle apparence. */
export type SeatView = { kind: SeatKind; appearance: Appearance };

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
      seats: Record<PlayerId, SeatView>;
      state: GameState;
      decisionEndsIn: number | null;
    }
  /** Ce qui vient de se passer, à animer, et l'état qui en résulte. */
  | { type: 'events'; events: GameEvent[]; state: GameState; decisionEndsIn: number | null }
  /** L'intention du client a été refusée. */
  | { type: 'rejected'; error: IntentError }
  /** Le mini-jeu d'arène en cours (30 fois par seconde pendant le jeu), ou null quand il finit. */
  | { type: 'arena'; run: ArenaRunView | null };
