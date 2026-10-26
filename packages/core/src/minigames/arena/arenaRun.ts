import type { BotLevel } from '../../bots/boardBot';
import { breakTies, type TieBreak } from '../../dice/dice';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { BOARD_REFLEX } from '../boardReflex/boardReflex';
import type { MinigameId } from '../catalog';
import { MELTING_PLATFORM } from '../meltingPlatform/meltingPlatform';
import { PAWN_SUMO } from '../pawnSumo/pawnSumo';
import { SPINNING_BAR } from '../spinningBar/spinningBar';
import {
  ARENA_STEP,
  type ArenaGame,
  type ArenaInput,
  type ArenaState,
  IDLE_INPUT,
  sanitizeInput,
} from './arena';

// Une partie d'arène hébergée (02-mini-jeux.md, section 1 : présentation, "Prêt", décompte,
// jeu, résultat). Comme la session, elle ne lance aucun minuteur : l'hôte lui donne l'heure.

/** Les arènes jouables. Les autres mini-jeux restent tirés au hasard en attendant. */
export const ARENAS = {
  pawnSumo: PAWN_SUMO,
  meltingPlatform: MELTING_PLATFORM,
  spinningBar: SPINNING_BAR,
  boardReflex: BOARD_REFLEX,
} satisfies Partial<Record<MinigameId, ArenaGame<ArenaState>>>;
export type ArenaMinigame = keyof typeof ARENAS;
/** L'état de chaque arène jouable. */
export type ArenaStates = {
  [M in ArenaMinigame]: (typeof ARENAS)[M] extends ArenaGame<infer State> ? State : never;
};

export function isArenaMinigame(minigame: MinigameId): minigame is ArenaMinigame {
  return minigame in ARENAS;
}

export type ArenaStage = 'intro' | 'countdown' | 'play' | 'result';

/**
 * Durées des étapes, en millisecondes. La présentation n'a pas de limite : on prend le temps de
 * comprendre le jeu, et elle finit quand tout le monde est prêt (en multi, l'hôte pourra la
 * lancer sans attendre un retardataire).
 */
export const ARENA_TIMES = {
  /** Entre bots seulement (le labo moteur), la présentation est courte. */
  botsIntro: 3000,
  countdown: 3000,
  result: 6000,
  /** Chaque lancer de départage des ex aequo allonge le résultat de tant (il se montre). */
  tieRoll: 2200,
} as const;

/**
 * Ce que les clients voient de la partie d'arène (tout y est public) : le mini-jeu et son état
 * vont ensemble (`minigame` dit de quelle arène est `arena`).
 */
export type ArenaRunView = {
  [M in ArenaMinigame]: { minigame: M; arena: ArenaStates[M] };
}[ArenaMinigame] & {
  stage: ArenaStage;
  /** Millisecondes avant la fin de l'étape, au moment de l'envoi ; null pendant le jeu. */
  stageEndsIn: number | null;
  players: PlayerId[];
  ready: PlayerId[];
  /** Le classement du mini-jeu, ex aequo groupés (ce qu'affiche le résultat d'abord). */
  ranking: PlayerId[][] | null;
  /** Les lancers qui départagent les ex aequo, dans l'ordre où les montrer, et l'ordre final. */
  tieBreaks: TieBreak[];
  order: PlayerId[] | null;
};

export class ArenaRun {
  readonly minigame: ArenaMinigame;
  readonly players: PlayerId[];
  readonly #game: ArenaGame<ArenaState>;
  readonly #bots: Map<PlayerId, BotLevel>;
  readonly #ready = new Set<PlayerId>();
  readonly #inputs = new Map<PlayerId, ArenaInput>();
  #stage: ArenaStage = 'intro';
  /** Fin de l'étape en cours (heure de l'hôte), l'infini pour une présentation sans limite ; pendant le jeu, son début. */
  #stageAt: number;
  #state: ArenaState;
  #ranking: PlayerId[][] | null = null;
  #tieBreaks: TieBreak[] = [];
  #order: PlayerId[] | null = null;

