import {
  type Actor,
  applyIntent,
  type Board,
  type BotLevel,
  chooseBoardIntent,
  createGame,
  distanceToGoal,
  type GameState,
  type Intent,
  type PlayerId,
  progressRanking,
  Rng,
  type TableSize,
} from '@board-trouble/core';

/** Probabilité de bien jouer un mini-jeu, selon le niveau (performance moyenne simulée). */
const MINIGAME_SKILL: Record<BotLevel, number> = { easy: 0.35, normal: 0.5, expert: 0.7 };
const MINIGAME_NOISE = 0.35;
const MAX_INTENTS = 20_000;

export type GameRecord = {
  rounds: number;
  turns: number;
  winner: PlayerId;
  winnerLevel: BotLevel;
  leaderChanges: number;
  /** Premier au classement quand le leader a parcouru les trois quarts du chemin. */
  leaderAtThreeQuarters: PlayerId | null;
};

export function simulateGame(board: Board, levels: BotLevel[], seed: number): GameRecord {
  const players = levels.map((_, index) => ({ id: `p${index}`, name: `Bot ${index}` }));
  const levelOf = new Map(players.map(({ id }, index) => [id, levels[index] ?? 'normal']));
  const rng = new Rng(seed);
  let { state } = createGame(board, {
    players,
    tableSize: levels.length as TableSize,
    seed: rng.int(0, 2 ** 31),
  });

  const startDistance = distanceToGoal(board, board.definition.start);
  let turns = 0;
  let leader = progressRanking(board, state)[0];
  let leaderChanges = 0;
  let leaderAtThreeQuarters: PlayerId | null = null;

  for (let i = 0; i < MAX_INTENTS && state.phase.type !== 'finished'; i++) {
    const { phase } = state;
    let intent: Intent;
    let actor: Actor = { type: 'system' };

    if (phase.type === 'minigame') {
      intent = {
        type: 'submitMinigameResult',
        ranking: simulateMinigame(state.turnOrder, levelOf, rng),
      };
    } else if (phase.type === 'finale') {
      intent = {
        type: 'submitFinaleResult',
        ranking: simulateMinigame(phase.contenders, levelOf, rng),
      };
    } else if (phase.type === 'turn') {
      const level = levelOf.get(phase.playerId) ?? 'normal';
      const choice = chooseBoardIntent(board, state, phase.playerId, level, rng);
      if (!choice) throw new Error('Le bot ne sait pas quoi jouer');
      intent = choice;
      actor = { type: 'player', playerId: phase.playerId };
      if (choice.type === 'roll') turns++;
    } else {
      break;
    }

    const result = applyIntent(board, state, actor, intent);
    if (!result.ok) throw new Error(`Intention refusée par le moteur : ${result.error}`);
    state = result.state;

    if (result.events.some((event) => event.type === 'roundEnded')) {
      const [newLeader] = progressRanking(board, state);
      if (newLeader !== leader) leaderChanges++;
      leader = newLeader;
      if (leaderAtThreeQuarters === null && newLeader !== undefined) {
        const progress = 1 - distanceOf(board, state, newLeader) / startDistance;
        if (progress >= 0.75) leaderAtThreeQuarters = newLeader;
      }
    }
  }

  if (state.phase.type !== 'finished') throw new Error(`Partie non terminée (graine ${seed})`);
  const winner = state.phase.winner;
  return {
    rounds: state.round,
    turns,
    winner,
    winnerLevel: levelOf.get(winner) ?? 'normal',
    leaderChanges,
    leaderAtThreeQuarters,
  };
}

function simulateMinigame(
  playerIds: PlayerId[],
  levelOf: Map<PlayerId, BotLevel>,
  rng: Rng,
): PlayerId[][] {
  return playerIds
    .map((id) => ({
      id,
      score: MINIGAME_SKILL[levelOf.get(id) ?? 'normal'] + (rng.next() - 0.5) * 2 * MINIGAME_NOISE,
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ id }) => [id]);
}

function distanceOf(board: Board, state: GameState, id: PlayerId): number {
  const player = state.players.find((candidate) => candidate.id === id);
  return player ? distanceToGoal(board, player.position) : 0;
}
