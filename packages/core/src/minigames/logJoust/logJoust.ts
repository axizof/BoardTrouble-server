import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Joute sur le tronc (02-mini-jeux.md, fiche 35), un duel : deux bûcherons debout sur un tronc qui
// flotte dans le bassin de la scierie. Le tronc roule : sa surface entraîne les pieds vers
// l'avant ou l'arrière, et chacun court sur place (haut, bas) pour rester en haut. Son équilibre
// (un angle autour du sommet du tronc) penche dès que sa course ne compense pas le roulis, et
// plus il penche, plus il part tout seul ; trop penché, il tombe à l'eau. Le tronc est partagé :
// courir contre le roulis le fait tourner plus vite, freiner le ralentit ; changer d'allure d'un
// coup déséquilibre l'autre. Action : un coup de talon (la jambe se lève, puis frappe) qui freine
// le tronc d'un coup ; Maj / B : sauter (en l'air, la secousse ne prend pas). Le tronc tremble de
// plus en plus au fil de la manche. Deux manches gagnantes.

/** L'équilibre : il tombe au-delà de FALL_ANGLE (radians) ; un penché grandit de lui-même. */
export const FALL_ANGLE = 0.9;
const UNSTABLE = 0.8;
/** La course : on court au plus à RUN_SPEED (m/s), et on y arrive à RUN_ACCEL près. */
const RUN_SPEED = 2.6;
const RUN_ACCEL = 9;
/** Un écart d'un mètre par seconde entre le roulis et la course penche de tant (rad/s). */
const SLIP = 0.5;
/**
 * Le tronc : il prend l'allure que lui donnent les pieds (la moyenne des deux courses, à
 * rebours), à LOG_GRIP près ; il freine de lui-même et il tremble. Quand les deux suivent son
 * allure, il garde la sienne ; quand l'un change d'allure, il entraîne l'autre. (Retour de
 * simulation : poussé sans fin par les pieds, il s'emballait, et une manche durait 3 s.)
 */
const LOG_GRIP = 1.6;
const LOG_DRAG = 0.55;
const LOG_MAX = 4.5;
/** Le tremblement du tronc : sa force au début de la manche, et ce qu'elle gagne par seconde. */
const WOBBLE = 0.55;
const WOBBLE_GROWTH = 0.03;
/**
 * Le coup de talon : la jambe se lève WINDUP secondes (l'autre le voit), puis frappe : le tronc
 * perd STOMP_BRAKE de sa vitesse et prend STOMP_KICK à rebours. Il faut STOMP_COOLDOWN pour
 * recommencer. Le saut dure JUMP_TIME, puis JUMP_COOLDOWN.
 */
export const WINDUP = 0.6;
const STOMP_BRAKE = 0.8;
const STOMP_KICK = 1.6;
/** La secousse jette l'équilibre de ceux qui ont les pieds sur le tronc, à proportion du choc. */
const STOMP_TILT = 0.35;
export const STOMP_COOLDOWN = 2.4;
export const JUMP_TIME = 0.5;
const JUMP_COOLDOWN = 0.6;
/** Celui qui frappe tient mieux le choc : il le sent venir (part de la secousse qu'il subit). */
const STOMPER_SHARE = 0.4;
/** Une manche : on se met en place, on joute, on tombe (le plouf), puis la suivante. */
export const READY_TIME = 2;
export const SPLASH_TIME = 2.4;
/** Les manches pour gagner. */
export const WINS_NEEDED = 2;
/** Le rayon du tronc (m), pour l'affichage du roulis. */
export const LOG_RADIUS = 0.55;

export type JoustPhase = 'ready' | 'play' | 'splash';

export type Jouster = {
  id: PlayerId;
  /** Personne n'est éliminé en cours de duel : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Son équilibre (radians autour du sommet du tronc ; positif vers la caméra) et sa vitesse. */
  tilt: number;
  spin: number;
  /** Sa course sur le tronc (m/s ; positive vers la caméra). */
  feet: number;
  /** Secondes restantes en l'air, et avant de pouvoir ressauter. */
  airborne: number;
  jumpReady: number;
  /** Secondes depuis qu'il a levé la jambe (null : pas de coup de talon en cours), et sa recharge. */
  windup: number | null;
  stompReady: number;
  /** Le pas de son dernier coup de talon (le client montre la secousse), ou null. */
  stompAt: number | null;
  wins: number;
  heldPrimary: boolean;
  heldSecondary: boolean;
};

export type JoustState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: Jouster[];
  /** La surface du tronc (m/s ; positive vers la caméra), et de combien il a tourné (pour l'affichage). */
  log: { speed: number; turned: number };
  round: { index: number; phase: JoustPhase; phaseAt: number; loser: PlayerId | null };
  winner: PlayerId | null;
};

