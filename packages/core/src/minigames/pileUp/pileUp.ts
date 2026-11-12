import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Gare à la pile ! (02-mini-jeux.md, fiche 47) : chacun porte un plateau sur la tête, sur un
// échafaudage de chantier. Une grue lâche des objets (planches, parpaings, barils, caisses,
// coussins), les mêmes pour tous au même moment, un peu à gauche ou à droite du milieu ; chacun
// tombe toujours sur la pile, là où on l'a placée sous lui (au pire tout au bord). La pile se
// balance et revient d'elle-même (le personnage la tient) : petite, elle est stable ; plus elle
// monte, plus elle tangue (le vent, et nos propres pas : partir trop vite la fait osciller), et
// elle penche du côté où l'on a posé trop de poids. Trop penchée, c'est le sauvetage : on
// martèle Action pour la redresser d'un coup, d'autant plus fort qu'elle est haute (elle peut
// repartir de l'autre côté). Raté, elle s'écroule : éliminé. Au bout du chrono, les piles encore
// debout se classent à la hauteur. Chacun sa pile, sans contact. Retour du premier test : la
// première version, un balai en équilibre sur la main, était instable dès le premier objet.
// Unités : mètres, secondes, radians (penché vers +x : positif).

/**
 * Au bout de SUDDEN_DEATH secondes, c'est la mort subite : les objets tombent toutes les
 * SUDDEN_EVERY secondes et le vent forcit, jusqu'à ce qu'il n'en reste qu'un. Tous reçoivent les
 * mêmes objets : les piles debout ont la même hauteur, le chrono seul ne les départageait pas
 * (premiers ex aequo dans 8 parties sur 10). À PILE_TIME_LIMIT, ceux encore debout sont ex aequo.
 */
export const SUDDEN_DEATH = 60;
const SUDDEN_EVERY = 1.1;
const SUDDEN_WIND = 1.6;
export const PILE_TIME_LIMIT = 100;
const END_PAUSE = 1.5;
/** On se déplace de -LANE_HALF à LANE_HALF dans son couloir : de quoi se placer, pas courir. */
export const LANE_HALF = 1.2;
const MOVE_SPEED = 2.6;
const MOVE_ACCEL = 10;

export type PileItemKind = 'tray' | 'plank' | 'brick' | 'barrel' | 'crate' | 'cushion';

/** Chaque objet : sa largeur, sa hauteur, son poids ; un coussin amortit le choc. */
export const PILE_ITEMS: Record<
  PileItemKind,
  { width: number; height: number; mass: number; isSoft: boolean }
> = {
  tray: { width: 1, height: 0.08, mass: 0.4, isSoft: false },
  plank: { width: 1.5, height: 0.12, mass: 1, isSoft: false },
  brick: { width: 0.55, height: 0.25, mass: 2.4, isSoft: false },
  barrel: { width: 0.55, height: 0.62, mass: 1.8, isSoft: false },
  crate: { width: 0.75, height: 0.5, mass: 1.3, isSoft: false },
  cushion: { width: 0.85, height: 0.28, mass: 0.5, isSoft: true },
};
const DROP_KINDS: [PileItemKind, number][] = [
  ['crate', 0.26],
  ['plank', 0.2],
  ['brick', 0.2],
  ['barrel', 0.2],
  ['cushion', 0.14],
];

/** Un objet de la pile : sa sorte, son décalage par rapport à l'axe de la pile (m). */
export type PileItem = { kind: PileItemKind; offset: number };

/**
 * Un objet lâché par la grue : sa sorte, sa place dans le couloir (m, la même pour tous), le
 * pas où il arrive sur les piles. Il se voit tomber DROP_FALL secondes avant.
 */
