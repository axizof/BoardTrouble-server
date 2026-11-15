import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  type BodyTuning,
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
  BLANK,
  CANVAS_HALF_X,
  CANVAS_HALF_Z,
  cellAt,
  cellsAround,
  isUnderProp,
  keepInAtelier,
  PAINT_COLUMNS,
  PAINT_ROWS,
  PAINT_STARTS,
  PAINTABLE_CELLS,
} from './atelier';

// Peinture fraîche (02-mini-jeux.md, fiche 7), dans l'atelier du peintre géant (atelier.ts) :
// chacun peint la toile de sa couleur en marchant. La peinture colle : on court plus vite sur sa
// couleur, plus lentement sur celle des autres. Espace / A : un dash ; celui qu'il touche
// trébuche et lâche une flaque de la couleur du dasheur. Des bonus apparaissent : le rouleau
// (trace large ROLLER_TIME secondes), la bombe (Maj / B la lance devant soi ; elle repeint une
// grande zone en éclatant) et l'éponge (elle efface aussitôt la couleur des autres autour de
// soi). Au bout de PAINT_TIME secondes, la plus grande surface gagne ; les pourcentages se
// cachent les HIDE_SCORES dernières secondes, puis la révélation les montre un à un.

export const PAINT_TIME = 60;
export const HIDE_SCORES = 10;
/** La trace : on peint ce qui est à BRUSH mètres des pieds, ROLLER avec le rouleau. */
const BRUSH = 0.55;
const ROLLER = 1.3;
export const ROLLER_TIME = 5;
/** La peinture qui colle : la vitesse sur sa couleur, et sur celle des autres. */
export const OWN_SPEED = 1.25;
export const OTHER_SPEED = 0.7;
/** Le dash : un élan bref (environ 2 m), puis une recharge. */
const DASH_SPEED = 11;
export const PAINT_DASH_TIME = 0.16;
export const PAINT_DASH_COOLDOWN = 1.5;
const DASH_REACH = WALKER.radius * 2 + 0.2;
/** Touché : il trébuche (à terre TRIP_DOWN secondes) et lâche une flaque de SPLAT mètres. */
const TRIP_SPEED = 5;
const TRIP_DOWN = 0.8;
const SPLAT = 1.2;
/** La bombe : lancée à THROW_REACH mètres devant soi, elle tombe au bout de BOMB_FLIGHT et éclate. */
const THROW_REACH = 5;
export const BOMB_FLIGHT = 0.6;
export const BOMB_RADIUS = 2.6;
/** Tenue trop longtemps (BOMB_FUSE secondes), elle éclate à ses pieds. */
export const BOMB_FUSE = 6;
/** L'éponge efface la couleur des autres à SPONGE_RADIUS mètres autour de soi. */
export const SPONGE_RADIUS = 3;
/** Les bonus : au plus BONUS_MAX sur la toile, un nouveau toutes les BONUS_EVERY secondes. */
const BONUS_MAX = 2;
const BONUS_EVERY = 6;
const FIRST_BONUS = 4;
const PICK_REACH = 0.8;
/** Une bombe éclatée, une éponge passée, restent dans l'état ce temps-là (le client les montre). */
const EFFECT_KEPT = 1;

export type PaintBonusKind = 'roller' | 'bomb' | 'sponge';
const BONUS_KINDS: readonly PaintBonusKind[] = ['roller', 'bomb', 'sponge'];

export type Painter = ArenaBody & {
  fellAt: null;
  /** Le rang de sa couleur (1 à 6) : son caractère dans la peinture. */
  color: string;
  dashing: number;
  dashReady: number;
  /** Le pas où il a dashé, où un dash l'a fait trébucher (le client montre le choc), ou null. */
  dashedAt: number | null;
  trippedAt: number | null;
  /** Le pas jusqu'où il a le rouleau, et le pas où il a ramassé une bombe (null : pas de bombe). */
  rollerUntil: number;
  bombSince: number | null;
  heldDash: boolean;
  heldThrow: boolean;
};

export type PaintBonus = {
  id: number;
  kind: PaintBonusKind;
  x: number;
  z: number;
  spawnedAt: number;
};

