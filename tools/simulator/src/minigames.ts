// Simulateur des mini-jeux d'arène : bun run simulate:minigames -- [--games 100] [--minigame rampart]
// Chaque mini-jeu d'arène, entre bots, à 4 et à 6 joueurs (à 2 pour un duel). Un mini-jeu
// classique se joue à une table aux niveaux mélangés : on regarde qui gagne selon son niveau.
// Un 1 contre tous se joue à niveau égal des deux côtés : on regarde si le joueur seul gagne.
// Un défi solo (la porte d'adresse) se joue seul : on regarde combien de fois il est réussi.
// Un nouveau mini-jeu d'arène (ARENAS) est simulé sans rien ajouter ici.
import {
  ARENA_STEP,
  ARENAS,
  type ArenaGame,
  type ArenaMinigame,
  type ArenaState,
  type BotLevel,
  MINIGAMES,
  type PlayerId,
  Rng,
} from '@board-trouble/core';

const LEVELS: BotLevel[] = ['easy', 'normal', 'expert'];
/** Les niveaux d'une table mélangée, place par place. */
const MIXED: Record<number, BotLevel[]> = {
  2: ['normal', 'expert'],
  4: ['easy', 'normal', 'normal', 'expert'],
  6: ['easy', 'easy', 'normal', 'normal', 'expert', 'expert'],
};
/** Au-delà, une partie est arrêtée (un mini-jeu sans fin serait un bug). */
const MAX_SECONDS = 600;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
}
const games = Number(args.get('--games') ?? 100);
const only = args.get('--minigame') ?? null;

type Played = { ranking: PlayerId[][]; seconds: number; succeeded: boolean | null };

/** Une partie entre bots, jusqu'à la fin. */
function play(
  game: ArenaGame<ArenaState>,
  levels: BotLevel[],
  seed: number,
  solo: PlayerId | null,
): Played {
  const players = levels.map((_, index) => `p${index}`);
  const rng = new Rng(seed);
  let state = game.create(players, { practice: false, seed, solo });
  while (!game.isOver(state) && state.tick * ARENA_STEP < MAX_SECONDS) {
    const current = state;
    const inputs = Object.fromEntries(
      players.map((id, index) => [id, game.botInput(current, id, levels[index] ?? 'normal', rng)]),
    );
    state = game.step(state, inputs);
  }
  return {
    ranking: game.ranking(state),
    seconds: state.tick * ARENA_STEP,
    succeeded: game.succeeded?.(state) ?? null,
  };
}

const percent = (part: number, total: number) =>
  `${Math.round((part / total) * 100)} %`.padStart(5);

function simulate(minigame: ArenaMinigame): void {
  const game = ARENAS[minigame] as ArenaGame<ArenaState>;
  const { occasions } = MINIGAMES[minigame];
  console.log(`\n${minigame}`);
  if (occasions.includes('solo')) {
    const cells = LEVELS.map((level) => {
      let wins = 0;
      let seconds = 0;
      for (let seed = 1; seed <= games; seed++) {
        const played = play(game, [level], seed, null);
        if (played.succeeded) wins += 1;
        seconds += played.seconds;
      }
      return `${level} ${percent(wins, games)} (${(seconds / games).toFixed(0)} s)`;
    });
    console.log(`  réussi seul : ${cells.join(' | ')}`);
    return;
  }
  const tables = occasions.includes('duel') ? [2] : [4, 6];
  for (const table of tables) {
    if (occasions.includes('oneVsAll')) {
      const cells = LEVELS.map((level) => {
        let soloWins = 0;
        let seconds = 0;
        for (let seed = 1; seed <= games; seed++) {
          const played = play(game, Array(table).fill(level), seed, 'p0');
          if (played.ranking[0]?.includes('p0')) soloWins += 1;
          seconds += played.seconds;
        }
        return `${level} ${percent(soloWins, games)} (${(seconds / games).toFixed(0)} s)`;
      });
      console.log(`  à ${table}, le joueur seul gagne : ${cells.join(' | ')}`);
      continue;
    }
    const levels = MIXED[table] ?? [];
    const wins = new Map<BotLevel, number>();
    let seconds = 0;
    let tiedTop = 0;
    for (let seed = 1; seed <= games; seed++) {
      const played = play(game, levels, seed, null);
      seconds += played.seconds;
      const first = played.ranking[0] ?? [];
      if (first.length > 1) tiedTop += 1;
      // Des premiers ex aequo se partagent la victoire.
      for (const id of first) {
        const level = levels[Number(id.slice(1))] ?? 'normal';
        wins.set(level, (wins.get(level) ?? 0) + 1 / first.length);
      }
    }
    // La part des victoires d'un bot de ce niveau (par place : il y en a parfois plusieurs).
    const perSeat = LEVELS.filter((level) => levels.includes(level)).map((level) => {
      const seats = levels.filter((one) => one === level).length;
      return `${level} ${percent((wins.get(level) ?? 0) / seats, games)}`;
    });
    console.log(
      `  à ${table} (${levels.join(', ')}) : victoires par place ${perSeat.join(' | ')}, ` +
        `${(seconds / games).toFixed(0)} s, premiers ex aequo ${percent(tiedTop, games)}`,
    );
  }
}

const minigames = Object.keys(ARENAS) as ArenaMinigame[];
console.log(`${games} parties par réglage.`);
for (const minigame of minigames) {
  if (only === null || only === minigame) simulate(minigame);
}