function freshJouster(id: PlayerId, wins = 0): Jouster {
  return {
    id,
    fellAt: null,
    tilt: 0,
    spin: 0,
    feet: 0,
    airborne: 0,
    jumpReady: 0,
    windup: null,
    stompReady: 1,
    stompAt: null,
    wins,
    heldPrimary: false,
    heldSecondary: false,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): JoustState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.slice(0, 2).map((id) => freshJouster(id)),
    log: { speed: 0, turned: 0 },
    round: { index: 0, phase: 'ready', phaseAt: 0, loser: null },
    winner: null,
  };
}

/** Le tremblement du tronc à ce pas : deux houles mêlées, de plus en plus fortes dans la manche. */
function wobble(state: JoustState, tick: number): number {
  const time = (tick - state.round.phaseAt) * ARENA_STEP;
  const phase = forestUnit(state.seed, state.round.index, 191) * Math.PI * 2;
  const strength = WOBBLE * (1 + time * WOBBLE_GROWTH * 4);
  return strength * (Math.sin(time * 1.3 + phase) + 0.6 * Math.sin(time * 2.9 + phase * 2));
}

function step(state: JoustState, inputs: Partial<Record<PlayerId, ArenaInput>>): JoustState {
  const tick = state.tick + 1;
  const dt = ARENA_STEP;
  const next: JoustState = {
    ...state,
    tick,
    fighters: state.fighters.map((one) => ({ ...one })),
    log: { ...state.log },
    round: { ...state.round },
  };
  if (next.winner !== null) return next;
  const { round, log } = next;
  const since = (tick - round.phaseAt) * ARENA_STEP;
  if (round.phase === 'ready') {
    if (since >= READY_TIME) Object.assign(round, { phase: 'play', phaseAt: tick });
    return next;
  }
  if (round.phase === 'splash') {
    if (since >= SPLASH_TIME) nextRound(next);
    return next;
  }
  // Les joueurs courent, sautent, lèvent la jambe ; le tronc suit leur course et tremble.
  let feet = 0;
  for (const player of next.fighters) {
    const input = inputs[player.id] ?? (state.practice ? dummyInput(next, player.id) : IDLE_INPUT);
    act(next, player, input, dt);
    // En l'air, ses pieds ne mènent plus le tronc.
    feet += player.airborne > 0 ? -log.speed : player.feet;
  }
  const driven = -feet / Math.max(1, next.fighters.length);
  log.speed += (LOG_GRIP * (driven - log.speed) - LOG_DRAG * log.speed + wobble(next, tick)) * dt;
  log.speed = Math.max(-LOG_MAX, Math.min(LOG_MAX, log.speed));
  log.turned += (log.speed / LOG_RADIUS) * dt;
  // L'équilibre de chacun : le roulis l'entraîne, sa course le retient, et un penché grandit.
  for (const player of next.fighters) {
    const grip = player.airborne > 0 ? 0 : 1;
    player.spin = grip * SLIP * (log.speed + player.feet) + UNSTABLE * player.tilt;
    player.tilt += player.spin * dt;
    if (Math.abs(player.tilt) <= FALL_ANGLE || round.phase !== 'play') continue;
    if (state.practice) {
      // Au bac à sable, on remonte aussitôt sur le tronc.
      Object.assign(player, { tilt: 0, spin: 0, feet: 0 });
      continue;
    }
    round.loser = player.id;
    Object.assign(round, { phase: 'splash', phaseAt: tick });
    const other = next.fighters.find((one) => one.id !== player.id);
    if (other) other.wins += 1;
  }
  return next;
}

/** Les commandes d'un joueur : courir (haut, bas), sauter, lever la jambe puis frapper. */
function act(state: JoustState, player: Jouster, input: ArenaInput, dt: number): void {
  const pressedStomp = input.primary && !player.heldPrimary;
  const pressedJump = input.secondary && !player.heldSecondary;
  player.heldPrimary = input.primary;
  player.heldSecondary = input.secondary;
  player.jumpReady = Math.max(0, player.jumpReady - dt);
  player.stompReady = Math.max(0, player.stompReady - dt);
  if (player.airborne > 0) {
    player.airborne = Math.max(0, player.airborne - dt);
    if (player.airborne === 0) {
      player.jumpReady = JUMP_COOLDOWN;
      // On retombe en courant à l'allure du tronc : un saut au bon moment pare vraiment le coup.
      player.feet = -state.log.speed;
      return;
    }
  } else if (pressedJump && player.jumpReady <= 0 && player.windup === null) {
    player.airborne = JUMP_TIME;
  }
  // Haut (vers le fond) ou bas (vers la caméra) : on court de ce côté, en y mettant le temps.
  const wanted = Math.max(-1, Math.min(1, input.move.z)) * RUN_SPEED;
  const gap = wanted - player.feet;
  player.feet += Math.max(-RUN_ACCEL * dt, Math.min(RUN_ACCEL * dt, gap));
  if (player.windup !== null) {
    player.windup += dt;
    if (player.windup >= WINDUP) stomp(state, player);
  } else if (pressedStomp && player.stompReady <= 0 && player.airborne <= 0) {
    player.windup = 0;
  }
}

/**
 * Le coup de talon : le tronc perd l'essentiel de sa vitesse et repart un peu à rebours. Celui
 * qui frappe sent venir le choc (il en subit moins) ; celui qui est en l'air n'en subit rien.
 */
