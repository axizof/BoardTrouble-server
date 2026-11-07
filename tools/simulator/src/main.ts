// Simulateur d'équilibrage : bun run simulate -- [--games 300] [--table 4|6] [--seed 1]
import {
  ARENA_TIMES,
  type BotLevel,
  buildMontTrouble,
  type MinigameOccasion,
  prepareBoard,
  type TableSize,
} from '@board-trouble/core';
import { type GameRecord, simulateGame } from './simulate';

/**
 * Un humain lit la présentation d'un mini-jeu et essaie le bac à sable avant "Prêt" : on compte
 * 20 s (hypothèse), là où une table de bots la passe en ARENA_TIMES.botsIntro.
 */
const HUMAN_INTRO_SECONDS = 20;
/**
 * Même avantage à 4 et à 6 : l'Expert gagne 2 à 3,7 fois plus souvent que chaque Normal
 * (03-equilibrage.md, mesure 10).
 */
const EXPERT_TARGET: Record<TableSize, string> = { 4: '40 à 55 %', 6: '30 à 42 %' };
const OCCASIONS: { occasion: MinigameOccasion; name: string }[] = [
  { occasion: 'round', name: 'manches' },
  { occasion: 'oneVsAll', name: '1 contre tous' },
  { occasion: 'duel', name: 'duels' },
  { occasion: 'solo', name: "portes d'adresse" },
  { occasion: 'finale', name: 'finale' },
];

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
}
const games = Number(args.get('--games') ?? 300);
const tableSize = Number(args.get('--table') ?? 4) as TableSize;
const seed = Number(args.get('--seed') ?? 1);
if (tableSize !== 4 && tableSize !== 6) throw new Error('--table doit valoir 4 ou 6');

const board = prepareBoard(buildMontTrouble());
const pathLength = board.distanceToGoal.get(board.definition.start) ?? 0;

console.log(
  `Plateau : ${board.definition.name}, ${Object.keys(board.definition.spaces).length} cases`,
);
console.log(
  `Chemin le plus court : ${pathLength} cases. Table de ${tableSize}, ${games} parties par scénario.\n`,
);

const normals: BotLevel[] = Array.from({ length: tableSize }, () => 'normal');
const oneExpert: BotLevel[] = ['expert', ...normals.slice(1)];

report('Tous Normaux', run(normals));
report('Un Expert contre des Normaux', run(oneExpert));

function run(levels: BotLevel[]): GameRecord[] {
  return Array.from({ length: games }, (_, index) =>
    simulateGame(board, levels, seed * 100_000 + index),
  );
}

/** La durée avec des humains : celle des bots, plus leur lecture de chaque présentation. */
function humanMinutes(record: GameRecord): number {
  const extraIntro = HUMAN_INTRO_SECONDS - ARENA_TIMES.botsIntro / 1000;
  return (record.seconds + record.arenas.length * extraIntro) / 60;
}

function report(title: string, records: GameRecord[]): void {
  const rounds = records.map((record) => record.rounds).sort((a, b) => a - b);
  const minutes = records.map(humanMinutes).sort((a, b) => a - b);
  const arenaSeconds = records.map((record) =>
    record.arenas.reduce((sum, arena) => sum + arena.seconds, 0),
  );
  const withLeader = records.filter((record) => record.leaderAtThreeQuarters !== null);
  const leaderWins = withLeader.filter((record) => record.leaderAtThreeQuarters === record.winner);
  const expertGames = records.filter((record) => record.winnerLevel === 'expert').length;
  const oneVsAll = records.flatMap((record) => record.oneVsAll);
  const skillGates = records.flatMap((record) => record.skillGates);

  console.log(`== ${title}`);
  console.log(
    `  Manches        : moyenne ${average(rounds).toFixed(1)}  (10 % : ${percentile(rounds, 0.1)}, médiane : ${percentile(rounds, 0.5)}, 90 % : ${percentile(rounds, 0.9)})`,
  );
  console.log(
    `  Durée          : ${average(minutes).toFixed(0)} min avec des humains (10 % : ${percentile(minutes, 0.1).toFixed(0)}, 90 % : ${percentile(minutes, 0.9).toFixed(0)}) ; entre bots ${average(records.map((record) => record.seconds / 60)).toFixed(0)} min, dont ${percent(average(arenaSeconds), average(records.map((record) => record.seconds)))} en mini-jeux`,
  );
  const perOccasion = OCCASIONS.map(({ occasion, name }) => {
    const played = records.flatMap((record) =>
      record.arenas.filter((arena) => arena.occasion === occasion),
    );
    const seconds = average(played.map((arena) => arena.seconds));
    return `${(played.length / records.length).toFixed(1)} ${name} (${seconds.toFixed(0)} s)`;
  });
  console.log(`  Mini-jeux      : ${perOccasion.join(', ')} par partie`);
  console.log(
    `  1 contre tous  : le joueur seul gagne ${percent(oneVsAll.filter(Boolean).length, oneVsAll.length)} ; portes d'adresse réussies : ${percent(skillGates.filter(Boolean).length, skillGates.length)}`,
  );
  console.log(
    `  Leaders        : ${average(records.map((record) => record.leaderChanges)).toFixed(1)} changements par partie`,
  );
  console.log(
    `  Leader aux 3/4 : gagne ${percent(leaderWins.length, withLeader.length)} des parties (cible : 50 à 65 %)`,
  );
  console.log(
    `  Chutes         : ${average(records.map((record) => record.falls)).toFixed(1)} par partie`,
  );
  console.log(
    `  TROUBLE        : ${average(records.map((record) => record.troubleWakes)).toFixed(1)} réveils par partie, Grand Échange dans ${percent(records.filter((record) => record.grandExchanges > 0).length, records.length)} des parties`,
  );
  console.log(
    `  Objets         : ${average(records.map((record) => record.legendaryItems)).toFixed(2)} objet légendaire par partie`,
  );
  if (expertGames > 0) {
    console.log(
      `  Expert         : gagne ${percent(expertGames, records.length)} des parties (cible : ${EXPERT_TARGET[tableSize]})`,
    );
  }
  console.log('');
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function percent(part: number, total: number): string {
  return `${total === 0 ? 0 : Math.round((part / total) * 100)} %`;
}
