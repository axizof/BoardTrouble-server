import type { SpaceId, SpaceKind, WheelSegment } from '../board/board';
import type {
  BonusDie,
  DiceRoll,
  SpecialDieKind,
  SpecialDieUse,
  TableSize,
  TieBreak,
} from '../dice/dice';
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
  /** Dernier joueur qui l'a fait reculer, et de combien de cases (pour la Vendetta). */
  lastAttack: { by: PlayerId; spaces: number } | null;
  /**
   * Au Cachot des Filous : tours passés, avancée sur le chemin intérieur, et case de
   * l'enlèvement (`position` y reste, le pion n'est plus sur le plateau). null : libre.
   */
  jail: { turns: number; progress: number } | null;
  /** Bourse à dés : 3 dés spéciaux au plus, séparés des objets. */
  specialDice: SpecialDieKind[];
};

/** Interactions qui demandent de choisir un adversaire. */
export type TargetedInteraction = 'magnet' | 'steal' | 'duel';

/** Ce qui a causé un effet hostile venant d'un joueur : un objet ou une interaction. */
export type HostileVia = ItemId | TargetedInteraction;

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
  | { type: 'awaitItemSwap'; offered: ItemId; source: ItemSource; resume: Resume }
  /** Case d'interaction : choisir l'adversaire. */
  | { type: 'awaitTarget'; interaction: TargetedInteraction; options: PlayerId[]; resume: Resume }
  /** Duel ou Vendetta en cours : en attente du résultat du mini-jeu. */
  | { type: 'awaitDuelResult'; opponent: PlayerId; kind: 'duel' | 'vendetta'; resume: Resume }
  /** 1 contre tous en cours : en attente du résultat du mini-jeu. */
  | { type: 'awaitOneVsAllResult'; resume: Resume }
  /** Au Cachot : avancer sur le chemin intérieur ou tenter la roue. */
  | { type: 'awaitJailChoice' }
  /** Sortie du Cachot : choisir l'une des trois trappes. */
  | { type: 'awaitTrapdoor' }
  /** Deux portes : choisir un passage. `remaining` : cases restantes après la porte. */
  | { type: 'awaitDoor'; remaining: number }
  /**
   * Péage : payer un objet ou tenter le seuil. `roll` : total déjà lancé ce tour (tentative en
   * début de tour), ou null (arrivée pendant un déplacement : on relancera).
   */
  | { type: 'awaitToll'; remaining: number; roll: number | null }
  /** Porte d'adresse : en attente du résultat du mini-défi (fourni par le serveur). */
  | { type: 'awaitSkillGate'; remaining: number }
  /**
   * Roue : en attente de l'issue (le serveur la déduit du timing du joueur). Les issues sont
   * notées au déclenchement : sous le Brouillard, la case n'est pas celle du plateau.
   */
  | { type: 'awaitWheel'; segments: WheelSegment[]; resume: Resume }
  /** Pari : choisir sur qui parier et combien. */
  | { type: 'awaitBet'; resume: Resume }
  /** Bourse à dés pleine : jeter un dé pour prendre le nouveau, ou le refuser. */
  | { type: 'awaitSpecialDieSwap'; offered: SpecialDieKind; resume: Resume };

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
  /** Dé spécial joué ce tour (la Relance relance avec le même dé). */
  special: SpecialDieUse | null;
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
  /** Paris en cours sur le vainqueur du prochain mini-jeu. */
  bets: { playerId: PlayerId; on: PlayerId; stake: number }[];
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
  | { type: 'chooseTarget'; playerId: PlayerId }
  /** Résultat d'un duel : le gagnant, ou null en cas d'égalité. */
  | { type: 'submitDuelResult'; winner: PlayerId | null }
  | { type: 'submitOneVsAllResult'; soloWon: boolean }
  | { type: 'chooseJailAction'; action: 'advance' | 'wheel' }
  | { type: 'chooseTrapdoor'; trapdoor: 0 | 1 | 2 }
  | { type: 'chooseDoor'; door: 0 | 1 }
  /** Péage : l'objet à payer, ou null pour tenter le seuil aux dés. */
  | { type: 'payToll'; item: ItemId | null }
  | { type: 'submitSkillGateResult'; success: boolean }
  /** Issue de la roue : l'index du segment où elle s'est arrêtée. */
  | { type: 'submitWheelResult'; segment: number }
  | { type: 'placeBet'; on: PlayerId; stake: number }
  /** `discard` : le dé à jeter, ou le dé proposé pour le refuser. */
  | { type: 'resolveSpecialDieSwap'; discard: SpecialDieKind }
  | { type: 'useItem'; item: ItemId; target?: PlayerId }
  /**
   * Lancer. `specialDie` : jouer un dé de sa bourse à la place du dé normal ; `call` : le
   * chiffre annoncé pour le Dé Piégé.
   */
  | { type: 'roll'; specialDie?: SpecialDieKind; call?: number }
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

