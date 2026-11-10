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
import { ArenaRun } from '../minigames/arena/arenaRun';
import type { MinigameId } from '../minigames/catalog';
import { Rng } from '../random/rng';
import { type GameChronicle, recordAction, startChronicle } from '../recap/chronicle';
import { recapOf } from '../recap/recap';
import { animationTime } from './pacing';
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
 * La Roue tourne ce temps-là avant que l'hôte tire sa case au hasard. Elle deviendra un test de
 * timing à arrêter soi-même (CLAUDE.md, "À ne pas oublier").
 */
const WHEEL_TIME = 5000;
/** Un joueur qui laisse passer son chrono : l'hôte choisit pour lui, comme un bot Normal. */
const STAND_IN_LEVEL: BotLevel = 'normal';
/** La présentation du plateau dure moins que ça ; au-delà, l'hôte la passe pour le joueur. */
const INTRO_TIME = 45_000;
/** Le hasard des bots est séparé de celui de la partie : il ne change pas les tirages. */
const BOT_SEED_OFFSET = 0x5eed;

export type SubmitResult = { ok: true; events: GameEvent[] } | { ok: false; error: IntentError };

/** Version du format de sauvegarde : une sauvegarde d'une autre version n'est pas chargée. */
export const SESSION_SAVE_VERSION = 1;

/**
 * Une partie sauvegardée (01-architecture.md, section 9) : de quoi la reprendre. Un mini-jeu
 * d'arène en cours n'y est pas : il recommence au début à la reprise.
 */
export type SessionSave = {
  version: typeof SESSION_SAVE_VERSION;
  boardId: string;
  state: GameState;
  seats: Record<PlayerId, Seat>;
  options: SessionOptions;
  chronicle: GameChronicle;
};

/** Un mini-jeu d'arène à jouer : qui y joue, et le joueur seul d'un 1 contre tous (ou null). */
type ArenaToPlay = { minigame: MinigameId; players: PlayerId[]; solo: PlayerId | null };

