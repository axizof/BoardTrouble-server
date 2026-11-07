import {
  type Board,
  type BotLevel,
  distanceToGoal,
  GameSession,
  type GameState,
  ITEMS,
  type MinigameId,
  type MinigameOccasion,
  naturalAppearance,
  type PlayerId,
  progressRanking,
  type Seat,
  type TableSize,
} from '@board-trouble/core';

// Une partie entière entre bots, jouée par la vraie session de jeu (celle du solo et du serveur)
// avec une horloge virtuelle : les vrais mini-jeux d'arène et leurs bots, les vrais temps
// d'animation et de réflexion. Rien n'est modélisé à part, sauf le temps de lecture humain.

/** Au-delà, la partie est arrêtée : une partie sans fin serait un bug. */
const MAX_WAKES = 2_000_000;
const SPECTATOR = { type: 'spectator' } as const;

export type ArenaPlayed = { minigame: MinigameId; occasion: MinigameOccasion; seconds: number };

export type GameRecord = {
  rounds: number;
  winner: PlayerId;
  winnerLevel: BotLevel;
  /** Durée de la partie entre bots (secondes), et la part passée dans les mini-jeux. */
  seconds: number;
  arenas: ArenaPlayed[];
  leaderChanges: number;
  /** Premier au classement quand le leader a parcouru les trois quarts du chemin. */
  leaderAtThreeQuarters: PlayerId | null;
  falls: number;
  troubleWakes: number;
  grandExchanges: number;
  legendaryItems: number;
  /** Chaque 1 contre tous (le joueur seul a-t-il gagné ?) et chaque porte d'adresse (réussie ?). */
  oneVsAll: boolean[];
  skillGates: boolean[];
};

export function simulateGame(board: Board, levels: BotLevel[], seed: number): GameRecord {
  const players = levels.map((_, index) => ({ id: `p${index}`, name: `Bot ${index}` }));
  const levelOf = new Map(players.map(({ id }, index) => [id, levels[index] ?? 'normal']));
  const seats = Object.fromEntries(
    players.map(({ id }): [PlayerId, Seat] => [
      id,
      { control: levelOf.get(id) ?? 'normal', appearance: naturalAppearance('fox') },
    ]),
  );
  const { session } = GameSession.create(
    board,
    { players, tableSize: levels.length as TableSize, seed },
    seats,
    { decisionTime: null },
    0,
  );

  const startDistance = distanceToGoal(board, board.definition.start);
  const record: Omit<GameRecord, 'rounds' | 'winner' | 'winnerLevel' | 'seconds'> = {
    arenas: [],
    leaderChanges: 0,
    leaderAtThreeQuarters: null,
    falls: 0,
    troubleWakes: 0,
    grandExchanges: 0,
    legendaryItems: 0,
    oneVsAll: [],
    skillGates: [],
  };
  let state = stateOf(session, 0);
  let leader = progressRanking(board, state)[0];
  let arena: { minigame: MinigameId; occasion: MinigameOccasion; start: number } | null = null;
  let now = 0;

  for (let wakes = 0; !session.isFinished; wakes++) {
    const wake = session.nextWakeAt();
    if (wake === null || wakes > MAX_WAKES) throw new Error(`Partie bloquée (graine ${seed})`);
    now = wake;
    const events = session.tick(now) ?? [];
    if (session.isPlayingArena && arena === null) arena = arenaAt(session, now);
    if (!session.isPlayingArena && arena !== null) {
      const { minigame, occasion, start } = arena;
      record.arenas.push({ minigame, occasion, seconds: (now - start) / 1000 });
      arena = null;
    }
    if (events.length === 0) continue;
    for (const event of events) {
      if (event.type === 'oneVsAllEnded') record.oneVsAll.push(event.soloWon);
      if (event.type === 'skillGateResult') record.skillGates.push(event.success);
      if (event.type === 'fell') record.falls++;
      if (event.type === 'troubleAwakened') record.troubleWakes++;
      if (event.type === 'troubleApplied' && event.event === 'grandExchange') {
        record.grandExchanges++;
      }
      if (event.type === 'itemGained' && ITEMS[event.item].rarity === 'legendary') {
        record.legendaryItems++;
      }
    }
    if (!events.some((event) => event.type === 'roundEnded')) continue;
    state = stateOf(session, now);
    const [newLeader] = progressRanking(board, state);
    if (newLeader !== leader) record.leaderChanges++;
    leader = newLeader;
    if (record.leaderAtThreeQuarters === null && newLeader !== undefined) {
      const progress = 1 - distanceOf(board, state, newLeader) / startDistance;
      if (progress >= 0.75) record.leaderAtThreeQuarters = newLeader;
    }
  }

  state = stateOf(session, now);
  if (state.phase.type !== 'finished') throw new Error(`Partie non terminée (graine ${seed})`);
  const { winner } = state.phase;
  return {
    ...record,
    rounds: state.round,
    winner,
    winnerLevel: levelOf.get(winner) ?? 'normal',
    seconds: now / 1000,
  };
}

/** Le mini-jeu d'arène qui commence, et à quelle occasion (d'après la phase de la partie). */
function arenaAt(
  session: GameSession,
  now: number,
): { minigame: MinigameId; occasion: MinigameOccasion; start: number } {
  const message = session.arenaMessage(SPECTATOR, now);
  if (message.type !== 'arena' || !message.run) throw new Error("Pas d'arène en cours");
  const { phase } = stateOf(session, now);
  const occasion: MinigameOccasion =
    phase.type === 'finale'
      ? 'finale'
      : phase.type !== 'turn'
        ? 'round'
        : phase.step.type === 'awaitDuelResult'
          ? 'duel'
          : phase.step.type === 'awaitSkillGate'
            ? 'solo'
            : 'oneVsAll';
  return { minigame: message.run.minigame, occasion, start: now };
}

/** L'état vu par un spectateur : tout ce qui compte ici (positions, phase) y est public. */
function stateOf(session: GameSession, now: number): GameState {
  const message = session.update(SPECTATOR, [], now);
  if (message.type !== 'events') throw new Error('Message de suite attendu');
  return message.state;
}

function distanceOf(board: Board, state: GameState, id: PlayerId): number {
  const player = state.players.find((candidate) => candidate.id === id);
  return player ? distanceToGoal(board, player.position) : 0;
}