export type ItemSource =
  | 'itemSpace'
  | 'chest'
  | 'rest'
  | 'pickpocket'
  | 'steal'
  | 'trouble'
  | 'roundEvent';

/** Faces du dé géant. */
export type GiantDieFace = 'bird' | 'monster' | 'item' | 'squall' | 'trouble' | 'specialDie';

/** Petits événements de fin de manche, sur un joueur au hasard. */
export type RoundEventId = 'bird' | 'hole' | 'foundItem' | 'foundSpecialDie';

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
  | { type: 'mirrorReflected'; playerId: PlayerId; attacker: PlayerId; via: HostileVia }
  | { type: 'shieldBlocked'; playerId: PlayerId }
  | { type: 'trapPlaced'; playerId: PlayerId; spaceId: SpaceId; trap: Trap['type'] }
  | { type: 'trapTriggered'; playerId: PlayerId; spaceId: SpaceId; trap: Trap['type'] }
  | { type: 'itemStolen'; playerId: PlayerId; victim: PlayerId; item: ItemId }
  | { type: 'bonusDieLost'; playerId: PlayerId }
  | { type: 'swapped'; playerId: PlayerId; with: PlayerId }
  | { type: 'squallHit'; playerId: PlayerId; spaces: number }
  | {
      type: 'targetChosen';
      playerId: PlayerId;
      target: PlayerId;
      interaction: TargetedInteraction | 'squall' | 'swap';
    }
  | { type: 'duelStarted'; challenger: PlayerId; opponent: PlayerId; kind: 'duel' | 'vendetta' }
  | { type: 'duelEnded'; winner: PlayerId | null }
  | { type: 'oneVsAllStarted'; solo: PlayerId }
  | { type: 'oneVsAllEnded'; solo: PlayerId; soloWon: boolean }
  | { type: 'kidnapped'; playerId: PlayerId; spaceId: SpaceId }
  | { type: 'jailTurn'; playerId: PlayerId; turn: number; automaticExit: boolean }
  | { type: 'jailAdvanced'; playerId: PlayerId; progress: number; length: number }
  | { type: 'jailWheel'; playerId: PlayerId; chance: number; success: boolean }
  | { type: 'trapdoorOpened'; playerId: PlayerId; trapdoor: 0 | 1 | 2; offset: number }
  | { type: 'released'; playerId: PlayerId; spaceId: SpaceId }
  | { type: 'doorOpened'; playerId: PlayerId; door: 0 | 1; trapped: boolean }
  | { type: 'tollPaid'; playerId: PlayerId; item: ItemId }
  | { type: 'skillGateResult'; playerId: PlayerId; success: boolean }
  | { type: 'boulderRolled'; playerId: PlayerId; spaceId: SpaceId; pushed: PlayerId[]; to: SpaceId }
  | {
      type: 'teleported';
      playerId: PlayerId;
      from: SpaceId;
      to: SpaceId;
      via: 'elevator' | 'freightLift' | 'slide' | 'teleporter';
    }
  | { type: 'seesawLaunched'; playerId: PlayerId; launched: PlayerId[] }
  | { type: 'giantDieRolled'; playerId: PlayerId; face: GiantDieFace }
  | { type: 'wheelStopped'; playerId: PlayerId; segment: number }
  | { type: 'betPlaced'; playerId: PlayerId; on: PlayerId; stake: number }
  | { type: 'betResolved'; playerId: PlayerId; on: PlayerId; stake: number; won: boolean }
  | { type: 'specialDieGained'; playerId: PlayerId; die: SpecialDieKind }
  | { type: 'specialDieRefused'; playerId: PlayerId; die: SpecialDieKind }
  | { type: 'specialDieDiscarded'; playerId: PlayerId; die: SpecialDieKind }
  | { type: 'specialDieTrapped'; playerId: PlayerId }
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
