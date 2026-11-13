import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Tirs au but (02-mini-jeux.md, fiche 52), un 1 contre tous : le joueur seul garde la cage, les
// autres tirent chacun leur tour, 6 tirs en tout. Le tireur vise librement dans la cage (une mire
// qu'il déplace, cachée au gardien) ; un ramasseur lui roule le ballon, il frappe au moment où le
// ballon arrive au point de penalty : pile à temps, la frappe part fort et où il vise ; en avance
// ou en retard, moins vite et de travers ; trop loin du moment, c'est raté. Le gardien se
// déplace sur sa ligne et plonge (une fois par tir) dans la direction du stick, en réflexe ou en
// devinant. Il gagne s'il encaisse moins de buts qu'il n'en arrête ; à égalité (3 partout), un tir
// de plus décide. Plan de la cage : `x` en travers (0 au milieu), `y` la hauteur, en mètres.

/** La cage : 2 × GOAL_HALF de large, GOAL_HEIGHT de haut ; le point de penalty à SPOT_DISTANCE. */
export const GOAL_HALF = 3;
export const GOAL_HEIGHT = 2.2;
export const SPOT_DISTANCE = 9;
/** La mire du tireur : elle va jusque-là (un peu hors du cadre : on peut tirer à côté), à cette vitesse. */
export const AIM_LIMIT_X = 3.8;
export const AIM_LIMIT_Y = 2.9;
const AIM_SPEED = 3.4;
/** Le tireur s'avance pendant WALK_TIME ; le ballon part entre ROLL_DELAY et arrive en ROLL_TIME. */
export const WALK_TIME = 1;
const ROLL_DELAY: readonly [number, number] = [0.9, 2];
export const ROLL_TIME = 0.9;
/**
 * La frappe : à PERFECT_KICK près du moment où le ballon arrive, elle est parfaite ; elle se
 * dégrade jusqu'à KICK_WINDOW, au-delà c'est raté. Une frappe parfaite part à FAST_SHOT, la plus
 * mauvaise à SLOW_SHOT, et dévie d'autant plus (jusqu'à SHOT_ERROR mètres) qu'elle est mauvaise.
 */
export const PERFECT_KICK = 0.04;
export const KICK_WINDOW = 0.3;
const FAST_SHOT = 23;
const SLOW_SHOT = 11;
/**
 * L'élan du tireur (02-mini-jeux.md, fiche 52) : HINT_LEAD secondes avant que le ballon n'arrive,
 * il penche vers le côté où il vise (si sa mire est à plus de HINT_SIDE du milieu), et tout le
 * monde le voit. Il peut encore corriger, mais pas assez pour changer de coin. Sans ce signe, un
 * gardien ne pouvait que deviner : sa réaction arrivait trop tard sur une bonne frappe.
 */
export const HINT_LEAD = 0.35;
const HINT_SIDE = 0.8;
const SHOT_ERROR = 1.1;
/** Un tir fini se montre ce temps-là avant le suivant (le but, l'arrêt, le ralenti du public). */
export const RESULT_TIME = 1.9;
/** Un tir raté se traîne ce temps avant d'être compté. */
const FLUFF_TIME = 0.7;
/** Le gardien : sa vitesse sur la ligne, jusqu'où il va, son plongeon (vitesse, portée). */
const KEEPER_SPEED = 3.2;
export const KEEPER_LIMIT = 2.6;
const DIVE_SPEED = 7.2;
export const DIVE_REACH = 2.5;
/** Son corps, pour les arrêts : un bâton (des pieds aux mains), d'une épaisseur de BODY_RADIUS. */
export const KEEPER_MIDDLE = 1;
const BODY_RADIUS = 0.5;
/** Debout, de ses pieds à ses mains levées ; en plongeon, de derrière lui à ses mains tendues. */
const STANDING_FROM = 0.15;
const STANDING_TO = 1.9;
const DIVE_BACK = 0.6;
const DIVE_HANDS = 0.85;
/** Les tirs de la séance, et au plus tant de tirs de plus pour départager. */
export const SHOTS = 6;

export type ShotOutcome = 'goal' | 'save' | 'wide' | 'fluff';

