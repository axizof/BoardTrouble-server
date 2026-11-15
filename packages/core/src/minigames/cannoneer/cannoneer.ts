import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  collideBodies,
  createBody,
  isSteady,
  knockDown,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';
import { forestUnit } from '../offPiste/forest';
import {
  clampToDeck,
  DECK_BACK,
  DECK_FRONT,
  DECK_HALF_X,
  keepOnDeck,
  LEVER_SPOTS,
  MUZZLE,
  RUNNER_STARTS,
} from './fort';

// Le Canonnier (02-mini-jeux.md, fiche 30), un 1 contre tous au fort pirate (fort.ts) : le
// joueur seul est en haut de la tour, avec un canon. Il vise un point du ponton (la souris, ou
// le viseur qu'il déplace au stick) et tire : le boulet monte en cloche et retombe au bout d'un
// peu plus d'une seconde ; son ombre grandit au sol, tout le monde la voit. Les autres courent
// sur le ponton, 3 vies chacun, avec une ruée pour esquiver. Un levier apparaît de temps en
// temps sur le ponton : y rester LEVER_TIME secondes enraye le canon ; au LEVERS_TO_WIN-ième, la
// tour s'écroule et les coureurs gagnent. Le canonnier reçoit un boulet spécial toutes les
// SPECIAL_EVERY secondes (annoncé à tous). Il gagne s'il élimine la moitié des coureurs avant la
// fin.

export const CANNON_TIME = 45;
export const RUNNER_LIVES = 3;
/** Le canon se recharge en tant de secondes ; enrayé par un levier, il ne tire plus JAM_TIME. */
export const CANNON_RELOAD = 0.6;
export const JAM_TIME = 2;
/** Le vol d'un boulet : FLIGHT_BASE, plus FLIGHT_PER_METER par mètre depuis la tour. */
const FLIGHT_BASE = 0.6;
const FLIGHT_PER_METER = 0.025;
/** Le viseur au stick va à cette vitesse (m/s). */
const AIM_SPEED = 10;
/** Un boulet spécial toutes les SPECIAL_EVERY secondes (un seul en réserve), le premier plus tôt. */
export const SPECIAL_EVERY = 8;
const FIRST_SPECIAL = 6;
export type BallKind = 'ball' | 'giant' | 'cluster' | 'bouncer';
export type SpecialKind = Exclude<BallKind, 'ball'>;
const SPECIALS: readonly SpecialKind[] = ['giant', 'cluster', 'bouncer'];
/** Le rayon de l'impact de chaque sorte (m), et ce qu'un boulet géant met de plus à tomber. */
export const CANNON_BLAST: Record<BallKind, number> = {
  ball: 1.5,
  giant: 2.8,
  cluster: 1,
  bouncer: 1.1,
};
const GIANT_SLOWER = 1.4;
/** La grappe : trois boulets en triangle autour du point visé, à tant du milieu. */
const CLUSTER_SPREAD = 1.8;
/** Le boulet qui rebondit : deux rebonds de BOUNCE_STEP mètres vers l'avant, BOUNCE_TIME chacun. */
const BOUNCES = 2;
const BOUNCE_STEP = 2.8;
const BOUNCE_TIME = 0.55;
/** Touché : il tombe et glisse, puis reste intouchable SHIELD_TIME secondes (il clignote). */
const HIT_SPEED = 6;
const HIT_DOWN = 0.8;
export const SHIELD_TIME = 1.6;
/** La ruée des coureurs : un élan bref (environ 2 m), puis une recharge. */
const RUSH_SPEED = 11;
export const CANNON_RUSH_TIME = 0.16;
export const CANNON_RUSH_COOLDOWN = 2;
/**
 * Les leviers : un à la fois, le premier après FIRST_LEVER secondes, le suivant LEVER_PAUSE après
 * le précédent. On le tire en restant à LEVER_REACH de lui : LEVER_TIME secondes de présence
 * (plus vite à plusieurs, jusqu'à deux fois), qui retombent doucement si personne n'y est.
 */
