import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';
import { COLUMNS_HALF, isCovered, isOn, type Lane, laneAt, passageColumn } from './lanes';

// La grande traversée (02-mini-jeux.md, fiche 49) : chacun traverse, par bonds, la même suite
// sans fin de routes, de rivières, de voies de wagonnets et de bandes d'herbe, en montant les
// étages du Mont Trouble. Un bond par appui (tenir la direction enchaîne les bonds, moins
// vite). Écrasé, noyé ou pris par le convoi : on repart du départ, comme au Hors-piste. Le
// plus loin atteint au bout du chrono gagne. Chacun sa traversée, sans collision (les autres
// sont des fantômes).

/** La partie dure tant (secondes), puis s'arrête après une courte pause. */
export const CROSSING_TIME_LIMIT = 120;
const END_PAUSE = 1.5;
/** La ligne d'arrivée, très loin : presque impossible à atteindre. */
export const FINISH_ROW = 300;
/** Un bond dure tant de pas ; tenir la direction en relance un tous les tant de pas. */
export const HOP_TICKS = 4;
const REPEAT_TICKS = 7;
/** Un sauteur fait tant de large (moitié, en cases) face aux véhicules : à peu près son corps dessiné. */
const BODY_HALF = 0.22;
/**
 * Sur l'eau, on tient debout tant que son milieu est sur le radeau, ou presque : à tant près
 * (cases). Les pieds dépassent du milieu ; sans cette marge, on coulait en se voyant dessus.
 */
const FOOTING = 0.25;
/** On se noie si la rivière nous emporte au-delà du bord de tant (cases). */
const DRIFT_LIMIT = COLUMNS_HALF + 0.5;
/** Après un accident, on reste là tant de secondes (on voit ce qui s'est passé), puis on repart du départ. */
export const DOWN_TIME = 1.3;

export type HopDirection = 'up' | 'down' | 'left' | 'right';
export type CrossingCause = 'road' | 'river' | 'rail';

export type Crosser = {
  id: PlayerId;
  /** Personne n'est éliminé : toujours null (contrat des arènes). */
  fellAt: null;
  /** Le pas de son dernier accident (il est à terre jusqu'à DOWN_TIME après), et ce qui l'a eu. */
  downAt: number | null;
  cause: CrossingCause | null;
  /** Combien de fois il est reparti du départ. */
  runs: number;
  /** Sa rangée et sa place en travers (cases : entière sur l'herbe et la route, libre sur l'eau). */
  row: number;
  x: number;
  /** Le bond en cours : d'où, vers où, depuis quel pas ; ou null. */
  hop: { fromRow: number; fromX: number; toRow: number; toX: number; at: number } | null;
  facing: HopDirection;
  /** La direction tenue au pas d'avant, et depuis quel pas (pour un bond par appui). */
  held: HopDirection | null;
  heldSince: number;
  /** La rangée la plus loin atteinte (toutes traversées confondues), et le pas où il l'a atteinte. */
  best: number;
  bestAt: number;
  /** Le pas où il a passé la ligne d'arrivée, ou null. */
  finishedAt: number | null;
};

export type CrossingState = {
  tick: number;
  practice: boolean;
  /** La graine de la traversée (publique : chacun la dessine). */
  seed: number;
  fighters: Crosser[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Au départ, à l'arrêt, prêt à traverser (les compteurs gardés à part). */
function atStart(crosser: Pick<Crosser, 'id' | 'runs' | 'best' | 'bestAt'>): Crosser {
  return {
    ...crosser,
    fellAt: null,
    downAt: null,
    cause: null,
    row: 0,
    x: 0,
    hop: null,
    facing: 'up',
    held: null,
    heldSince: 0,
    finishedAt: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): CrossingState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id) => atStart({ id, runs: 0, best: 0, bestAt: 0 })),
  };
}

/** La direction demandée (l'axe le plus marqué du stick ou des flèches), ou null. */
function directionOf(input: ArenaInput): HopDirection | null {
  const { x, z } = input.move;
  if (Math.max(Math.abs(x), Math.abs(z)) < 0.5) return null;
  if (Math.abs(z) >= Math.abs(x)) return z < 0 ? 'up' : 'down';
  return x < 0 ? 'left' : 'right';
}

