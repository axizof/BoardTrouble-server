import { ARENA_STEP } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Ce qui dégringole dans La dégringolade (02-mini-jeux.md, fiche 51) : des tonneaux, des bidons,
// des caisses, des roues de chariot et des wagonnets, lâchés de l'entrée de la mine en haut de la
// rampe. Pas de vraie physique : chaque objet suit un trajet fixé d'avance par la graine (il
// descend à sa vitesse, dérive de côté en rebondissant sur les parois, sautille s'il est léger).
// Les mêmes chutes pour tous au même moment, et rien à synchroniser. Les objets se traversent
// entre eux. Plan : `s` le long de la rampe (0 en bas, RAMP_LENGTH en haut), `x` en travers
// (0 au milieu), `y` au-dessus de la rampe ; mètres et secondes.

export const RAMP_LENGTH = 120;
/** La rampe fait 2 × RAMP_HALF de large, entre deux parois. */
export const RAMP_HALF = 4.5;
/** Les rails des wagonnets, de part et d'autre du milieu. */
export const RAIL_X = 2.2;
/** Un objet apparaît à l'entrée de la mine, un peu au-dessus du haut, et s'en va sous le bas. */
export const RUBBLE_TOP = RAMP_LENGTH + 3;
const RUBBLE_GONE = -4;

export type RubbleKind = 'barrel' | 'can' | 'crate' | 'wheel' | 'wagon';

/**
 * Chaque sorte : sa demi-largeur (en travers) et sa demi-longueur (le long de la rampe), sa
 * hauteur, sa vitesse de descente et sa dérive de côté (m/s, tirées entre ces bornes), la hauteur
 * et la période de ses sauts (0 : il roule au sol), et de combien il repousse qui il touche.
 * Plus haut que JUMP_CLEAR (un tonneau, un bidon, une caisse), on peut le sauter ; une roue ou un
 * wagonnet, il faut l'éviter.
 */
export const RUBBLE: Record<
  RubbleKind,
  {
    half: number;
    depth: number;
    height: number;
    speed: readonly [number, number];
    drift: readonly [number, number];
    hop: number;
    hopPeriod: number;
    push: number;
  }
> = {
  barrel: {
    half: 0.6,
    depth: 0.42,
    height: 0.84,
    speed: [7, 9],
    drift: [0, 0.8],
    hop: 0,
    hopPeriod: 1,
    push: 5,
  },
  can: {
    half: 0.28,
    depth: 0.28,
    height: 0.55,
    speed: [8.5, 10.5],
    drift: [1.5, 3],
    hop: 0.55,
    hopPeriod: 0.45,
    push: 4,
  },
  crate: {
    half: 0.45,
    depth: 0.45,
    height: 0.9,
    speed: [6, 7.5],
    drift: [0, 1],
    hop: 0.7,
    hopPeriod: 0.7,
    push: 6,
  },
  wheel: {
    half: 0.14,
    depth: 0.75,
    height: 1.5,
    speed: [9, 11],
    drift: [2.5, 4],
    hop: 0,
    hopPeriod: 1,
    push: 6,
  },
  wagon: {
    half: 0.95,
    depth: 0.75,
    height: 1.3,
    speed: [5.5, 6.5],
    drift: [0, 0],
    hop: 0,
    hopPeriod: 1,
    push: 8,
  },
};

/**
 * Le rythme : le premier objet part à FIRST_RUBBLE, puis un toutes les RUBBLE_GAP secondes au
 * début, de plus en plus serrés (jusqu'à RUBBLE_GAP_MIN), à 30 % près. De temps en temps, une
 * rangée de tonneaux côte à côte, avec un trou pour passer (ou à sauter).
 */
const FIRST_RUBBLE = 1.5;
const RUBBLE_GAP = 0.65;
const RUBBLE_GAP_MIN = 0.35;
const RUBBLE_GAP_SHRINK = 0.006;
const RUBBLE_JITTER = 0.3;
/** Au bac à sable : un objet toutes les 1,6 s, toujours. */
const PRACTICE_GAP = 1.6;
/** La rangée : des tonneaux tous les ROW_STEP mètres en travers, sauf au trou. */
const ROW_STEP = 1.3;
const ROW_SPEED = 7;
/** Le mélange des sortes au début et à partir de MIX_LATE secondes (entre les deux, en fondu). */
const MIX_EARLY: Record<RubbleKind | 'row', number> = {
  barrel: 4,
  can: 2,
  crate: 2,
  wheel: 1,
  wagon: 0.5,
  row: 0.3,
};
const MIX_LATE: Record<RubbleKind | 'row', number> = {
  barrel: 3,
  can: 2,
  crate: 2,
  wheel: 2,
  wagon: 1,
  row: 1,
};
const MIX_LATE_AT = 60;
/** Le programme couvre ce temps (au-delà du chrono, la partie est finie). */
const SCHEDULE_TIME = 140;

/**
 * Un objet : il part du haut au pas `spawnAt`, à la place `x` en travers, descend à `speed`,
 * dérive à `drift` (signée), et sautille avec ce décalage de phase (secondes).
 */
export type Rubble = {
  id: number;
  kind: RubbleKind;
  spawnAt: number;
  x: number;
  speed: number;
  drift: number;
  phase: number;
};

const schedules = new Map<string, readonly Rubble[]>();