/** Ce qui se voit d'un coup : une bombe (en vol puis éclatée) ou un coup d'éponge. */
export type PaintEffect = {
  id: number;
  kind: 'bomb' | 'sponge';
  by: PlayerId;
  fromX: number;
  fromZ: number;
  x: number;
  z: number;
  startAt: number;
  /** Le pas où elle éclate (la bombe) ou où l'éponge passe ; null tant qu'elle vole. */
  doneAt: number | null;
  landAt: number;
};

export type PaintState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: Painter[];
  /** La toile : un caractère par case (BLANK, ou la couleur d'un joueur). */
  paint: string;
  bonuses: PaintBonus[];
  nextBonusAt: number;
  bonusCount: number;
  effects: PaintEffect[];
  nextEffect: number;
};

function steps(seconds: number): number {
  return Math.round(seconds / ARENA_STEP);
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): PaintState {
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id, index) => {
      const start = PAINT_STARTS[index % PAINT_STARTS.length] ?? { x: 0, z: 0 };
      return {
        ...createBody(id, start.x, start.z, Math.atan2(-start.x, -start.z)),
        fellAt: null,
        color: String(index + 1),
        dashing: 0,
        dashReady: 0,
        dashedAt: null,
        trippedAt: null,
        rollerUntil: 0,
        bombSince: null,
        heldDash: false,
        heldThrow: false,
      };
    }),
    paint: BLANK.repeat(PAINT_COLUMNS * PAINT_ROWS),
    bonuses: [],
    nextBonusAt: steps(practice ? 1 : FIRST_BONUS),
    bonusCount: 0,
    effects: [],
    nextEffect: 0,
  };
}

/** Les cases peintes de chaque couleur. */
export function paintCounts(state: PaintState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of state.paint) {
    if (char !== BLANK) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return counts;
}

/** La part de la toile peinte par ce joueur (0 à 100). */
export function paintShare(state: PaintState, player: PlayerId): number {
  const painter = state.fighters.find((one) => one.id === player);
  if (!painter) return 0;
  let count = 0;
  for (const char of state.paint) if (char === painter.color) count += 1;
  return (count / PAINTABLE_CELLS) * 100;
}

/** Les pourcentages sont cachés : les dernières secondes de la partie. */
export function areScoresHidden(state: PaintState): boolean {
  return !state.practice && (timeLeft(state) ?? Number.POSITIVE_INFINITY) <= HIDE_SCORES;
}

function step(state: PaintState, inputs: Partial<Record<PlayerId, ArenaInput>>): PaintState {
  const tick = state.tick + 1;
  const next: PaintState = {
    ...state,
    tick,
    fighters: state.fighters.map((one) => ({ ...one })),
    bonuses: [...state.bonuses],
    effects: state.effects.map((one) => ({ ...one })),
  };
  if (isOver(state)) return next;
  const paint = state.paint.split('');
  for (const painter of next.fighters) {
    const input = inputs[painter.id] ?? IDLE_INPUT;
    act(next, painter, input, paint);
  }
  dashHits(next, paint);
  const shift = tick % Math.max(1, next.fighters.length);
  collideBodies(
    [...next.fighters.slice(shift), ...next.fighters.slice(0, shift)],
    WALKER,
    new Set(),
  );
  moveBodies(next.fighters, WALKER, ARENA_STEP);
  for (const painter of next.fighters) {
    keepInAtelier(painter, WALKER.radius);
    // À terre, on ne peint pas : la flaque du dasheur reste sous celui qui a trébuché.
    if (painter.downed > 0) continue;
    const radius = tick < painter.rollerUntil ? ROLLER : BRUSH;
    for (const cell of cellsAround(painter.x, painter.z, radius)) paint[cell] = painter.color;
  }
  pickBonuses(next);
  landEffects(next, paint);
  spawnBonus(next);
  next.paint = paint.join('');
  next.effects = next.effects.filter(
    (one) => one.doneAt === null || tick - one.doneAt <= steps(EFFECT_KEPT),
  );
  return next;
}

/** La vitesse de course de ce joueur (part de la normale), selon la couleur sous ses pieds. */
export function speedFactor(paint: ArrayLike<string>, painter: Painter): number {
  const cell = cellAt(painter.x, painter.z);
  const under = cell < 0 ? BLANK : (paint[cell] ?? BLANK);
  if (under === BLANK) return 1;
  return under === painter.color ? OWN_SPEED : OTHER_SPEED;
}