/** Où mène un bond dans cette direction (sans vérifier qu'on peut y aller). */
function hopTarget(
  crosser: Pick<Crosser, 'row' | 'x'>,
  direction: HopDirection,
): { row: number; x: number } {
  const row = crosser.row + (direction === 'up' ? 1 : direction === 'down' ? -1 : 0);
  const side = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
  return { row, x: crosser.x + side };
}

/** La place d'arrivée d'un bond : sur l'eau, là où l'on est ; ailleurs, sur une case. */
function landingX(seed: number, row: number, x: number): number {
  return laneAt(seed, row).type === 'river' ? x : Math.round(x);
}

/** Peut-on sauter là ? Pas hors de la traversée, ni derrière le départ, ni dans un obstacle. */
function isOpen(seed: number, row: number, x: number): boolean {
  if (row < 0 || Math.abs(x) > COLUMNS_HALF + 0.01) return false;
  const lane = laneAt(seed, row);
  return lane.type !== 'grass' || !lane.blocked.includes(Math.round(x));
}

/** Le pas de dérive de l'eau sur cette rangée (cases par pas), 0 hors de l'eau. */
function driftOf(lane: Lane): number {
  return lane.type === 'river' ? lane.traffic.dir * lane.traffic.speed * ARENA_STEP : 0;
}

/** Ce qui arrive à qui se tient là à ce moment : rien (null), ou ce qui le renverse. */
export function dangerAt(lane: Lane, x: number, time: number): CrossingCause | null {
  if (lane.type === 'road' && isCovered(lane.traffic, x, BODY_HALF, time)) return 'road';
  if (lane.type === 'rail' && isCovered(lane.traffic, x, BODY_HALF, time)) return 'rail';
  if (lane.type === 'river') {
    const isAfloat = isOn(lane.traffic, x, -FOOTING, time);
    if (!isAfloat || Math.abs(x) > DRIFT_LIMIT) return 'river';
  }
  return null;
}

/** Un pas d'un sauteur : son bond, la dérive sur l'eau, les dangers. */
function move(state: CrossingState, crosser: Crosser, input: ArenaInput, tick: number): void {
  const time = tick * ARENA_STEP;
  const direction = directionOf(input);
  const isNewPress = direction !== null && direction !== crosser.held;
  if (direction !== crosser.held) crosser.heldSince = tick;
  crosser.held = direction;
  if (crosser.hop) {
    const { hop } = crosser;
    // Un pas de côté sur un radeau : on garde la dérive du radeau pendant le bond.
    if (hop.fromRow === hop.toRow) {
      const drift = driftOf(laneAt(state.seed, hop.fromRow));
      hop.fromX += drift;
      hop.toX += drift;
    }
    if (tick - hop.at < HOP_TICKS) return;
    crosser.row = hop.toRow;
    crosser.x = hop.toX;
    crosser.hop = null;
    if (crosser.row > crosser.best) {
      crosser.best = crosser.row;
      crosser.bestAt = tick;
    }
    if (crosser.row >= FINISH_ROW && crosser.finishedAt === null) crosser.finishedAt = tick;
  }
  const lane = laneAt(state.seed, crosser.row);
  // Sur l'eau, le radeau l'emporte.
  crosser.x += driftOf(lane);
  const danger = dangerAt(lane, crosser.x, time);
  if (danger) {
    crosser.downAt = tick;
    crosser.cause = danger;
    return;
  }
  const isRepeat = direction !== null && tick - crosser.heldSince >= REPEAT_TICKS;
  if (!direction || !(isNewPress || isRepeat) || crosser.finishedAt !== null) return;
  crosser.facing = direction;
  if (isRepeat) crosser.heldSince = tick;
  const target = hopTarget(crosser, direction);
  const toX = landingX(state.seed, target.row, target.x);
  if (isOpen(state.seed, target.row, toX)) {
    crosser.hop = { fromRow: crosser.row, fromX: crosser.x, toRow: target.row, toX, at: tick };
  }
}

