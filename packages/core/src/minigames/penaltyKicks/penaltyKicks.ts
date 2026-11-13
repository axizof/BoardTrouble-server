import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Tirs au but (02-mini-jeux.md, fiche 52), un 1 contre tous : le joueur seul garde la cage, les
// autres tirent chacun leur tour, 6 tirs en tout. La cage est découpée en 6 zones (gauche,
// milieu, droite ; en bas, en haut). Le tireur et le gardien choisissent chacun une zone, en
// secret et en même temps. Puis un ramasseur roule le ballon au tireur, qui frappe au moment où
// il arrive au point de penalty : à temps, la frappe est forte ; moins juste, elle est faible ;
// trop loin du moment, c'est raté. Une lucarne (un coin du haut) demande une frappe presque
// parfaite, sinon elle passe à côté. Le gardien arrête toujours sa zone, et une frappe faible
// dans une zone voisine. Retour de test : en réflexe, le gardien ne pouvait rien contre une
// bonne frappe ; c'est maintenant une lecture de l'adversaire, avec un risque pour le tireur. Le
// gardien gagne s'il encaisse moins de buts qu'il n'en arrête ; à 3 partout, un tir de plus.

/** La cage : 2 × GOAL_HALF de large, GOAL_HEIGHT de haut ; le point de penalty à SPOT_DISTANCE. */
export const GOAL_HALF = 3;
export const GOAL_HEIGHT = 2.2;
export const SPOT_DISTANCE = 9;
/**
 * Les zones : 3 colonnes (de -1 à gauche à 1 à droite) et 2 rangées (0 en bas, 1 en haut),
 * numérotées rangée par rangée : 0, 1, 2 en bas, 3, 4, 5 en haut.
 */
export const ZONES = 6;
const COLUMN_WIDTH = (GOAL_HALF * 2) / 3;
const ROW_HEIGHTS = [0.55, 1.65] as const;
/** Le choix de départ, avant qu'on ne bouge : le milieu en bas. */
const FIRST_ZONE = 1;
/** Le tireur s'avance pendant WALK_TIME, puis chacun a CHOOSE_TIME pour choisir sa zone. */
export const WALK_TIME = 1;
export const CHOOSE_TIME = 4;
/** Les deux choix faits : un temps, puis le ballon roule et arrive au point en ROLL_TIME. */
const REVEAL_PAUSE = 0.35;
export const ROLL_TIME = 0.9;
/**
 * La frappe : à PERFECT_KICK près du moment où le ballon arrive, elle est parfaite (qualité 1) ;
 * elle se dégrade jusqu'à KICK_WINDOW, au-delà c'est raté. Une qualité d'au moins STRONG_KICK
 * fait une frappe forte ; une lucarne en demande LUCARNE_KICK, sinon elle passe à côté.
 */
export const PERFECT_KICK = 0.04;
export const KICK_WINDOW = 0.3;
export const STRONG_KICK = 0.8;
export const LUCARNE_KICK = 0.88;
const FAST_SHOT = 22;
const SLOW_SHOT = 13;
/** Un tir fini se montre ce temps-là avant le suivant. */
export const RESULT_TIME = 1.9;
/** Un tir raté se traîne ce temps avant d'être compté. */
const FLUFF_TIME = 0.7;
/** Les tirs de la séance (plus un pour départager, à 3 partout). */
export const SHOTS = 6;

export type ShotOutcome = 'goal' | 'save' | 'wide' | 'fluff';

export type PenaltyShot = {
  index: number;
  shooter: PlayerId;
  startAt: number;
  /** Le pas où le temps de choisir est écoulé. */
  chooseEndsAt: number;
  /** La zone du tireur (cachée aux autres jusqu'à la frappe : null pour eux), et s'il l'a verrouillée. */
  aim: number | null;
  aimLocked: boolean;
  /** Le pas où le ballon part (les deux ont choisi), et où il arrive au point ; null avant. */
  rollAt: number | null;
  arriveAt: number | null;
  /** La frappe : son pas, sa qualité (0 à 1), sa force, où le ballon passe la ligne et à quelle vitesse. */
  kickAt: number | null;
  quality: number | null;
  power: 'strong' | 'weak' | null;
  target: { x: number; y: number } | null;
  speed: number;
  /** Le pas où le ballon passe la ligne (ou finit de se traîner), et ce que ça donne. */
  endAt: number | null;
  outcome: ShotOutcome | null;
};

