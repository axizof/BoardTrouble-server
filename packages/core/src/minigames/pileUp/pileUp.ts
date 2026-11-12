import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Gare à la pile ! (02-mini-jeux.md, fiche 47) : chacun porte un plateau sur la tête, sur un
// échafaudage de chantier. Une grue lâche des objets (planches, parpaings, barils, caisses,
// coussins), les mêmes pour tous au même moment et à la même place de chaque couloir ; on se
// déplace à gauche et à droite pour les recevoir sur sa pile. La pile est un pendule inversé
// (un balai en équilibre sur la main) : on la rattrape en bougeant sous elle, et plus elle est
// haute, plus elle bascule vite. Un objet posé de travers la fait pencher de son côté ; un
// objet qui tape le bord la cogne. Trop penchée, elle s'écroule : éliminé. Au bout du chrono,
// les piles encore debout se classent à la hauteur. Chacun sa pile, sans contact.
// Unités : mètres, secondes, radians (penché vers +x : positif).

export const PILE_TIME_LIMIT = 60;
const END_PAUSE = 1.5;
/** On se déplace de -LANE_HALF à LANE_HALF dans son couloir. */
export const LANE_HALF = 1.8;
const MOVE_SPEED = 4.2;
const MOVE_ACCEL = 12;

export type PileItemKind = 'tray' | 'plank' | 'brick' | 'barrel' | 'crate' | 'cushion';

/** Chaque objet : sa largeur, sa hauteur, son poids ; un coussin amortit le choc. */
export const PILE_ITEMS: Record<
  PileItemKind,
  { width: number; height: number; mass: number; isSoft: boolean }