/** Les commandes d'un joueur : courir (plus ou moins vite selon la peinture), dasher, lancer sa bombe. */
function act(state: PaintState, painter: Painter, input: ArenaInput, paint: string[]): void {
  const { tick } = state;
  const pressedDash = input.primary && !painter.heldDash;
  const pressedThrow = input.secondary && !painter.heldThrow;
  painter.heldDash = input.primary;
  painter.heldThrow = input.secondary;
  painter.dashReady = Math.max(0, painter.dashReady - ARENA_STEP);
  // La bombe : lancée devant soi, ou elle éclate à ses pieds au bout de sa mèche.
  if (painter.bombSince !== null) {
    const isLate = tick - painter.bombSince >= steps(BOMB_FUSE);
    if ((pressedThrow && isSteady(painter)) || isLate) {
      const reach = isLate ? 0 : THROW_REACH;
      throwBomb(state, painter, reach);
      painter.bombSince = null;
    }
  }
  if (painter.dashing > 0) {
    painter.dashing = Math.max(0, painter.dashing - ARENA_STEP);
    return;
  }
  if (pressedDash && painter.dashReady <= 0 && isSteady(painter)) {
    if (Math.hypot(input.move.x, input.move.z) > 0.1) {
      painter.facing = Math.atan2(input.move.x, input.move.z);
    }
    Object.assign(painter, {
      dashing: PAINT_DASH_TIME,
      dashReady: PAINT_DASH_COOLDOWN,
      dashedAt: tick,
      vx: Math.sin(painter.facing) * DASH_SPEED,
      vz: Math.cos(painter.facing) * DASH_SPEED,
    });
    return;
  }
  const tuning: BodyTuning = {
    ...WALKER,
    walkSpeed: WALKER.walkSpeed * speedFactor(paint, painter),
  };
  walkBody(painter, input.move, tuning, ARENA_STEP);
}

/** Un dash qui touche quelqu'un devant : il trébuche et lâche une flaque de la couleur du dasheur. */
function dashHits(state: PaintState, paint: string[]): void {
  for (const dasher of state.fighters) {
    if (dasher.dashing <= 0) continue;
    const dirX = Math.sin(dasher.facing);
    const dirZ = Math.cos(dasher.facing);
    for (const other of state.fighters) {
      if (other === dasher || other.downed > 0) continue;
      const dx = other.x - dasher.x;
      const dz = other.z - dasher.z;
      const gap = Math.hypot(dx, dz);
      if (gap === 0 || gap > DASH_REACH || (dx * dirX + dz * dirZ) / gap < 0.5) continue;
      knockDown(other, dx / gap, dz / gap, TRIP_SPEED, TRIP_DOWN);
      Object.assign(other, { trippedAt: state.tick, dashing: 0 });
      Object.assign(dasher, { dashing: 0, vx: dasher.vx * 0.3, vz: dasher.vz * 0.3 });
      for (const cell of cellsAround(other.x, other.z, SPLAT)) paint[cell] = dasher.color;
      break;
    }
  }
}

/** La bombe part : elle vole jusqu'à `reach` mètres devant lui (sur la toile), puis éclate. */
function throwBomb(state: PaintState, painter: Painter, reach: number): void {
  const x = Math.max(
    -CANVAS_HALF_X,
    Math.min(CANVAS_HALF_X, painter.x + Math.sin(painter.facing) * reach),
  );
  const z = Math.max(
    -CANVAS_HALF_Z,
    Math.min(CANVAS_HALF_Z, painter.z + Math.cos(painter.facing) * reach),
  );
  state.effects.push({
    id: state.nextEffect,
    kind: 'bomb',
    by: painter.id,
    fromX: painter.x,
    fromZ: painter.z,
    x,
    z,
    startAt: state.tick,
    landAt: state.tick + (reach > 0 ? steps(BOMB_FLIGHT) : 0),
    doneAt: null,
  });
  state.nextEffect += 1;
}

/** Les bombes qui tombent éclatent ; l'éponge efface. */
function landEffects(state: PaintState, paint: string[]): void {
  for (const effect of state.effects) {
    if (effect.doneAt !== null || state.tick < effect.landAt) continue;
    effect.doneAt = state.tick;
    const painter = state.fighters.find((one) => one.id === effect.by);
    if (!painter) continue;
    if (effect.kind === 'bomb') {
      for (const cell of cellsAround(effect.x, effect.z, BOMB_RADIUS)) paint[cell] = painter.color;
    } else {
      for (const cell of cellsAround(effect.x, effect.z, SPONGE_RADIUS)) {
        if (paint[cell] !== painter.color) paint[cell] = BLANK;
      }
    }
  }
}