const FIRST_LEVER = 3;
const LEVER_PAUSE = 4;
export const LEVER_TIME = 2.5;
const LEVER_REACH = 1;
const LEVER_DECAY = 0.5;
/**
 * Chaque coureur au-delà de LEVER_RUNNERS rend un levier LEVER_PER_EXTRA secondes plus long à
 * tirer : à six joueurs, plus de coureurs se relaient sur les leviers (retour de simulation : la
 * tour tombait une fois sur deux).
 */
const LEVER_RUNNERS = 3;
const LEVER_PER_EXTRA = 0.5;
const RELOAD_PER_EXTRA = 0.05;
export const LEVERS_TO_WIN = 5;
/** Un boulet tombé reste dans l'état ce temps-là : le client montre l'explosion. */
const BLAST_KEPT = 0.8;

export type CannonSolo = {
  id: PlayerId;
  /** Le point visé sur le ponton. */
  aim: { x: number; z: number };
  /** Le pas où le canon sera rechargé, et celui jusqu'où il est enrayé. */
  readyAt: number;
  jammedUntil: number;
  /** Son boulet spécial en réserve, ou null ; le pas où il en recevra un (s'il n'en a pas). */
  special: SpecialKind | null;
  specialAt: number;
  specials: number;
  /** Ses tirs, et les vies qu'il a prises (stats). */
  shots: number;
  hits: number;
  heldPrimary: boolean;
  heldSecondary: boolean;
};

export type CannonRunner = ArenaBody & {
  /** Le pas où il a perdu sa dernière vie, ou null. */
  fellAt: number | null;
  lives: number;
  /** Le pas où un boulet l'a touché, ou null : il est intouchable SHIELD_TIME après. */
  hurtAt: number | null;
  rushing: number;
  rushReady: number;
  held: boolean;
  /** Les leviers qu'il a tirés (stats). */
  pulls: number;
};

/** Un boulet : d'où il part, où il tombe, quand, et ce qui lui reste de rebonds. */
export type CannonBall = {
  id: number;
  kind: BallKind;
  fromX: number;
  fromY: number;
  fromZ: number;
  x: number;
  z: number;
  firedAt: number;
  landAt: number;
  bounces: number;
  /** Le pas où il est tombé (il explose), ou null en vol. */
  landedAt: number | null;
};

export type CannonLever = {
  id: number;
  spot: number;
  x: number;
  z: number;
  /** Les secondes de présence déjà faites (LEVER_TIME pour le tirer). */
  progress: number;
  appearedAt: number;
  /** Le pas où il a été tiré, ou null. */
  pulledAt: number | null;
};

export type CannonState = {
  tick: number;
  practice: boolean;
  seed: number;
  solo: CannonSolo;
  fighters: CannonRunner[];
  balls: CannonBall[];
  nextBall: number;
  lever: CannonLever | null;
  nextLeverAt: number;
  levers: number;
  /** Le pas où la tour s'est écroulée (le dernier levier), ou null. */
  fallenAt: number | null;
};

function steps(seconds: number): number {
  return Math.round(seconds / ARENA_STEP);
}

function create(
  players: PlayerId[],
  { practice, seed, solo }: { practice: boolean; seed: number; solo?: PlayerId | null },
): CannonState {
  const soloId = solo ?? players[0] ?? '';
  const runners = players.filter((id) => id !== soloId);
  return {
    tick: 0,
    practice,
    seed,
    solo: {
      id: soloId,
      aim: { x: 0, z: 1 },
      readyAt: 0,
      jammedUntil: 0,
      special: null,
      specialAt: steps(FIRST_SPECIAL),
      specials: 0,
      shots: 0,
      hits: 0,
      heldPrimary: false,
      heldSecondary: false,
    },
    fighters: runners.map((id, index) => {
      const start = RUNNER_STARTS[index % RUNNER_STARTS.length] ?? { x: 0, z: 2 };
      return {
        // Ils regardent la tour, au fond.
        ...createBody(id, start.x, start.z, Math.PI),
        fellAt: null,
        lives: RUNNER_LIVES,
        hurtAt: null,
        rushing: 0,
        rushReady: 0,
        held: false,
        pulls: 0,
      };
    }),
    balls: [],
    nextBall: 0,
    lever: null,
    nextLeverAt: steps(FIRST_LEVER),
    levers: 0,
    fallenAt: null,
  };
}

