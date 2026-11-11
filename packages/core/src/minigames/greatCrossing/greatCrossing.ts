import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';
import { COLUMNS_HALF, isCovered, isOn, type Lane, laneAt, passageColumn } from './lanes';

// La grande traversée (02-mini-jeux.md, fiche 49) : chacun traverse, par bonds, la même suite
// sans fin de routes, de rivières, de voies de wagonnets et de bandes d'herbe, en montant les
// étages du Mont Trouble. Un bond par appui (tenir la direction enchaîne les bonds, moins
// vite). Écrasé, noyé, ou avalé par le brouillard du TROUBLE qui avance derrière, de plus en
// plus vite : éliminé. Le plus loin au bout du chrono gagne. Chacun sa traversée, sans
// collision (les autres sont des fantômes).

/** La partie dure tant (secondes) ; elle finit ce temps après le dernier éliminé ou arrivé. */
export const CROSSING_TIME_LIMIT = 90;
const END_PAUSE = 1.5;
/** La ligne d'arrivée, très loin : presque impossible à atteindre. */
export const FINISH_ROW = 300;
/** Un bond dure tant de pas ; tenir la direction en relance un tous les tant de pas. */
export const HOP_TICKS = 4;
const REPEAT_TICKS = 7;
/** Un sauteur fait tant de large (moitié, en cases) face aux véhicules. */
const BODY_HALF = 0.3;
/** On se noie si la rivière nous emporte au-delà du bord de tant (cases). */
const DRIFT_LIMIT = COLUMNS_HALF + 0.5;
/**
 * Le brouillard : il part de FOG_START rangées derrière le départ, attend FOG_DELAY secondes,
 * puis avance de FOG_SPEED rangées par seconde, plus FOG_RAMP par seconde écoulée (de plus en
 * plus vite). Il avale qui est à moins de FOG_BITE de son front.
 */
const FOG_START = -3;
const FOG_DELAY = 4;
const FOG_SPEED = 0.6;
const FOG_RAMP = 0.018;
const FOG_BITE = 0.3;
/** Au bac à sable, on reprend un peu avant au bout de tant (secondes). */
const PRACTICE_RESPAWN = 1.5;
const PRACTICE_BACK = 3;

export type HopDirection = 'up' | 'down' | 'left' | 'right';
export type CrossingCause = 'road' | 'river' | 'rail' | 'fog';

export type Crosser = {
  id: PlayerId;
  /** Le pas où il a été éliminé, et comment, ou null. */
  fellAt: number | null;
  cause: CrossingCause | null;
  /** Sa rangée et sa place en travers (cases : entière sur l'herbe et la route, libre sur l'eau). */
  row: number;
  x: number;
  /** Le bond en cours : d'où, vers où, depuis quel pas ; ou null. */
  hop: { fromRow: number; fromX: number; toRow: number; toX: number; at: number } | null;
  facing: HopDirection;
  /** La direction tenue au pas d'avant, et depuis quel pas (pour un bond par appui). */
  held: HopDirection | null;
  heldSince: number;
  /** La rangée la plus loin atteinte, et le pas où il l'a atteinte. */
  best: number;
  bestAt: number;
  /** Le pas (avec sa fraction) où il a passé la ligne d'arrivée, ou null. */
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

/** Le front du brouillard à ce pas (en rangées), ou null au bac à sable (pas de brouillard). */
export function fogRow(state: Pick<CrossingState, 'tick' | 'practice'>): number | null {
  if (state.practice) return null;
  const moving = Math.max(0, state.tick * ARENA_STEP - FOG_DELAY);
  return FOG_START + FOG_SPEED * moving + 0.5 * FOG_RAMP * moving * moving;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): CrossingState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      cause: null,
      row: 0,
      x: 0,
      hop: null,
      facing: 'up',
      held: null,
      heldSince: 0,
      best: 0,
      bestAt: 0,
      finishedAt: null,
    })),
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

/** Ce qui arrive à qui se tient là à ce moment : rien (null), ou ce qui l'élimine. */
export function dangerAt(lane: Lane, x: number, time: number): CrossingCause | null {
  if (lane.type === 'road' && isCovered(lane.traffic, x, BODY_HALF, time)) return 'road';
  if (lane.type === 'rail' && isCovered(lane.traffic, x, BODY_HALF, time)) return 'rail';
  if (lane.type === 'river') {
    const isAfloat = isOn(lane.traffic, x, 0, time);
    if (!isAfloat || Math.abs(x) > DRIFT_LIMIT) return 'river';
  }
  return null;
}