export type PileDrop = { id: number; kind: PileItemKind; x: number; landAt: number };
export const DROP_FALL = 1.4;
const FIRST_DROP = 2.5;
/** L'écart entre deux objets : de DROP_EVERY au début à DROP_EVERY_LATE à la fin du chrono. */
const DROP_EVERY = 3.0;
const DROP_EVERY_LATE = 2.3;
const DROP_JITTER = 0.25;
/** Les objets tombent à cette distance du milieu du couloir, au plus : un pas de côté suffit. */
const DROP_SPREAD = 0.75;
/** Un objet se pose au plus à cette part du bord du dessus (sur la pile, jamais à côté). */
const EDGE_SHARE = 0.75;

/**
 * Le balancement : la pile revient vers son penché d'équilibre avec une raideur qui baisse
 * quand elle monte (petite, elle revient vite et bouge à peine ; haute, elle revient mollement),
 * peu amortie (elle oscille). Son penché d'équilibre vient de son poids décalé, d'autant plus
 * qu'il est haut. Nos pas la font osciller (une accélération la fait partir en arrière), et le
 * vent souffle d'autant plus fort qu'elle est haute.
 */
const STIFFNESS = { base: 16, halfAt: 2.4 } as const;
const DAMPING = 0.55;
const IMBALANCE = 1.1;
const STEP_SWAY = 0.09;
const WIND = { strength: 0.035, growth: 1.35, rate: 1.1 } as const;
/** Un objet qui se pose de travers lance un peu la pile de son côté. */
const IMPACT = 0.9;
const SOFT_IMPACT = 0.3;
/** Pas de calcul du balancement par pas de simulation. */
const SUBSTEPS = 3;

/**
 * Le sauvetage : au-delà de TEETER (rad), la pile part. Le temps ralentit (elle penche au
 * ralenti), on a RESCUE_TIME secondes pour marteler Action assez de fois (plus si elle est haute,
 * et si elle penche du côté de son poids). Réussi, on la redresse d'un coup, d'autant plus fort
 * qu'elle est haute : elle peut repartir de l'autre côté. Raté, elle s'écroule.
 */
export const TEETER = 0.42;
export const RESCUE_TIME = 1.8;
const RESCUE_SLOWDOWN = 0.2;
const RESCUE_PRESSES = { base: 3, perMetre: 0.9 } as const;
/**
 * La fatigue : chaque sauvetage (réussi ou non) demande FATIGUE appuis de plus aux suivants, et
 * elle redescend d'un appui toutes les FATIGUE_REST secondes. Sans elle, marteler sans arrêt
 * sauvait tout, et rester planté au milieu en martelant gagnait (retour de test).
 */
const FATIGUE = 1.5;
const FATIGUE_REST = 6;
/**
 * Redressée, elle repart de l'autre côté jusqu'à environ ce penché (rad) : un peu sur une petite
 * pile, presque jusqu'au seuil sur une très haute (et il faudra peut-être la sauver encore).
 */
const RESCUE_SWING = { base: 0.16, perMetre: 0.025 } as const;
const RESCUE_TILT = 0.15;

export type PileCatch = { drop: number; at: number; isEdge: boolean };

/** Un sauvetage en cours : depuis quel pas, de quel côté elle part, les appuis faits et à faire. */
export type PileRescue = { since: number; side: 1 | -1; presses: number; needed: number };

export type Stacker = {
  id: PlayerId;
  /** Le pas où sa pile s'est écroulée, ou null. */
  fellAt: number | null;
  /** Sa place dans son couloir et sa vitesse. */
  x: number;
  vx: number;
  /** Le penché de la pile et sa vitesse. */
  tilt: number;
  spin: number;
  /** Sa pile, du plateau (en bas) au dernier objet reçu. */
  items: PileItem[];
  /** Le dernier objet posé sur sa pile. */
  last: PileCatch | null;
  /** Le sauvetage en cours, ou null ; et le dernier réussi (le pas), pour le dessin et le son. */
  rescue: PileRescue | null;
  savedAt: number | null;
  /** La touche Action tenue au pas précédent : un appui compte quand on appuie, pas en tenant. */
  held: boolean;
  /** Les appuis de plus que demandera le prochain sauvetage (la fatigue des précédents). */
  fatigue: number;
  /** Au bac à sable, combien de fois sa pile est tombée (elle revient). */
  falls: number;
};

