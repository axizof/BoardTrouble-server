import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import type { MinigameId } from '../catalog';
import { PAWN_SUMO, type SumoState } from '../pawnSumo/pawnSumo';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT, sanitizeInput } from './arena';

// Une partie d'arène hébergée (02-mini-jeux.md, section 1 : présentation, "Prêt", décompte,
// jeu, résultat). Comme la session, elle ne lance aucun minuteur : l'hôte lui donne l'heure.

/** Les arènes jouables. Les autres mini-jeux restent tirés au hasard en attendant. */
export const ARENAS = { pawnSumo: PAWN_SUMO } satisfies Partial<
  Record<MinigameId, ArenaGame<SumoState>>
>;
export type ArenaMinigame = keyof typeof ARENAS;

export function isArenaMinigame(minigame: MinigameId): minigame is ArenaMinigame {
  return minigame in ARENAS;
}

export type ArenaStage = 'intro' | 'countdown' | 'play' | 'result';

/** Durées des étapes, en millisecondes. */
export const ARENA_TIMES = {
  /** La présentation et le bac à sable, au plus : elle finit dès que tout le monde est prêt. */
  intro: 30_000,
  /** Entre bots seulement (le labo moteur), la présentation est courte. */
  botsIntro: 3000,
  countdown: 3000,
  result: 6000,
} as const;

/** Ce que les clients voient de la partie d'arène (tout y est public). */
export type ArenaRunView = {
  minigame: ArenaMinigame;
  stage: ArenaStage;
  /** Millisecondes avant la fin de l'étape, au moment de l'envoi ; null pendant le jeu. */
  stageEndsIn: number | null;
  players: PlayerId[];
  ready: PlayerId[];
  arena: SumoState;
  ranking: PlayerId[][] | null;
};

export class ArenaRun {
  readonly minigame: ArenaMinigame;
  readonly players: PlayerId[];
  readonly #game: ArenaGame<SumoState>;
  readonly #bots: Map<PlayerId, BotLevel>;
  readonly #ready = new Set<PlayerId>();
  readonly #inputs = new Map<PlayerId, ArenaInput>();
  #stage: ArenaStage = 'intro';
  /** Fin de l'étape en cours (heure de l'hôte) ; pendant le jeu, son début. */
  #stageAt: number;
  #state: SumoState;
  #ranking: PlayerId[][] | null = null;

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
    this.#stageAt = now + (isBotsOnly ? ARENA_TIMES.botsIntro : ARENA_TIMES.intro);
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

  /** L'heure à laquelle l'hôte doit rappeler `advance`. */
  nextWakeAt(): number {
    if (this.#stage !== 'play') return this.#stageAt;
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
        this.#stage = 'result';
        this.#stageAt = now + ARENA_TIMES.result;
      }
    }
  }

  /** Le résultat a été montré : le classement peut partir au moteur. */
  isDone(now: number): boolean {
    return this.#ranking !== null && this.#stage === 'result' && now >= this.#stageAt;
  }

  /** Le classement complet, une fois la partie finie ; null avant. */
  get ranking(): PlayerId[][] | null {
    return this.#ranking;
  }

  view(now: number): ArenaRunView {
    return {
      minigame: this.minigame,
      stage: this.#stage,
      stageEndsIn: this.#stage === 'play' ? null : Math.max(0, this.#stageAt - now),
      players: this.players,
      ready: [...this.#ready],
      arena: this.#state,
      ranking: this.#ranking,
    };
  }

  #startCountdown(now: number): void {
    this.#stage = 'countdown';
    this.#stageAt = now + ARENA_TIMES.countdown;
  }
}