/** Tous les objets d'une partie, dans l'ordre où ils partent (gardés : ils servent à chaque pas). */
export function rubbleSchedule(seed: number, practice: boolean): readonly Rubble[] {
  const key = `${seed}:${practice}`;
  const known = schedules.get(key);
  if (known) return known;
  const list: Rubble[] = [];
  let time = FIRST_RUBBLE;
  for (let k = 0; time < SCHEDULE_TIME; k++) {
    const roll = (salt: number) => forestUnit(seed, k, salt);
    const kind = practice ? practiceKind(k) : pickKind(roll(71), time);
    if (kind === 'row') list.push(...rowOf(list.length, toTick(time), roll(72)));
    else list.push(single(list.length, kind, toTick(time), roll));
    const gap = practice
      ? PRACTICE_GAP
      : Math.max(RUBBLE_GAP_MIN, RUBBLE_GAP - time * RUBBLE_GAP_SHRINK) *
        (1 + (roll(73) * 2 - 1) * RUBBLE_JITTER);
    // Après une rangée, un peu d'air : elle prend toute la largeur.
    time += kind === 'row' ? gap * 1.6 : gap;
  }
  // Une poignée de graines à la fois (la partie, le bac à sable) : on oublie les plus anciennes.
  if (schedules.size > 8) schedules.delete(schedules.keys().next().value ?? key);
  schedules.set(key, list);
  return list;
}

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);

function practiceKind(k: number): RubbleKind | 'row' {
  const order = ['barrel', 'can', 'barrel', 'crate', 'wheel', 'barrel', 'wagon', 'row'] as const;
  return order[k % order.length] ?? 'barrel';
}

function pickKind(unit: number, time: number): RubbleKind | 'row' {
  const late = Math.min(1, time / MIX_LATE_AT);
  const kinds = Object.keys(MIX_EARLY) as (RubbleKind | 'row')[];
  const weights = kinds.map((kind) => MIX_EARLY[kind] + (MIX_LATE[kind] - MIX_EARLY[kind]) * late);
  let left = unit * weights.reduce((sum, weight) => sum + weight, 0);
  for (const [index, kind] of kinds.entries()) {
    left -= weights[index] ?? 0;
    if (left < 0) return kind;
  }
  return 'barrel';
}

function single(
  id: number,
  kind: RubbleKind,
  spawnAt: number,
  roll: (salt: number) => number,
): Rubble {
  const { speed, drift, half } = RUBBLE[kind];
  // Les wagonnets roulent sur leurs rails ; le reste part n'importe où en travers.
  const x =
    kind === 'wagon' ? (roll(74) < 0.5 ? -1 : 1) * RAIL_X : (roll(74) * 2 - 1) * (RAMP_HALF - half);
  return {
    id,
    kind,
    spawnAt,
    x,
    speed: speed[0] + (speed[1] - speed[0]) * roll(75),
    drift: (roll(76) < 0.5 ? -1 : 1) * (drift[0] + (drift[1] - drift[0]) * roll(77)),
    phase: roll(78) * 2,
  };
}

/** Une rangée de tonneaux sur toute la largeur, avec un trou d'un tonneau quelque part. */
function rowOf(firstId: number, spawnAt: number, unit: number): Rubble[] {
  const reach = RAMP_HALF - RUBBLE.barrel.half;
  const count = Math.floor((reach * 2) / ROW_STEP) + 1;
  const gap = Math.floor(unit * count);
  const row: Rubble[] = [];
  for (let index = 0; index < count; index++) {
    if (index === gap) continue;
    row.push({
      id: firstId + row.length,
      kind: 'barrel',
      spawnAt,
      x: -reach + (index * (reach * 2)) / (count - 1),
      speed: ROW_SPEED,
      drift: 0,
      phase: 0,
    });
  }
  return row;
}

/** Où est un objet à ce pas (fraction comprise), ou null s'il n'est pas (ou plus) sur la rampe. */
export function rubbleAt(
  rubble: Rubble,
  tick: number,
): { s: number; x: number; y: number; time: number } | null {
  const time = (tick - rubble.spawnAt) * ARENA_STEP;
  if (time < 0) return null;
  const s = RUBBLE_TOP - rubble.speed * time;
  if (s < RUBBLE_GONE) return null;
  const { half, hop, hopPeriod } = RUBBLE[rubble.kind];
  const x = bounce(rubble.x + rubble.drift * time, RAMP_HALF - half);
  const y = hop > 0 ? hop * Math.abs(Math.sin((Math.PI * (time + rubble.phase)) / hopPeriod)) : 0;
  return { s, x, y, time };
}

/** Une place qui rebondit entre -limit et limit (un aller-retour entre les parois). */
function bounce(x: number, limit: number): number {
  if (limit <= 0) return 0;
  const span = limit * 4;
  const folded = (((x + limit) % span) + span) % span;
  return folded <= limit * 2 ? folded - limit : limit * 3 - folded;
}

/** Les objets sur la rampe à ce pas (le programme est rangé par départ). */
export function liveRubble(schedule: readonly Rubble[], tick: number): Rubble[] {
  const live: Rubble[] = [];
  for (const rubble of schedule) {
    if (rubble.spawnAt > tick) break;
    if (rubbleAt(rubble, tick)) live.push(rubble);
  }
  return live;
}