/** Qui passe sur un bonus le prend : le rouleau tout de suite, la bombe en main, l'éponge aussitôt. */
function pickBonuses(state: PaintState): void {
  for (const bonus of [...state.bonuses]) {
    const taker = state.fighters.find(
      (one) =>
        isSteady(one) &&
        Math.hypot(one.x - bonus.x, one.z - bonus.z) <= PICK_REACH &&
        !(bonus.kind === 'bomb' && one.bombSince !== null),
    );
    if (!taker) continue;
    state.bonuses = state.bonuses.filter((one) => one !== bonus);
    if (bonus.kind === 'roller') taker.rollerUntil = state.tick + steps(ROLLER_TIME);
    if (bonus.kind === 'bomb') taker.bombSince = state.tick;
    if (bonus.kind === 'sponge') {
      state.effects.push({
        id: state.nextEffect,
        kind: 'sponge',
        by: taker.id,
        fromX: taker.x,
        fromZ: taker.z,
        x: taker.x,
        z: taker.z,
        startAt: state.tick,
        landAt: state.tick,
        doneAt: null,
      });
      state.nextEffect += 1;
    }
  }
}

/** À l'heure, un bonus apparaît sur la toile (pas sous un obstacle ni sur un joueur). */
function spawnBonus(state: PaintState): void {
  if (state.tick < state.nextBonusAt) return;
  state.nextBonusAt = state.tick + steps(BONUS_EVERY);
  if (state.bonuses.length >= BONUS_MAX) return;
  const id = state.bonusCount;
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = (forestUnit(state.seed, id * 16 + attempt, 601) * 2 - 1) * (CANVAS_HALF_X - 1.5);
    const z = (forestUnit(state.seed, id * 16 + attempt, 602) * 2 - 1) * (CANVAS_HALF_Z - 1.5);
    if (isUnderProp(x, z) || cellsAround(x, z, 1).length < 9) continue;
    if (state.fighters.some((one) => Math.hypot(one.x - x, one.z - z) < 2)) continue;
    const kind =
      BONUS_KINDS[Math.floor(forestUnit(state.seed, id, 603) * BONUS_KINDS.length)] ?? 'roller';
    state.bonuses.push({ id, kind, x, z, spawnedAt: state.tick });
    state.bonusCount = id + 1;
    return;
  }
}

function timeLeft(state: PaintState): number | null {
  if (state.practice) return null;
  return Math.max(0, PAINT_TIME - state.tick * ARENA_STEP);
}

function isOver(state: PaintState): boolean {
  return !state.practice && state.tick >= steps(PAINT_TIME);
}

