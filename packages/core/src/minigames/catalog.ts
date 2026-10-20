// Mini-jeux qui peuvent être tirés : le premier lot de 02-mini-jeux.md (section 8). Les lots
// suivants s'ajoutent ici, au fur et à mesure qu'ils sont construits.
export type MinigameId =
  | 'meltingPlatform'
  | 'pawnSumo'
  | 'spinningBar'
  | 'stacker'
  | 'cardMemory'
  | 'boardReflex'
  | 'secretAuction'
  | 'uniqueStairs'
  | 'rhythmTugOfWar'
  | 'bigDie'
  | 'rampart'
  | 'highNoon'
  | 'lastRoll'
  | 'perfectGauge'
  | 'combination';

/** Moment où l'on joue un mini-jeu. Une manche peut tirer un chacun pour soi ou un jeu d'équipes. */
export type MinigameOccasion = 'round' | 'oneVsAll' | 'duel' | 'finale' | 'solo';

export type MinigameDefinition = {
  occasions: MinigameOccasion[];
  /** Pour une finale : nombre de finalistes possible. */
  finalists?: { min: number; max: number };
};

export const MINIGAMES: Record<MinigameId, MinigameDefinition> = {
  meltingPlatform: { occasions: ['round'] },
  pawnSumo: { occasions: ['round', 'finale'], finalists: { min: 2, max: 6 } },
  spinningBar: { occasions: ['round'] },
  stacker: { occasions: ['round'] },
  cardMemory: { occasions: ['round'] },
  boardReflex: { occasions: ['round'] },
  secretAuction: { occasions: ['round'] },
  uniqueStairs: { occasions: ['round'] },
  rhythmTugOfWar: { occasions: ['round'] },
  bigDie: { occasions: ['oneVsAll'] },
  rampart: { occasions: ['oneVsAll'] },
  highNoon: { occasions: ['duel', 'finale'], finalists: { min: 2, max: 2 } },
  lastRoll: { occasions: ['finale'], finalists: { min: 2, max: 6 } },
  perfectGauge: { occasions: ['solo'] },
  combination: { occasions: ['solo'] },
};

export const MINIGAME_IDS = Object.keys(MINIGAMES) as MinigameId[];

/** Mini-jeux jouables à cette occasion, avec `players` joueurs (compte pour une finale). */
export function minigameCandidates(occasion: MinigameOccasion, players: number): MinigameId[] {
  return MINIGAME_IDS.filter((id) => {
    const { occasions, finalists } = MINIGAMES[id];
    if (!occasions.includes(occasion)) return false;
    if (occasion !== 'finale') return true;
    return finalists !== undefined && players >= finalists.min && players <= finalists.max;
  });
}