function alive(state: CannonState): CannonRunner[] {
  return state.fighters.filter((one) => one.fellAt === null);
}

function step(state: CannonState, inputs: Partial<Record<PlayerId, ArenaInput>>): CannonState {
  const tick = state.tick + 1;
  const next: CannonState = {
    ...state,
    tick,
    solo: { ...state.solo, aim: { ...state.solo.aim } },
    fighters: state.fighters.map((one) => ({ ...one })),
    balls: state.balls.map((ball) => ({ ...ball })),
    lever: state.lever ? { ...state.lever } : null,
  };
  if (isOver(state)) return next;
  const standing = alive(next);
  for (const runner of standing) {
    const input =
      inputs[runner.id] ?? (state.practice ? dummyRunnerInput(next, runner) : IDLE_INPUT);
    actRunner(runner, input);
  }
  const shift = tick % Math.max(1, standing.length);
  collideBodies([...standing.slice(shift), ...standing.slice(0, shift)], WALKER, new Set());
  moveBodies(standing, WALKER, ARENA_STEP);
  for (const runner of standing) keepOnDeck(runner, WALKER.radius);
  const soloInput = inputs[next.solo.id] ?? (state.practice ? dummySoloInput(next) : IDLE_INPUT);
  actSolo(next, soloInput);
  landBalls(next);
  pullLever(next);
  next.balls = next.balls.filter(
    (ball) => ball.landedAt === null || tick - ball.landedAt <= steps(BLAST_KEPT),
  );
  return next;
}

/** Un coureur : il court, et sa ruée part quand on appuie. */
function actRunner(runner: CannonRunner, input: ArenaInput): void {
  const pressed = input.primary && !runner.held;
  runner.held = input.primary;
  runner.rushReady = Math.max(0, runner.rushReady - ARENA_STEP);
  if (runner.rushing > 0) {
    runner.rushing = Math.max(0, runner.rushing - ARENA_STEP);
    return;
  }
  if (pressed && runner.rushReady <= 0 && isSteady(runner)) {
    if (Math.hypot(input.move.x, input.move.z) > 0.1) {
      runner.facing = Math.atan2(input.move.x, input.move.z);
    }
    Object.assign(runner, {
      rushing: CANNON_RUSH_TIME,
      rushReady: CANNON_RUSH_COOLDOWN,
      vx: Math.sin(runner.facing) * RUSH_SPEED,
      vz: Math.cos(runner.facing) * RUSH_SPEED,
    });
    return;
  }
  walkBody(runner, input.move, WALKER, ARENA_STEP);
}

/**
 * Le canonnier : son viseur suit la souris (le point du ponton sous elle), ou se déplace au
 * stick ; Action tire un boulet, Maj / B son boulet spécial s'il en a un. Il reçoit un spécial à
 * l'heure.
 */
function actSolo(state: CannonState, input: ArenaInput): void {
  const { solo, tick } = state;
  const pressedFire = input.primary && !solo.heldPrimary;
  const pressedSpecial = input.secondary && !solo.heldSecondary;
  solo.heldPrimary = input.primary;
  solo.heldSecondary = input.secondary;
  if (input.point) {
    solo.aim = clampToDeck(input.point);
  } else {
    solo.aim = clampToDeck({
      x: solo.aim.x + input.move.x * AIM_SPEED * ARENA_STEP,
      z: solo.aim.z + input.move.z * AIM_SPEED * ARENA_STEP,
    });
  }
  if (solo.special === null && tick >= solo.specialAt) {
    solo.special =
      SPECIALS[Math.floor(forestUnit(state.seed, solo.specials, 501) * SPECIALS.length)] ?? 'giant';
    solo.specials += 1;
  }
  const isReady = tick >= solo.readyAt && tick >= solo.jammedUntil && state.fallenAt === null;
  if (!isReady) return;
  if (pressedSpecial && solo.special !== null) {
    fire(state, solo.special);
    solo.special = null;
    solo.specialAt = tick + steps(SPECIAL_EVERY);
  } else if (pressedFire) {
    fire(state, 'ball');
  } else {
    return;
  }
  solo.readyAt = tick + steps(cannonReload(state));
  solo.shots += 1;
}