/** Le dernier stick tenu : on change de zone d'un cran à chaque poussée, pas en tenant. */
type Stick = { x: number; z: number };

export type PenaltyKeeper = {
  id: PlayerId;
  /** Sa zone (cachée aux autres jusqu'à la frappe : null pour eux), et s'il l'a verrouillée. */
  zone: number | null;
  locked: boolean;
  stick: Stick;
  held: boolean;
  saves: number;
};

export type PenaltyShooter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  stick: Stick;
  held: boolean;
  goals: number;
  shots: number;
};

export type PenaltyState = {
  tick: number;
  practice: boolean;
  seed: number;
  keeper: PenaltyKeeper;
  fighters: PenaltyShooter[];
  shot: PenaltyShot;
  /** Les tirs finis, dans l'ordre : qui a tiré, dans quelle zone, et ce que ça a donné. */
  history: { shooter: PlayerId; zone: number; outcome: ShotOutcome }[];
  /** Le vainqueur, une fois décidé. */
  winner: 'keeper' | 'shooters' | null;
};

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** La colonne (-1, 0, 1) et la rangée (0 en bas, 1 en haut) d'une zone. */
export function zoneCell(zone: number): { column: number; row: number } {
  return { column: (zone % 3) - 1, row: zone >= 3 ? 1 : 0 };
}

/** Le milieu d'une zone dans le plan de la cage. */
export function zoneCenter(zone: number): { x: number; y: number } {
  const { column, row } = zoneCell(zone);
  return { x: column * COLUMN_WIDTH, y: ROW_HEIGHTS[row] ?? 1 };
}

/** Une lucarne : un coin du haut. */
export function isLucarne(zone: number): boolean {
  const { column, row } = zoneCell(zone);
  return row === 1 && column !== 0;
}

/** Deux zones voisines : côte à côte sur une rangée, ou l'une au-dessus de l'autre. */
export function areNeighbours(a: number, b: number): boolean {
  const one = zoneCell(a);
  const two = zoneCell(b);
  const columns = Math.abs(one.column - two.column);
  return (one.row === two.row && columns === 1) || (one.row !== two.row && columns === 0);
}

/** Un nombre propre à chaque joueur, pour varier les tirages d'un joueur à l'autre. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

function newShot(index: number, shooter: PlayerId, startAt: number): PenaltyShot {
  return {
    index,
    shooter,
    startAt,
    chooseEndsAt: startAt + toTick(WALK_TIME + CHOOSE_TIME),
    aim: FIRST_ZONE,
    aimLocked: false,
    rollAt: null,
    arriveAt: null,
    kickAt: null,
    quality: null,
    power: null,
    target: null,
    speed: 0,
    endAt: null,
    outcome: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed, solo }: { practice: boolean; seed: number; solo?: PlayerId | null },
): PenaltyState {
  const keeperId = solo ?? players[0] ?? '';
  const shooters = players.filter((id) => id !== keeperId);
  const still = { x: 0, z: 0 };
  return {
    tick: 0,
    practice,
    seed,
    keeper: { id: keeperId, zone: FIRST_ZONE, locked: false, stick: still, held: false, saves: 0 },
    fighters: shooters.map((id) => ({
      id,
      fellAt: null,
      stick: still,
      held: false,
      goals: 0,
      shots: 0,
    })),
    shot: newShot(0, shooters[0] ?? '', 0),
    history: [],
    winner: null,
  };
}

function step(state: PenaltyState, inputs: Partial<Record<PlayerId, ArenaInput>>): PenaltyState {
  const tick = state.tick + 1;
  const next: PenaltyState = {
    ...state,
    tick,
    keeper: { ...state.keeper },
    fighters: state.fighters.map((one) => ({ ...one })),
    shot: { ...state.shot },
  };
  if (next.winner !== null) return next;
  const { shot, keeper } = next;
  const shooter = next.fighters.find((one) => one.id === shot.shooter);
  // Au bac à sable, le mannequin d'en face joue tout seul (dummyInput).
  const shooterInput =
    inputs[shot.shooter] ?? (state.practice ? dummyInput(next, 'shooter') : IDLE_INPUT);
  const keeperInput =
    inputs[keeper.id] ?? (state.practice ? dummyInput(next, 'keeper') : IDLE_INPUT);
  const isChoosing = tick >= shot.startAt + toTick(WALK_TIME) && shot.rollAt === null;
  if (shooter) {
    if (isChoosing && !shot.aimLocked) {
      shot.aim = choose(shot.aim ?? FIRST_ZONE, shooter, shooterInput);
      if (pressed(shooter, shooterInput)) shot.aimLocked = true;
    } else if (shot.rollAt !== null) {
      kick(next, shooter, pressed(shooter, shooterInput));
    }
    shooter.stick = shooterInput.move;
    shooter.held = shooterInput.primary;
  }
  if (isChoosing && !keeper.locked) {
    keeper.zone = choose(keeper.zone ?? FIRST_ZONE, keeper, keeperInput);
    if (pressed(keeper, keeperInput)) keeper.locked = true;
  }
  keeper.stick = keeperInput.move;
  keeper.held = keeperInput.primary;
  // Les deux ont choisi (ou le temps est écoulé) : le ballon part.
  if (isChoosing && ((shot.aimLocked && keeper.locked) || tick >= shot.chooseEndsAt)) {
    shot.aimLocked = true;
    keeper.locked = true;
    shot.rollAt = tick + toTick(REVEAL_PAUSE);
    shot.arriveAt = shot.rollAt + toTick(ROLL_TIME);
  }
  settle(next);
  if (shot.endAt !== null && tick >= shot.endAt + toTick(RESULT_TIME)) nextShot(next);
  return next;
}

function pressed(player: { held: boolean }, input: ArenaInput): boolean {
  return input.primary && !player.held;
}

/**
 * Changer de zone : d'un cran à gauche ou à droite, en haut ou en bas, à chaque poussée du
 * stick ; ou d'un coup, en cliquant une zone (`target`).
 */