export type PileState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: Stacker[];
  /** Le prochain objet à arriver (son numéro). */
  nextDrop: number;
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

const dropsBySeed = new Map<number, PileDrop[]>();
const KEPT_SEEDS = 4;

/** Le `id`-ième objet lâché pour cette graine (les mêmes pour tous). */
export function pileDrop(seed: number, id: number): PileDrop {
  let drops = dropsBySeed.get(seed);
  if (!drops) {
    drops = [];
    dropsBySeed.set(seed, drops);
    if (dropsBySeed.size > KEPT_SEEDS) dropsBySeed.delete(dropsBySeed.keys().next().value ?? seed);
  }
  while (drops.length <= id) {
    const k = drops.length;
    const before = drops[k - 1];
    const time = before ? before.landAt * ARENA_STEP : 0;
    const share = Math.min(1, time / SUDDEN_DEATH);
    const every =
      time >= SUDDEN_DEATH ? SUDDEN_EVERY : DROP_EVERY + (DROP_EVERY_LATE - DROP_EVERY) * share;
    const gap = before ? every + (forestUnit(seed, k, 61) * 2 - 1) * DROP_JITTER : FIRST_DROP;
    // Le premier objet : une caisse, au milieu, pour se mettre en route.
    const kind = k === 0 ? 'crate' : pickKind(forestUnit(seed, k, 62));
    drops.push({
      id: k,
      kind,
      x: k === 0 ? 0 : (forestUnit(seed, k, 63) * 2 - 1) * DROP_SPREAD,
      landAt: Math.round((time + gap) / ARENA_STEP),
    });
  }
  return drops[id] as PileDrop;
}

function pickKind(pick: number): PileItemKind {
  let sum = 0;
  for (const [kind, chance] of DROP_KINDS) {
    sum += chance;
    if (pick < sum) return kind;
  }
  return 'crate';
}

/** La hauteur de la pile (m, plateau compris). */
export function pileHeight(items: readonly PileItem[]): number {
  return items.reduce((sum, item) => sum + PILE_ITEMS[item.kind].height, 0);
}

/** Le poids de la pile : son total, son décalage moyen, la hauteur de son centre. */
function weightOf(items: readonly PileItem[]) {
  let mass = 0;
  let offset = 0;
  let height = 0;
  let base = 0;
  for (const item of items) {
    const { height: tall, mass: weight } = PILE_ITEMS[item.kind];
    mass += weight;
    offset += weight * item.offset;
    height += weight * (base + tall / 2);
    base += tall;
  }
  return { mass, offset: offset / mass, height: height / mass };
}

/** Le penché vers lequel la pile revient : son poids décalé, d'autant plus qu'il est haut. */
export function restingLean(items: readonly PileItem[]): number {
  const weight = weightOf(items);
  return IMBALANCE * weight.offset * (0.5 + weight.height);
}

function stiffnessOf(items: readonly PileItem[]): number {
  return STIFFNESS.base / (1 + pileHeight(items) / STIFFNESS.halfAt);
}

/** Où est le dessus de la pile dans le couloir (le milieu du dernier objet). */
export function topCenter(stacker: Pick<Stacker, 'x' | 'tilt' | 'items'>): number {
  const top = stacker.items[stacker.items.length - 1];
  const height = pileHeight(stacker.items);
  return stacker.x + height * Math.sin(stacker.tilt) + (top?.offset ?? 0) * Math.cos(stacker.tilt);
}

/** Les appuis à faire pour sauver cette pile qui part de ce côté. */
function pressesFor(items: readonly PileItem[], side: number): number {
  const height = pileHeight(items);
  // Elle part du côté de son poids : plus dur à rattraper.
  const heavySide = Math.sign(restingLean(items)) === side ? 2 : 0;
  return Math.ceil(RESCUE_PRESSES.base + RESCUE_PRESSES.perMetre * height + heavySide);
}

