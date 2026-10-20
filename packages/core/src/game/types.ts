import type { SpaceId } from '../board/board';
import type { BonusDie, DiceRoll, TableSize, TieBreak } from '../dice/dice';

export type PlayerId = string;

export type PlayerState = {
  id: PlayerId;
  name: string;
  position: SpaceId;
  /** Arrêté devant une porte pas encore franchie (le pion est sur la case de la porte). */
  atGate: boolean;
  /** Dernières cases quittées, pour qu'un recul suive le chemin réellement pris. */
  trail: SpaceId[];
  /** Échecs par porte : le seuil de chaque porte baisse pour ce joueur. */
  gateFailures: Record<SpaceId, number>;
};

export type TurnStep =
  | { type: 'awaitRoll' }
  | { type: 'awaitBranch'; remaining: number; options: SpaceId[] };

export type Phase =
  /** En attente du classement du mini-jeu de manche. */
  | { type: 'minigame' }
  | { type: 'turn'; playerId: PlayerId; step: TurnStep }
  /** Plusieurs joueurs ont ouvert la porte finale : en attente du classement de la finale. */
  | { type: 'finale'; contenders: PlayerId[] }
  | { type: 'finished'; winner: PlayerId };

/** État complet d'une partie : du JSON pur, sauvegardable tel quel. */
export type GameState = {
  version: 1;
  boardId: string;
  tableSize: TableSize;
  players: PlayerState[];
  round: number;
  turnOrder: PlayerId[];
  turnIndex: number;
  bonusDice: Record<PlayerId, BonusDie | null>;
  /** Joueurs qui ont ouvert la porte finale pendant la manche en cours. */
  finalGateOpenedBy: PlayerId[];
  phase: Phase;
  /** État du générateur de hasard. Ne doit jamais être envoyé aux clients. */
  rngState: number;
};

export type GameConfig = {
  players: { id: PlayerId; name: string }[];
  tableSize: TableSize;
  seed: number;
};

/** Qui envoie l'intention : un joueur, ou le serveur lui-même (résultats de mini-jeux). */
export type Actor = { type: 'system' } | { type: 'player'; playerId: PlayerId };

export type Intent =
  /** Classement du mini-jeu, du meilleur au moins bon ; chaque groupe contient des ex aequo. */
  | { type: 'submitMinigameResult'; ranking: PlayerId[][] }
  | { type: 'submitFinaleResult'; ranking: PlayerId[][] }
  | { type: 'roll' }
  | { type: 'chooseBranch'; spaceId: SpaceId };

export type IntentError =
  | 'notAllowed'
  | 'notYourTurn'
  | 'wrongPhase'
  | 'invalidChoice'
  | 'invalidRanking';

/** Ce qui s'est passé, dans l'ordre : c'est ce que le client anime. */
export type GameEvent =
  | {
      type: 'orderDrawn';
      rolls: { playerId: PlayerId; value: number }[];
      tieBreaks: TieBreak[];
      order: PlayerId[];
    }
  | { type: 'roundStarted'; round: number }
  | {
      type: 'minigameRanked';
      order: PlayerId[];
      tieBreaks: TieBreak[];
      bonusDice: Record<PlayerId, BonusDie | null>;
    }
  | { type: 'turnStarted'; playerId: PlayerId }
  | { type: 'diceRolled'; playerId: PlayerId; purpose: 'move' | 'gate'; roll: DiceRoll }
  | { type: 'moved'; playerId: PlayerId; path: SpaceId[]; cause: 'dice' | 'effect' }
  | { type: 'branchReached'; playerId: PlayerId; options: SpaceId[] }
  | {
      type: 'gateTested';
      playerId: PlayerId;
      spaceId: SpaceId;
      threshold: number;
      total: number;
      success: boolean;
    }
  | { type: 'finalGateOpened'; playerId: PlayerId }
  | { type: 'coinFlipped'; playerId: PlayerId; spaceId: SpaceId; heads: boolean }
  | { type: 'spaceTriggered'; playerId: PlayerId; spaceId: SpaceId }
  | { type: 'turnEnded'; playerId: PlayerId }
  | { type: 'roundEnded'; round: number }
  | { type: 'finaleStarted'; contenders: PlayerId[] }
  | { type: 'gameWon'; playerId: PlayerId };

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: IntentError };
