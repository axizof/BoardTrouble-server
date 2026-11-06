import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Le dernier lancer (02-mini-jeux.md, fiche 37), la finale (2 à 6 finalistes) : chacun son dé,
// qui roule face après face dans un ordre fixe (6, 2, 3, 1, 5, 4) en accélérant, et plus vite à
// chaque essai. À l'appui, il ne s'arrête pas net : il roule encore un instant, d'autant plus loin qu'il
// va vite, puis se pose sur la face la plus proche. Il faut lire la suite et appuyer un peu
// avant le 6. Trois essais, tous en même temps ; chaque lancer rapporte sa face, le meilleur
// total gagne. Égalité au sommet : un lancer de mort subite entre les ex aequo.

/** La suite des faces du dessus quand le dé roule (chacune voisine de la suivante sur un dé). */
export const DIE_CYCLE = [6, 2, 3, 1, 5, 4] as const;
/**
 * Les essais. À chacun, le dé part à sa vitesse (faces par seconde) et accélère (faces par
 * seconde, chaque seconde) : attendre rend le 6 plus dur à avoir. La mort subite, plus vite
 * encore. À vitesse constante, le rythme se lisait trop bien : les bots faisaient 6 presque à
 * chaque lancer, et les morts subites ne départageaient plus personne.
 */
export const ROLL_TRIES = 3;
export const TRY_SPEEDS = [
  { start: 3, accel: 1.5 },
  { start: 4, accel: 2 },
  { start: 5, accel: 2.5 },
] as const;
export const SUDDEN_SPEED = { start: 6, accel: 3 } as const;
/** Au plus tant de morts subites ; au-delà, l'égalité reste (les dés de l'arène départagent). */
const MAX_SUDDEN = 3;
/** Après l'appui, le dé roule encore ce temps-là (à sa vitesse), puis se pose. */
export const ROLL_CARRY_TIME = 0.15;
/** Avant de rouler, un temps pour se préparer ; sans appui, le dé s'arrête seul au bout de ROLL_TRY_TIME. */
export const ROLL_READY_TIME = 1.2;
export const ROLL_TRY_TIME = 5;
/** Tous les dés posés, les faces restent montrées ce temps-là avant l'essai suivant. */
export const ROLL_REVEAL_TIME = 1.8;

/**
 * Un lancer : son numéro (0 à 2 les essais, puis les morts subites), qui lance, quand le dé se
 * met à rouler, sa vitesse de départ et son accélération, et d'où dans la suite il part ;
 * `endedAt` : le pas où tous les dés se sont posés, ou null.
 */
export type RollRound = {
  index: number;
  throwers: PlayerId[];
  spinAt: number;
  speed: number;
  accel: number;
  startPhase: number;
  endedAt: number | null;
};

export type Roller = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Les faces de ses essais, puis de ses morts subites. */
  rolls: number[];
  sudden: number[];
  /** Ce lancer : le pas de son appui et la face où son dé se pose, ou null. */
  stopAt: number | null;
  face: number | null;
  held: boolean;
};

