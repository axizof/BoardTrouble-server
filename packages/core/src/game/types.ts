import type { SpaceId, SpaceKind } from '../board/board';
import type { BonusDie, DiceRoll, TableSize, TieBreak } from '../dice/dice';
import type { ItemId } from '../items/catalog';
import type { TroubleEventId } from '../trouble/events';

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
  /** 3 objets au plus. Un Miroir activé y reste jusqu'à ce qu'il serve ou expire. */
  inventory: ItemId[];
  /** Miroir activé en secret : jamais envoyé aux autres joueurs. */
  mirrorArmed: boolean;
};

export type TurnStep =
  | { type: 'awaitRoll' }
  /** Relance activée : garder le lancer ou relancer. */
  | { type: 'awaitRerollChoice'; roll: DiceRoll }
  /**
   * Embranchement. `mode` : déplacement aux dés ou par un effet (case bonus, Fusée), qui ne
   * se poursuivent pas pareil.
   */
  | {
      type: 'awaitBranch';
      remaining: number;
      options: SpaceId[];
      mode: 'dice' | 'effect';
      resume: Resume;
    }
  /** Case Coffre : choisir l'un des deux coffres. */
  | { type: 'awaitChest'; resume: Resume }
  /** Inventaire plein : échanger l'objet proposé contre un des siens, ou le refuser. */
  | { type: 'awaitItemSwap'; offered: ItemId; source: ItemSource; resume: Resume };

/** Après une pause : finir le tour, ou revenir au lancer (pause pendant un objet). */
export type Resume = 'endTurn' | 'roll';

export type Phase =
  /** En attente du classement du mini-jeu de manche. */
  | { type: 'minigame' }
  | { type: 'turn'; playerId: PlayerId; step: TurnStep }
  /** Plusieurs joueurs ont ouvert la porte finale : en attente du classement de la finale. */
  | { type: 'finale'; contenders: PlayerId[] }
  /** Le Plateau se réveille : le dernier choisit un événement parmi `options`. */
  | { type: 'trouble'; chooser: PlayerId; options: TroubleEventId[] }
  /** Objets reçus hors des tours avec un inventaire plein : chacun choisit, dans l'ordre. */
  | { type: 'itemChoices'; queue: { playerId: PlayerId; offered: ItemId }[] }
  /** Événement Mini-jeu bonus : en attente de son classement. */
  | { type: 'bonusMinigame' }
  | { type: 'finished'; winner: PlayerId };

/** Modificateurs du tour en cours, remis à zéro à chaque nouveau tour. */
export type TurnModifiers = {
  itemUsed: boolean;
  extraDie: boolean;
  rerollArmed: boolean;
  /** Colle posée : le dé normal devient un dé 1-4 pour ce tour. */
  shortNormalDie: boolean;
  /** Joueurs qui ont déjà eu leur pile ou face pendant ce tour. */
  coinFlipped: PlayerId[];
};

export type Trap = { type: 'glue' | 'firecracker'; owner: PlayerId };

/** Vitesse de la jauge TROUBLE, réglée dans le salon. */
export type ChaosLevel = 'calm' | 'normal' | 'trouble';

/**
 * Modifications temporaires du plateau par le TROUBLE, actives jusqu'à la fin de la manche
 * indiquée (comprise).
 */
export type Overlays = {
  inversionUntil: number | null;
  eruptionUntil: number | null;
  /**
   * Brouillard : les cases spéciales ont échangé leurs effets en secret. `kinds` donne
   * l'effet réel de chaque case ; il n'est jamais envoyé aux clients.
   */
  fog: { until: number; kinds: Record<SpaceId, SpaceKind> } | null;
};

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
  turn: TurnModifiers;
  /** Pièges posés, visibles de tous. Un seul par case. */
  traps: Record<SpaceId, Trap>;
  trouble: { gauge: number; chaos: ChaosLevel };
  overlays: Overlays;
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
  chaos?: ChaosLevel;
};

/** Qui envoie l'intention : un joueur, ou le serveur lui-même (résultats de mini-jeux). */
export type Actor = { type: 'system' } | { type: 'player'; playerId: PlayerId };