/**
 * Une partie hébergée : l'état complet, les places, et le rythme. Les horloges viennent de
 * l'appelant (`now`, en millisecondes) : la session ne lance aucun minuteur, ce qui la rend
 * testable et utilisable aussi bien dans un Web Worker que sur le serveur. L'hôte appelle
 * `tick` à l'heure donnée par `nextWakeAt` pour faire jouer les bots, les choix par défaut, les
 * mini-jeux et la Roue.
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
  /** Ce que le récap montrera à la fin. */
  #chronicle: GameChronicle;

  private constructor(
    board: Board,
    state: GameState,
    seats: Record<PlayerId, Seat>,
    options: SessionOptions,
    seed: number,
    readyAt: number,
    chronicle: GameChronicle,
  ) {
    this.board = board;
    this.#state = state;
    this.seats = seats;
    this.#options = options;
    this.#botRng = new Rng(seed + BOT_SEED_OFFSET);
    this.#readyAt = readyAt;
    this.#chronicle = chronicle;
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
    const chronicle = startChronicle(board, state);
    return {
      session: new GameSession(board, state, seats, options, config.seed, now, chronicle),
      events: [],
    };
  }

  /**
   * Reprend une partie sauvegardée, à l'heure `now` ; lève une erreur si la sauvegarde n'est pas
   * de ce format ou de ce plateau (elle n'est jamais chargée à moitié).
   */
  static restore(board: Board, save: SessionSave, now: number): GameSession {
    if (save.version !== SESSION_SAVE_VERSION) {
      throw new Error(`Sauvegarde d'une autre version (${save.version})`);
    }
    if (save.boardId !== board.definition.id) {
      throw new Error(`Sauvegarde d'un autre plateau (${save.boardId})`);
    }
    const { state, seats, options, chronicle } = structuredClone(save);
    // Les sauvegardes d'avant le Piolet n'ont pas ce champ.
    for (const player of state.players) player.iceAxeUntil ??= null;
    // Le hasard des bots repart de celui de la partie : il ne change pas les tirages.
    return new GameSession(board, state, seats, options, state.rngState, now, chronicle);
  }

  /** La partie à sauvegarder, telle qu'elle est maintenant (sans l'arène en cours). */
  toSave(): SessionSave {
    return structuredClone({
      version: SESSION_SAVE_VERSION,
      boardId: this.board.definition.id,
      state: this.#state,
      seats: this.seats,
      options: this.#options,
      chronicle: this.#chronicle,
    });
  }

  get isFinished(): boolean {
    return this.#state.phase.type === 'finished';
  }

  /** Applique l'intention d'un joueur (ou du serveur), puis attend ses animations. */
  submit(actor: Actor, intent: Intent, now: number): SubmitResult {
    const result = applyIntent(this.board, this.#state, actor, intent);
    if (!result.ok) return result;
    this.#chronicle = recordAction(
      this.#chronicle,
      this.board,
      actor,
      this.#state,
      result.state,
      result.events,
    );
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
      return this.#readyAt + WHEEL_TIME;
    }
    if (this.seats[actor.playerId]?.control !== 'human') {
      return this.#readyAt + botThinkTime(this.#state);
    }
    const decisionTime = this.#decisionTime();
    return decisionTime === null ? null : this.#readyAt + decisionTime;
  }

  /**
   * Joue l'action automatique si son heure est venue : décision d'un bot, choix par défaut
   * d'un joueur dont le chrono est écoulé, pas d'un mini-jeu d'arène, case de la Roue. Renvoie ses événements (une liste vide si seule l'arène a avancé), ou null
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
        ? this.#wheelIntent()
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

  /** Le récap de fin de partie (tout y est public), une fois la partie finie ; sinon null. */
  recapMessage(): HostMessage | null {
    if (!this.isFinished) return null;
    return { type: 'recap', recap: recapOf(this.board, this.#state, this.#chronicle) };
  }

  /** Un joueur envoie ses commandes d'arène. */
  arenaInput(player: PlayerId, input: unknown): void {
    this.#arena?.setInput(player, input);
  }

  /** Un joueur se dit prêt, à la présentation d'un mini-jeu d'arène. */
  arenaReady(player: PlayerId, now: number): void {
    this.#arena?.setReady(player, now);
  }

  /**
   * Le message du mini-jeu d'arène en cours pour `viewer` (null s'il n'y en a pas) : tout y est
   * public, sauf ce que le mini-jeu cache à ce joueur.
   */
  arenaMessage(viewer: Viewer, now: number): HostMessage {
    return { type: 'arena', run: this.#arena?.view(now, viewer) ?? null };
  }

  get isPlayingArena(): boolean {
    return this.#arena !== null;
  }

  /**
   * Le mini-jeu d'arène que la partie attend, qui le joue (en duel : le joueur du tour et son
   * adversaire), et le joueur seul d'un 1 contre tous ; null sinon.
   */
  #arenaToPlay(): ArenaToPlay | null {
    const { phase } = this.#state;
    const everyone = this.#state.players.map((player) => player.id);
    if (phase.type === 'minigame' || phase.type === 'bonusMinigame') {
      return { minigame: phase.minigame, players: everyone, solo: null };
    }
    if (phase.type === 'finale') {
      return { minigame: phase.minigame, players: phase.contenders, solo: null };
    }
    if (phase.type !== 'turn') return null;
    const { step } = phase;
    if (step.type === 'awaitDuelResult') {
      return { minigame: step.minigame, players: [phase.playerId, step.opponent], solo: null };
    }
    // La porte d'adresse : son défi, joué par le joueur du tour seul (les autres regardent).
    if (step.type === 'awaitSkillGate') {
      return { minigame: step.minigame, players: [phase.playerId], solo: null };
    }
    if (step.type !== 'awaitOneVsAllResult') return null;
    return { minigame: step.minigame, players: everyone, solo: phase.playerId };
  }

  /** Lance l'arène une fois les animations jouées, la fait avancer, puis rend son classement. */
  #playArena(to: ArenaToPlay, now: number): GameEvent[] {
    if (!this.#arena) {
      const bots = new Map(
        to.players.flatMap((id): [PlayerId, BotLevel][] => {
          const control = this.seats[id]?.control;
          return control && control !== 'human' ? [[id, control]] : [];
        }),
      );
      const seed = this.#botRng.int(1, 1e9);
      this.#arena = new ArenaRun(to.minigame, to.players, bots, seed, now, to.solo);
      return [];
    }
    this.#arena.advance(now, this.#botRng);
    const { ranking, soloWon, succeeded } = this.#arena;
    if (!ranking || !this.#arena.isDone(now)) return [];
    this.#arena = null;
    const { phase } = this.#state;
    const isDuel = phase.type === 'turn' && phase.step.type === 'awaitDuelResult';
    const intent: Intent =
      soloWon !== null
        ? { type: 'submitOneVsAllResult', soloWon }
        : succeeded !== null
          ? { type: 'submitSkillGateResult', success: succeeded }
          : isDuel
            ? { type: 'submitDuelResult', winner: ranking[0]?.[0] ?? null }
            : phase.type === 'finale'
              ? { type: 'submitFinaleResult', ranking }
              : phase.type === 'bonusMinigame'
                ? { type: 'submitBonusMinigameResult', ranking }
                : { type: 'submitMinigameResult', ranking };
    const result = this.submit({ type: 'system' }, intent, now);
    if (!result.ok) throw new Error(`Classement d'arène refusé : ${result.error}`);
    return result.events;
  }

  /** La case de la Roue, tirée au hasard (null si la partie n'attend pas la Roue). */
  #wheelIntent(): Intent | null {
    const { phase } = this.#state;
    if (phase.type !== 'turn' || phase.step.type !== 'awaitWheel') return null;
    return {
      type: 'submitWheelResult',
      segment: this.#botRng.int(0, phase.step.segments.length - 1),
    };
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