function eliminate(crosser: Crosser, cause: CrossingCause, tick: number): void {
  crosser.fellAt = tick;
  crosser.cause = cause;
  crosser.hop = null;
}

/** Un pas d'un sauteur : son bond, la dérive sur l'eau, les dangers, le brouillard. */
function move(state: CrossingState, crosser: Crosser, input: ArenaInput, tick: number): void {
  const time = tick * ARENA_STEP;
  const direction = directionOf(input);
  const isNewPress = direction !== null && direction !== crosser.held;
  if (direction !== crosser.held) crosser.heldSince = tick;
  crosser.held = direction;
  if (crosser.hop && tick - crosser.hop.at >= HOP_TICKS) {
    crosser.row = crosser.hop.toRow;
    crosser.x = crosser.hop.toX;
    crosser.hop = null;
    if (crosser.row > crosser.best) {
      crosser.best = crosser.row;
      crosser.bestAt = tick;
    }
    if (crosser.row >= FINISH_ROW && crosser.finishedAt === null) crosser.finishedAt = tick;
  }
  if (!crosser.hop) {
    const lane = laneAt(state.seed, crosser.row);
    // Sur l'eau, le radeau l'emporte.
    if (lane.type === 'river') crosser.x += lane.traffic.dir * lane.traffic.speed * ARENA_STEP;
    const danger = dangerAt(lane, crosser.x, time);
    if (danger) {
      eliminate(crosser, danger, tick);
      return;
    }
    const isRepeat = direction !== null && tick - crosser.heldSince >= REPEAT_TICKS;
    if (direction && (isNewPress || isRepeat) && crosser.finishedAt === null) {
      crosser.facing = direction;
      if (isRepeat) crosser.heldSince = tick;
      const target = hopTarget(crosser, direction);
      const toX = landingX(state.seed, target.row, target.x);
      if (isOpen(state.seed, target.row, toX)) {
        crosser.hop = { fromRow: crosser.row, fromX: crosser.x, toRow: target.row, toX, at: tick };
      }
    }
  }
  const fog = fogRow(state);
  const standing = crosser.hop ? Math.min(crosser.row, crosser.hop.toRow) : crosser.row;
  if (fog !== null && fog >= standing + FOG_BITE && crosser.finishedAt === null) {
    eliminate(crosser, 'fog', tick);
  }
}

/** Au bac à sable, l'éliminé reprend un peu avant, sur l'herbe, au bout d'un moment. */
function respawn(state: CrossingState, crosser: Crosser, tick: number): void {
  if (crosser.fellAt === null || tick - crosser.fellAt < steps(PRACTICE_RESPAWN)) return;
  let row = Math.max(0, crosser.row - PRACTICE_BACK);
  while (row > 0 && laneAt(state.seed, row).type !== 'grass') row--;
  Object.assign(crosser, {
    fellAt: null,
    cause: null,
    row,
    x: passageColumn(state.seed, row) * (row === 0 ? 0 : 1),
    hop: null,
  });
}

function step(state: CrossingState, inputs: Partial<Record<PlayerId, ArenaInput>>): CrossingState {
  const tick = state.tick + 1;
  const next = { ...state, tick };
  const isTimeUp = !state.practice && tick > steps(CROSSING_TIME_LIMIT);
  next.fighters = state.fighters.map((crosser) => {
    const moved = { ...crosser, hop: crosser.hop && { ...crosser.hop } };
    if (state.practice) respawn(next, moved, tick);
    if (moved.fellAt !== null || isTimeUp) return moved;
    move(next, moved, inputs[moved.id] ?? IDLE_INPUT, tick);
    return moved;
  });
  return next;
}

function lastEvent(state: CrossingState): number | null {
  let last = 0;
  for (const crosser of state.fighters) {
    const at = crosser.fellAt ?? crosser.finishedAt;
    if (at === null) return null;
    last = Math.max(last, at);
  }
  return last;
}

function isOver(state: CrossingState): boolean {
  if (state.practice) return false;
  if (state.tick >= steps(CROSSING_TIME_LIMIT) + steps(END_PAUSE)) return true;
  const last = lastEvent(state);
  return last !== null && state.tick >= last + steps(END_PAUSE);
}

function timeLeft(state: CrossingState): number | null {
  if (state.practice) return null;
  return Math.max(0, CROSSING_TIME_LIMIT - state.tick * ARENA_STEP);
}