function step(state: CrossingState, inputs: Partial<Record<PlayerId, ArenaInput>>): CrossingState {
  const tick = state.tick + 1;
  const next = { ...state, tick };
  const isTimeUp = !state.practice && tick > steps(CROSSING_TIME_LIMIT);
  next.fighters = state.fighters.map((crosser) => {
    if (isTimeUp) return crosser;
    if (crosser.downAt !== null) {
      if (tick - crosser.downAt < steps(DOWN_TIME)) return crosser;
      // Retour au départ : la rangée la plus loin reste acquise.
      return atStart({ ...crosser, runs: crosser.runs + 1 });
    }
    const moved = { ...crosser, hop: crosser.hop && { ...crosser.hop } };
    move(next, moved, inputs[moved.id] ?? IDLE_INPUT, tick);
    return moved;
  });
  return next;
}

function isOver(state: CrossingState): boolean {
  return !state.practice && state.tick >= steps(CROSSING_TIME_LIMIT) + steps(END_PAUSE);
}

function timeLeft(state: CrossingState): number | null {
  if (state.practice) return null;
  return Math.max(0, CROSSING_TIME_LIMIT - state.tick * ARENA_STEP);
}

/**
 * Le classement : la rangée la plus loin atteinte, puis le moment où on l'a atteinte (le plus tôt
 * d'abord) ; au même pas, ex aequo (départagés aux dés).
 */