export type PenaltyShot = {
  index: number;
  shooter: PlayerId;
  /** Le pas où il commence (le tireur s'avance), où le ballon part, où il arrive au point. */
  startAt: number;
  rollAt: number;
  arriveAt: number;
  /** La mire du tireur (cachée au gardien jusqu'à la frappe : null pour lui). */
  aim: { x: number; y: number } | null;
  /** La frappe : son pas, sa qualité (0 à 1), où le ballon passe la ligne et à quelle vitesse. */
  kickAt: number | null;
  quality: number | null;
  target: { x: number; y: number } | null;
  speed: number;
  /** Le pas où le ballon passe la ligne de but (ou finit de se traîner), et ce que ça donne. */
  endAt: number | null;
  outcome: ShotOutcome | null;
  /** Le côté vers lequel le tireur penche (-1, 0 au milieu, 1), une fois son élan pris ; ou null. */
  lean: -1 | 0 | 1 | null;
};

export type PenaltyKeeper = {
  id: PlayerId;
  x: number;
  vx: number;
  /** Son plongeon de ce tir : quand, et vers où (vecteur unité dans le plan de la cage). */
  diveAt: number | null;
  dive: { x: number; y: number } | null;
  held: boolean;
  saves: number;
};

export type PenaltyShooter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
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
  /** Les tirs finis, dans l'ordre : qui a tiré, et ce que ça a donné. */
  history: { shooter: PlayerId; outcome: ShotOutcome }[];
  /** Le vainqueur, une fois décidé (le gardien ou les tireurs). */
  winner: 'keeper' | 'shooters' | null;
};

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Un nombre propre à chaque joueur, pour varier les tirages d'un joueur à l'autre. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

function newShot(seed: number, index: number, shooter: PlayerId, startAt: number): PenaltyShot {
  const delay = ROLL_DELAY[0] + (ROLL_DELAY[1] - ROLL_DELAY[0]) * forestUnit(seed, index, 101);
  const rollAt = startAt + toTick(WALK_TIME + delay);
  return {
    index,
    shooter,
    startAt,
    rollAt,
    arriveAt: rollAt + toTick(ROLL_TIME),
    aim: { x: 0, y: GOAL_HEIGHT / 2 },
    kickAt: null,
    quality: null,
    target: null,
    speed: 0,
    endAt: null,
    outcome: null,
    lean: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed, solo }: { practice: boolean; seed: number; solo?: PlayerId | null },
): PenaltyState {
  // Au bac à sable, toi et un mannequin : il garde la cage, ou c'est lui qui tire quand tu es
  // le joueur seul (il tire alors tout seul, dummyShot).
  const keeperId = solo ?? players[0] ?? '';
  const shooters = players.filter((id) => id !== keeperId);
  const first = shooters[0] ?? '';
  return {
    tick: 0,
    practice,
    seed,
    keeper: { id: keeperId, x: 0, vx: 0, diveAt: null, dive: null, held: false, saves: 0 },
    fighters: shooters.map((id) => ({ id, fellAt: null, held: false, goals: 0, shots: 0 })),
    shot: newShot(seed, 0, first, 0),
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
    history: state.history,
  };
  if (next.winner !== null) return next;
  const { shot } = next;
  const shooterInput = inputs[shot.shooter] ?? (state.practice ? dummyShot(state) : IDLE_INPUT);
  const shooter = next.fighters.find((one) => one.id === shot.shooter);
  if (shooter) aimAndKick(next, shooter, shooterInput);
  guard(next, inputs[next.keeper.id] ?? IDLE_INPUT);
  settle(next);
  if (shot.endAt !== null && tick >= shot.endAt + toTick(RESULT_TIME)) nextShot(next);
  return next;
}

