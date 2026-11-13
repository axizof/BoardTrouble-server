import type { BotLevel } from '../../bots/boardBot';
import { breakTies, TIE_ROLL_TIME, type TieBreak } from '../../dice/dice';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { BIG_DIE } from '../bigDie/bigDie';
import { BOARD_REFLEX } from '../boardReflex/boardReflex';
import { CARD_MEMORY } from '../cardMemory/cardMemory';
import type { MinigameId } from '../catalog';
import { CHIFOUMI } from '../chifoumi/chifoumi';
import { CLAY_SHOOT } from '../clayShoot/clayShoot';
import { COMBINATION } from '../combination/combination';
import { CONVEYOR_SORT } from '../conveyorSort/conveyorSort';
import { FALLING_PLATES } from '../fallingPlates/fallingPlates';
import { GREAT_CROSSING } from '../greatCrossing/greatCrossing';
import { HAMSTER_BALL } from '../hamsterBall/hamsterBall';
import { HIGH_NOON } from '../highNoon/highNoon';
import { HOT_POTATO } from '../hotPotato/hotPotato';
import { LAST_ROLL } from '../lastRoll/lastRoll';
import { MELTING_PLATFORM } from '../meltingPlatform/meltingPlatform';
import { OFF_PISTE } from '../offPiste/offPiste';
import { PAWN_SUMO } from '../pawnSumo/pawnSumo';
import { PENALTY_KICKS } from '../penaltyKicks/penaltyKicks';
import { PERFECT_GAUGE } from '../perfectGauge/perfectGauge';
import { PILE_UP } from '../pileUp/pileUp';
import { RAMPART } from '../rampart/rampart';
import { RHYTHM_TUG } from '../rhythmTugOfWar/rhythmTugOfWar';
import { RIDGE_RIDE } from '../ridgeRide/ridgeRide';
import { SECRET_AUCTION } from '../secretAuction/secretAuction';
import { SKY_PHOTO } from '../skyPhoto/skyPhoto';
import { SPINNING_BAR } from '../spinningBar/spinningBar';
import { STACKER } from '../stacker/stacker';
import { TUMBLE_DOWN } from '../tumbleDown/tumbleDown';
import { UNIQUE_STAIRS } from '../uniqueStairs/uniqueStairs';
import {
  ARENA_STEP,
  type ArenaGame,
  type ArenaInput,
  type ArenaState,
  IDLE_INPUT,
  sanitizeInput,
} from './arena';
import { planReveal, type RevealPlan, revealDuration } from './reveal';

// Une partie d'arène hébergée (02-mini-jeux.md, section 1 : présentation, "Prêt", décompte,
// jeu, résultat). Comme la session, elle ne lance aucun minuteur : l'hôte lui donne l'heure.

/** L'arène de chaque mini-jeu du catalogue : un mini-jeu n'y entre qu'avec la sienne. */
export const ARENAS = {
  pawnSumo: PAWN_SUMO,
  meltingPlatform: MELTING_PLATFORM,
  spinningBar: SPINNING_BAR,
  boardReflex: BOARD_REFLEX,
  stacker: STACKER,
  cardMemory: CARD_MEMORY,
  secretAuction: SECRET_AUCTION,
  uniqueStairs: UNIQUE_STAIRS,
  rhythmTugOfWar: RHYTHM_TUG,
  bigDie: BIG_DIE,
  rampart: RAMPART,
  highNoon: HIGH_NOON,
  clayShoot: CLAY_SHOOT,
  lastRoll: LAST_ROLL,
  perfectGauge: PERFECT_GAUGE,
  combination: COMBINATION,
  conveyorSort: CONVEYOR_SORT,
  fallingPlates: FALLING_PLATES,
  skyPhoto: SKY_PHOTO,
  ridgeRide: RIDGE_RIDE,
  offPiste: OFF_PISTE,
  greatCrossing: GREAT_CROSSING,
  hotPotato: HOT_POTATO,
  pileUp: PILE_UP,
  hamsterBall: HAMSTER_BALL,
  tumbleDown: TUMBLE_DOWN,
  penaltyKicks: PENALTY_KICKS,
  chifoumi: CHIFOUMI,
} satisfies Record<MinigameId, ArenaGame<ArenaState>>;
export type ArenaMinigame = keyof typeof ARENAS;
/** L'état de chaque arène jouable. */
export type ArenaStates = {
  [M in ArenaMinigame]: (typeof ARENAS)[M] extends ArenaGame<infer State> ? State : never;
};

/** `reveal` : la révélation de fin, pour les mini-jeux qui en ont une (ArenaGame.reveal). */
export type ArenaStage = 'intro' | 'countdown' | 'play' | 'reveal' | 'result';

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
  tieRoll: TIE_ROLL_TIME,
} as const;

/**
 * Ce que les clients voient de la partie d'arène (tout y est public) : le mini-jeu et son état
 * vont ensemble (`minigame` dit de quelle arène est `arena`).
 */