> = {
  tray: { width: 1, height: 0.08, mass: 0.4, isSoft: false },
  plank: { width: 1.5, height: 0.14, mass: 1, isSoft: false },
  brick: { width: 0.55, height: 0.28, mass: 2.4, isSoft: false },
  barrel: { width: 0.62, height: 0.8, mass: 1.8, isSoft: false },
  crate: { width: 0.8, height: 0.62, mass: 1.3, isSoft: false },
  cushion: { width: 0.85, height: 0.32, mass: 0.5, isSoft: true },
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
const DROP_EVERY = 2.5;
const DROP_EVERY_LATE = 1.5;
const DROP_JITTER = 0.25;
/** Les objets tombent à cette distance du milieu du couloir, au plus. */
const DROP_SPREAD = 1.3;

/**
 * L'équilibre. Le penché effectif `u` : celui de la pile, plus son poids décalé (un objet posé
 * de travers la fait pencher de son côté). La pile part vers où elle penche (GRAVITY), et ce
 * que fait la tête la rattrape (bouger vers où elle penche la redresse). TIPPINESS dit à quelle
 * vitesse tout ça va, selon la hauteur de son centre de gravité : plus haut, plus vif.
 */
const GRAVITY = 9.8;
const TIPPINESS = { base: 0.26, perMetre: 0.3 } as const;
const DAMPING = 0.7;
/**
 * Le poids décalé compte rapporté à la hauteur de la pile plus ce bras : sur une petite pile, un
 * objet posé de travers la fait pencher sans la jeter par terre d'un coup.
 */
const OFFSET_LEVER = 2.5;
/** Un petit vent, d'autant plus fort que la pile est haute (rad/s² par mètre). */
const WIND = 0.22;
const WIND_RATE = 1.15;
/** Au-delà de ce penché (rad), elle s'écroule. */
export const COLLAPSE = 0.7;
/** Un objet reçu à tant de sa largeur et de celle du dessus près est posé ; au-delà, il cogne le bord. */
const CATCH_SHARE = 0.8;
const GRAZE_MARGIN = 0.18;
/** Un objet posé de travers lance la pile de son côté ; un objet qui cogne le bord la pousse. */
const IMPACT = 0.6;
const GRAZE_KNOCK = 1.0;
const SOFT_IMPACT = 0.3;
/** Pas de calcul de l'équilibre par pas de simulation (assez fin pour rester stable). */
const SUBSTEPS = 3;

export type PileCatch = { drop: number; at: number; result: 'caught' | 'grazed' | 'missed' };

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
  /** Ce qu'a fait le dernier objet arrivé sur lui. */
  last: PileCatch | null;
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
    const share = Math.min(1, time / PILE_TIME_LIMIT);
    const gap = before
      ? DROP_EVERY +
        (DROP_EVERY_LATE - DROP_EVERY) * share +
        (forestUnit(seed, k, 61) * 2 - 1) * DROP_JITTER
      : FIRST_DROP;
    // Le premier objet : une caisse, pas loin du milieu, pour se mettre en route.
    const kind = k === 0 ? 'crate' : pickKind(forestUnit(seed, k, 62));
    const spread = k === 0 ? 0.4 : DROP_SPREAD;
    drops.push({
      id: k,
      kind,
      x: (forestUnit(seed, k, 63) * 2 - 1) * spread,
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

/** Le centre de gravité de la pile : sa hauteur au-dessus de la tête, son décalage, son poids. */
function balanceOf(items: readonly PileItem[]) {
  let mass = 0;
  let height = 0;
  let offset = 0;
  let base = 0;
  for (const item of items) {
    const { height: tall, mass: weight } = PILE_ITEMS[item.kind];
    mass += weight;
    height += weight * (base + tall / 2);
    offset += weight * item.offset;
    base += tall;
  }
  return { mass, height: height / mass, offset: offset / mass, top: base };
}

/** Le penché effectif : celui de la pile, plus son poids décalé (rapporté à sa hauteur). */
export function effectiveLean(stacker: Pick<Stacker, 'tilt' | 'items'>): number {
  const balance = balanceOf(stacker.items);
  return stacker.tilt + balance.offset / (balance.height + OFFSET_LEVER);
}

/** Où est le dessus de la pile dans le couloir (le milieu du dernier objet). */
export function topCenter(stacker: Pick<Stacker, 'x' | 'tilt' | 'items'>): number {
  const top = stacker.items[stacker.items.length - 1];
  const height = pileHeight(stacker.items);
  return stacker.x + height * Math.sin(stacker.tilt) + (top?.offset ?? 0);
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
    balance(next, inputs[stacker.id] ?? IDLE_INPUT, state.seed, tick);
    return next;
  });
  let nextDrop = state.nextDrop;
  for (
    let drop = pileDrop(state.seed, nextDrop);
    drop.landAt <= tick;
    drop = pileDrop(state.seed, nextDrop)
  ) {
    if (isPlaying)
      for (const stacker of fighters) if (stacker.fellAt === null) land(stacker, drop, tick);
    nextDrop++;
  }
  for (const stacker of fighters) {
    if (stacker.fellAt !== null || Math.abs(stacker.tilt) <= COLLAPSE) continue;
    if (state.practice) {
      // Au bac à sable, une pile neuve revient sur la tête.
      Object.assign(stacker, { tilt: 0, spin: 0, items: freshPile(), falls: stacker.falls + 1 });
    } else {
      stacker.fellAt = tick;
    }
  }
  return { ...state, tick, fighters, nextDrop };
}

/** Un pas de marche et d'équilibre. */
function balance(stacker: Stacker, input: ArenaInput, seed: number, tick: number): void {
  const dt = ARENA_STEP / SUBSTEPS;
  const pile = balanceOf(stacker.items);
  const lever = pile.height + OFFSET_LEVER;
  const tippiness = TIPPINESS.base + TIPPINESS.perMetre * pile.height;
  const phase = forestUnit(seed, 7, 64) * Math.PI * 2;
  for (let k = 0; k < SUBSTEPS; k++) {
    let target = Math.max(-1, Math.min(1, input.move.x)) * MOVE_SPEED;
    // Vers le garde-corps, il freine à temps (au plus fort de ses jambes) : s'y cogner arrêtait
    // net, et la pile partait d'un coup.
    const room = Math.max(0, LANE_HALF - Math.abs(stacker.x));
    const reachable = Math.sqrt(2 * MOVE_ACCEL * room);
    if (target * Math.sign(stacker.x) > reachable) target = Math.sign(stacker.x) * reachable;
    const change = Math.max(-MOVE_ACCEL * dt, Math.min(MOVE_ACCEL * dt, target - stacker.vx));
    const before = stacker.vx;
    stacker.vx += change;
    stacker.x += stacker.vx * dt;
    if (Math.abs(stacker.x) > LANE_HALF) {
      // Le garde-corps de l'échafaudage (on n'y arrive qu'à l'arrêt, ou presque).
      stacker.x = Math.sign(stacker.x) * LANE_HALF;
      stacker.vx = 0;
    }
    const push = (stacker.vx - before) / dt;
    const lean = stacker.tilt + pile.offset / lever;
    const time = (tick - 1 + k / SUBSTEPS) * ARENA_STEP;
    const wind = WIND * pile.height * Math.sin(time * WIND_RATE + phase);
    stacker.spin +=
      (tippiness * (GRAVITY * Math.sin(lean) - push * Math.cos(stacker.tilt)) -
        DAMPING * stacker.spin +
        wind) *
      dt;
    stacker.tilt += stacker.spin * dt;
  }
}

/** Un objet arrive sur sa pile : posé (de travers ou non), qui cogne le bord, ou à côté. */
function land(stacker: Stacker, drop: PileDrop, tick: number): void {
  const item = PILE_ITEMS[drop.kind];
  const top = stacker.items[stacker.items.length - 1];
  const topWidth = top ? PILE_ITEMS[top.kind].width : 1;
  const gap = drop.x - topCenter(stacker);
  const reach = (topWidth + item.width) / 2;
  const pile = balanceOf(stacker.items);
  const share = item.mass / (pile.mass + item.mass);
  const lever = Math.max(1, pile.top);
  if (Math.abs(gap) <= reach * CATCH_SHARE) {
    stacker.items = [...stacker.items, { kind: drop.kind, offset: (top?.offset ?? 0) + gap }];
    stacker.spin += (IMPACT * share * gap * (item.isSoft ? SOFT_IMPACT : 1)) / lever;
    stacker.last = { drop: drop.id, at: tick, result: 'caught' };
    return;
  }
  if (Math.abs(gap) <= reach + GRAZE_MARGIN) {
    // Il tape le coin du dessus et la pousse de l'autre côté.
    stacker.spin -=
      (GRAZE_KNOCK * share * Math.sign(gap) * (item.isSoft ? SOFT_IMPACT : 1)) / lever;
    stacker.last = { drop: drop.id, at: tick, result: 'grazed' };
    return;
  }
  stacker.last = { drop: drop.id, at: tick, result: 'missed' };
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

function timeLeft(state: PileState): number | null {
  return state.practice ? null : Math.max(0, PILE_TIME_LIMIT - state.tick * ARENA_STEP);
}

// Le bot (02-mini-jeux.md, fiche 47) : il tient sa pile en bougeant sous elle, et va se placer
// sous l'objet qui tombe quand sa pile est assez calme ; quand elle tangue trop, ou qu'il est
// prudent, il le laisse passer. Sa commande est celle d'un balai sur la main : elle regarde à la
// fois le penché, sa vitesse, sa place et la sienne (pour aller à droite, il recule d'abord un
// peu à gauche, et la pile penche vers où il va). Le niveau règle sa vivacité et ses erreurs de
// lecture du penché.

/**
 * Sa vivacité (plus haut, il rattrape plus vite), son temps de réaction (il voit sa pile telle
 * qu'elle était il y a tant de secondes : une pile haute, plus vive, le surprend davantage) et un
 * peu d'erreur de lecture du penché (rad).
 */
const BOT_HOLD: Record<BotLevel, { quickness: number; reaction: number; misread: number }> = {
  easy: { quickness: 1.95, reaction: 0.075, misread: 0.03 },
  normal: { quickness: 2.2, reaction: 0.065, misread: 0.02 },
  expert: { quickness: 2.3, reaction: 0.06, misread: 0.01 },
};
/**
 * Il va chercher un objet si sa pile penche moins que ça (rad), avec cette envie, qui baisse de
 * tant par mètre de pile : le Facile prend tout, même quand ça tangue ; l'Expert lève le pied
 * quand sa pile devient haute.
 */
const CATCH_CALM: Record<BotLevel, number> = { easy: 0.3, normal: 0.18, expert: 0.12 };
const CATCH_WISH: Record<BotLevel, { base: number; perMetre: number }> = {
  easy: { base: 0.95, perMetre: 0 },
  normal: { base: 0.92, perMetre: 0.05 },
  expert: { base: 0.92, perMetre: 0.08 },
};
/** Il commence à se placer tant de secondes avant que l'objet arrive. */
const PLACE_LEAD = 1.3;
/** Ces niveaux jouent comme au clavier (gauche, rien, droite) ; l'Expert dose, comme au stick. */
const KEYBOARD_BOTS: ReadonlySet<BotLevel> = new Set(['easy', 'normal', 'expert']);
/** S'il laisse passer un objet, il s'en écarte de tant de plus que le contact (m). */
const DODGE_ROOM = 0.35;
/** Il reste à tant du garde-corps (m) : s'y cogner arrête net, et la pile part. */
const BOT_ROOM = LANE_HALF - 0.5;
/** Il ne vise pas plus loin que ça d'un coup (m) : sinon la commande demande l'impossible. */
const PLACE_REACH = 0.5;

function botInput(state: PileState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((stacker) => stacker.id === player);
  if (!me || me.fellAt !== null) return IDLE_INPUT;
  const hold = BOT_HOLD[level];
  const pile = balanceOf(me.items);
  const tippiness = TIPPINESS.base + TIPPINESS.perMetre * pile.height;
  const lean = effectiveLean(me) - me.spin * hold.reaction + (rng.next() * 2 - 1) * hold.misread;
  const drop = pileDrop(state.seed, state.nextDrop);
  const soon = (drop.landAt - state.tick) * ARENA_STEP;
  const isCalm = Math.abs(lean) < CATCH_CALM[level];
  const wish = CATCH_WISH[level].base - CATCH_WISH[level].perMetre * pileHeight(me.items);
  const wants = forestUnit(state.seed, drop.id, 70 + saltOf(player)) < wish;
  // Où il veut être : sous l'objet qui arrive (le dessus de sa pile dessous) ; s'il le laisse
  // passer, franchement à côté (sinon il cogne le bord) ; sinon au milieu.
  const gap = drop.x - topCenter(me);
  const top = me.items[me.items.length - 1];
  const clear =
    ((top ? PILE_ITEMS[top.kind].width : 1) + PILE_ITEMS[drop.kind].width) / 2 + DODGE_ROOM;
  const isComing = soon < PLACE_LEAD;
  let goal = 0;
  if (isComing && isCalm && wants) goal = me.x + gap;
  else if (isComing && Math.abs(gap) < clear) {
    const side = drop.x > 0 ? -1 : 1;
    goal = me.x + gap - side * -clear;
  }
  goal = Math.max(-BOT_ROOM, Math.min(BOT_ROOM, goal));
  const away = Math.max(-PLACE_REACH, Math.min(PLACE_REACH, me.x - goal));
  // Les gains qui ramènent tout au calme sans osciller (quatre fois la même vivacité `p`), pour
  // la pile vue comme : vitesse du penché' = K (g penché - poussée) - amorti.
  const p = hold.quickness;
  const kg = tippiness * GRAVITY;
  const onPlace = p ** 4 / kg;
  const onSpeed = (4 * p ** 3 + onPlace * DAMPING) / kg;
  const onSpin = (4 * p - DAMPING + onSpeed) / tippiness;
  const onLean = (6 * p * p + kg + onSpeed * DAMPING + onPlace) / tippiness;
  const push = onLean * lean + onSpin * me.spin + onPlace * away + onSpeed * me.vx;
  const speed = me.vx + push * ARENA_STEP;
  const wanted = Math.max(-1, Math.min(1, speed / MOVE_SPEED));
  // Au clavier, c'est gauche, rien ou droite : le Facile et le Normal jouent comme ça.
  const isKeys = KEYBOARD_BOTS.has(level);
  // Au clavier : gauche, rien ou droite, celui qui le rapproche le plus de la vitesse voulue.
  const move = isKeys ? closestKey(me.vx, speed) : wanted;
  return {
    move: { x: move, z: 0 },
    primary: false,
    secondary: false,
  };
}

/** Gauche (-1), rien (0) ou droite (1) : celui qui amène sa vitesse au plus près de `speed` au pas suivant. */
function closestKey(vx: number, speed: number): number {
  const change = MOVE_ACCEL * ARENA_STEP;
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const key of [-1, 0, 1]) {
    const next = vx + Math.max(-change, Math.min(change, key * MOVE_SPEED - vx));
    const gap = Math.abs(next - speed);
    if (gap < bestGap) {
      bestGap = gap;
      best = key;
    }
  }
  return best;
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
