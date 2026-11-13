// Mini-jeux qui peuvent être tirés : le premier lot de 02-mini-jeux.md (section 8), puis le lot 2
// (section 10), au fur et à mesure qu'ils sont construits.
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
  | 'clayShoot'
  | 'lastRoll'
  | 'perfectGauge'
  | 'combination'
  | 'conveyorSort'
  | 'fallingPlates'
  | 'skyPhoto'
  | 'ridgeRide'
  | 'offPiste'
  | 'greatCrossing'
  | 'hotPotato'
  | 'pileUp'
  | 'hamsterBall'
  | 'tumbleDown'
  | 'penaltyKicks'
  | 'chifoumi';

/** Moment où l'on joue un mini-jeu. Une manche peut tirer un chacun pour soi ou un jeu d'équipes. */
export type MinigameOccasion = 'round' | 'oneVsAll' | 'duel' | 'finale' | 'solo';

export type MinigameDefinition = {
  occasions: MinigameOccasion[];
  /** Pour une finale : nombre de finalistes possible. */
  finalists?: { min: number; max: number };
  /** Sa chance d'être tiré, face aux autres (1 par défaut). */
  weight?: number;
  /** Ses mondes (des décors au choix), s'il en a plusieurs : tirés de la graine (minigameWorld). */
  worlds?: number;
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
  clayShoot: { occasions: ['duel', 'finale'], finalists: { min: 2, max: 2 } },
  lastRoll: { occasions: ['finale'], finalists: { min: 2, max: 6 } },
  perfectGauge: { occasions: ['solo'] },
  combination: { occasions: ['solo'] },
  conveyorSort: { occasions: ['round'] },
  // De la chance pure : il ne doit pas sortir trop souvent.
  fallingPlates: { occasions: ['round'], weight: 0.5 },
  skyPhoto: { occasions: ['round'] },
  ridgeRide: { occasions: ['round'] },
  offPiste: { occasions: ['round'] },
  greatCrossing: { occasions: ['round', 'finale'], finalists: { min: 2, max: 6 } },
  hotPotato: { occasions: ['round', 'finale'], finalists: { min: 3, max: 6 } },
  pileUp: { occasions: ['round'] },
  hamsterBall: { occasions: ['round'] },
  tumbleDown: { occasions: ['round'], worlds: 2 },
  penaltyKicks: { occasions: ['oneVsAll'] },
  chifoumi: { occasions: ['finale'], finalists: { min: 2, max: 2 } },
};

export const MINIGAME_IDS = Object.keys(MINIGAMES) as MinigameId[];

/**
 * Le monde d'un mini-jeu qui en a plusieurs, tiré de la graine de la partie : en partie, il
 * tombe au hasard ; pour en choisir un (le menu Mini-jeux), on choisit une graine qui y mène.
 */
export function minigameWorld(seed: number, worlds: number): number {
  return ((Math.floor(seed) % worlds) + worlds) % worlds;
}

/** Mini-jeux jouables à cette occasion, avec `players` joueurs (compte pour une finale). */
export function minigameCandidates(occasion: MinigameOccasion, players: number): MinigameId[] {
  return MINIGAME_IDS.filter((id) => {
    const { occasions, finalists } = MINIGAMES[id];
    if (!occasions.includes(occasion)) return false;
    if (occasion !== 'finale') return true;
    return finalists !== undefined && players >= finalists.min && players <= finalists.max;
  });
}