function freshPile(): PileItem[] {
  return [{ kind: 'tray', offset: 0 }];
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): PileState {
  return {
    tick: 0,
    practice,
    seed,
    nextDrop: 0,
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      x: 0,
      vx: 0,
      tilt: 0,
      spin: 0,
      items: freshPile(),
      last: null,
      rescue: null,
      savedAt: null,
      held: false,
      fatigue: 0,
      falls: 0,
    })),
  };
}

function step(state: PileState, inputs: Partial<Record<PlayerId, ArenaInput>>): PileState {
  const tick = state.tick + 1;
  const isPlaying = state.practice || tick * ARENA_STEP < PILE_TIME_LIMIT;
  // Au coup de sifflet, les piles se figent : on ne tombe plus pendant la pause de fin.
  const fighters = state.fighters.map((stacker) => {
    if (stacker.fellAt !== null || !isPlaying) return stacker;
    const next = { ...stacker };
    act(next, inputs[stacker.id] ?? IDLE_INPUT, state, tick);
    return next;
  });
  let nextDrop = state.nextDrop;
  for (
    let drop = pileDrop(state.seed, nextDrop);
    drop.landAt <= tick;
    drop = pileDrop(state.seed, nextDrop)
  ) {
    if (isPlaying) {
      for (const stacker of fighters) if (stacker.fellAt === null) land(stacker, drop, tick);
    }
    nextDrop++;
  }
  return { ...state, tick, fighters, nextDrop };
}

/** Un pas : le sauvetage s'il y en a un, sinon la marche et le balancement. */
function act(stacker: Stacker, input: ArenaInput, state: PileState, tick: number): void {
  const pressed = input.primary && !stacker.held;
  stacker.held = input.primary;
  stacker.fatigue = Math.max(0, stacker.fatigue - ARENA_STEP / FATIGUE_REST);
  if (stacker.rescue) {
    rescue(stacker, stacker.rescue, pressed, state, tick);
    return;
  }
  sway(stacker, input, state.seed, tick, 1);
  if (Math.abs(stacker.tilt) < TEETER) return;
  const side = stacker.tilt > 0 ? 1 : -1;
  const needed = pressesFor(stacker.items, side) + Math.round(stacker.fatigue);
  stacker.rescue = { since: tick, side, presses: 0, needed };
  stacker.fatigue += FATIGUE;
  stacker.vx = 0;
}

/**
 * Le sauvetage : la pile penche au ralenti, chaque appui compte ; assez d'appuis, on la redresse
 * d'un coup ; le temps écoulé, elle s'écroule (au bac à sable, une pile neuve revient).
 */
function rescue(
  stacker: Stacker,
  current: PileRescue,
  pressed: boolean,
  state: PileState,
  tick: number,
): void {
  const presses = current.presses + (pressed ? 1 : 0);
  if (presses >= current.needed) {
    // Redressée d'un coup : elle repart vers l'autre côté, d'autant plus loin qu'elle est haute
    // (la vitesse qu'il faut pour aller jusqu'à ce penché, à sa raideur).
    const swing = RESCUE_SWING.base + RESCUE_SWING.perMetre * pileHeight(stacker.items);
    const pace = Math.sqrt(stiffnessOf(stacker.items));
    stacker.tilt = current.side * RESCUE_TILT;
    stacker.spin =
      -current.side * pace * Math.sqrt(Math.max(0, swing * swing - RESCUE_TILT * RESCUE_TILT));
    stacker.rescue = null;
    stacker.savedAt = tick;
    return;
  }
  stacker.rescue = { ...current, presses };
  // Elle continue de partir, au ralenti.
  sway(stacker, IDLE_INPUT, state.seed, tick, RESCUE_SLOWDOWN);
  if (tick - current.since < steps(RESCUE_TIME)) return;
  if (state.practice) {
    Object.assign(stacker, {
      tilt: 0,
      spin: 0,
      items: freshPile(),
      rescue: null,
      falls: stacker.falls + 1,
    });
  } else {
    stacker.fellAt = tick;
  }
}