function choose(zone: number, player: { stick: Stick }, input: ArenaInput): number {
  if (input.target != null && input.target >= 0 && input.target < ZONES) return input.target;
  const { column, row } = zoneCell(zone);
  const was = player.stick;
  const move = input.move;
  let nextColumn = column;
  let nextRow = row;
  if (move.x > 0.5 && was.x <= 0.5) nextColumn = Math.min(1, column + 1);
  if (move.x < -0.5 && was.x >= -0.5) nextColumn = Math.max(-1, column - 1);
  if (move.z < -0.5 && was.z >= -0.5) nextRow = 1;
  if (move.z > 0.5 && was.z <= 0.5) nextRow = 0;
  return nextRow * 3 + nextColumn + 1;
}

/** La frappe : une fois, quand le ballon roule ; sa qualité dit sa force et où elle va. */
function kick(state: PenaltyState, shooter: PenaltyShooter, isPressed: boolean): void {
  const { shot, tick } = state;
  const isWaiting = shot.arriveAt === null || shot.rollAt === null;
  if (shot.kickAt !== null || shot.outcome !== null || isWaiting) return;
  const late = (tick - (shot.arriveAt ?? tick)) * ARENA_STEP;
  // Il n'a pas frappé à temps : le ballon file sous son pied, pas de tir.
  if (late > KICK_WINDOW) {
    fluff(shot, tick);
    return;
  }
  if (!isPressed || tick < (shot.rollAt ?? tick)) return;
  shot.kickAt = tick;
  shooter.shots += 1;
  if (Math.abs(late) > KICK_WINDOW) {
    fluff(shot, tick);
    return;
  }
  const quality = clamp(1 - (Math.abs(late) - PERFECT_KICK) / (KICK_WINDOW - PERFECT_KICK), 0, 1);
  const zone = shot.aim ?? FIRST_ZONE;
  const center = zoneCenter(zone);
  // Un peu de jeu autour du milieu de la zone, pour que tous les tirs ne se ressemblent pas.
  const jitter = (salt: number) => (forestUnit(state.seed, shot.index, salt) * 2 - 1) * 0.35;
  const isOver = isLucarne(zone) && quality < LUCARNE_KICK;
  shot.quality = quality;
  shot.power = quality >= STRONG_KICK ? 'strong' : 'weak';
  shot.speed = shot.power === 'strong' ? FAST_SHOT : SLOW_SHOT;
  shot.target = isOver
    ? { x: Math.sign(center.x) * (GOAL_HALF + 0.5), y: GOAL_HEIGHT + 0.4 }
    : { x: center.x + jitter(131), y: Math.max(0.25, center.y + jitter(132) * 0.6) };
  shot.endAt = tick + Math.max(1, Math.round(SPOT_DISTANCE / shot.speed / ARENA_STEP));
}