/** Le temps de vol d'un boulet tiré de la tour jusqu'à ce point. */
export function flightTime(kind: BallKind, x: number, z: number): number {
  const distance = Math.hypot(x - MUZZLE.x, z - MUZZLE.z);
  const time = FLIGHT_BASE + distance * FLIGHT_PER_METER;
  return kind === 'giant' ? time * GIANT_SLOWER : time;
}

/** Le canon tire vers le viseur : un boulet (ou trois, pour la grappe). */
function fire(state: CannonState, kind: BallKind): void {
  const { solo, tick } = state;
  const targets =
    kind === 'cluster'
      ? [0, 1, 2].map((index) => {
          const angle = (index / 3) * Math.PI * 2 + Math.PI / 2;
          return clampToDeck({
            x: solo.aim.x + Math.cos(angle) * CLUSTER_SPREAD,
            z: solo.aim.z + Math.sin(angle) * CLUSTER_SPREAD,
          });
        })
      : [solo.aim];
  for (const target of targets) {
    state.balls.push({
      id: state.nextBall,
      kind,
      fromX: MUZZLE.x,
      fromY: MUZZLE.y,
      fromZ: MUZZLE.z,
      x: target.x,
      z: target.z,
      firedAt: tick,
      landAt: tick + steps(flightTime(kind, target.x, target.z)),
      bounces: kind === 'bouncer' ? BOUNCES : 0,
      landedAt: null,
    });
    state.nextBall += 1;
  }
}

/** Les boulets qui tombent à ce pas explosent ; celui qui rebondit repart vers l'avant. */
function landBalls(state: CannonState): void {
  const { tick } = state;
  for (const ball of [...state.balls]) {
    if (ball.landedAt !== null || ball.landAt > tick) continue;
    ball.landedAt = tick;
    blast(state, ball);
    if (ball.bounces <= 0) continue;
    // Il repart dans le sens de son vol (en s'éloignant de la tour), un peu plus loin.
    const dx = ball.x - ball.fromX;
    const dz = ball.z - ball.fromZ;
    const length = Math.hypot(dx, dz) || 1;
    const target = clampToDeck({
      x: ball.x + (dx / length) * BOUNCE_STEP,
      z: ball.z + (dz / length) * BOUNCE_STEP,
    });
    state.balls.push({
      id: state.nextBall,
      kind: ball.kind,
      fromX: ball.x,
      fromY: 0,
      fromZ: ball.z,
      x: target.x,
      z: target.z,
      firedAt: tick,
      landAt: tick + steps(BOUNCE_TIME),
      bounces: ball.bounces - 1,
      landedAt: null,
    });
    state.nextBall += 1;
  }
}

/** Un boulet qui tombe : chaque coureur dans son rayon (et pas intouchable) perd une vie. */
function blast(state: CannonState, ball: CannonBall): void {
  const radius = CANNON_BLAST[ball.kind];
  for (const runner of alive(state)) {
    const dx = runner.x - ball.x;
    const dz = runner.z - ball.z;
    const gap = Math.hypot(dx, dz);
    if (gap > radius || isShielded(runner, state.tick)) continue;
    const nx = gap > 0 ? dx / gap : 0;
    const nz = gap > 0 ? dz / gap : 1;
    knockDown(runner, nx, nz, HIT_SPEED, HIT_DOWN);
    Object.assign(runner, { hurtAt: state.tick, rushing: 0 });
    state.solo.hits += 1;
    if (state.practice) continue;
    runner.lives -= 1;
    if (runner.lives <= 0) runner.fellAt = state.tick;
  }
}

/** Touché il y a peu, il ne peut pas l'être à nouveau. */
export function isShielded(runner: CannonRunner, tick: number): boolean {
  return runner.hurtAt !== null && tick - runner.hurtAt < steps(SHIELD_TIME);
}

/**
 * Le levier : il apparaît à l'heure ; ceux qui restent près de lui le tirent peu à peu. Tiré,
 * il enraye le canon ; au dernier, la tour s'écroule. Puis le suivant se prépare.
 */
