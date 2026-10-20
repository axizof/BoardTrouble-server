import { type Board, distanceToGoal } from '../board/board';
import { progressRanking } from '../game/progress';
import type { GameState, PlayerId } from '../game/types';
import type { Rng } from '../random/rng';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'veryRare' | 'legendary';

export type ItemId =
  | 'turboDie'
  | 'rocket'
  | 'shield'
  | 'firecracker'
  | 'glue'
  | 'reroll'
  | 'blower'
  | 'hourglass'
  | 'pickpocket'
  | 'parachute'
  | 'mirror'
  | 'grapple'
  | 'luckyCharm'
  | 'key'
  | 'mysteryBox'
  | 'joker'
  | 'boardSeal';

export type ItemDefinition = {
  rarity: Rarity;
  /** `self` : sans cible ; `target` : vise un joueur ; `passive` : se déclenche seul. */
  use: 'self' | 'target' | 'passive';
};

export const ITEMS: Record<ItemId, ItemDefinition> = {
  turboDie: { rarity: 'common', use: 'self' },
  rocket: { rarity: 'common', use: 'self' },
  shield: { rarity: 'common', use: 'passive' },
  firecracker: { rarity: 'common', use: 'self' },
  glue: { rarity: 'uncommon', use: 'self' },
  reroll: { rarity: 'uncommon', use: 'self' },
  blower: { rarity: 'uncommon', use: 'target' },
  hourglass: { rarity: 'uncommon', use: 'target' },
  pickpocket: { rarity: 'uncommon', use: 'target' },
  /** Empêche la prochaine chute. Il se déclenche seul. */
  parachute: { rarity: 'uncommon', use: 'passive' },
  mirror: { rarity: 'rare', use: 'self' },
  grapple: { rarity: 'rare', use: 'target' },
  /** Porte-bonheur : la roue du Cachot passe à 60 %. Il se déclenche seul. */
  luckyCharm: { rarity: 'rare', use: 'passive' },
  key: { rarity: 'veryRare', use: 'passive' },
  /** Un objet au hasard, ou un petit TROUBLE sur soi. */
  mysteryBox: { rarity: 'common', use: 'self' },
  /** Choisir le prochain mini-jeu de manche parmi 3. */
  joker: { rarity: 'rare', use: 'self' },
  /** Déclencher tout de suite un événement TROUBLE choisi parmi 3. */
  boardSeal: { rarity: 'legendary', use: 'self' },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

/** Valeur d'un objet : le "meilleur objet" (Taxe du Plateau), ce qu'un bot jette en premier. */
export const ITEM_VALUE: Record<ItemId, number> = {
  firecracker: 2,
  turboDie: 3,
  rocket: 3,
  glue: 3,
  reroll: 3,
  pickpocket: 3,
  parachute: 3,
  shield: 4,
  blower: 4,
  hourglass: 4,
  mirror: 5,
  grapple: 6,
  luckyCharm: 4,
  key: 6,
  mysteryBox: 2,
  joker: 3,
  boardSeal: 6,
};
export const INVENTORY_SIZE = 3;

const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'veryRare', 'legendary'];

/**
 * Poids de chaque rareté. `catchUp` (0 à 1) vaut 0 pour le premier et monte pour les
 * joueurs loin derrière : un coup de pouce, jamais du légendaire à coup sûr.
 */
export function rarityWeights(catchUp: number): Record<Rarity, number> {
  return {
    common: 50 - 25 * catchUp,
    uncommon: 30,
    rare: 14 + 12 * catchUp,
    veryRare: 5 + 8 * catchUp,
    legendary: 1 + 3 * catchUp,
  };
}

/** Écart (en cases) à partir duquel un joueur en retard reçoit tout le coup de pouce. */
const FULL_CATCH_UP_GAP = 30;

/** 0 pour le premier ; jusqu'à 1 pour le dernier, s'il est loin derrière. */
export function catchUpFactor(board: Board, state: GameState, playerId: PlayerId): number {
  const ranking = progressRanking(board, state);
  const rank = ranking.indexOf(playerId);
  if (rank <= 0 || ranking.length < 2) return 0;
  const position = (id: PlayerId | undefined) =>
    distanceToGoal(board, state.players.find((player) => player.id === id)?.position ?? '');
  const gap = (position(playerId) - position(ranking[0])) / FULL_CATCH_UP_GAP;
  return (rank / (ranking.length - 1)) * Math.min(1, Math.max(0, gap));
}

/** Tire un objet. `minRarity` limite le tirage aux raretés au moins égales (coffre). */
export function drawItem(rng: Rng, catchUp: number, minRarity: Rarity = 'common'): ItemId {
  const weights = rarityWeights(catchUp);
  const available = RARITIES.slice(RARITIES.indexOf(minRarity)).filter((rarity) =>
    ITEM_IDS.some((item) => ITEMS[item].rarity === rarity),
  );
  const total = available.reduce((sum, rarity) => sum + weights[rarity], 0);
  let roll = rng.next() * total;
  let rarity = available[available.length - 1];
  for (const candidate of available) {
    roll -= weights[candidate];
    if (roll < 0) {
      rarity = candidate;
      break;
    }
  }
  return rng.pick(ITEM_IDS.filter((item) => ITEMS[item].rarity === rarity));
}