function fluff(shot: PenaltyShot, tick: number): void {
  shot.kickAt ??= tick;
  shot.quality = 0;
  shot.power = null;
  shot.outcome = 'fluff';
  shot.endAt = tick + toTick(FLUFF_TIME);
}

/** Le ballon passe la ligne : à côté, arrêté (sa zone, ou une voisine sur un tir faible), ou dedans. */
function settle(state: PenaltyState): void {
  const { shot, tick, keeper } = state;
  if (shot.outcome !== null || shot.target === null || shot.endAt === null || tick < shot.endAt) {
    return;
  }
  const { target } = shot;
  const zone = shot.aim ?? FIRST_ZONE;
  const isOut = Math.abs(target.x) > GOAL_HALF || target.y > GOAL_HEIGHT;
  const guarded = keeper.zone ?? FIRST_ZONE;
  const isSaved = guarded === zone || (shot.power === 'weak' && areNeighbours(guarded, zone));
  shot.outcome = isOut ? 'wide' : isSaved ? 'save' : 'goal';
}

/** Le tir fini compte ; le suivant commence, ou la séance est décidée. */
function nextShot(state: PenaltyState): void {
  const { shot } = state;
  const outcome = shot.outcome ?? 'fluff';
  state.history = [
    ...state.history,
    { shooter: shot.shooter, zone: shot.aim ?? FIRST_ZONE, outcome },
  ];
  const shooter = state.fighters.find((one) => one.id === shot.shooter);
  if (outcome === 'goal' && shooter) shooter.goals += 1;
  if (outcome === 'save') state.keeper.saves += 1;
  if (!state.practice) state.winner = winnerOf(state.history);
  if (state.winner !== null) return;
  const index = shot.index + 1;
  const shooters = state.fighters;
  const nextShooter = shooters[index % Math.max(1, shooters.length)]?.id ?? shot.shooter;
  state.shot = newShot(index, nextShooter, state.tick);
  state.keeper = { ...state.keeper, zone: FIRST_ZONE, locked: false };
}

/**
 * Qui gagne, d'après les tirs déjà finis (null : on continue). Le gardien gagne dès que les
 * tireurs ne peuvent plus marquer plus de la moitié des 6 tirs, les tireurs dès qu'ils en ont
 * marqué plus de la moitié ; à 3 partout, le septième tir décide.
 */
export function winnerOf(history: { outcome: ShotOutcome }[]): 'keeper' | 'shooters' | null {
  const goals = history.filter((one) => one.outcome === 'goal').length;
  const missed = history.length - goals;
  const half = SHOTS / 2;
  if (goals > half) return 'shooters';
  if (missed > half) return 'keeper';
  if (history.length <= SHOTS) return null;
  return history.at(-1)?.outcome === 'goal' ? 'shooters' : 'keeper';
}

/**
 * Au bac à sable, le mannequin d'en face : il choisit une zone au hasard et la verrouille ; s'il
 * tire, il frappe à peu près à temps.
 */
function dummyInput(state: PenaltyState, role: 'shooter' | 'keeper'): ArenaInput {
  const { shot, tick } = state;
  const unit = (salt: number) => forestUnit(state.seed, shot.index, salt);
  const zone = Math.floor(unit(role === 'shooter' ? 141 : 142) * ZONES);
  const isChoosing = shot.rollAt === null && tick >= shot.startAt + toTick(WALK_TIME + 0.8);
  if (isChoosing) return { move: { x: 0, z: 0 }, primary: true, secondary: false, target: zone };
  const isKick =
    role === 'shooter' &&
    shot.arriveAt !== null &&
    tick === shot.arriveAt + Math.round((unit(143) - 0.5) * 4);
  return { move: { x: 0, z: 0 }, primary: isKick, secondary: false };
}

function isOver(state: PenaltyState): boolean {
  return !state.practice && state.winner !== null;
}

function ranking(state: PenaltyState): PlayerId[][] {
  const shooters = state.fighters.map((one) => one.id);
  return state.winner === 'keeper' ? [[state.keeper.id], shooters] : [shooters, [state.keeper.id]];
}

/**
 * Les choix cachés (02-mini-jeux.md : le tir et le plongeon sont cachés jusqu'au coup de pied) :
 * jusqu'à la frappe, le gardien ne voit pas la zone du tireur, et les tireurs (et les
 * spectateurs) ne voient pas celle du gardien. Chacun voit la sienne.
 */
