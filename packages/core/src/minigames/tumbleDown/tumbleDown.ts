import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { minigameWorld } from '../catalog';
import { forestUnit } from '../offPiste/forest';
import {
  liveRubble,
  RAMP_HALF,
  RAMP_LENGTH,
  RUBBLE,
  RUBBLE_TOP,
  type Rubble,
  type RubbleKind,
  rubbleAt,
  rubbleSchedule,
} from './rubble';

// La dégringolade (02-mini-jeux.md, fiche 51) : une longue rampe en planches qui monte vers
// l'entrée d'une mine ; de là dégringolent des tonneaux, des bidons, des caisses, des roues et des
// wagonnets (rubble.ts), les mêmes pour tous au même moment. On monte, on se décale, on saute ce
// qui est bas. Touché, on est renversé et repoussé vers le bas (plus ou moins loin selon l'objet),
// puis un instant intouchable en se relevant. Les autres sont des fantômes (on se traverse). Le
// premier en haut gagne ; la partie finit peu après, ou au chrono : les arrivés au temps, les
// autres à la plus grande hauteur atteinte.

/** Le coureur : sa taille (un disque au sol, une hauteur), sa course en montant, de côté, en reculant. */
export const RUNNER_RADIUS = 0.35;
const RUNNER_HEIGHT = 1.3;
const RUN_SPEED = 4.2;
const SIDE_SPEED = 4.5;
const BACK_SPEED = 3;
/** Il atteint la vitesse voulue à ce rythme (m/s²) : vif, mais pas instantané. */
const RUN_ACCEL = 16;
/** Le saut : environ 1,15 m de haut, 0,7 s en l'air. */
const JUMP_SPEED = 6.5;
const GRAVITY = 18;
/**
 * Touché : à terre ce temps (il glisse vers le bas, 12 à 15 m selon l'objet), puis intouchable
 * ce temps en se relevant.
 */
export const TUMBLE_DOWN_TIME = 1.4;
export const TUMBLE_SAFE_TIME = 1.2;

/** Le chrono, et le temps laissé aux autres une fois le premier arrivé (secondes). */
export const TUMBLE_TIME_LIMIT = 120;
export const FINISH_GRACE = 12;
/** Au bac à sable, arrivé en haut, on repart d'en bas au bout de ce temps. */
const PRACTICE_RESTART = 1;
/** Départ : côte à côte en bas, à cet écart. */
const START_SPACING = 1.2;
const START_S = 1;
/** Les plus hautes hauteurs atteintes se comparent au demi-mètre. */
const HEIGHT_STEP = 0.5;

export type TumbleRunner = {
  id: PlayerId;
  /** Personne ne tombe de la rampe : toujours null (le contrat des arènes). */
  fellAt: null;
  /** Où il est (le long de la rampe, en travers, au-dessus) et sa vitesse. */
  s: number;
  x: number;
  y: number;
  vs: number;
  vx: number;
  vy: number;
  /** Secondes restantes à terre, la vitesse de sa glissade quand il est tombé, et intouchable. */
  downed: number;
  slide: number;
  safe: number;
  /** Le dernier objet qui l'a touché, et quand ; null s'il n'a rien pris. */
  knock: { at: number; kind: RubbleKind } | null;
  /** La plus grande hauteur atteinte (le long de la rampe). */
  best: number;
  /** Le moment exact (en pas, fraction comprise) où il est arrivé en haut, ou null. */
  finishedAt: number | null;
  /** La touche de saut tenue au pas précédent : on saute en appuyant, pas en tenant. */
  held: boolean;
};

export type TumbleState = {
  tick: number;
  practice: boolean;
  /** La graine des chutes (publique : chacun les dessine). */
  seed: number;
  fighters: TumbleRunner[];
};

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);

/**
 * Les mondes (retour de test : que ce qui dégringole varie) : la mine des Ateliers ou le Marais.
 * Seul le décor change, les objets gardent leurs tailles et leurs trajets ; il se tire de la
 * graine de la partie (minigameWorld), et le menu Mini-jeux peut le choisir.
 */
