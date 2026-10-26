import { TIE_ROLL_TIME } from '../dice/dice';
import type { GameEvent } from '../game/types';
import { viewEvents } from '../game/views';

// Durée d'animation de chaque événement, en millisecondes : l'hôte n'ouvre la décision
// suivante (bot, chrono) qu'une fois les animations jouées, pour que tout le monde voie la
// même chose au même moment (01-architecture.md, section 5). Valeurs de départ, à recaler
// sur les vraies animations du plateau.
const EVENT_TIME: Record<GameEvent['type'], number> = {
  introEnded: 600,
  // Tout le monde lance en même temps : les dés roulent ensemble, pas l'un après l'autre.
  orderRolled: 400,
  orderDrawn: 3500,
  roundStarted: 1200,
  minigameRanked: 2500,
  // Le bandeau "Au tour de" et la caméra qui rejoint le joueur.
  turnStarted: 1800,
  diceRolled: 1800,
  // Par case parcourue : voir `MOVE_STEP_TIME`.
  moved: 0,
  branchReached: 300,
  gateTested: 1500,
  keyUsed: 1200,
  finalGateOpened: 2500,
  coinFlipped: 1500,
  // Le temps de lire ce que fait la case (le jeu l'annonce à l'écran ; 1,6 s : trop court).
  spaceTriggered: 2400,
  itemGained: 1200,
  itemRefused: 600,
  itemDiscarded: 600,
  itemUsed: 1200,
  // Privés : jamais comptés (voir `animationTime`).
  mirrorArmed: 0,
  mirrorExpired: 0,
  mirrorReflected: 1500,
  shieldBlocked: 1200,
  trapPlaced: 1000,
  trapTriggered: 1200,
  itemStolen: 1500,
  bonusDieLost: 1000,
  swapped: 2000,
  squallHit: 1200,
  targetChosen: 1000,
  duelStarted: 2000,
  duelEnded: 1500,
  oneVsAllStarted: 2000,
  oneVsAllEnded: 1500,
  kidnapped: 2500,
  jailTurn: 1000,
  jailAdvanced: 1200,
  jailWheel: 3000,
  trapdoorOpened: 2000,
  released: 1500,
  doorOpened: 1800,
  tollPaid: 1200,
  skillGateResult: 1500,
  boulderRolled: 3000,
  teleported: 1800,
  seesawLaunched: 1500,
  giantDieRolled: 2500,
  wheelStopped: 1500,
  betPlaced: 1000,
  betResolved: 1200,
  specialDieGained: 1200,
  specialDieRefused: 600,
  specialDieDiscarded: 600,
  specialDieTrapped: 1500,
  fell: 2000,
  parachuteOpened: 1500,
  jostled: 1500,
  conveyorMoved: 800,
  windBlew: 2000,
  // Le ruban tourne 2,2 s, puis on a le temps de voir le mini-jeu tiré.
  minigameDrawn: 4500,
  minigameChoiceOffered: 1000,
  minigameChosen: 1500,
  minigameChoiceGranted: 1500,
  mysteryBoxOpened: 1500,
  chestOpened: 1800,
  rerolled: 1800,
  troubleGauge: 600,
  troubleAwakened: 3500,
  troubleApplied: 2500,
  overlayEnded: 1000,
  roundEvent: 2000,
  bonusMinigameStarted: 2000,
  turnEnded: 300,
  roundEnded: 1000,
  finaleStarted: 3000,
  gameWon: 5000,
};

/** Le personnage marche d'une case à l'autre (environ 6 m) : il prend son temps. */
export const MOVE_STEP_TIME = 800;

/**
 * Le rythme de la partie : chaque moment dure un peu plus que sa durée de base, pour jouer
 * sans être pressé (retour du test solo : "pas en mode rush"). L'ouverture, où tout le monde
 * agit en même temps, garde son rythme.
 */
const PACE = 1.35;
const UNPACED = new Set<GameEvent['type']>(['introEnded', 'orderRolled']);

/**
 * Temps nécessaire pour jouer ces événements. Il est calculé sur ce que voit un spectateur :
 * une action secrète (Miroir activé) ne doit pas se trahir par une pause plus longue.
 */
export function animationTime(events: GameEvent[]): number {
  return viewEvents(events, { type: 'spectator' }).reduce(
    (total, event) => total + eventTime(event),
    0,
  );
}

function eventTime(event: GameEvent): number {
  if (event.type === 'moved') return event.path.length * MOVE_STEP_TIME;
  const base = EVENT_TIME[event.type] * (UNPACED.has(event.type) ? 1 : PACE);
  // Les relances du départage se montrent au rythme du client, sans le PACE.
  return event.type === 'orderDrawn' ? base + event.tieBreaks.length * TIE_ROLL_TIME : base;
}