function viewFor(state: PenaltyState, viewer: Viewer): PenaltyState {
  if (state.shot.kickAt !== null) return state;
  const id = viewer.type === 'player' ? viewer.playerId : null;
  const seesAim = id === state.shot.shooter;
  const seesKeeper = id === state.keeper.id;
  return {
    ...state,
    shot: seesAim ? state.shot : { ...state.shot, aim: null },
    keeper: seesKeeper ? state.keeper : { ...state.keeper, zone: null },
  };
}

/**
 * Le goût d'un bot pour chaque sorte de zone : le milieu en bas, les coins du bas, le milieu en
 * haut, les lucarnes. Les tireurs ont aussi l'écart de leur frappe au bon moment (secondes, tiré
 * entre plus et moins) ; les gardiens, la part des fois où ils gardent la zone où ce tireur a
 * tiré la dernière fois.
 */
type Taste = { middle: number; corners: number; top: number; lucarnes: number };
const SHOOTER: Record<BotLevel, { timing: number; taste: Taste }> = {
  easy: { timing: 0.14, taste: { middle: 3, corners: 2, top: 1, lucarnes: 0.4 } },
  normal: { timing: 0.135, taste: { middle: 2, corners: 3, top: 1, lucarnes: 1 } },
  expert: { timing: 0.125, taste: { middle: 1, corners: 3, top: 1, lucarnes: 1.4 } },
};
const KEEPER: Record<BotLevel, { taste: Taste; read: number }> = {
  easy: { taste: { middle: 1.5, corners: 2, top: 1, lucarnes: 1 }, read: 0 },
  normal: { taste: { middle: 1.5, corners: 3, top: 1, lucarnes: 1 }, read: 0.4 },
  expert: { taste: { middle: 1, corners: 3.5, top: 0.8, lucarnes: 2.2 }, read: 0.75 },
};
/** Un bot verrouille sa zone au bout de tant de secondes (tiré entre ces bornes). */
const BOT_THINK: readonly [number, number] = [0.6, 2.4];

/** Une zone tirée selon un goût : chaque coin compte pour moitié de son goût (il y en a deux). */
function pickZone(unit: number, taste: Taste): number {
  const weights = [
    taste.corners / 2,
    taste.middle,
    taste.corners / 2,
    taste.lucarnes / 2,
    taste.top,
    taste.lucarnes / 2,
  ];
  let left = unit * weights.reduce((sum, one) => sum + one, 0);
  for (const [zone, weight] of weights.entries()) {
    left -= weight;
    if (left < 0) return zone;
  }
  return FIRST_ZONE;
}

function botInput(state: PenaltyState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const { shot, tick } = state;
  if (state.winner !== null) return IDLE_INPUT;
  const isKeeper = player === state.keeper.id;
  if (!isKeeper && player !== shot.shooter) return IDLE_INPUT;
  const unit = (salt: number) => forestUnit(state.seed, shot.index, salt + saltOf(player));
  const think = BOT_THINK[0] + (BOT_THINK[1] - BOT_THINK[0]) * unit(151);
  if (shot.rollAt === null) {
    const locked = isKeeper ? state.keeper.locked : shot.aimLocked;
    if (locked || tick < shot.startAt + toTick(WALK_TIME + think)) return IDLE_INPUT;
    const zone = isKeeper
      ? keeperZone(state, level, unit)
      : pickZone(unit(152), SHOOTER[level].taste);
    return { move: { x: 0, z: 0 }, primary: true, secondary: false, target: zone };
  }
  if (isKeeper || shot.arriveAt === null || shot.kickAt !== null) return IDLE_INPUT;
  const error = Math.round(((unit(153) * 2 - 1) * SHOOTER[level].timing) / ARENA_STEP);
  const kickAt = Math.max(shot.rollAt, shot.arriveAt + error);
  return { move: { x: 0, z: 0 }, primary: tick === kickAt, secondary: false };
}

/** Le gardien bot : une zone selon son goût, ou celle où ce tireur a tiré la dernière fois. */
function keeperZone(state: PenaltyState, level: BotLevel, unit: (salt: number) => number): number {
  const bot = KEEPER[level];
  const last = [...state.history].reverse().find((one) => one.shooter === state.shot.shooter);
  if (last && unit(154) < bot.read) return last.zone;
  return pickZone(unit(155), bot.taste);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export const PENALTY_KICKS: ArenaGame<PenaltyState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
  viewFor,
};