export const TUMBLE_WORLDS = ['mine', 'swamp'] as const;
export type TumbleWorld = (typeof TUMBLE_WORLDS)[number];

export function tumbleWorld(seed: number): TumbleWorld {
  return TUMBLE_WORLDS[minigameWorld(seed, TUMBLE_WORLDS.length)] ?? 'mine';
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): TumbleState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id, index) =>
      freshRunner(id, (index - (players.length - 1) / 2) * START_SPACING),
    ),
  };
}

function freshRunner(id: PlayerId, x: number): TumbleRunner {
  return {
    id,
    fellAt: null,
    s: START_S,
    x,
    y: 0,
    vs: 0,
    vx: 0,
    vy: 0,
    downed: 0,
    slide: 0,
    safe: 0,
    knock: null,
    best: START_S,
    finishedAt: null,
    held: false,
  };
}

/** Le premier arrivé (en pas), ou null. */
export function firstFinish(state: TumbleState): number | null {
  const finished = state.fighters
    .map((runner) => runner.finishedAt)
    .filter((at): at is number => at !== null);
  return finished.length > 0 ? Math.min(...finished) : null;
}

function step(state: TumbleState, inputs: Partial<Record<PlayerId, ArenaInput>>): TumbleState {
  const tick = state.tick + 1;
  const live = liveRubble(rubbleSchedule(state.seed, state.practice), tick);
  const fighters = state.fighters.map((runner) => {
    const next = { ...runner };
    if (next.finishedAt !== null) {
      // Arrivé : il reste en haut ; au bac à sable, il repart d'en bas.
      if (state.practice && (tick - next.finishedAt) * ARENA_STEP >= PRACTICE_RESTART) {
        return freshRunner(runner.id, 0);
      }
      return next;
    }
    run(next, inputs[runner.id] ?? IDLE_INPUT, tick);
    const hit = hitBy(next, live, tick);
    if (hit) knockDown(next, hit, tick);
    return next;
  });
  return { ...state, tick, fighters };
}

/** Un pas de course : monter, se décaler, sauter ; à terre, il glisse vers le bas. */
function run(runner: TumbleRunner, input: ArenaInput, tick: number): void {
  const dt = ARENA_STEP;
  const pressed = input.primary && !runner.held;
  runner.held = input.primary;
  runner.safe = Math.max(0, runner.safe - dt);
  if (runner.downed > 0) {
    // Il glisse vers le bas, de moins en moins vite, puis se relève, intouchable un moment.
    runner.downed = Math.max(0, runner.downed - dt);
    runner.vs = -runner.slide * (runner.downed / TUMBLE_DOWN_TIME);
    runner.vx *= 0.9;
    if (runner.downed <= 0) runner.safe = TUMBLE_SAFE_TIME;
  } else {
    const forward = -input.move.z;
    const wantS = forward >= 0 ? forward * RUN_SPEED : forward * BACK_SPEED;
    const wantX = input.move.x * SIDE_SPEED;
    runner.vs = approach(runner.vs, wantS, RUN_ACCEL * dt);
    runner.vx = approach(runner.vx, wantX, RUN_ACCEL * dt);
    if (pressed && runner.y <= 0) runner.vy = JUMP_SPEED;
  }
  if (runner.y > 0 || runner.vy > 0) {
    runner.vy -= GRAVITY * dt;
    runner.y = Math.max(0, runner.y + runner.vy * dt);
    if (runner.y <= 0) runner.vy = 0;
  }
  const before = runner.s;
  runner.s = Math.max(0, runner.s + runner.vs * dt);
  runner.x = Math.max(
    -RAMP_HALF + RUNNER_RADIUS,
    Math.min(RAMP_HALF - RUNNER_RADIUS, runner.x + runner.vx * dt),
  );
  runner.best = Math.max(runner.best, Math.min(RAMP_LENGTH, runner.s));
  if (runner.s >= RAMP_LENGTH) {
    const share = (RAMP_LENGTH - before) / Math.max(1e-6, runner.s - before);
    runner.finishedAt = tick - 1 + Math.max(0, Math.min(1, share));
    runner.s = RAMP_LENGTH;
    runner.vs = 0;
  }
}