/** Du plus de cases au moins ; à cases égales, ex aequo. */
function ranking(state: PaintState): PlayerId[][] {
  const counts = paintCounts(state);
  const groups = new Map<number, PlayerId[]>();
  for (const one of state.fighters) {
    const count = counts.get(one.color) ?? 0;
    groups.set(count, [...(groups.get(count) ?? []), one.id]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

// Le bot (02-mini-jeux.md, fiche 7) : il regarde quelques directions autour de lui (les mêmes une
// demi-seconde durant) et prend celle où sa trace peindrait le plus (cases vierges, ou d'une
// autre couleur, plus encore celles du meneur), en gardant son élan ; il fait un détour pour un bonus
// proche, lance sa bombe vers l'endroit le moins à lui, et dashe qui passe devant lui. Selon son
// niveau : combien de points il regarde, son goût pour les bonus et pour le dash, et des
// hésitations.

const BOT: Record<BotLevel, { looks: number; bonus: number; dash: number; drift: number }> = {
  easy: { looks: 4, bonus: 3, dash: 0.03, drift: 0.9 },
  normal: { looks: 10, bonus: 6, dash: 0.1, drift: 0.35 },
  expert: { looks: 18, bonus: 9, dash: 0.25, drift: 0.12 },
};
/** Il change de plan toutes les PLAN_EVERY secondes (sinon il hésiterait à chaque pas). */
const PLAN_EVERY = 0.5;
/** Il juge chaque direction sur PATH_LENGTH mètres de trajet ; garder son élan vaut MOMENTUM. */
const PATH_LENGTH = 4;
const PATH_STEP = 0.5;
const MOMENTUM = 0.8;

function botInput(state: PaintState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  if (!me || !isSteady(me) || me.dashing > 0) return IDLE_INPUT;
  const bot = BOT[level];
  const plan = Math.floor(state.tick / steps(PLAN_EVERY));
  const salt = saltOf(player);
  // Un bonus pas trop loin : il y va.
  const bonus = state.bonuses
    .filter((one) => !(one.kind === 'bomb' && me.bombSince !== null))
    .map((one) => ({ one, gap: Math.hypot(one.x - me.x, one.z - me.z) }))
    .filter(({ gap }) => gap < bot.bonus)
    .sort((a, b) => a.gap - b.gap)[0];
  let target: { x: number; z: number } | null = bonus ? bonus.one : null;
  if (!target) target = bestSpot(state, me, bot.looks, plan, salt);
  const drift = (forestUnit(state.seed, plan, 604 + salt) - 0.5) * bot.drift * 2;
  const move = target ? rotate(toward(me, target), drift) : { x: 0, z: 0 };
  // Il dashe qui passe devant lui, tout près.
  const prey = state.fighters.find((other) => {
    if (other === me || other.downed > 0) return false;
    const dx = other.x - me.x;
    const dz = other.z - me.z;
    const gap = Math.hypot(dx, dz);
    return gap > 0 && gap < 1.8 && (dx * move.x + dz * move.z) / gap > 0.6;
  });
  const dash = prey !== undefined && me.dashReady <= 0 && rng.chance(bot.dash * 3);
  // La bombe : vers là où il y a le plus à prendre, dès qu'il y regarde.
  const throwNow = me.bombSince !== null && (state.tick - me.bombSince) * ARENA_STEP > 0.6;
  return { move, primary: dash, secondary: throwNow };
}

/** Le point le plus intéressant parmi `looks` autour de lui : beaucoup à prendre, pas trop loin. */
function bestSpot(
  state: PaintState,
  me: Painter,
  looks: number,
  plan: number,
  salt: number,
): { x: number; z: number } | null {
  const leader = leaderColor(state, me.color);
  const turn = forestUnit(state.seed, plan, 605 + salt) * Math.PI * 2;
  let best: { x: number; z: number } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let look = 0; look < looks; look++) {
    const angle = turn + (look / looks) * Math.PI * 2;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    // Ce qu'il peindrait en allant par là : les cases sous sa trace, le long du trajet.
    const swath = new Set<number>();
    let reach = 0;
    for (let along = PATH_STEP; along <= PATH_LENGTH; along += PATH_STEP) {
      const x = me.x + dirX * along;
      const z = me.z + dirZ * along;
      if (
        Math.abs(x) > CANVAS_HALF_X - 0.5 ||
        Math.abs(z) > CANVAS_HALF_Z - 0.5 ||
        isUnderProp(x, z)
      ) {
        break;
      }
      reach = along;
      for (const cell of cellsAround(x, z, BRUSH)) swath.add(cell);
    }
    if (reach === 0) continue;
    let gain = 0;
    for (const cell of swath) {
      const char = state.paint[cell];
      if (char === me.color) continue;
      gain += char === BLANK ? 1 : char === leader ? 1.4 : 1.2;
    }
    // Il garde son élan : faire demi-tour coûte.
    const keep = Math.cos(angle - me.facing) * MOMENTUM;
    const score = gain / PATH_LENGTH + keep - (reach < PATH_LENGTH ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { x: me.x + dirX * reach, z: me.z + dirZ * reach };
    }
  }
  return best;
}

/** La couleur qui mène (pas la sienne), ou null. */
function leaderColor(state: PaintState, own: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [color, count] of paintCounts(state)) {
    if (color !== own && count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

function toward(me: { x: number; z: number }, target: { x: number; z: number }) {
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const gap = Math.hypot(dx, dz);
  return gap > 0.2 ? { x: dx / gap, z: dz / gap } : { x: 0, z: 0 };
}

function rotate(dir: { x: number; z: number }, angle: number): { x: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: dir.x * cos + dir.z * sin, z: -dir.x * sin + dir.z * cos };
}

export const FRESH_PAINT: ArenaGame<PaintState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
  reveal: { score: paintShare, close: 2, crushing: 15 },
};