function stomp(state: JoustState, player: Jouster): void {
  const { log, tick } = state;
  const before = log.speed;
  const direction = before === 0 ? 1 : Math.sign(before);
  log.speed = before * (1 - STOMP_BRAKE) - direction * STOMP_KICK;
  const jolt = log.speed - before;
  for (const one of state.fighters) {
    if (one.airborne > 0) continue;
    const share = one.id === player.id ? STOMPER_SHARE : 1;
    // La secousse jette les pieds dans le sens du choc : l'équilibre part d'autant.
    one.tilt += jolt * SLIP * STOMP_TILT * share;
  }
  Object.assign(player, { windup: null, stompReady: STOMP_COOLDOWN, stompAt: tick });
}

/** La manche suivante, ou la fin du duel. */
function nextRound(state: JoustState): void {
  const champion = state.fighters.find((one) => one.wins >= WINS_NEEDED);
  if (champion && !state.practice) {
    state.winner = champion.id;
    return;
  }
  state.fighters = state.fighters.map((one) => freshJouster(one.id, state.practice ? 0 : one.wins));
  state.log = { speed: 0, turned: state.log.turned };
  state.round = { index: state.round.index + 1, phase: 'ready', phaseAt: state.tick, loser: null };
}

/** Au bac à sable, le mannequin d'en face tient debout et donne un coup de talon de temps en temps. */
function dummyInput(state: JoustState, player: PlayerId): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  if (!me) return IDLE_INPUT;
  const time = (state.tick - state.round.phaseAt) * ARENA_STEP;
  const isStomp = me.stompReady <= 0 && Math.floor(time / 3.5) % 2 === 1;
  return { move: { x: 0, z: balanceRun(state, me, 1) }, primary: isStomp, secondary: false };
}

/**
 * La course qui ramène l'équilibre : compenser le roulis, et plus encore quand on penche.
 * `skill` (0 à 1) dose la correction du penché.
 */
function balanceRun(state: JoustState, me: Jouster, skill: number): number {
  const wanted = -state.log.speed - (1.8 * me.tilt + 0.5 * me.spin) * skill * RUN_SPEED;
  return Math.max(-1, Math.min(1, wanted / RUN_SPEED));
}

function isOver(state: JoustState): boolean {
  return !state.practice && state.winner !== null;
}

function ranking(state: JoustState): PlayerId[][] {
  const ids = state.fighters.map((one) => one.id);
  if (!state.winner) return [ids];
  return [[state.winner], ids.filter((id) => id !== state.winner)];
}

/**
 * Les bots, selon leur niveau : le retard de leur regard (secondes : ils corrigent ce qu'ils ont
 * vu un peu plus tôt), leur dosage de la correction, leur envie de frapper (chance par seconde)
 * et la part des coups de talon de l'autre qu'ils sautent. Retour de test (2026-11-15) : le
 * Normal était un peu trop fort ; affaibli, il bat le Facile 69 % du temps, l'Expert le bat 89 %.
 */
const BOT: Record<BotLevel, { lag: number; skill: number; eager: number; dodge: number }> = {
  easy: { lag: 0.3, skill: 0.6, eager: 0.15, dodge: 0.25 },
  normal: { lag: 0.25, skill: 0.75, eager: 0.22, dodge: 0.4 },
  expert: { lag: 0.08, skill: 1, eager: 0.55, dodge: 0.85 },
};

/** Un nombre propre à chaque joueur. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

/**
 * Le bot (02-mini-jeux.md, fiche 35) : il court pour compenser le roulis et son penché (avec un
 * temps de retard), frappe du talon quand l'autre penche ou au hasard, et saute quand l'autre lève
 * la jambe (s'il le voit à temps).
 */
function botInput(state: JoustState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  const other = state.fighters.find((one) => one.id !== player);
  if (!me || !other || state.round.phase !== 'play') return IDLE_INPUT;
  const bot = BOT[level];
  // Ce qu'il voit, avec un temps de retard : son penché d'il y a `lag` secondes.
  const seen = { ...me, tilt: me.tilt - me.spin * bot.lag };
  const run = balanceRun(state, seen, bot.skill);
  // L'autre lève la jambe : il saute juste avant le coup (une fois par coup, s'il le voit).
  const isComing = other.windup !== null && other.windup >= WINDUP - 0.15;
  const sees =
    forestUnit(state.seed, (other.stompAt ?? 0) + state.round.index, 192 + saltOf(player)) <
    bot.dodge;
  const jump = isComing && sees && me.airborne <= 0;
  // Il frappe quand l'autre penche déjà, ou de temps en temps.
  const isShaky = Math.abs(other.tilt) > 0.3;
  const stomp = me.stompReady <= 0 && rng.chance((isShaky ? 3 : 1) * bot.eager * ARENA_STEP);
  return { move: { x: 0, z: run }, primary: stomp, secondary: jump };
}

export const LOG_JOUST: ArenaGame<JoustState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