function approach(value: number, target: number, amount: number): number {
  return value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
}

/** L'objet qui le touche à ce pas, s'il y en a un (pas à terre, ni intouchable). */
function hitBy(runner: TumbleRunner, live: readonly Rubble[], tick: number): Rubble | null {
  if (runner.downed > 0 || runner.safe > 0) return null;
  for (const rubble of live) {
    const at = rubbleAt(rubble, tick);
    if (!at) continue;
    const { half, depth, height } = RUBBLE[rubble.kind];
    if (Math.abs(runner.x - at.x) >= half + RUNNER_RADIUS) continue;
    if (Math.abs(runner.s - at.s) >= depth + RUNNER_RADIUS) continue;
    // Sauté par-dessus, ou passé dessous un objet qui bondit.
    if (runner.y >= at.y + height || runner.y + RUNNER_HEIGHT <= at.y) continue;
    return rubble;
  }
  return null;
}

/** Renversé : il glisse vers le bas sur la distance de l'objet (en TUMBLE_DOWN_TIME, en freinant). */
function knockDown(runner: TumbleRunner, rubble: Rubble, tick: number): void {
  runner.downed = TUMBLE_DOWN_TIME;
  runner.slide = (2 * RUBBLE[rubble.kind].push) / TUMBLE_DOWN_TIME;
  runner.vy = Math.min(0, runner.vy);
  runner.knock = { at: tick, kind: rubble.kind };
}

function isOver(state: TumbleState): boolean {
  if (state.practice) return false;
  const first = firstFinish(state);
  return (
    state.fighters.every((runner) => runner.finishedAt !== null) ||
    state.tick * ARENA_STEP >= TUMBLE_TIME_LIMIT ||
    (first !== null && state.tick >= first + toTick(FINISH_GRACE))
  );
}

function timeLeft(state: TumbleState): number | null {
  if (state.practice) return null;
  const first = firstFinish(state);
  const limit =
    first === null
      ? TUMBLE_TIME_LIMIT
      : Math.min(TUMBLE_TIME_LIMIT, first * ARENA_STEP + FINISH_GRACE);
  return Math.max(0, limit - state.tick * ARENA_STEP);
}

/**
 * Le classement : les arrivés au temps (au centième : ex aequo), puis les autres à la plus grande
 * hauteur atteinte, au demi-mètre (à égalité : ex aequo, les dés les départageront).
 */