function pullLever(state: CannonState): void {
  const { tick } = state;
  // Tiré, il reste une seconde (le client le montre baissé), puis s'en va.
  const pulledAt = state.lever?.pulledAt ?? null;
  if (pulledAt !== null && tick - pulledAt >= steps(1)) state.lever = null;
  if (state.lever === null) {
    if (tick < state.nextLeverAt || state.fallenAt !== null) return;
    const spot = leverSpot(state);
    const place = LEVER_SPOTS[spot] ?? { x: 0, z: 2 };
    state.lever = {
      id: state.levers,
      spot,
      x: place.x,
      z: place.z,
      progress: 0,
      appearedAt: tick,
      pulledAt: null,
    };
    return;
  }
  const lever = state.lever;
  if (lever.pulledAt !== null) return;
  const pullers = alive(state).filter(
    (one) => isSteady(one) && Math.hypot(one.x - lever.x, one.z - lever.z) <= LEVER_REACH,
  );
  if (pullers.length === 0) {
    lever.progress = Math.max(0, lever.progress - LEVER_DECAY * ARENA_STEP);
    return;
  }
  lever.progress += Math.min(2, pullers.length) * ARENA_STEP;
  if (lever.progress < leverTime(state)) return;
  lever.pulledAt = tick;
  for (const one of pullers) one.pulls += 1;
  state.levers += 1;
  state.solo.jammedUntil = tick + steps(JAM_TIME);
  state.nextLeverAt = tick + steps(LEVER_PAUSE);
  if (state.levers >= LEVERS_TO_WIN && !state.practice) state.fallenAt = tick;
}

/**
 * La recharge du canon : un peu plus courte avec plus de coureurs (plus de vies à prendre, et
 * plus de monde sur les leviers).
 */
export function cannonReload(state: CannonState): number {
  return CANNON_RELOAD - Math.max(0, state.fighters.length - LEVER_RUNNERS) * RELOAD_PER_EXTRA;
}

/** Le temps de présence pour tirer un levier, selon le nombre de coureurs. */
export function leverTime(state: CannonState): number {
  return LEVER_TIME + Math.max(0, state.fighters.length - LEVER_RUNNERS) * LEVER_PER_EXTRA;
}

/** La place du prochain levier : tirée de la graine, jamais deux fois de suite la même. */
function leverSpot(state: CannonState): number {
  const last = state.levers > 0 ? lastLeverSpot(state) : -1;
  const choices = LEVER_SPOTS.map((_, id) => id).filter((id) => id !== last);
  return choices[Math.floor(forestUnit(state.seed, state.levers, 502) * choices.length)] ?? 0;
}

/** La place du dernier levier tiré (recalculée : elle ne dépend que de la graine). */
function lastLeverSpot(state: CannonState): number {
  let spot = -1;
  for (let index = 0; index < state.levers; index++) {
    const choices = LEVER_SPOTS.map((_, id) => id).filter((id) => id !== spot);
    spot = choices[Math.floor(forestUnit(state.seed, index, 502) * choices.length)] ?? 0;
  }
  return spot;
}

function timeLeft(state: CannonState): number | null {
  if (state.practice) return null;
  return Math.max(0, CANNON_TIME - state.tick * ARENA_STEP);
}

function isOver(state: CannonState): boolean {
  if (state.practice) return false;
  return state.fallenAt !== null || cannoneerWins(state) || (timeLeft(state) ?? 1) <= 0;
}

/**
 * Les coureurs que le canonnier doit éliminer pour gagner : la moitié, arrondie au-dessus (2 sur
 * 3, 3 sur 5). Tous, c'était presque impossible (retour de simulation : 15 vies à prendre à six
 * joueurs en 45 s).
 */
export function eliminationsToWin(state: CannonState): number {
  return Math.ceil(state.fighters.length / 2);
}

export function eliminated(state: CannonState): number {
  return state.fighters.length - alive(state).length;
}

/** Le canonnier gagne s'il élimine assez de coureurs avant la fin ; sinon, ce sont eux. */
export function cannoneerWins(state: CannonState): boolean {
  return (
    state.fallenAt === null &&
    state.fighters.length > 0 &&
    eliminated(state) >= eliminationsToWin(state)
  );
}