  /** `bots` : le niveau de chaque joueur tenu par un bot ; les autres sont des humains. */
  constructor(
    minigame: ArenaMinigame,
    players: PlayerId[],
    bots: Map<PlayerId, BotLevel>,
    seed: number,
    now: number,
  ) {
    this.minigame = minigame;
    this.players = players;
    this.#game = ARENAS[minigame];
    this.#bots = bots;
    for (const id of players) if (bots.has(id)) this.#ready.add(id);
    this.#state = this.#game.create(players, { practice: false, seed });
    const isBotsOnly = players.every((id) => bots.has(id));
    this.#stageAt = isBotsOnly ? now + ARENA_TIMES.botsIntro : Number.POSITIVE_INFINITY;
  }

  get stage(): ArenaStage {
    return this.#stage;
  }

  /** Un humain se dit prêt : quand tout le monde l'est, le décompte commence. */
  setReady(player: PlayerId, now: number): void {
    if (this.#stage !== 'intro' || !this.players.includes(player)) return;
    this.#ready.add(player);
    if (this.#ready.size === this.players.length) this.#startCountdown(now);
  }

  setInput(player: PlayerId, input: unknown): void {
    if (this.players.includes(player) && !this.#bots.has(player)) {
      this.#inputs.set(player, sanitizeInput(input));
    }
  }

  /** L'heure à laquelle l'hôte doit rappeler `advance`, ou null s'il attend les joueurs. */
  nextWakeAt(): number | null {
    if (this.#stage !== 'play') return Number.isFinite(this.#stageAt) ? this.#stageAt : null;
    return this.#stageAt + (this.#state.tick + 1) * ARENA_STEP * 1000;
  }

  /** Avance jusqu'à `now` : étapes, puis pas de simulation (les bots jouent à chaque pas). */
  advance(now: number, rng: Rng): void {
    if (this.#stage === 'intro' && now >= this.#stageAt) this.#startCountdown(now);
    if (this.#stage === 'countdown' && now >= this.#stageAt) this.#stage = 'play';
    if (this.#stage === 'play') {
      // Le pas dû à cette heure (la marge évite qu'un arrondi fasse rater le pas attendu).
      const due = Math.floor((now - this.#stageAt) / (ARENA_STEP * 1000) + 1e-6);
      while (this.#state.tick < due && !this.#game.isOver(this.#state)) {
        const state = this.#state;
        const inputs = Object.fromEntries(
          this.players.map((id) => {
            const level = this.#bots.get(id);
            const input = level
              ? this.#game.botInput(state, id, level, rng)
              : (this.#inputs.get(id) ?? IDLE_INPUT);
            return [id, input];
          }),
        );
        this.#state = this.#game.step(state, inputs);
      }
      if (this.#game.isOver(this.#state)) {
        this.#ranking = this.#game.ranking(this.#state);
        // Les ex aequo se départagent aux dés ici, pour que le résultat le montre ; le moteur
        // reçoit ensuite un classement sans égalité.
        ({ order: this.#order, tieBreaks: this.#tieBreaks } = breakTies(this.#ranking, rng));
        this.#stage = 'result';
        this.#stageAt = now + ARENA_TIMES.result + this.#tieBreaks.length * ARENA_TIMES.tieRoll;
      }
    }
  }

  /** Le résultat a été montré : le classement peut partir au moteur. */
  isDone(now: number): boolean {
    return this.#ranking !== null && this.#stage === 'result' && now >= this.#stageAt;
  }

  /** Le classement final, sans égalité (les ex aequo départagés aux dés), une fois la partie finie ; null avant. */
  get ranking(): PlayerId[][] | null {
    return this.#order?.map((id) => [id]) ?? null;
  }

  view(now: number): ArenaRunView {
    // L'état vient toujours du jeu de ce mini-jeu (ARENAS[minigame]) : la paire est juste, ce
    // que le typage ne peut pas suivre à travers `#game`.
    return {
      minigame: this.minigame,
      stage: this.#stage,
      stageEndsIn:
        this.#stage === 'play' || !Number.isFinite(this.#stageAt)
          ? null
          : Math.max(0, this.#stageAt - now),
      players: this.players,
      ready: [...this.#ready],
      arena: this.#state,
      ranking: this.#ranking,
      tieBreaks: this.#tieBreaks,
      order: this.#order,
    } as ArenaRunView;
  }

  #startCountdown(now: number): void {
    this.#stage = 'countdown';
    this.#stageAt = now + ARENA_TIMES.countdown;
  }
}