/** Le tireur : il déplace sa mire, et frappe (une fois) quand le ballon roule vers lui. */
function aimAndKick(state: PenaltyState, shooter: PenaltyShooter, input: ArenaInput): void {
  const { shot, tick } = state;
  const pressed = input.primary && !shooter.held;
  shooter.held = input.primary;
  if (shot.kickAt !== null || shot.outcome !== null || tick < shot.startAt + toTick(WALK_TIME))
    return;
  const aim = shot.aim ?? { x: 0, y: GOAL_HEIGHT / 2 };
  shot.aim = {
    x: clamp(aim.x + input.move.x * AIM_SPEED * ARENA_STEP, -AIM_LIMIT_X, AIM_LIMIT_X),
    y: clamp(aim.y - input.move.z * AIM_SPEED * ARENA_STEP, 0, AIM_LIMIT_Y),
  };
  if (shot.lean === null && tick >= shot.arriveAt - toTick(HINT_LEAD)) {
    shot.lean = Math.abs(shot.aim.x) < HINT_SIDE ? 0 : shot.aim.x < 0 ? -1 : 1;
  }
  const late = (tick - shot.arriveAt) * ARENA_STEP;
  // Il n'a pas frappé à temps : le ballon file sous son pied, pas de tir.
  if (late > KICK_WINDOW) {
    fluff(shot, tick);
    return;
  }
  if (!pressed || tick < shot.rollAt) return;
  shot.kickAt = tick;
  if (Math.abs(late) > KICK_WINDOW) {
    fluff(shot, tick);
    return;
  }
  const quality = clamp(1 - (Math.abs(late) - PERFECT_KICK) / (KICK_WINDOW - PERFECT_KICK), 0, 1);
  const angle = forestUnit(state.seed, shot.index, 102 + saltOf(shooter.id)) * Math.PI * 2;
  const error = (1 - quality) * SHOT_ERROR;
  shot.quality = quality;
  shot.speed = SLOW_SHOT + (FAST_SHOT - SLOW_SHOT) * quality;
  shot.target = {
    x: shot.aim.x + Math.cos(angle) * error,
    y: Math.max(0.1, shot.aim.y + Math.sin(angle) * error),
  };
  shot.endAt = tick + Math.max(1, Math.round(SPOT_DISTANCE / shot.speed / ARENA_STEP));
  shooter.shots += 1;
}

function fluff(shot: PenaltyShot, tick: number): void {
  shot.kickAt ??= tick;
  shot.quality = 0;
  shot.outcome = 'fluff';
  shot.endAt = tick + toTick(FLUFF_TIME);
}

/** Le gardien : il se déplace sur sa ligne, et plonge une fois par tir, vers où pousse le stick. */
function guard(state: PenaltyState, input: ArenaInput): void {
  const { keeper, shot, tick } = state;
  const pressed = input.primary && !keeper.held;
  keeper.held = input.primary;
  const isOpen = shot.outcome === null && (shot.endAt === null || tick <= shot.endAt);
  if (keeper.diveAt === null && isOpen) {
    keeper.vx = clamp(input.move.x, -1, 1) * KEEPER_SPEED;
    keeper.x = clamp(keeper.x + keeper.vx * ARENA_STEP, -KEEPER_LIMIT, KEEPER_LIMIT);
    if (pressed && tick >= shot.startAt + toTick(WALK_TIME)) {
      // Sans direction, il saute droit vers le haut.
      const dx = input.move.x;
      const dy = -input.move.z;
      const length = Math.hypot(dx, dy);
      keeper.diveAt = tick;
      keeper.dive = length > 0.2 ? { x: dx / length, y: dy / length } : { x: 0, y: 1 };
    }
  } else {
    keeper.vx = 0;
  }
}

/** Où est le centre du gardien à ce pas (fraction comprise), et vers où il est tendu. */
export function keeperPose(
  keeper: PenaltyKeeper,
  tick: number,
): { x: number; y: number; dir: { x: number; y: number } | null } {
  if (keeper.diveAt === null || keeper.dive === null) {
    return { x: keeper.x, y: KEEPER_MIDDLE, dir: null };
  }
  const flown = Math.min(DIVE_REACH, Math.max(0, tick - keeper.diveAt) * ARENA_STEP * DIVE_SPEED);
  return {
    x: keeper.x + keeper.dive.x * flown,
    // Il ne s'envole pas : un plongeon vers le haut monte moins loin qu'un plongeon de côté.
    y: Math.max(0.35, KEEPER_MIDDLE + keeper.dive.y * flown * 0.55),
    dir: keeper.dive,
  };
}

/** Le gardien touche-t-il un ballon qui passe la ligne en (x, y) à ce pas ? */
export function isSaved(
  keeper: PenaltyKeeper,
  tick: number,
  ball: { x: number; y: number },
): boolean {
  const pose = keeperPose(keeper, tick);
  const from = pose.dir
    ? { x: pose.x - pose.dir.x * DIVE_BACK, y: pose.y - pose.dir.y * DIVE_BACK }
    : { x: pose.x, y: STANDING_FROM };
  const to = pose.dir
    ? { x: pose.x + pose.dir.x * DIVE_HANDS, y: pose.y + pose.dir.y * DIVE_HANDS }
    : { x: pose.x, y: STANDING_TO };
  return segmentDistance(ball, from, to) < BODY_RADIUS;
}

