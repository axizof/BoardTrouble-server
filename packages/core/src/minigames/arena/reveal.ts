import type { PlayerId } from '../../game/types';

// La révélation de fin (retour de test de l'Empileur : le classement tout de suite gâchait la
// fin) : avant le résultat, la caméra passe d'un joueur à l'autre, du dernier au premier. Si les
// deux premiers sont proches, elle hésite entre eux avant de se poser sur le gagnant (suspense) ;
// si le premier écrase les autres, elle file sur lui. Les mini-jeux qui la veulent donnent leur
// score et ce qui est "proche" ou "écrasant" chez eux (ArenaGame.reveal) ; le client cadre
// chaque plan dans sa scène.

/** Ce qu'un mini-jeu donne pour sa révélation : le score de chacun, et ses seuils. */
export type RevealRules<State> = {
  score(state: State, player: PlayerId): number;
  /** Les deux premiers sont proches à cet écart de score ou moins : suspense. */
  close: number;
  /** Le premier a au moins cet écart d'avance sur le deuxième : il écrase. */
  crushing: number;
};

/**
 * Un plan : les joueurs montrés (un groupe d'ex aequo), leur place (0 : premier), sa durée.
 * `duel` : la caméra hésite entre les deux premiers (le deuxième d'abord dans `players`) ;
 * `winner` : elle se pose sur le gagnant.
 */
export type RevealShot = {
  kind: 'place' | 'duel' | 'winner';
  players: PlayerId[];
  place: number;
  ms: number;
};

export type RevealPlan = {
  /** `close` : suspense entre les deux premiers ; `crushing` : le premier a écrasé les autres. */
  mood: 'normal' | 'close' | 'crushing';
  shots: RevealShot[];
};

/** Les durées des plans (ms) : un plan ordinaire, plus court quand le premier écrase. */
export const REVEAL_TIMES = { place: 1400, quick: 900, duel: 2600, winner: 2400 } as const;

/** Le plan de la révélation, d'après le classement (meilleur d'abord, ex aequo groupés). */
export function planReveal(
  ranking: PlayerId[][],
  score: (player: PlayerId) => number,
  rules: Pick<RevealRules<unknown>, 'close' | 'crushing'>,
): RevealPlan {
  const [first, second] = ranking;
  if (!first) return { mood: 'normal', shots: [] };
  const top = first[0] === undefined ? 0 : score(first[0]);
  const next = second?.[0] === undefined ? null : score(second[0]);
  const gap = next === null ? Number.POSITIVE_INFINITY : top - next;
  const mood = !second
    ? 'normal'
    : gap <= rules.close
      ? 'close'
      : gap >= rules.crushing
        ? 'crushing'
        : 'normal';
  const shots: RevealShot[] = [];
  // Les places, du dernier au troisième (au deuxième, sans suspense).
  let place = ranking.reduce((count, group) => count + group.length, 0);
  for (let index = ranking.length - 1; index >= 1; index--) {
    const group = ranking[index] ?? [];
    place -= group.length;
    if (index === 1 && mood === 'close') break;
    const ms = mood === 'crushing' ? REVEAL_TIMES.quick : REVEAL_TIMES.place;
    shots.push({ kind: 'place', players: group, place, ms });
  }
  if (mood === 'close' && second) {
    shots.push({ kind: 'duel', players: [...second, ...first], place: 0, ms: REVEAL_TIMES.duel });
  }
  shots.push({ kind: 'winner', players: first, place: 0, ms: REVEAL_TIMES.winner });
  return { mood, shots };
}

/** La durée de toute la révélation (ms). */
export function revealDuration(plan: RevealPlan): number {
  return plan.shots.reduce((total, shot) => total + shot.ms, 0);
}

/**
 * Le plan montré `elapsed` ms après le début de la révélation, son rang dans le plan, et où il en
 * est (0 à 1) ; le dernier plan reste une fois fini.
 */
export function revealShotAt(
  plan: RevealPlan,
  elapsed: number,
): { shot: RevealShot; index: number; progress: number } | null {
  let start = 0;
  for (const [index, shot] of plan.shots.entries()) {
    const isLast = index === plan.shots.length - 1;
    if (elapsed < start + shot.ms || isLast) {
      return { shot, index, progress: Math.min(1, Math.max(0, (elapsed - start) / shot.ms)) };
    }
    start += shot.ms;
  }
  return null;
}
