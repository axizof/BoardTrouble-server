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
import { ArenaRun, isArenaMinigame } from '../minigames/arena/arenaRun';
import type { MinigameId } from '../minigames/catalog';
import { Rng } from '../random/rng';
import { animationTime } from './pacing';
import { placeholderSystemIntent } from './placeholder';
import { type HostMessage, PROTOCOL_VERSION, type SeatView } from './protocol';

/** Qui contrôle une place : un humain, ou un bot de ce niveau. */
export type SeatControl = 'human' | BotLevel;

/** Une place de la partie : qui la contrôle, et son apparence. */
export type Seat = { control: SeatControl; appearance: Appearance };

export type SessionOptions = {
  /**
   * Temps pour décider, en millisecondes, ou null sans limite (le solo : on joue quand on veut ;
   * en multi, réglable dans le salon).
   */
  decisionTime: number | null;
};

/**
 * Un bot décide vite, mais on le voit "réfléchir" : le temps de voir où il en est avant qu'il
 * lance, et un peu plus quand il a un vrai choix à faire (voie, coffre, cible, objet...). À
 * l'ouverture (intro, tirage de l'ordre), tout le monde agit en même temps : les bots, vite.
 */
const BOT_ROLL_TIME = 1600;
const BOT_CHOICE_TIME = 2400;
const BOT_OPENING_TIME = 700;
/**
 * Durée d'un mini-jeu provisoire (voir `placeholderSystemIntent`), quand on ne l'attend pas :
 * en multi avec un chrono, ou entre bots. Sans limite de temps (le solo), l'hôte attend que
 * chaque humain ait lu sa présentation ("Suivant").
 */
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
  /** Le mini-jeu d'arène en cours, ou null. */
  #arena: ArenaRun | null = null;
  /** Les humains qui ont lu la présentation du mini-jeu provisoire en cours. */
  readonly #minigameReady = new Set<PlayerId>();

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

  /**
   * Heure de la prochaine action automatique, ou null s'il n'y en a pas : partie finie, ou un
   * humain qui a tout son temps (l'hôte attend qu'il joue).
   */
  nextWakeAt(): number | null {
    const actor = this.#actor();
    if (actor === null) return null;
    if (actor.type === 'system') {
      if (this.#arenaToPlay()) return this.#arena ? this.#arena.nextWakeAt() : this.#readyAt;
      return this.#placeholderWakeAt();
    }
    if (this.seats[actor.playerId]?.control !== 'human') {
      return this.#readyAt + botThinkTime(this.#state);
    }
    const decisionTime = this.#decisionTime();
    return decisionTime === null ? null : this.#readyAt + decisionTime;
  }

  /**
   * Joue l'action automatique si son heure est venue : décision d'un bot, choix par défaut
   * d'un joueur dont le chrono est écoulé, pas d'un mini-jeu d'arène, résultat provisoire des
   * autres mini-jeux. Renvoie ses événements (une liste vide si seule l'arène a avancé), ou null
   * s'il n'y avait rien à jouer.
   */
  tick(now: number): GameEvent[] | null {
    const wake = this.nextWakeAt();
    const actor = this.#actor();
    if (wake === null || actor === null || now < wake) return null;
    const arena = actor.type === 'system' ? this.#arenaToPlay() : null;
    if (arena) return this.#playArena(arena, now);
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
    if (actor.type === 'system') this.#minigameReady.clear();
    return result.events;
  }

  /** Un joueur a lu la présentation d'un mini-jeu provisoire ("Suivant"). */
  minigameReady(player: PlayerId): void {
    if (this.#isPlaceholderMinigame() && this.seats[player]?.control === 'human') {
      this.#minigameReady.add(player);
    }
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

  /** Un joueur envoie ses commandes d'arène. */
  arenaInput(player: PlayerId, input: unknown): void {
    this.#arena?.setInput(player, input);
  }

  /** Un joueur se dit prêt, à la présentation d'un mini-jeu d'arène. */
  arenaReady(player: PlayerId, now: number): void {
    this.#arena?.setReady(player, now);
  }

  /** Le message du mini-jeu d'arène en cours (null s'il n'y en a pas). Tout y est public. */
  arenaMessage(now: number): HostMessage {
    return { type: 'arena', run: this.#arena?.view(now) ?? null };
  }

  get isPlayingArena(): boolean {
    return this.#arena !== null;
  }

  /** Le mini-jeu d'arène que la partie attend, et qui le joue ; null sinon. */
  #arenaToPlay(): { minigame: MinigameId; players: PlayerId[] } | null {
    const { phase } = this.#state;
    if (phase.type === 'minigame' || phase.type === 'bonusMinigame') {
      return isArenaMinigame(phase.minigame)
        ? { minigame: phase.minigame, players: this.#state.players.map((player) => player.id) }
        : null;
    }
    if (phase.type === 'finale' && isArenaMinigame(phase.minigame)) {
      return { minigame: phase.minigame, players: phase.contenders };
    }
    return null;
  }

  /** Lance l'arène une fois les animations jouées, la fait avancer, puis rend son classement. */
  #playArena(to: { minigame: MinigameId; players: PlayerId[] }, now: number): GameEvent[] {
    if (!isArenaMinigame(to.minigame)) return [];
    if (!this.#arena) {
      const bots = new Map(
        to.players.flatMap((id): [PlayerId, BotLevel][] => {
          const control = this.seats[id]?.control;
          return control && control !== 'human' ? [[id, control]] : [];
        }),
      );
      this.#arena = new ArenaRun(to.minigame, to.players, bots, this.#botRng.int(1, 1e9), now);
      return [];
    }
    this.#arena.advance(now, this.#botRng);
    const ranking = this.#arena.ranking;
    if (!ranking || !this.#arena.isDone(now)) return [];
    this.#arena = null;
    const { phase } = this.#state;
    const intent: Intent =
      phase.type === 'finale'
        ? { type: 'submitFinaleResult', ranking }
        : phase.type === 'bonusMinigame'
          ? { type: 'submitBonusMinigameResult', ranking }
          : { type: 'submitMinigameResult', ranking };
    const result = this.submit({ type: 'system' }, intent, now);
    if (!result.ok) throw new Error(`Classement d'arène refusé : ${result.error}`);
    return result.events;
  }

  /**
   * Quand tirer le résultat provisoire : dès que tous les humains ont lu la présentation ;
   * sinon, sans limite de temps, on les attend ; avec un chrono (ou entre bots), au bout de
   * PLACEHOLDER_MINIGAME_TIME.
   */
  #placeholderWakeAt(): number | null {
    const automatic = this.#readyAt + PLACEHOLDER_MINIGAME_TIME;
    if (!this.#isPlaceholderMinigame()) return automatic;
    const humans = Object.keys(this.seats).filter((id) => this.seats[id]?.control === 'human');
    if (humans.length === 0) return automatic;
    if (humans.every((id) => this.#minigameReady.has(id))) return this.#readyAt;
    return this.#options.decisionTime === null ? null : automatic;
  }

  /** La partie attend le résultat d'un mini-jeu provisoire, dont le client montre la présentation. */
  #isPlaceholderMinigame(): boolean {
    const { phase } = this.#state;
    if (phase.type === 'minigame' || phase.type === 'bonusMinigame' || phase.type === 'finale') {
      return !isArenaMinigame(phase.minigame);
    }
    return (
      phase.type === 'turn' &&
      ['awaitDuelResult', 'awaitOneVsAllResult', 'awaitSkillGate'].includes(phase.step.type)
    );
  }

  #decisionEndsIn(now: number): number | null {
    const actor = this.#actor();
    if (actor?.type !== 'player' || this.seats[actor.playerId]?.control !== 'human') return null;
    const decisionTime = this.#decisionTime();
    return decisionTime === null ? null : this.#readyAt + decisionTime - now;
  }

  /** Qui l'hôte fait jouer ou attend. Quand tout le monde agit en même temps, les bots d'abord. */
  #actor(): Actor | null {
    const bot = pendingPlayers(this.#state)?.find((id) => this.seats[id]?.control !== 'human');
    return bot ? { type: 'player', playerId: bot } : whoMustAct(this.#state);
  }

  #decisionTime(): number | null {
    if (this.#options.decisionTime === null) return null;
    return this.#state.phase.type === 'intro' ? INTRO_TIME : this.#options.decisionTime;
  }

  #levelOf(playerId: PlayerId): BotLevel {
    const control = this.seats[playerId]?.control;
    return control === undefined || control === 'human' ? STAND_IN_LEVEL : control;
  }
}

/** Le temps de "réflexion" d'un bot avant son action, selon ce qu'il a à faire. */
function botThinkTime(state: GameState): number {
  const { phase } = state;
  if (phase.type === 'intro' || phase.type === 'orderRoll') return BOT_OPENING_TIME;
  if (phase.type === 'turn' && phase.step.type === 'awaitRoll') return BOT_ROLL_TIME;
  return BOT_CHOICE_TIME;
}