export type ArenaRunView = {
  [M in ArenaMinigame]: { minigame: M; arena: ArenaStates[M] };
}[ArenaMinigame] & {
  stage: ArenaStage;
  /** En 1 contre tous, le joueur seul face aux autres ; null sinon. */
  solo: PlayerId | null;
  /** Millisecondes avant la fin de l'étape, au moment de l'envoi ; null pendant le jeu. */
  stageEndsIn: number | null;
  players: PlayerId[];
  ready: PlayerId[];
  /** Le classement du mini-jeu, ex aequo groupés (ce qu'affiche le résultat d'abord). */
  ranking: PlayerId[][] | null;
  /** Les lancers qui départagent les ex aequo, dans l'ordre où les montrer, et l'ordre final. */
  tieBreaks: TieBreak[];
  order: PlayerId[] | null;
  /** Le plan de la révélation de fin, une fois la partie finie ; null sans révélation. */
  reveal: RevealPlan | null;
  /** Un défi solo fini : réussi ou non ; null avant la fin, ou pour un autre mini-jeu. */
  succeeded: boolean | null;
};

export class ArenaRun {
  readonly minigame: ArenaMinigame;
  readonly players: PlayerId[];
  readonly solo: PlayerId | null;
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
  #reveal: RevealPlan | null = null;

  /**
   * `bots` : le niveau de chaque joueur tenu par un bot ; les autres sont des humains. `solo` :
   * en 1 contre tous, le joueur seul.
   */
  constructor(
    minigame: ArenaMinigame,
    players: PlayerId[],
    bots: Map<PlayerId, BotLevel>,
    seed: number,
    now: number,
    solo: PlayerId | null = null,
  ) {
    this.minigame = minigame;
    this.players = players;
    this.solo = solo;
    this.#game = ARENAS[minigame];
    this.#bots = bots;
    for (const id of players) if (bots.has(id)) this.#ready.add(id);
    this.#state = this.#game.create(players, { practice: false, seed, solo });
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
    if (this.#stage === 'reveal' && now >= this.#stageAt) this.#showResult(now);
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
        // Une visée (un clic) ne vaut que pour un pas : la commande reste, pas le clic.
        for (const [id, input] of this.#inputs) {
          if (input.target != null) this.#inputs.set(id, { ...input, target: null });
        }
        this.#state = this.#game.step(state, inputs);
      }
      if (this.#game.isOver(this.#state)) {
        this.#ranking = this.#game.ranking(this.#state);
        // Les ex aequo se départagent aux dés ici, pour que le résultat le montre ; le moteur
        // reçoit ensuite un classement sans égalité. En 1 contre tous, seul compte le camp gagnant.
        ({ order: this.#order, tieBreaks: this.#tieBreaks } = this.solo
          ? { order: this.#ranking.flat(), tieBreaks: [] }
          : breakTies(this.#ranking, rng));
        this.#reveal = this.#planReveal(this.#ranking);
        if (this.#reveal) {
          this.#stage = 'reveal';
          this.#stageAt = now + revealDuration(this.#reveal);
        } else {
          this.#showResult(now);
        }
      }
    }
  }

  /** La révélation de fin, si le mini-jeu en a une (et qu'il y a plus d'un joueur à montrer). */
  #planReveal(ranking: PlayerId[][]): RevealPlan | null {
    const rules = this.#game.reveal;
    if (!rules || this.solo || this.players.length < 2) return null;
    const state = this.#state;
    return planReveal(ranking, (player) => rules.score(state, player), rules);
  }

  #showResult(now: number): void {
    this.#stage = 'result';
    this.#stageAt = now + ARENA_TIMES.result + this.#tieBreaks.length * ARENA_TIMES.tieRoll;
  }

  /** Le résultat a été montré : le classement peut partir au moteur. */
  isDone(now: number): boolean {
    return this.#ranking !== null && this.#stage === 'result' && now >= this.#stageAt;
  }

  /** Le classement final, sans égalité (les ex aequo départagés aux dés), une fois la partie finie ; null avant. */
  get ranking(): PlayerId[][] | null {
    return this.#order?.map((id) => [id]) ?? null;
  }

  /** Un défi solo, une fois fini : le joueur l'a réussi ; null avant, ou pour un autre mini-jeu. */
  get succeeded(): boolean | null {
    const check = this.#game.succeeded;
    return check && this.#ranking ? check(this.#state) : null;
  }

  /** En 1 contre tous, une fois la partie finie : le joueur seul l'a emporté ; null avant. */
  get soloWon(): boolean | null {
    if (!this.solo || !this.#ranking) return null;
    const [first] = this.#ranking;
    return first?.length === 1 && first[0] === this.solo;
  }

  /** Ce que voit `viewer` de la partie : tout, sauf ce que le mini-jeu cache (`viewFor`). */
  view(now: number, viewer: Viewer): ArenaRunView {
    // L'état vient toujours du jeu de ce mini-jeu (ARENAS[minigame]) : la paire est juste, ce
    // que le typage ne peut pas suivre à travers `#game`.
    return {
      minigame: this.minigame,
      stage: this.#stage,
      solo: this.solo,
      stageEndsIn:
        this.#stage === 'play' || !Number.isFinite(this.#stageAt)
          ? null
          : Math.max(0, this.#stageAt - now),
      players: this.players,
      ready: [...this.#ready],
      arena: this.#game.viewFor?.(this.#state, viewer) ?? this.#state,
      ranking: this.#ranking,
      tieBreaks: this.#tieBreaks,
      order: this.#order,
      reveal: this.#reveal,
      succeeded: this.succeeded,
    } as ArenaRunView;
  }

  #startCountdown(now: number): void {
    this.#stage = 'countdown';
    this.#stageAt = now + ARENA_TIMES.countdown;
  }
}