export type RollState = {
  tick: number;
  practice: boolean;
  seed: number;
  round: RollRound;
  /** Plus de lancer après celui-ci : la partie finit une fois ses faces montrées. */
  isLast: boolean;
  fighters: Roller[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** Où en est le dé dans sa suite à ce pas (en faces, fraction comprise). */
export function rollPhase(round: RollRound, tick: number): number {
  const time = Math.max(0, tick - round.spinAt) * ARENA_STEP;
  return round.startPhase + round.speed * time + 0.5 * round.accel * time * time;
}

/** La vitesse du dé à ce pas (faces par seconde). */
export function rollSpeed(round: RollRound, tick: number): number {
  return round.speed + round.accel * Math.max(0, tick - round.spinAt) * ARENA_STEP;
}

/** La face du dessus à cet endroit de la suite. */
export function faceAt(phase: number): number {
  const index = ((Math.floor(phase) % DIE_CYCLE.length) + DIE_CYCLE.length) % DIE_CYCLE.length;
  return DIE_CYCLE[index] ?? 6;
}

/** Là où le dé se pose s'il est arrêté à ce pas : il roule encore ROLL_CARRY_TIME, puis à la face la plus proche. */
export function landingPhase(round: RollRound, tick: number): number {
  return Math.round(rollPhase(round, tick) + rollSpeed(round, tick) * ROLL_CARRY_TIME);
}

export function totalOf(roller: Roller): number {
  return roller.rolls.reduce((sum, face) => sum + face, 0);
}

function planRound(
  seed: number,
  index: number,
  at: number,
  throwers: PlayerId[],
  practice: boolean,
): RollRound {
  // Au bac à sable, les vitesses des essais reviennent en boucle.
  const tried = practice ? index % ROLL_TRIES : index;
  const { start, accel } = tried < ROLL_TRIES ? (TRY_SPEEDS[tried] ?? SUDDEN_SPEED) : SUDDEN_SPEED;
  return {
    index,
    throwers,
    spinAt: at + steps(ROLL_READY_TIME),
    speed: start,
    accel,
    // Le même départ pour tous : personne n'a un 6 plus près que l'autre.
    startPhase: Math.floor(hashUnit(`${seed}:roll:${index}`) * DIE_CYCLE.length),
    endedAt: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): RollState {
  return {
    tick: 0,
    practice,
    seed,
    round: planRound(seed, 0, 0, players, practice),
    isLast: false,
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      rolls: [],
      sudden: [],
      stopAt: null,
      face: null,
      held: false,
    })),
  };
}

function step(state: RollState, inputs: Partial<Record<PlayerId, ArenaInput>>): RollState {
  const tick = state.tick + 1;
  let round = state.round;
  let isLast = state.isLast;
  let fighters = state.fighters.map((fighter) => ({ ...fighter }));
  // Le lancer montré : le suivant (ou la fin).
  if (round.endedAt !== null && tick >= round.endedAt + steps(ROLL_REVEAL_TIME) && !isLast) {
    const next = nextRound(state.seed, round, fighters, tick, state.practice);
    round = next ?? round;
    isLast = next === null;
    if (next) fighters = fighters.map((fighter) => ({ ...fighter, stopAt: null, face: null }));
  }
  if (round.endedAt === null) {
    for (const fighter of fighters) {
      const pressing = (inputs[fighter.id] ?? IDLE_INPUT).primary;
      const isPress = pressing && !fighter.held;
      fighter.held = pressing;
      const isThrowing = round.throwers.includes(fighter.id) && fighter.stopAt === null;
      const isTooLate = tick >= round.spinAt + steps(ROLL_TRY_TIME);
      if (!isThrowing || tick < round.spinAt || !(isPress || isTooLate)) continue;
      fighter.stopAt = tick;
      fighter.face = faceAt(landingPhase(round, tick));
      if (round.index < ROLL_TRIES || state.practice) fighter.rolls.push(fighter.face);
      else fighter.sudden.push(fighter.face);
    }
    const isSettled = round.throwers.every((id) => {
      const fighter = fighters.find((one) => one.id === id);
      return fighter?.stopAt != null && tick >= fighter.stopAt + steps(ROLL_CARRY_TIME);
    });
    if (isSettled) round = { ...round, endedAt: tick };
  } else {
    for (const fighter of fighters) fighter.held = (inputs[fighter.id] ?? IDLE_INPUT).primary;
  }
  // Au bac à sable, on ne garde que les derniers lancers.
  if (state.practice)
    fighters = fighters.map((fighter) => ({ ...fighter, rolls: fighter.rolls.slice(-ROLL_TRIES) }));
  return { ...state, tick, round, isLast, fighters };
}

/**
 * Le lancer suivant : l'essai d'après, puis, après le dernier essai, une mort subite entre les
 * ex aequo du meilleur total (puis entre ceux de la meilleure face) ; null s'il n'y en a plus.
 */