function ranking(state: CannonState): PlayerId[][] {
  const runners = state.fighters.map((one) => one.id);
  return cannoneerWins(state) ? [[state.solo.id], runners] : [runners, [state.solo.id]];
}

/** Les coureurs ne voient pas le viseur du canonnier (seulement les ombres des boulets). */
function viewFor(state: CannonState, viewer: Viewer): CannonState {
  const isSolo = viewer.type === 'player' && viewer.playerId === state.solo.id;
  return isSolo ? state : { ...state, seed: 0, solo: { ...state.solo, aim: { x: 0, z: 0 } } };
}

// Au bac à sable : le mannequin coureur se promène (le canonnier s'entraîne à viser une cible
// qui bouge) ; le mannequin canonnier tire sur toi toutes les deux secondes et demie.

function dummyRunnerInput(state: CannonState, runner: CannonRunner): ArenaInput {
  const time = state.tick * ARENA_STEP;
  const target = { x: Math.sin(time * 0.5) * 6, z: 1 + Math.cos(time * 0.37) * 3 };
  return { move: toward(runner, target, 0.6), primary: false, secondary: false };
}

function dummySoloInput(state: CannonState): ArenaInput {
  const target = alive(state)[0];
  const isTime = state.tick % steps(2.5) === 0;
  if (!target) return IDLE_INPUT;
  return { ...IDLE_INPUT, point: { x: target.x, z: target.z }, primary: isTime };
}

// Les bots (02-mini-jeux.md, fiche 30). Le canonnier vise un coureur (de préférence celui qui
// tire le levier), en anticipant sa course (Expert) ou là où il est (Facile), avec une erreur
// et une cadence selon son niveau ; il garde son spécial pour un groupe ou un levier. Les
// coureurs fuient l'ombre d'un boulet qui va tomber près d'eux (avec un temps de réaction),
// se ruent quand il est trop tard pour marcher, et vont tirer le levier, un ou deux à la fois.

const SOLO_BOT: Record<BotLevel, { lead: number; error: number; cadence: number }> = {
  easy: { lead: 0, error: 2, cadence: 0.3 },
  normal: { lead: 0.6, error: 0.9, cadence: 0.6 },
  expert: { lead: 1, error: 0.35, cadence: 0.9 },
};
const RUNNER_BOT: Record<
  BotLevel,
  { sight: number; notice: number; rush: number; levers: number }
> = {
  easy: { sight: 0.5, notice: 0.7, rush: 0.2, levers: 0.4 },
  normal: { sight: 0.35, notice: 0.8, rush: 0.5, levers: 0.7 },
  expert: { sight: 0.25, notice: 0.81, rush: 0.8, levers: 1 },
};

function botInput(state: CannonState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  if (player === state.solo.id) return soloBot(state, level, rng);
  const me = state.fighters.find((one) => one.id === player);
  if (!me || me.fellAt !== null || !isSteady(me) || me.rushing > 0) return IDLE_INPUT;
  return runnerBot(state, me, level, rng);
}

function soloBot(state: CannonState, level: BotLevel, rng: Rng): ArenaInput {
  const bot = SOLO_BOT[level];
  const { solo, tick } = state;
  const isReady = tick >= solo.readyAt && tick >= solo.jammedUntil;
  if (!isReady || !rng.chance(bot.cadence * ARENA_STEP * 6)) return IDLE_INPUT;
  const targets = alive(state).filter((one) => !isShielded(one, tick));
  if (targets.length === 0) return IDLE_INPUT;
  // Celui qui tire le levier d'abord ; sinon un coureur tiré au hasard (de préférence groupé).
  const lever = state.lever;
  const onLever =
    lever && lever.pulledAt === null
      ? targets.find((one) => Math.hypot(one.x - lever.x, one.z - lever.z) <= LEVER_REACH + 0.5)
      : undefined;
  const target = onLever ?? targets[Math.floor(rng.next() * targets.length)];
  if (!target) return IDLE_INPUT;
  const crowd = targets.filter((one) => Math.hypot(one.x - target.x, one.z - target.z) < 2.5);
  const useSpecial =
    solo.special !== null && (crowd.length >= 2 || onLever !== undefined || rng.chance(0.15));
  const kind: BallKind = useSpecial && solo.special ? solo.special : 'ball';
  const time = flightTime(kind, target.x, target.z) * bot.lead;
  const angle = rng.next() * Math.PI * 2;
  const miss = rng.next() * bot.error;
  const point = clampToDeck({
    x: target.x + target.vx * time + Math.cos(angle) * miss,
    z: target.z + target.vz * time + Math.sin(angle) * miss,
  });
  return { ...IDLE_INPUT, point, primary: !useSpecial, secondary: useSpecial };
}