function ranking(state: CrossingState): PlayerId[][] {
  const groups = new Map<string, { best: number; at: number; ids: PlayerId[] }>();
  for (const crosser of state.fighters) {
    const key = `${crosser.best}:${crosser.bestAt}`;
    const group = groups.get(key) ?? { best: crosser.best, at: crosser.bestAt, ids: [] };
    group.ids.push(crosser.id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.best - a.best || a.at - b.at)
    .map((group) => group.ids);
}

/**
 * Le bot regarde la case où chaque bond le mènerait, et le temps qu'il lui faudra pour repartir
 * (`STAY`, selon son niveau) : il avance si la case devant est sûre pendant ce temps, sinon il
 * attend si sa place l'est, sinon il s'écarte, et ne recule qu'en dernier recours. Comme un
 * joueur, il se trompe parfois (`RASH` : il saute sans bien regarder) et hésite (`HESITATE` : il
 * laisse passer une occasion), chacun à son rythme (`REFLEX`).
 */
const STAY: Record<BotLevel, number> = { easy: 0.55, normal: 0.42, expert: 0.32 };
const RASH: Record<BotLevel, number> = { easy: 0.006, normal: 0.003, expert: 0.001 };
const HESITATE: Record<BotLevel, number> = { easy: 0.12, normal: 0.06, expert: 0.02 };
/** Il se décide tous les tant de pas. */
const REFLEX: Record<BotLevel, number> = { easy: 5, normal: 4, expert: 3 };
/** Sur un radeau, il regarde où il sera dans tant de secondes ; sur l'herbe, plus loin que tant du milieu, il y revient. */
const EDGE_LOOK = 1.5;
const CENTER_PULL = 2;
/** Il vérifie sa sécurité tous les tant de secondes, sur la durée qui compte. */
const CHECK_STEP = 0.05;
/** Sur l'eau, il veut au moins tant de radeau de part et d'autre (cases). */
const RAFT_MARGIN = 0.2;

/** Une place reste-t-elle sûre de `from` à `to` (secondes), en dérivant avec l'eau ? */
function isSafe(seed: number, row: number, x: number, from: number, to: number): boolean {
  if (!isOpen(seed, row, x)) return false;
  const lane = laneAt(seed, row);
  if (lane.type === 'grass') return true;
  for (let time = from; time <= to; time += CHECK_STEP) {
    if (lane.type === 'river') {
      const at = x + lane.traffic.dir * lane.traffic.speed * (time - from);
      if (Math.abs(at) > DRIFT_LIMIT - 0.5) return false;
      if (!isOn(lane.traffic, at, RAFT_MARGIN, time)) return false;
      continue;
    }
    if (dangerAt(lane, x, time)) return false;
  }
  return true;
}

function botInput(state: CrossingState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((crosser) => crosser.id === player);
  if (!me || me.downAt !== null || me.finishedAt !== null || me.hop) return IDLE_INPUT;
  // Il relâche entre deux bonds : chaque bond est un nouvel appui.
  if (me.held !== null) return IDLE_INPUT;
  const key = hashId(player);
  // Il ne se décide qu'à son rythme (ses réflexes), décalé de celui des autres bots.
  if ((state.tick + key) % REFLEX[level] !== 0) return IDLE_INPUT;
  const now = state.tick * ARENA_STEP;
  const land = now + (HOP_TICKS + 1) * ARENA_STEP;
  // Chacun sa prudence : d'un bot à l'autre, un peu plus ou un peu moins que son niveau.
  const until = land + STAY[level] * (0.8 + forestUnit(state.seed, -3, key) * 0.4);
  const moment = Math.floor(state.tick / 6);
  const isRash = forestUnit(state.seed, moment, key) < RASH[level];
  const options: { direction: HopDirection | null; row: number; x: number }[] = [
    { direction: 'up', ...hopTarget(me, 'up') },
    { direction: null, row: me.row, x: me.x },
    { direction: 'left', ...hopTarget(me, 'left') },
    { direction: 'right', ...hopTarget(me, 'right') },
    { direction: 'down', ...hopTarget(me, 'down') },
  ];
  const here = laneAt(state.seed, me.row);
  const isGrass = here.type === 'grass';
  // Les pas de côté : sur l'herbe, vers le milieu (au bord, l'eau emporte vite hors de la
  // traversée) ; ailleurs, vers la colonne de passage de la rangée suivante.
  const goal = isGrass ? 0 : passageColumn(state.seed, me.row + 1);
  const sides = options.slice(2, 4).sort((a, b) => Math.abs(a.x - goal) - Math.abs(b.x - goal));
  // Sur un radeau qui file vers le bord, il n'attend pas d'y être : rester n'est plus sûr.
  const isDrifting =
    here.type === 'river' &&
    Math.abs(me.x + here.traffic.dir * here.traffic.speed * EDGE_LOOK) > COLUMNS_HALF - 0.5;
  // Coincé au bord de l'herbe, il revient vers le milieu plutôt que d'attendre.
  const inward = isGrass && Math.abs(me.x) > CENTER_PULL ? sides.slice(0, 1) : [];
  const ordered = isDrifting
    ? [options[0], ...sides, options[4]]
    : [options[0], ...inward, options[1], ...sides, options[4]];
  for (const option of ordered) {
    if (!option) continue;
    // Rester : sa place dès maintenant ; sauter : la case d'arrivée, au moment d'y arriver.
    const isStay = option.direction === null;
    const x = isStay ? option.x : landingX(state.seed, option.row, option.x);
    const safe = isSafe(state.seed, option.row, x, isStay ? now : land, until);
    if (option.direction === 'up' && (safe || isRash)) {
      if (forestUnit(state.seed, moment, key + 1) < HESITATE[level]) return IDLE_INPUT;
      return press('up');
    }
    if (!safe) continue;
    return option.direction ? press(option.direction) : IDLE_INPUT;
  }
  // Nulle part de sûr : il reste tant que sa place tient encore un instant, sinon il tente sa
  // chance devant.
  const isHoldingOn = isSafe(state.seed, me.row, me.x, now, now + 0.1);
  return isHoldingOn ? IDLE_INPUT : press('up');
}

function press(direction: HopDirection): ArenaInput {
  const move = {
    up: { x: 0, z: -1 },
    down: { x: 0, z: 1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 },
  }[direction];
  return { ...IDLE_INPUT, move };
}

/** Un nombre propre à chaque joueur, pour ses tirages. */
function hashId(id: PlayerId): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export const GREAT_CROSSING: ArenaGame<CrossingState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