function nextRound(
  seed: number,
  round: RollRound,
  fighters: Roller[],
  tick: number,
  practice: boolean,
): RollRound | null {
  const index = round.index + 1;
  const everyone = fighters.map((fighter) => fighter.id);
  if (practice || index < ROLL_TRIES) return planRound(seed, index, tick, everyone, practice);
  const sudden = index - ROLL_TRIES;
  if (sudden >= MAX_SUDDEN) return null;
  const leaders = topGroup(fighters);
  return leaders.length > 1 ? planRound(seed, index, tick, leaders, practice) : null;
}

/** Les ex aequo en tête : le meilleur total, puis les mêmes morts subites. */
function topGroup(fighters: Roller[]): PlayerId[] {
  const sorted = [...fighters].sort(compare);
  const first = sorted[0];
  return first
    ? sorted.filter((fighter) => compare(fighter, first) === 0).map((fighter) => fighter.id)
    : [];
}

/** Le meilleur d'abord : le total, puis les morts subites, une à une. */
function compare(a: Roller, b: Roller): number {
  const byTotal = totalOf(b) - totalOf(a);
  if (byTotal !== 0) return byTotal;
  for (let k = 0; k < Math.max(a.sudden.length, b.sudden.length); k++) {
    const gap = (b.sudden[k] ?? 0) - (a.sudden[k] ?? 0);
    if (gap !== 0) return gap;
  }
  return 0;
}

function isOver(state: RollState): boolean {
  const { round } = state;
  return (
    !state.practice &&
    state.isLast &&
    round.endedAt !== null &&
    state.tick >= round.endedAt + steps(ROLL_REVEAL_TIME)
  );
}

function ranking(state: RollState): PlayerId[][] {
  const sorted = [...state.fighters].sort(compare);
  const groups: PlayerId[][] = [];
  sorted.forEach((fighter, index) => {
    const before = sorted[index - 1];
    if (before && compare(before, fighter) === 0) groups.at(-1)?.push(fighter.id);
    else groups.push([fighter.id]);
  });
  return groups;
}

/**
 * Le bot vise le 6 : il appuie au moment où le dé, avec son élan, se poserait pile au milieu du
 * 6, après un temps pour lire la suite, à son erreur près (en secondes, tirée une fois par
 * lancer). Plus le dé va vite, plus une même erreur l'en éloigne.
 */
const TIMING: Record<BotLevel, number> = { easy: 0.14, normal: 0.09, expert: 0.06 };
const READ_DELAY = 0.6;

function botInput(state: RollState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  const { round, tick } = state;
  if (!me || round.endedAt !== null || me.stopAt !== null || !round.throwers.includes(player)) {
    return IDLE_INPUT;
  }
  // La première fois, après le temps de lecture, où le dé se poserait au milieu d'un 6 : fixée
  // pour tout le lancer (recalculée à chaque pas, elle sautait d'un tour au moindre retard).
  const read = round.spinAt + steps(READ_DELAY);
  const lap = DIE_CYCLE.length;
  const sixAt =
    Math.ceil((rollPhase(round, read) + rollSpeed(round, read) * ROLL_CARRY_TIME) / lap) * lap;
  // Le temps t où phase(t) + vitesse(t) x élan = sixAt : 0,5 a t² + (v + a c) t + (p + v c - six) = 0.
  const { speed: v, accel: a, startPhase: p } = round;
  const c = ROLL_CARRY_TIME;
  const b = v + a * c;
  const time = (-b + Math.sqrt(b * b - 2 * a * (p + v * c - sixAt))) / a;
  const ideal = round.spinAt + time / ARENA_STEP;
  const error = (hashUnit(`${state.seed}:${player}:${round.index}`) * 2 - 1) * TIMING[level];
  const pressAt = ideal + error / ARENA_STEP;
  return { ...IDLE_INPUT, primary: !me.held && tick + 1 >= pressAt };
}

export const LAST_ROLL: ArenaGame<RollState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