function ranking(state: TumbleState): PlayerId[][] {
  const groups = new Map<string, { order: number; ids: PlayerId[] }>();
  for (const runner of state.fighters) {
    const order =
      runner.finishedAt !== null
        ? -1e6 + Math.round(runner.finishedAt * ARENA_STEP * 100)
        : -Math.floor(runner.best / HEIGHT_STEP);
    const key = String(order);
    const group = groups.get(key) ?? { order, ids: [] };
    group.ids.push(runner.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map((group) => group.ids);
}

/**
 * Les bots, selon leur niveau : combien de secondes ils regardent devant eux, avec quel retard ils
 * voient les objets (ils réagissent sur ce qu'ils ont vu un peu plus tôt), et la part des fois où
 * ils foncent tout droit sans regarder (une étourderie, tirée par seconde).
 */
const BOT: Record<BotLevel, { horizon: number; delay: number; careless: number }> = {
  easy: { horizon: 0.6, delay: 0.2, careless: 0.18 },
  normal: { horizon: 0.9, delay: 0.1, careless: 0.08 },
  expert: { horizon: 1.05, delay: 0.08, careless: 0.05 },
};
/** Chaque bot a son couloir préféré, à au plus tant du milieu (m). */
const LANE_SPREAD = 2.5;
/** Le plus rapide des objets (m/s) : au-delà de sa portée, un objet ne peut pas l'atteindre à temps. */
const FASTEST_RUBBLE = Math.max(...Object.values(RUBBLE).map((one) => one.speed[1]));
/** Une étourderie dure ce temps (secondes). */
const CARELESS_TIME = 0.5;
/** Les gestes qu'il essaie : de côté (-1, 0, 1), monter ou rester, sauter ou non. */
const SIDES = [-1, 0, 1] as const;
const FORWARDS = [1, 0] as const;
/** Un geste qui le fait toucher vaut tant de moins (et d'autant moins que le choc est loin). */
const HIT_COST = 100;

/** Un nombre propre à chaque joueur, pour varier les tirages d'un bot à l'autre. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

/**
 * Le bot (02-mini-jeux.md, fiche 51) : à chaque pas, il essaie quelques gestes (se décaler d'un
 * côté ou de l'autre, monter ou attendre, sauter ou non) en jouant la suite de son horizon avec
 * les vrais objets, et garde celui qui monte le plus sans se faire toucher. Il voit les objets avec
 * un léger retard, et de temps en temps il fonce tout droit sans regarder.
 */
function botInput(state: TumbleState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((runner) => runner.id === player);
  if (!me || me.finishedAt !== null || me.downed > 0) return IDLE_INPUT;
  const bot = BOT[level];
  const window = toTick(CARELESS_TIME);
  const slot = Math.floor(state.tick / window);
  const isCareless =
    forestUnit(state.seed, slot, 81 + saltOf(player)) < bot.careless * CARELESS_TIME;
  if (isCareless) return { move: { x: 0, z: -1 }, primary: false, secondary: false };
  const schedule = rubbleSchedule(state.seed, state.practice);
  // Il voit les objets comme ils étaient il y a `delay` : il les croit plus haut qu'ils ne sont.
  const lag = toTick(bot.delay);
  const steps = toTick(bot.horizon);
  const lane = (forestUnit(state.seed, saltOf(player), 82) * 2 - 1) * LANE_SPREAD;
  // Seuls comptent les objets qui peuvent l'atteindre dans son horizon (le plus rapide descend à
  // 11 m/s, lui monte à RUN_SPEED) : un bot essaie douze gestes à chaque pas, ça coûte cher.
  const reach = (FASTEST_RUBBLE + RUN_SPEED) * bot.horizon + 3;
  const live = liveRubble(schedule, state.tick + steps).filter((rubble) => {
    // Pas encore parti (pour ce qu'il en voit) : il est en haut.
    const s = rubbleAt(rubble, state.tick - lag)?.s ?? RUBBLE_TOP;
    return s > me.s - 3 && s - me.s < reach;
  });
  let best: { input: ArenaInput; score: number } | null = null;
  for (const side of SIDES) {
    for (const forward of FORWARDS) {
      for (const jump of [false, true]) {
        const input: ArenaInput = {
          move: { x: side, z: -forward },
          primary: jump,
          secondary: false,
        };
        const score = rollout(me, input, live, state.tick, steps, lag);
        // À score égal : sans sauter, et vers son couloir préféré. Sans ce couloir, deux bots du
        // même niveau collés au départ faisaient les mêmes choix et arrivaient ensemble.
        const tidy = score - (jump ? 0.3 : 0) - Math.abs(me.x + side - lane) * 0.05;
        if (!best || tidy > best.score) best = { input, score: tidy };
      }
    }
  }
  return best?.input ?? IDLE_INPUT;
}

/** Joue un geste sur `steps` pas avec les objets vus `lag` pas trop tôt : ce qu'il gagne en hauteur, moins le choc. */
function rollout(
  me: TumbleRunner,
  input: ArenaInput,
  live: readonly Rubble[],
  tick: number,
  steps: number,
  lag: number,
): number {
  const ghost: TumbleRunner = { ...me, held: false };
  for (let k = 1; k <= steps; k++) {
    run(ghost, k === 1 ? input : { ...input, primary: false }, tick + k);
    if (ghost.finishedAt !== null) return HIT_COST;
    if (hitBy(ghost, live, tick + k - lag))
      return ghost.s - me.s - HIT_COST * (1 - k / (steps * 2));
  }
  return ghost.s - me.s;
}

export const TUMBLE_DOWN: ArenaGame<TumbleState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
