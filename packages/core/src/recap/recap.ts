import type { Board } from '../board/board';
import { progressRanking } from '../game/progress';
import type { GameState, PlayerId } from '../game/types';
import type { ChronicleMoment, GameChronicle, PlayerChronicle } from './chronicle';

// Le récap de fin de partie (01-vision-et-plateau.md, section 18) : classement final, graphe,
// titres, score de partie et stats, tirés de la chronique. Tout y est public : la partie est
// finie, plus rien n'est caché.

export const TITLES = [
  'minigameKing',
  'blackCat',
  'scourge',
  'thief',
  'freeFall',
  'rocket',
  'jailRegular',
  'comeback',
  'goldenHand',
  'cursedHand',
  'duelist',
  'chaosAgent',
] as const;
export type TitleId = (typeof TITLES)[number];

export type AwardedTitle = { title: TitleId; playerId: PlayerId; value: number };

export type GameRecap = {
  /** Du gagnant au dernier : le gagnant, puis les autres selon leur avancée. */
  ranking: PlayerId[];
  rounds: number;
  players: Record<PlayerId, PlayerChronicle>;
  moments: ChronicleMoment[];
  titles: AwardedTitle[];
  scores: Record<PlayerId, ScoreDetail>;
};

/** Le score de partie, à part du classement : d'où viennent ses points. */
export type ScoreDetail = {
  total: number;
  minigames: number;
  duels: number;
  progress: number;
  harm: number;
  items: number;
};

/** Points du score de partie (gagner tous les mini-jeux sans gagner la partie se voit). */
const SCORE = {
  minigameWon: 10,
  duelWon: 6,
  /** Par case gagnée, et par case fait perdre aux autres. */
  spaceGained: 0.5,
  spaceInflicted: 1,
  itemUsed: 2,
} as const;

/** Les lancers qu'il faut pour juger une moyenne aux dés. */
const MIN_ROLLS = 5;

/**
 * Chaque titre : la valeur d'un joueur (plus haut = plus mérité), et le minimum pour l'avoir.
 * Un titre n'est donné qu'à un seul joueur : en cas d'égalité au meilleur, personne ne l'a.
 */
const TITLE_RULES: Record<
  TitleId,
  {
    value: (mine: PlayerChronicle, finalRank: number, players: number) => number | null;
    minimum: number;
  }
> = {
  minigameKing: { value: (mine) => mine.minigamesWon, minimum: 2 },
  blackCat: { value: (mine) => mine.spacesLostToLuck, minimum: 15 },
  scourge: { value: (mine) => mine.spacesInflicted, minimum: 12 },
  thief: { value: (mine) => mine.swapsAndThefts, minimum: 2 },
  freeFall: { value: (mine) => mine.biggestFall, minimum: 5 },
  rocket: { value: (mine) => mine.biggestJump, minimum: 20 },
  jailRegular: { value: (mine) => mine.jailStays, minimum: 2 },
  comeback: { value: comebackOf, minimum: 2 },
  goldenHand: { value: (mine) => averageRoll(mine), minimum: 0 },
  // La pire moyenne : la valeur est inversée pour que "plus haut" reste "plus mérité".
  cursedHand: {
    value: (mine) => {
      const average = averageRoll(mine);
      return average === null ? null : -average;
    },
    minimum: Number.NEGATIVE_INFINITY,
  },
  duelist: { value: (mine) => mine.duelsWon, minimum: 2 },
  chaosAgent: { value: (mine) => mine.troublesChosen, minimum: 2 },
};

export function recapOf(board: Board, state: GameState, chronicle: GameChronicle): GameRecap {
  const winner = state.phase.type === 'finished' ? state.phase.winner : null;
  const others = progressRanking(board, state).filter((id) => id !== winner);
  const ranking = winner === null ? others : [winner, ...others];
  const entries = ranking.flatMap((id): [PlayerId, PlayerChronicle][] => {
    const mine = chronicle.players[id];
    return mine ? [[id, mine]] : [];
  });
  return {
    ranking,
    rounds: state.round,
    players: Object.fromEntries(entries),
    moments: chronicle.moments,
    titles: awardTitles(entries, ranking),
    scores: Object.fromEntries(entries.map(([id, mine]) => [id, scoreOf(mine)])),
  };
}

function awardTitles(entries: [PlayerId, PlayerChronicle][], ranking: PlayerId[]): AwardedTitle[] {
  return TITLES.flatMap((title): AwardedTitle[] => {
    const { value, minimum } = TITLE_RULES[title];
    const values = entries.flatMap(([id, mine]) => {
      const one = value(mine, ranking.indexOf(id) + 1, ranking.length);
      return one === null || one < minimum ? [] : [{ id, value: one }];
    });
    const best = Math.max(...values.map((one) => one.value));
    const leaders = values.filter((one) => one.value === best);
    const [leader] = leaders;
    if (leaders.length !== 1 || !leader) return [];
    // Les moyennes aux dés se montrent telles quelles (la Main maudite était inversée).
    return [{ title, playerId: leader.id, value: Math.abs(leader.value) }];
  });
}

function scoreOf(mine: PlayerChronicle): ScoreDetail {
  const detail = {
    minigames: mine.minigamesWon * SCORE.minigameWon,
    duels: mine.duelsWon * SCORE.duelWon,
    progress: Math.round(mine.spacesGained * SCORE.spaceGained),
    harm: mine.spacesInflicted * SCORE.spaceInflicted,
    items: mine.itemsUsed * SCORE.itemUsed,
  };
  return {
    total: detail.minigames + detail.duels + detail.progress + detail.harm + detail.items,
    ...detail,
  };
}

function averageRoll(mine: PlayerChronicle): number | null {
  return mine.rolls < MIN_ROLLS ? null : Math.round((mine.rollTotal / mine.rolls) * 10) / 10;
}

/**
 * La Remontada : de combien de places il est remonté, s'il a été dernier à la fin d'une manche
 * et finit sur le podium (le départ ne compte pas : tout le monde y est à égalité).
 */
function comebackOf(mine: PlayerChronicle, finalRank: number, players: number): number | null {
  const wasLast = mine.ranks.slice(1).includes(players);
  return wasLast && finalRank <= 3 ? players - finalRank : null;
}