export type Intent =
  /** Classement du mini-jeu, du meilleur au moins bon ; chaque groupe contient des ex aequo. */
  | { type: 'submitMinigameResult'; ranking: PlayerId[][] }
  | { type: 'submitFinaleResult'; ranking: PlayerId[][] }
  | { type: 'submitBonusMinigameResult'; ranking: PlayerId[][] }
  | { type: 'chooseTrouble'; event: TroubleEventId }
  | { type: 'useItem'; item: ItemId; target?: PlayerId }
  | { type: 'roll' }
  | { type: 'keepRoll' }
  | { type: 'reroll' }
  | { type: 'chooseBranch'; spaceId: SpaceId }
  | { type: 'chooseChest'; chest: 0 | 1 }
  /** `discard` : l'objet à jeter, ou l'objet proposé pour le refuser. */
  | { type: 'resolveItemSwap'; discard: ItemId };

export type IntentError =
  | 'notAllowed'
  | 'notYourTurn'
  | 'wrongPhase'
  | 'invalidChoice'
  | 'invalidRanking'
  | 'itemAlreadyUsed'
  | 'itemNotOwned'
  | 'itemNotUsable'
  | 'invalidTarget';

export type ItemSource = 'itemSpace' | 'chest' | 'rest' | 'pickpocket' | 'trouble' | 'roundEvent';

/** Petits événements de fin de manche, sur un joueur au hasard. */
export type RoundEventId = 'bird' | 'hole' | 'foundItem';

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
  | { type: 'keyUsed'; playerId: PlayerId; spaceId: SpaceId }
  | { type: 'finalGateOpened'; playerId: PlayerId }
  | { type: 'coinFlipped'; playerId: PlayerId; spaceId: SpaceId; heads: boolean }
  | { type: 'spaceTriggered'; playerId: PlayerId; spaceId: SpaceId }
  | { type: 'itemGained'; playerId: PlayerId; item: ItemId; source: ItemSource }
  | { type: 'itemRefused'; playerId: PlayerId; item: ItemId }
  | { type: 'itemDiscarded'; playerId: PlayerId; item: ItemId }
  | { type: 'itemUsed'; playerId: PlayerId; item: ItemId; target?: PlayerId }
  /** Privé : seul le propriétaire du Miroir le reçoit. */
  | { type: 'mirrorArmed'; playerId: PlayerId }
  /** Privé : seul le propriétaire du Miroir le reçoit. */
  | { type: 'mirrorExpired'; playerId: PlayerId }
  | { type: 'mirrorReflected'; playerId: PlayerId; attacker: PlayerId; item: ItemId }
  | { type: 'shieldBlocked'; playerId: PlayerId }
  | { type: 'trapPlaced'; playerId: PlayerId; spaceId: SpaceId; trap: Trap['type'] }
  | { type: 'trapTriggered'; playerId: PlayerId; spaceId: SpaceId; trap: Trap['type'] }
  | { type: 'itemStolen'; playerId: PlayerId; victim: PlayerId; item: ItemId }
  | { type: 'bonusDieLost'; playerId: PlayerId }
  | { type: 'swapped'; playerId: PlayerId; with: PlayerId }
  | { type: 'chestOpened'; playerId: PlayerId; chest: 0 | 1; trapped: boolean }
  | { type: 'rerolled'; playerId: PlayerId; previous: DiceRoll; roll: DiceRoll }
  | { type: 'troubleGauge'; value: number; added: number; reason: 'round' | 'double' | 'gap' }
  | { type: 'troubleAwakened'; chooser: PlayerId; options: TroubleEventId[] }
  | { type: 'troubleApplied'; event: TroubleEventId; chooser: PlayerId | null }
  | { type: 'overlayEnded'; overlay: 'inversion' | 'eruption' | 'fog' }
  | { type: 'roundEvent'; event: RoundEventId; playerId: PlayerId }
  | { type: 'bonusMinigameStarted' }
  | { type: 'turnEnded'; playerId: PlayerId }
  | { type: 'roundEnded'; round: number }
  | { type: 'finaleStarted'; contenders: PlayerId[] }
  | { type: 'gameWon'; playerId: PlayerId };

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: IntentError };