/** La marche, et le balancement de la pile (`pace` : 1 au temps normal, moins au ralenti). */
function sway(stacker: Stacker, input: ArenaInput, seed: number, tick: number, pace: number) {
  const dt = (ARENA_STEP / SUBSTEPS) * pace;
  const stiffness = stiffnessOf(stacker.items);
  const resting = restingLean(stacker.items);
  const height = pileHeight(stacker.items);
  const isSudden = tick * ARENA_STEP >= SUDDEN_DEATH;
  const wind = WIND.strength * height ** WIND.growth * (isSudden ? SUDDEN_WIND : 1);
  const phase = forestUnit(seed, 7, 64) * Math.PI * 2;
  for (let k = 0; k < SUBSTEPS; k++) {
    const target = Math.max(-1, Math.min(1, input.move.x)) * MOVE_SPEED;
    const change = Math.max(-MOVE_ACCEL * dt, Math.min(MOVE_ACCEL * dt, target - stacker.vx));
    stacker.vx += change;
    stacker.x += stacker.vx * dt;
    if (Math.abs(stacker.x) > LANE_HALF) {
      stacker.x = Math.sign(stacker.x) * LANE_HALF;
      stacker.vx = 0;
    }
    const push = change / dt;
    const time = (tick - 1 + k / SUBSTEPS) * ARENA_STEP;
    // Une accélération fait partir la pile en arrière (elle traîne derrière les pas).
    stacker.spin +=
      (stiffness * (resting - stacker.tilt) -
        DAMPING * stacker.spin -
        STEP_SWAY * push +
        wind * Math.sin(time * WIND.rate + phase)) *
      dt;
    stacker.tilt += stacker.spin * dt;
  }
}

/**
 * Un objet arrive sur sa pile, toujours : là où il tombe par rapport au dessus, ou au plus tout
 * au bord (il glisse jusqu'au bord). Posé de travers, il lance la pile de son côté.
 */
function land(stacker: Stacker, drop: PileDrop, tick: number): void {
  const item = PILE_ITEMS[drop.kind];
  const top = stacker.items[stacker.items.length - 1];
  const topWidth = top ? PILE_ITEMS[top.kind].width : 1;
  const edge = ((topWidth + item.width) / 2) * EDGE_SHARE;
  const gap = drop.x - topCenter(stacker);
  const placed = Math.max(-edge, Math.min(edge, gap));
  const share = item.mass / (weightOf(stacker.items).mass + item.mass);
  stacker.items = [...stacker.items, { kind: drop.kind, offset: (top?.offset ?? 0) + placed }];
  stacker.spin += IMPACT * share * placed * (item.isSoft ? SOFT_IMPACT : 1);
  stacker.last = { drop: drop.id, at: tick, isEdge: Math.abs(gap) > edge };
}

function alive(state: PileState): Stacker[] {
  return state.fighters.filter((stacker) => stacker.fellAt === null);
}

function isOver(state: PileState): boolean {
  if (state.practice) return false;
  if (state.fighters.length > 1 && alive(state).length <= 1) return true;
  if (state.fighters.length === 1 && alive(state).length === 0) return true;
  return state.tick * ARENA_STEP >= PILE_TIME_LIMIT + END_PAUSE;
}

/** La hauteur classée (au centimètre : deux piles à un cheveu sont ex aequo, les dés tranchent). */
export function rankedHeight(stacker: Stacker): number {
  return Math.round(pileHeight(stacker.items) * 100);
}

/**
 * Le classement : ceux encore debout, de la plus haute pile à la plus basse ; puis ceux dont la
 * pile est tombée, du dernier tombé au premier. Au même pas, ou à la même hauteur : ex aequo.
 */
