import {
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
  whoMustAct,
} from '@board-trouble/core';

/** Probabilité de bien jouer un mini-jeu, selon le niveau (performance moyenne simulée). */
const MINIGAME_SKILL: Record<BotLevel, number> = { easy: 0.35, normal: 0.5, expert: 0.7 };
const MINIGAME_NOISE = 0.35;
const SKILL_GATE_SUCCESS: Record<BotLevel, number> = { easy: 0.4, normal: 0.6, expert: 0.8 };
const MAX_INTENTS = 20_000;

export type GameRecord = {
  rounds: number;
  turns: number;
  winner: PlayerId;
  winnerLevel: BotLevel;
  leaderChanges: number;
  /** Premier au classement quand le leader a parcouru les trois quarts du chemin. */
  leaderAtThreeQuarters: PlayerId | null;
  falls: number;
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
  let falls = 0;

  for (let i = 0; i < MAX_INTENTS && state.phase.type !== 'finished'; i++) {
    const { phase } = state;
    const actor = whoMustAct(state);
    if (!actor) break;
    let intent: Intent | null;
    if (actor.type === 'player') {
      intent = chooseBoardIntent(
        board,
        state,
        actor.playerId,
        levelOf.get(actor.playerId) ?? 'normal',
        rng,
      );
      if (intent?.type === 'roll') turns++;
    } else if (phase.type === 'turn' && phase.step.type === 'awaitSkillGate') {
      // Défi solo de 10 s : réussi selon le niveau (01-mini-jeux, défis solo).
      const level = levelOf.get(phase.playerId) ?? 'normal';
      intent = { type: 'submitSkillGateResult', success: rng.chance(SKILL_GATE_SUCCESS[level]) };
    } else if (phase.type === 'turn' && phase.step.type === 'awaitWheel') {
      intent = { type: 'submitWheelResult', segment: rng.int(0, phase.step.segments.length - 1) };
    } else if (phase.type === 'turn' && phase.step.type === 'awaitDuelResult') {
      const [winner] =
        simulateMinigame([phase.playerId, phase.step.opponent], levelOf, rng)[0] ?? [];
      intent = { type: 'submitDuelResult', winner: winner ?? null };
    } else if (phase.type === 'turn') {
      // 1 contre tous : le joueur seul gagne environ une fois sur trois, plus s'il est fort.
      const skill = MINIGAME_SKILL[levelOf.get(phase.playerId) ?? 'normal'];
      intent = { type: 'submitOneVsAllResult', soloWon: rng.chance(skill * 0.7) };
    } else if (phase.type === 'finale') {
      intent = {
        type: 'submitFinaleResult',
        ranking: simulateMinigame(phase.contenders, levelOf, rng),
      };
    } else {
      const ranking = simulateMinigame(
        state.players.map((player) => player.id),
        levelOf,
        rng,
      );
      intent =
        phase.type === 'bonusMinigame'
          ? { type: 'submitBonusMinigameResult', ranking }
          : { type: 'submitMinigameResult', ranking };
    }
    if (!intent) throw new Error(`Aucune décision possible (phase ${phase.type})`);

    const result = applyIntent(board, state, actor, intent);
    if (!result.ok) throw new Error(`Intention refusée par le moteur : ${result.error}`);
    state = result.state;
    falls += result.events.filter((event) => event.type === 'fell').length;

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
    falls,
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
