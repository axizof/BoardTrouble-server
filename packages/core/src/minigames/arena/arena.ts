import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import type { RevealRules } from './reveal';

// Les mini-jeux d'arène (01-architecture.md, section 4 : "arène en temps réel") : l'hôte fait
// tourner la simulation à 30 pas par seconde, les joueurs n'envoient que leurs commandes. Chaque
// arène est une simulation pure et déterministe : même état et mêmes commandes, même suite.

/** Pas de simulation, en secondes : 30 par seconde. */
export const ARENA_STEP = 1 / 30;

/**
 * Les commandes d'un joueur, communes à toutes les arènes (02-mini-jeux.md, section 1) :
 * déplacement (flèches, ZQSD ou stick gauche, longueur 0 à 1), action principale (Espace / A)
 * et action secondaire (Maj / B), tenues ou non, et ce qu'il vient de viser à la souris
 * (l'élément cliqué, pour les mini-jeux où l'on choisit : une carte...), ou null.
 */
export type ArenaInput = {
  move: { x: number; z: number };
  primary: boolean;
  secondary: boolean;
  target?: number | null;
};

export const IDLE_INPUT: ArenaInput = { move: { x: 0, z: 0 }, primary: false, secondary: false };

/** Ce que garde toute arène : le pas, le bac à sable ou non, et ses combattants (tombés ou non). */
export type ArenaState = {
  tick: number;
  practice: boolean;
  fighters: readonly { id: PlayerId; fellAt: number | null }[];
};

/** Une arène : comment elle se crée, avance, se joue par un bot et se classe. */
export type ArenaGame<State extends ArenaState> = {
  /**
   * `practice` : le bac à sable de la présentation, sans fin de partie ni danger qui monte.
   * `seed` : propre à chaque partie (ce qui varie d'une partie à l'autre en dépend).
   * `solo` : en 1 contre tous, le joueur seul face aux autres.
   */
  create(
    players: PlayerId[],
    options: { practice: boolean; seed: number; solo?: PlayerId | null },
  ): State;
  step(state: State, inputs: Partial<Record<PlayerId, ArenaInput>>): State;
  botInput(state: State, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput;
  isOver(state: State): boolean;
  /** Les secondes qui restent avant la fin forcée de la partie (le chrono affiché), ou null. */
  timeLeft(state: State): number | null;
  /** Le classement complet, du premier au dernier ; les ex aequo partagent un groupe. */
  ranking(state: State): PlayerId[][];
  /**
   * Ce que ce joueur (ou un spectateur) a le droit de voir de l'état, pour les mini-jeux qui
   * cachent quelque chose (01-architecture.md, section 4 : "le serveur garde la solution").
   * Sans elle, tout est public.
   */
  viewFor?(state: State, viewer: Viewer): State;
  /**
   * Pour les mini-jeux qui finissent par une révélation (la caméra passe du dernier au premier
   * avant le résultat) : le score qu'elle compare, et ses seuils. Sans elle, le résultat tout de
   * suite.
   */
  reveal?: RevealRules<State>;
};

/** La plus grande visée acceptée (un indice d'élément). */
const MAX_TARGET = 255;

/** Remet une commande reçue d'un client dans les bornes (le client n'est jamais cru). */
export function sanitizeInput(input: unknown): ArenaInput {
  if (typeof input !== 'object' || input === null) return IDLE_INPUT;
  const raw = input as Record<string, unknown>;
  const move = (typeof raw.move === 'object' && raw.move !== null ? raw.move : {}) as Record<
    string,
    unknown
  >;
  let x = typeof move.x === 'number' && Number.isFinite(move.x) ? move.x : 0;
  let z = typeof move.z === 'number' && Number.isFinite(move.z) ? move.z : 0;
  const length = Math.hypot(x, z);
  if (length > 1) {
    x /= length;
    z /= length;
  }
  const target =
    typeof raw.target === 'number' && Number.isInteger(raw.target) && raw.target >= 0
      ? Math.min(raw.target, MAX_TARGET)
      : null;
  return {
    move: { x, z },
    primary: raw.primary === true,
    secondary: raw.secondary === true,
    target,
  };
}