function ranking(state: PileState): PlayerId[][] {
  const groups = (entries: [number, PlayerId][]) => {
    const byKey = new Map<number, PlayerId[]>();
    for (const [key, id] of entries) byKey.set(key, [...(byKey.get(key) ?? []), id]);
    return [...byKey.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  };
  const standing = groups(alive(state).map((stacker) => [rankedHeight(stacker), stacker.id]));
  const fallen = groups(
    state.fighters
      .filter((stacker) => stacker.fellAt !== null)
      .map((stacker) => [stacker.fellAt ?? 0, stacker.id]),
  );
  return [...standing, ...fallen];
}

/** Le chrono va jusqu'à la mort subite ; ensuite, plus de chrono : le dernier debout gagne. */
function timeLeft(state: PileState): number | null {
  const time = state.tick * ARENA_STEP;
  return state.practice || time >= SUDDEN_DEATH ? null : SUDDEN_DEATH - time;
}

/** La mort subite a commencé. */
export function isSuddenDeath(state: PileState): boolean {
  return !state.practice && state.tick * ARENA_STEP >= SUDDEN_DEATH;
}

// Le bot (02-mini-jeux.md, fiche 47) : il se place sous chaque objet pour le poser du côté qui
// rééquilibre sa pile, se déplace doucement (partir trop vite la fait osciller) et accompagne
// le balancement (il va un peu du côté où elle penche, comme on retient un plateau). Au
// sauvetage, il martèle plus ou moins vite selon son niveau. Il voit sa pile avec un peu de
// retard et vise plus ou moins juste.

const BOT: Record<
  BotLevel,
  { aim: number; follow: number; mash: number; reaction: number; care: number }
> = {
  easy: { aim: 0.18, follow: 1.28, mash: 6.2, reaction: 0.2, care: 0.7 },
  normal: { aim: 0.12, follow: 1.6, mash: 6.8, reaction: 0.15, care: 0.8 },
  expert: { aim: 0.09, follow: 1.84, mash: 7.3, reaction: 0.12, care: 0.9 },
};
/** Il commence à se placer tant de secondes avant que l'objet arrive, sans dépasser cette allure (part de la pleine vitesse). */
const PLACE_LEAD = 1.6;
const BOT_PACE = 0.45;

function botInput(state: PileState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((stacker) => stacker.id === player);
  if (!me || me.fellAt !== null) return IDLE_INPUT;
  const bot = BOT[level];
  if (me.rescue) {
    // Il martèle à son rythme (un peu plus ou moins vite selon le sauvetage).
    const rate = bot.mash * (0.75 + 0.5 * forestUnit(state.seed, me.rescue.since, saltOf(player)));
    const elapsed = (state.tick - me.rescue.since) * ARENA_STEP;
    const isDown = Math.floor(elapsed * rate * 2) % 2 === 0;
    return { move: { x: 0, z: 0 }, primary: isDown, secondary: false };
  }
  const drop = pileDrop(state.seed, state.nextDrop);
  const soon = (drop.landAt - state.tick) * ARENA_STEP;
  // Ce qu'il voit : sa pile il y a un instant.
  const seenTilt = me.tilt - me.spin * bot.reaction;
  // Sous l'objet, pour le poser du côté qui ramène le poids au milieu (et vise plus ou moins juste).
  const lean = restingLean(me.items);
  const wished = Math.max(-0.3, Math.min(0.3, -lean * bot.care));
  const miss = (forestUnit(state.seed, drop.id, 80 + saltOf(player)) * 2 - 1) * bot.aim;
  const goal =
    soon < PLACE_LEAD ? me.x + (drop.x - wished + miss - topCenter({ ...me, tilt: seenTilt })) : 0;
  // Doucement vers sa place (partir trop vite la fait osciller), et un peu du côté où la pile
  // penche (il l'accompagne).
  const speed =
    Math.max(-BOT_PACE, Math.min(BOT_PACE, (goal - me.x) * 1.5)) + seenTilt * bot.follow;
  const wanted = Math.max(-1, Math.min(1, speed + (rng.next() * 2 - 1) * 0.05));
  return { move: { x: wanted, z: 0 }, primary: false, secondary: false };
}

/** Un nombre propre à chaque joueur : chaque bot a ses envies, pas toutes les mêmes. */
function saltOf(player: PlayerId): number {
  let salt = 0;
  for (const char of player) salt = (salt * 31 + char.charCodeAt(0)) % 997;
  return salt;
}

export const PILE_UP: ArenaGame<PileState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
