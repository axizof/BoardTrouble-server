import type { Board } from '../board/board';
import { type BotLevel, chooseBoardIntent } from '../bots/boardBot';
import { pendingPlayers } from '../game/context';
import { applyIntent, openGame, whoMustAct } from '../game/engine';
import type {
  Actor,
  GameConfig,
  GameEvent,
  GameState,
  Intent,
  IntentError,
  PlayerId,
} from '../game/types';
import { type Viewer, viewEvents, viewState } from '../game/views';
import type { Appearance } from '../lobby/players';
import { Rng } from '../random/rng';
import { animationTime } from './pacing';
import { placeholderSystemIntent } from './placeholder';
import { type HostMessage, PROTOCOL_VERSION, type SeatView } from './protocol';

/** Qui contrôle une place : un humain, ou un bot de ce niveau. */
export type SeatControl = 'human' | BotLevel;

/** Une place de la partie : qui la contrôle, et son apparence. */
export type Seat = { control: SeatControl; appearance: Appearance };

export type SessionOptions = {
  /** Temps pour décider, en millisecondes (20 s par défaut, réglable dans le salon). */
  decisionTime: number;
};

/** Un bot décide vite, mais on le voit "réfléchir" un instant. */
const BOT_THINK_TIME = 700;
/** Durée d'un mini-jeu provisoire (voir `placeholderSystemIntent`). */
const PLACEHOLDER_MINIGAME_TIME = 5000;
/** Un joueur qui laisse passer son chrono : l'hôte choisit pour lui, comme un bot Normal. */
const STAND_IN_LEVEL: BotLevel = 'normal';
/** La présentation du plateau dure moins que ça ; au-delà, l'hôte la passe pour le joueur. */
const INTRO_TIME = 45_000;
/** Le hasard des bots est séparé de celui de la partie : il ne change pas les tirages. */
const BOT_SEED_OFFSET = 0x5eed;

export type SubmitResult = { ok: true; events: GameEvent[] } | { ok: false; error: IntentError };

/**
 * Une partie hébergée : l'état complet, les places, et le rythme. Les horloges viennent de
 * l'appelant (`now`, en millisecondes) : la session ne lance aucun minuteur, ce qui la rend
 * testable et utilisable aussi bien dans un Web Worker que sur le serveur. L'hôte appelle
 * `tick` à l'heure donnée par `nextWakeAt` pour faire jouer les bots, les choix par défaut et
 * les mini-jeux provisoires.
 */
export class GameSession {
  readonly board: Board;
  readonly seats: Readonly<Record<PlayerId, Seat>>;
  readonly #options: SessionOptions;
  readonly #botRng: Rng;
  #state: GameState;
  /** Fin des animations en cours : rien d'automatique ne se joue avant. */
  #readyAt: number;

  private constructor(
    board: Board,
    state: GameState,
    seats: Record<PlayerId, Seat>,
    options: SessionOptions,
    seed: number,
    readyAt: number,
  ) {
    this.board = board;
    this.#state = state;
    this.seats = seats;
    this.#options = options;
    this.#botRng = new Rng(seed + BOT_SEED_OFFSET);
    this.#readyAt = readyAt;
  }

  /** Crée la partie : elle commence par la présentation du plateau, puis le tirage de l'ordre. */
  static create(
    board: Board,
    config: GameConfig,
    seats: Record<PlayerId, Seat>,
    options: SessionOptions,
    now: number,
  ): { session: GameSession; events: GameEvent[] } {
    const missing = config.players.filter((player) => seats[player.id] === undefined);
    if (missing.length > 0) throw new Error(`Places sans contrôle : ${missing.map((p) => p.id)}`);
    const state = openGame(board, config);
    return {
      session: new GameSession(board, state, seats, options, config.seed, now),
      events: [],
    };
  }

  get isFinished(): boolean {
    return this.#state.phase.type === 'finished';
  }

  /** Applique l'intention d'un joueur (ou du serveur), puis attend ses animations. */
  submit(actor: Actor, intent: Intent, now: number): SubmitResult {
    const result = applyIntent(this.board, this.#state, actor, intent);
    if (!result.ok) return result;
    this.#state = result.state;
    this.#readyAt = Math.max(now, this.#readyAt) + animationTime(result.events);
    return { ok: true, events: result.events };
  }

  /** Heure de la prochaine action automatique, ou null si la partie est finie. */
  nextWakeAt(): number | null {
    const actor = this.#actor();
    if (actor === null) return null;
    if (actor.type === 'system') return this.#readyAt + PLACEHOLDER_MINIGAME_TIME;
    return this.seats[actor.playerId]?.control === 'human'
      ? this.#readyAt + this.#decisionTime()
      : this.#readyAt + BOT_THINK_TIME;
  }

  /**
   * Joue l'action automatique si son heure est venue : décision d'un bot, choix par défaut
   * d'un joueur dont le chrono est écoulé, résultat provisoire d'un mini-jeu. Renvoie ses
   * événements, ou null s'il n'y avait rien à jouer.
   */
  tick(now: number): GameEvent[] | null {
    const wake = this.nextWakeAt();
    const actor = this.#actor();
    if (wake === null || actor === null || now < wake) return null;
    const intent =
      actor.type === 'system'
        ? placeholderSystemIntent(this.#state, this.#botRng)
        : chooseBoardIntent(
            this.board,
            this.#state,
            actor.playerId,
            this.#levelOf(actor.playerId),
            this.#botRng,
          );
    if (intent === null)
      throw new Error(`Aucune action automatique (phase ${this.#state.phase.type})`);
    const result = this.submit(actor, intent, now);
    if (!result.ok) throw new Error(`Action automatique refusée : ${result.error}`);
    return result.events;
  }

  /** Message d'arrivée dans la partie, pour une place ou un spectateur. */
  snapshot(viewer: Viewer, now: number): HostMessage {
    return {
      type: 'snapshot',
      protocol: PROTOCOL_VERSION,
      board: this.board.definition,
      you: viewer.type === 'player' ? viewer.playerId : null,
      seats: Object.fromEntries(
        Object.entries(this.seats).map(([id, { control, appearance }]): [PlayerId, SeatView] => [
          id,
          { kind: control === 'human' ? 'human' : 'bot', appearance },
        ]),
      ),
      state: viewState(this.#state, viewer),
      decisionEndsIn: this.#decisionEndsIn(now),
    };
  }

  /** Message de suite de partie : les événements que ce client a le droit de voir. */
  update(viewer: Viewer, events: GameEvent[], now: number): HostMessage {
    return {
      type: 'events',
      events: viewEvents(events, viewer),
      state: viewState(this.#state, viewer),
      decisionEndsIn: this.#decisionEndsIn(now),
    };
  }

  #decisionEndsIn(now: number): number | null {
    const actor = this.#actor();
    if (actor?.type !== 'player' || this.seats[actor.playerId]?.control !== 'human') return null;
    return this.#readyAt + this.#decisionTime() - now;
  }

  /** Qui l'hôte fait jouer ou attend. Quand tout le monde agit en même temps, les bots d'abord. */
  #actor(): Actor | null {
    const bot = pendingPlayers(this.#state)?.find((id) => this.seats[id]?.control !== 'human');
    return bot ? { type: 'player', playerId: bot } : whoMustAct(this.#state);
  }

  #decisionTime(): number {
    return this.#state.phase.type === 'intro' ? INTRO_TIME : this.#options.decisionTime;
  }

  #levelOf(playerId: PlayerId): BotLevel {
    const control = this.seats[playerId]?.control;
    return control === undefined || control === 'human' ? STAND_IN_LEVEL : control;
  }
}