function segmentDistance(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const share = clamp(
    ((point.x - a.x) * ex + (point.y - a.y) * ey) / (ex * ex + ey * ey || 1),
    0,
    1,
  );
  return Math.hypot(point.x - (a.x + ex * share), point.y - (a.y + ey * share));
}

/** Le ballon passe la ligne : à côté, arrêté, ou dedans. */
function settle(state: PenaltyState): void {
  const { shot, tick } = state;
  if (shot.outcome !== null || shot.target === null || shot.endAt === null || tick < shot.endAt) {
    return;
  }
  const { target } = shot;
  const isOut = Math.abs(target.x) > GOAL_HALF || target.y > GOAL_HEIGHT;
  if (isOut) shot.outcome = 'wide';
  else if (isSaved(state.keeper, tick, target)) shot.outcome = 'save';
  else shot.outcome = 'goal';
}

/** Le tir fini compte ; le suivant commence, ou la séance est décidée. */
function nextShot(state: PenaltyState): void {
  const { shot } = state;
  const outcome = shot.outcome ?? 'fluff';
  state.history = [...state.history, { shooter: shot.shooter, outcome }];
  const shooter = state.fighters.find((one) => one.id === shot.shooter);
  if (outcome === 'goal' && shooter) shooter.goals += 1;
  if (outcome === 'save') state.keeper.saves += 1;
  if (!state.practice) state.winner = winnerOf(state.history);
  if (state.winner !== null) return;
  const index = shot.index + 1;
  const shooters = state.fighters;
  const nextShooter = shooters[index % Math.max(1, shooters.length)]?.id ?? shot.shooter;
  state.shot = newShot(state.seed, index, nextShooter, state.tick);
  state.keeper = { ...state.keeper, x: 0, vx: 0, diveAt: null, dive: null };
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

/** Au bac à sable, le tireur mannequin : il vise un coin tiré au hasard et frappe à peu près à temps. */
function dummyShot(state: PenaltyState): ArenaInput {
  const { shot, tick } = state;
  const unit = (salt: number) => forestUnit(state.seed, shot.index, salt);
  const goal = { x: (unit(103) * 2 - 1) * 2.4, y: 0.3 + unit(104) * 1.6 };
  const aim = shot.aim ?? goal;
  const kickAt = shot.arriveAt + Math.round((unit(105) - 0.5) * 4);
  return {
    move: { x: clamp((goal.x - aim.x) * 2, -1, 1), z: clamp(-(goal.y - aim.y) * 2, -1, 1) },
    primary: tick === kickAt,
    secondary: false,
  };
}

function isOver(state: PenaltyState): boolean {
  return !state.practice && state.winner !== null;
}

function ranking(state: PenaltyState): PlayerId[][] {
  const shooters = state.fighters.map((one) => one.id);
  return state.winner === 'keeper' ? [[state.keeper.id], shooters] : [shooters, [state.keeper.id]];
}

/** Le gardien ne voit pas la mire du tireur avant la frappe (02-mini-jeux.md : choix cachés). */
function viewFor(state: PenaltyState, viewer: Viewer): PenaltyState {
  const isKeeper = viewer.type === 'player' && viewer.playerId === state.keeper.id;
  if (!isKeeper || state.shot.kickAt !== null) return state;
  return { ...state, shot: { ...state.shot, aim: null } };
}

/**
 * Les bots tireurs, selon leur niveau : l'écart de leur frappe au bon moment (secondes, tiré
 * entre plus et moins), et jusqu'où ils osent viser vers les poteaux et la lucarne (part de la
 * cage). Les gardiens : le temps qu'ils mettent à réagir à la frappe, leur erreur sur l'endroit
 * où le ballon arrive (m), et la chance qu'ils devinent (plongent avant la frappe, d'un côté au
 * hasard).
 */
const SHOOTER: Record<BotLevel, { timing: number; daring: number }> = {
  easy: { timing: 0.16, daring: 0.75 },
  normal: { timing: 0.1, daring: 0.88 },
  expert: { timing: 0.06, daring: 0.96 },
};
const KEEPER: Record<BotLevel, { react: number; error: number; guess: number; read: number }> = {
  easy: { react: 0.29, error: 0.6, guess: 0.12, read: 0.3 },
  normal: { react: 0.25, error: 0.42, guess: 0.15, read: 0.45 },
  expert: { react: 0.22, error: 0.3, guess: 0.15, read: 0.55 },
};
/** Sa réaction varie d'un tir à l'autre, de tant de part et d'autre (secondes). */
const REACT_JITTER = 0.06;
/** Il lit l'élan (une chance par tir selon son niveau) : il se décale de tant de ce côté. */
const LEAN_STEP = 0.6;
/** Un gardien qui devine plonge tant de secondes avant que le ballon arrive au point. */
const GUESS_LEAD = 0.1;

function botInput(state: PenaltyState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  if (state.winner !== null) return IDLE_INPUT;
  if (player === state.keeper.id) return keeperBot(state, level);
  if (player !== state.shot.shooter) return IDLE_INPUT;
  const { shot, tick } = state;
  if (shot.kickAt !== null) return IDLE_INPUT;
  const unit = (salt: number) => forestUnit(state.seed, shot.index, salt + saltOf(player));
  const bot = SHOOTER[level];
  // Un coin choisi pour ce tir, plus ou moins près des poteaux selon son audace.
  const side = unit(111) < 0.5 ? -1 : 1;
  const wide = 0.25 + (unit(112) * 0.4 + 0.6) * (bot.daring - 0.25);
  const goal = {
    x: unit(113) < 0.15 ? 0 : side * GOAL_HALF * wide,
    y: unit(114) < 0.5 ? 0.35 : GOAL_HEIGHT * (0.45 + 0.4 * bot.daring),
  };
  const aim = shot.aim ?? goal;
  const kickAt = shot.arriveAt + Math.round(((unit(115) * 2 - 1) * bot.timing) / ARENA_STEP);
  return {
    move: { x: clamp((goal.x - aim.x) * 3, -1, 1), z: clamp(-(goal.y - aim.y) * 3, -1, 1) },
    primary: tick === Math.max(shot.rollAt, kickAt),
    secondary: false,
  };
}

/** Le gardien bot : il devine parfois, sinon il réagit à la frappe et plonge vers le ballon. */
function keeperBot(state: PenaltyState, level: BotLevel): ArenaInput {
  const { shot, tick, keeper } = state;
  const bot = KEEPER[level];
  if (keeper.diveAt !== null || shot.outcome !== null) return IDLE_INPUT;
  const unit = (salt: number) => forestUnit(state.seed, shot.index, salt);
  const isGuess = unit(121) < bot.guess;
  if (shot.kickAt === null) {
    if (isGuess && tick === shot.arriveAt - toTick(GUESS_LEAD)) {
      const side = unit(122) < 0.5 ? -1 : 1;
      return { move: { x: side, z: unit(123) < 0.5 ? 0 : -0.8 }, primary: true, secondary: false };
    }
    // Il se recentre ; s'il lit l'élan du tireur, il se décale de ce côté.
    const isRead = shot.lean !== null && unit(126) < bot.read;
    const spot = isRead ? (shot.lean ?? 0) * LEAN_STEP : 0;
    return {
      move: { x: clamp((spot - keeper.x) * 2, -1, 1), z: 0 },
      primary: false,
      secondary: false,
    };
  }
  const react = bot.react + (unit(127) * 2 - 1) * REACT_JITTER;
  if (!shot.target || tick < shot.kickAt + toTick(react)) return IDLE_INPUT;
  // Là où il croit que le ballon va arriver (à son erreur près), et le plongeon pour y être.
  const errX = (unit(124) * 2 - 1) * bot.error;
  const errY = (unit(125) * 2 - 1) * bot.error * 0.6;
  const seen = { x: shot.target.x + errX, y: shot.target.y + errY };
  if (Math.abs(seen.x) > GOAL_HALF + 0.3 || seen.y > GOAL_HEIGHT + 0.3) return IDLE_INPUT;
  const dx = seen.x - keeper.x;
  const dy = (seen.y - KEEPER_MIDDLE) / 0.55;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return { move: { x: 0, z: 0 }, primary: true, secondary: false };
  return { move: { x: dx / length, z: -dy / length }, primary: true, secondary: false };
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