/**
 * Le classement : la rangée la plus loin atteinte (éliminé ou non), puis le moment où on l'a
 * atteinte (le plus tôt d'abord) ; au même pas, ex aequo.
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
 * attend si sa place l'est, sinon il s'écarte, et ne recule qu'en dernier recours. Le brouillard
 * trop près le pousse à oser. Comme un joueur, il se trompe parfois (`RASH` : il saute sans
 * bien regarder) et hésite (`HESITATE` : il laisse passer une occasion).
 */
const STAY: Record<BotLevel, number> = { easy: 0.55, normal: 0.42, expert: 0.32 };
const RASH: Record<BotLevel, number> = { easy: 0.012, normal: 0.006, expert: 0.002 };
const HESITATE: Record<BotLevel, number> = { easy: 0.12, normal: 0.06, expert: 0.02 };
/** Il se décide tous les tant de pas. */
const REFLEX: Record<BotLevel, number> = { easy: 5, normal: 4, expert: 3 };
/** Talonné par le brouillard, il ne regarde que l'arrivée du bond (secondes). */
const CHASED_STAY = 0.12;
/** Il vérifie sa sécurité tous les tant de secondes, sur la durée qui compte. */
const CHECK_STEP = 0.05;
/** Sur l'eau, il veut au moins tant de radeau de part et d'autre (cases). */
const RAFT_MARGIN = 0.25;

/** Une place reste-t-elle sûre de `from` à `to` (secondes), en dérivant avec l'eau ? */
function isSafe(seed: number, row: number, x: number, from: number, to: number): boolean {
  if (!isOpen(seed, row, x)) return false;
  const lane = laneAt(seed, row);
  if (lane.type === 'grass') return true;
  for (let time = from; time <= to; time += CHECK_STEP) {
    if (lane.type === 'river') {
      const drift = lane.traffic.dir * lane.traffic.speed * (time - from);
      const at = x + drift;
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
  if (!me || me.fellAt !== null || me.finishedAt !== null || me.hop) return IDLE_INPUT;
  // Il relâche entre deux bonds : chaque bond est un nouvel appui.
  if (me.held !== null) return IDLE_INPUT;
  // Il ne se décide qu'à son rythme (ses réflexes), décalé de celui des autres bots.
  if ((state.tick + hashId(player)) % REFLEX[level] !== 0) return IDLE_INPUT;
  const now = state.tick * ARENA_STEP;
  const land = now + (HOP_TICKS + 1) * ARENA_STEP;
  // Chacun sa prudence : d'un bot à l'autre, un peu plus ou un peu moins que son niveau.
  const caution = STAY[level] * (0.8 + forestUnit(state.seed, -3, hashId(player)) * 0.4);
  const key = hashId(player);
  const moment = Math.floor(state.tick / 6);
  const isRash = forestUnit(state.seed, moment, key) < RASH[level];
  const fog = fogRow(state);
  const isChased = fog !== null && fog > me.row - 2.5;
  // Le brouillard aux trousses, il se contente d'arriver sur la case sans encombre.
  const until = land + (isChased ? CHASED_STAY : caution);
  const options: { direction: HopDirection | null; row: number; x: number }[] = [
    { direction: 'up', ...hopTarget(me, 'up') },
    { direction: null, row: me.row, x: me.x },
    { direction: 'left', ...hopTarget(me, 'left') },
    { direction: 'right', ...hopTarget(me, 'right') },
    { direction: 'down', ...hopTarget(me, 'down') },
  ];
  const passage = passageColumn(state.seed, me.row + 1);
  // Les pas de côté : d'abord vers la colonne de passage de la rangée suivante.
  const sides = options
    .slice(2, 4)
    .sort((a, b) => Math.abs(a.x - passage) - Math.abs(b.x - passage));
  const ordered = [
    options[0],
    ...(isChased ? sides : []),
    options[1],
    ...(isChased ? [] : sides),
    options[4],
  ];
  for (const option of ordered) {
    if (!option) continue;
    // Rester : sa place dès maintenant ; sauter : la case d'arrivée, au moment d'y arriver.
    const isStay = option.direction === null;
    const x = isStay ? option.x : landingX(state.seed, option.row, option.x);
    const safe = isSafe(state.seed, option.row, x, isStay ? now : land, until);
    if (option.direction === 'up' && (safe || isRash)) {
      if (!isChased && forestUnit(state.seed, moment, key + 1) < HESITATE[level]) {
        return IDLE_INPUT;
      }
      return press('up');
    }
    if (!safe) continue;
    return option.direction ? press(option.direction) : IDLE_INPUT;
  }
  // Nulle part de sûr : il tente sa chance devant.
  return press('up');
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
