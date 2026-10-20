// Simulateur d'équilibrage : bun run simulate -- [--games 2000] [--table 4|6] [--seed 1]
import { type BotLevel, buildMontTrouble, prepareBoard, type TableSize } from '@board-trouble/core';
import { type GameRecord, simulateGame } from './simulate';

// Estimation de durée réelle : mini-jeu avec sa présentation, et un tour animé.
const MINIGAME_SECONDS = 110;
/**
 * Même avantage à 4 et à 6 : l'Expert gagne 2 à 3,7 fois plus souvent que chaque Normal
 * (03-equilibrage.md, mesure 10).
 */
const EXPERT_TARGET: Record<TableSize, string> = { 4: '40 à 55 %', 6: '30 à 42 %' };
const TURN_SECONDS = 15;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i] ?? '', process.argv[i + 1] ?? '');
}
const games = Number(args.get('--games') ?? 2000);
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

function report(title: string, records: GameRecord[]): void {
  const rounds = records.map((record) => record.rounds).sort((a, b) => a - b);
  const minutes = records.map(
    (record) => ((record.rounds - 1) * MINIGAME_SECONDS + record.turns * TURN_SECONDS) / 60,
  );
  const withLeader = records.filter((record) => record.leaderAtThreeQuarters !== null);
  const leaderWins = withLeader.filter((record) => record.leaderAtThreeQuarters === record.winner);
  const expertGames = records.filter((record) => record.winnerLevel === 'expert').length;

  console.log(`== ${title}`);
  console.log(
    `  Manches        : moyenne ${average(rounds).toFixed(1)}  (10 % : ${percentile(rounds, 0.1)}, médiane : ${percentile(rounds, 0.5)}, 90 % : ${percentile(rounds, 0.9)})`,
  );
  console.log(`  Durée estimée  : ${average(minutes).toFixed(0)} min en moyenne`);
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