function runnerBot(state: CannonState, me: CannonRunner, level: BotLevel, rng: Rng): ArenaInput {
  const bot = RUNNER_BOT[level];
  const { tick } = state;
  // Le danger : les ombres qu'il voit (le boulet en vol depuis assez longtemps) près de lui.
  const threats = state.balls.filter((ball) => {
    if (ball.landedAt !== null || (tick - ball.firedAt) * ARENA_STEP < bot.sight) return false;
    // Il ne remarque pas toutes les ombres (il regarde le levier, les autres...).
    if (forestUnit(state.seed, ball.id, 505 + saltOf(me.id)) >= bot.notice) return false;
    return Math.hypot(me.x - ball.x, me.z - ball.z) < CANNON_BLAST[ball.kind] + 0.8;
  });
  if (threats.length > 0 && !isShielded(me, tick)) {
    let awayX = 0;
    let awayZ = 0;
    let soonest = Number.POSITIVE_INFINITY;
    for (const ball of threats) {
      const dx = me.x - ball.x;
      const dz = me.z - ball.z;
      const gap = Math.hypot(dx, dz) || 0.01;
      awayX += dx / gap;
      awayZ += dz / gap;
      soonest = Math.min(soonest, (ball.landAt - tick) * ARENA_STEP);
    }
    // Vers le milieu du ponton s'il est acculé à un bord.
    awayX += -me.x / DECK_HALF_X;
    awayZ += ((DECK_BACK + DECK_FRONT) / 2 - me.z) / 6;
    const length = Math.hypot(awayX, awayZ) || 1;
    const move = { x: awayX / length, z: awayZ / length };
    const rush =
      soonest < 0.35 && me.rushReady <= 0 && forestUnit(state.seed, tick, 503) < bot.rush;
    return { move, primary: rush, secondary: false };
  }
  const lever = state.lever;
  if (lever && lever.pulledAt === null && wantsLever(state, me, lever, bot.levers)) {
    return { move: toward(me, lever, 1), primary: false, secondary: false };
  }
  // Sinon, il se tient à l'écart des autres (un groupe attire les boulets) et ne reste pas
  // planté : une cible immobile est facile.
  const time = tick * ARENA_STEP + saltOf(me.id);
  const wander = { x: Math.sin(time * 0.6) * 6, z: 1 + Math.cos(time * 0.45) * 3.5 };
  const nudge = (rng.next() - 0.5) * 0.4;
  const dir = toward(me, wander, 1);
  return { move: { x: dir.x + nudge, z: dir.z - nudge }, primary: false, secondary: false };
}

/** Il va au levier s'il fait partie des deux coureurs les plus proches (et en a le goût). */
function wantsLever(
  state: CannonState,
  me: CannonRunner,
  lever: CannonLever,
  taste: number,
): boolean {
  if (forestUnit(state.seed, lever.id, 504 + saltOf(me.id)) >= taste) return false;
  const closest = alive(state)
    .map((one) => ({ id: one.id, gap: Math.hypot(one.x - lever.x, one.z - lever.z) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 2);
  return closest.some((one) => one.id === me.id);
}

function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

function toward(
  me: { x: number; z: number },
  target: { x: number; z: number },
  speed: number,
): { x: number; z: number } {
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const gap = Math.hypot(dx, dz);
  if (gap < 0.2) return { x: 0, z: 0 };
  return { x: (dx / gap) * speed, z: (dz / gap) * speed };
}

export const CANNONEER: ArenaGame<CannonState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  viewFor,
};
