import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Ball-trap (02-mini-jeux.md, fiche 45, ton idée), un duel (et une finale à deux) : chacun son
// lanceur, l'un à gauche, l'autre à droite ; à chaque volée, les deux lancent un plateau en même
// temps, en miroir, à des moments qu'on ne peut pas prévoir. Trois zones de tir dans le ciel
// (gauche, haut, droite) : on choisit la sienne d'une direction, et on tire quand son plateau la
// traverse. Deux cartouches par volée. Le lanceur du milieu envoie de temps en temps un plateau
// argenté, commun : le premier qui le casse marque 2 points. Le plus de points après la
// dernière volée gagne. Tout se joue dans le plan du ciel, face à la caméra : x à droite, y en
// haut, en mètres.

/** Les volées, et l'écart au hasard entre deux (secondes). La première part à FIRST_VOLLEY. */
export const CLAY_VOLLEYS = 10;
const FIRST_VOLLEY = 2;
const VOLLEY_GAP_MIN = 2.4;
const VOLLEY_GAP_MAX = 3.6;
/** Les plateaux argentés : combien, et leur décalage au hasard sur leur volée (secondes). */
export const SILVER_COUNT = 3;
const SILVER_OFFSET_MIN = -0.4;
const SILVER_OFFSET_MAX = 0.8;
export const SILVER_POINTS = 2;
/** Les cartouches, rechargées à chaque volée. */
export const SHELLS = 2;
/** Les zones de tir, dans le plan du ciel, et leur rayon. */
export type ClayZone = 'left' | 'up' | 'right';
export const ZONES: Record<ClayZone, { x: number; y: number }> = {
  left: { x: -3.6, y: 4.2 },
  up: { x: 0, y: 6.4 },
  right: { x: 3.6, y: 4.2 },
};
export const ZONE_RADIUS = 1.25;
/** Les lanceurs : le joueur de gauche, celui de droite (en miroir), celui du milieu. */
export const LAUNCHER_X = 7.5;
const LAUNCHER_Y = 0.6;
const GRAVITY = 9.8;
/** Un plateau monte jusqu'à APEX_MIN à APEX_MAX mètres, en avançant à SPEED_MIN à SPEED_MAX m/s. */
const APEX_MIN = 4.4;
const APEX_MAX = 7.2;
const SPEED_MIN = 4.5;
const SPEED_MAX = 7.5;
/** Le plateau argenté monte tout droit, en dérivant un peu d'un côté. */
const SILVER_APEX = 7.4;
const SILVER_DRIFT = 1.2;
/** Après le dernier plateau, la partie finit au bout de ce temps (secondes). */
const END_PAUSE = 1.5;
/** Le stick ou les flèches ne changent de zone qu'au-delà de cette inclinaison. */
const AIM_DEAD_ZONE = 0.5;
/** La souris choisit la zone la plus proche, à cette distance au plus (mètres). */
const POINT_REACH = 3.5;

/** Un plateau : à qui il est (null : l'argenté, commun), d'où et comment il part. */
export type ClayDisc = {
  id: number;
  owner: PlayerId | null;
  launchAt: number;
  x0: number;
  vx: number;
  vy: number;
  /** Le pas où il a été cassé, et par qui ; null s'il vole encore ou est retombé. */
  brokenAt: number | null;
  brokenBy: PlayerId[];
};

export type ClayShooter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  points: number;
  shells: number;
  aim: ClayZone;
  /** Son dernier tir (le pas, et la zone visée), pour le client ; null avant. */
  shotAt: number | null;
  shotZone: ClayZone | null;
  held: boolean;
};

export type ClayState = {
  tick: number;
  practice: boolean;
  seed: number;
  discs: ClayDisc[];
  /** La volée en cours (0 avant la première), et le pas où part la suivante. */
  volley: number;
  nextVolleyAt: number;
  fighters: ClayShooter[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

/** Où est le plateau à ce pas (fraction comprise), dans le plan du ciel. */
export function discPosition(disc: ClayDisc, tick: number): { x: number; y: number } {
  const time = Math.max(0, tick - disc.launchAt) * ARENA_STEP;
  return {
    x: disc.x0 + disc.vx * time,
    y: LAUNCHER_Y + disc.vy * time - 0.5 * GRAVITY * time * time,
  };
}

/** Le plateau est en l'air (parti, ni cassé ni retombé). */
export function isFlying(disc: ClayDisc, tick: number): boolean {
  return disc.brokenAt === null && tick >= disc.launchAt && discPosition(disc, tick).y > 0;
}

export function isInZone(point: { x: number; y: number }, zone: ClayZone): boolean {
  const center = ZONES[zone];
  return Math.hypot(point.x - center.x, point.y - center.y) <= ZONE_RADIUS;
}

/** Le pas où un plateau passe au plus près du centre d'une zone, s'il la traverse ; sinon null. */
export function zoneCrossing(disc: ClayDisc, zone: ClayZone): number | null {
  let best: { tick: number; gap: number } | null = null;
  for (let tick = disc.launchAt; ; tick++) {
    const point = discPosition(disc, tick);
    if (point.y < 0) break;
    const center = ZONES[zone];
    const gap = Math.hypot(point.x - center.x, point.y - center.y);
    if (gap <= ZONE_RADIUS && (!best || gap < best.gap)) best = { tick, gap };
  }
  return best?.tick ?? null;
}

/**
 * Le plateau de la volée `volley` pour le joueur de gauche (`side` 1) ou de droite (-1, en
 * miroir) : au hasard de la partie, mais toujours par au moins une zone.
 */
function playerDisc(
  seed: number,
  volley: number,
  side: 1 | -1,
  launchAt: number,
  owner: PlayerId,
  id: number,
): ClayDisc {
  for (let attempt = 0; ; attempt++) {
    const key = `${seed}:clay:${volley}:${attempt}`;
    const apex = APEX_MIN + hashUnit(`${key}:apex`) * (APEX_MAX - APEX_MIN);
    const speed = SPEED_MIN + hashUnit(`${key}:speed`) * (SPEED_MAX - SPEED_MIN);
    const disc: ClayDisc = {
      id,
      owner,
      launchAt,
      x0: -side * LAUNCHER_X,
      vx: side * speed,
      vy: Math.sqrt(2 * GRAVITY * (apex - LAUNCHER_Y)),
      brokenAt: null,
      brokenBy: [],
    };
    const isReachable = (['left', 'up', 'right'] as const).some(
      (zone) => zoneCrossing(disc, zone) !== null,
    );
    if (isReachable || attempt >= 20) return disc;
  }
}

function silverDisc(seed: number, volley: number, launchAt: number, id: number): ClayDisc {
  const side = hashUnit(`${seed}:silver:${volley}:side`) < 0.5 ? 1 : -1;
  return {
    id,
    owner: null,
    launchAt,
    x0: 0,
    vx: side * SILVER_DRIFT,
    vy: Math.sqrt(2 * GRAVITY * (SILVER_APEX - LAUNCHER_Y)),
    brokenAt: null,
    brokenBy: [],
  };
}

/** Les volées qui ont un plateau argenté (au hasard de la partie, jamais la première). */
function silverVolleys(seed: number): Set<number> {
  const chosen = new Set<number>();
  for (let k = 0; chosen.size < SILVER_COUNT && k < 100; k++) {
    chosen.add(1 + Math.floor(hashUnit(`${seed}:silver:${k}`) * (CLAY_VOLLEYS - 1)));
  }
  return chosen;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): ClayState {
  return {
    tick: 0,
    practice,
    seed,
    discs: [],
    volley: 0,
    nextVolleyAt: steps(FIRST_VOLLEY),
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      points: 0,
      shells: SHELLS,
      aim: 'up',
      shotAt: null,
      shotZone: null,
      held: false,
    })),
  };
}

/** Lance la volée suivante : un plateau par joueur, en miroir, et l'argenté si c'en est une. */
function launchVolley(state: ClayState, tick: number): void {
  const volley = state.volley + 1;
  let id = state.discs.reduce((most, disc) => Math.max(most, disc.id + 1), 0);
  state.fighters.forEach((fighter, index) => {
    state.discs.push(
      playerDisc(state.seed, volley, index % 2 === 0 ? 1 : -1, tick, fighter.id, id),
    );
    id += 1;
    fighter.shells = SHELLS;
  });
  // Au bac à sable, une volée sur trois a son argenté.
  const isSilver = state.practice ? volley % 3 === 0 : silverVolleys(state.seed).has(volley - 1);
  if (isSilver) {
    const offset =
      SILVER_OFFSET_MIN +
      hashUnit(`${state.seed}:silver-at:${volley}`) * (SILVER_OFFSET_MAX - SILVER_OFFSET_MIN);
    state.discs.push(silverDisc(state.seed, volley, tick + steps(offset), id));
  }
  state.volley = volley;
  const gap =
    VOLLEY_GAP_MIN + hashUnit(`${state.seed}:gap:${volley}`) * (VOLLEY_GAP_MAX - VOLLEY_GAP_MIN);
  state.nextVolleyAt = tick + steps(gap);
}

/** La zone où vise cette commande : une direction (bas ne change rien), sinon la souris. */
export function clayAimOf(input: ArenaInput, current: ClayZone): ClayZone {
  const { x, z } = input.move;
  if (Math.abs(x) >= AIM_DEAD_ZONE && Math.abs(x) >= -z) return x < 0 ? 'left' : 'right';
  if (z <= -AIM_DEAD_ZONE) return 'up';
  // La souris vise dans le plan du ciel : le point reçu y porte la hauteur dans `z`.
  const point = input.point;
  if (!point) return current;
  const nearest = (['left', 'up', 'right'] as const)
    .map((zone) => ({ zone, gap: Math.hypot(point.x - ZONES[zone].x, point.z - ZONES[zone].y) }))
    .sort((a, b) => a.gap - b.gap)[0];
  return nearest && nearest.gap <= POINT_REACH ? nearest.zone : current;
}

function step(state: ClayState, inputs: Partial<Record<PlayerId, ArenaInput>>): ClayState {
  const tick = state.tick + 1;
  const next: ClayState = {
    ...state,
    tick,
    discs: state.discs.map((disc) => ({ ...disc })),
    fighters: state.fighters.map((fighter) => ({ ...fighter })),
  };
  const isLastDone = !state.practice && state.volley >= CLAY_VOLLEYS;
  if (tick >= next.nextVolleyAt && !isLastDone) launchVolley(next, tick);
  // Les tirs de ce pas, puis ce qu'ils cassent (deux sur l'argenté au même pas : 1 point chacun).
  const silverHits = new Map<number, PlayerId[]>();
  for (const fighter of next.fighters) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    fighter.aim = clayAimOf(input, fighter.aim);
    const isPress = input.primary && !fighter.held;
    fighter.held = input.primary;
    if (!isPress || fighter.shells <= 0) continue;
    fighter.shells -= 1;
    fighter.shotAt = tick;
    fighter.shotZone = fighter.aim;
    for (const disc of next.discs) {
      const isMine = disc.owner === fighter.id || disc.owner === null;
      if (!isMine || !isFlying(disc, tick) || !isInZone(discPosition(disc, tick), fighter.aim))
        continue;
      if (disc.owner === null)
        silverHits.set(disc.id, [...(silverHits.get(disc.id) ?? []), fighter.id]);
      else {
        Object.assign(disc, { brokenAt: tick, brokenBy: [fighter.id] });
        fighter.points += 1;
      }
    }
  }
  for (const [id, shooters] of silverHits) {
    const disc = next.discs.find((one) => one.id === id);
    if (!disc) continue;
    Object.assign(disc, { brokenAt: tick, brokenBy: shooters });
    const points = shooters.length === 1 ? SILVER_POINTS : 1;
    for (const fighter of next.fighters)
      if (shooters.includes(fighter.id)) fighter.points += points;
  }
  // Les plateaux finis depuis un moment s'en vont (le client a montré leurs éclats).
  next.discs = next.discs.filter((disc) => tick - disc.launchAt < steps(8));
  return next;
}

/** Toutes les volées sont parties, et plus rien ne vole depuis un moment. */
function isOver(state: ClayState): boolean {
  if (state.practice || state.volley < CLAY_VOLLEYS) return false;
  const lastEnd = Math.max(
    0,
    ...state.discs.map((disc) => {
      if (disc.brokenAt !== null) return disc.brokenAt;
      // Le pas où il retombe.
      let tick = disc.launchAt;
      while (discPosition(disc, tick).y > 0) tick += 1;
      return tick;
    }),
  );
  return state.tick >= lastEnd + steps(END_PAUSE);
}

/** Le classement aux points ; à égalité, ex aequo (les dés départagent). */
function ranking(state: ClayState): PlayerId[][] {
  const byPoints = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    byPoints.set(fighter.points, [...(byPoints.get(fighter.points) ?? []), fighter.id]);
  }
  return [...byPoints.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/**
 * Le bot vise une zone que son plateau traverse (le Facile se trompe parfois de zone), et tire
 * quand le plateau y passe au plus près, avec une erreur de timing selon son niveau (tirée une
 * fois par plateau et par cartouche). Raté, il retente avec sa seconde cartouche si le plateau
 * traverse encore une zone. Un plateau argenté en l'air, il le vise d'abord (plus ou moins
 * souvent selon son niveau) s'il passe avant le sien.
 */
const TIMING: Record<BotLevel, number> = { easy: 0.13, normal: 0.08, expert: 0.05 };
const WRONG_ZONE: Record<BotLevel, number> = { easy: 0.15, normal: 0.06, expert: 0.02 };
const SILVER_GREED: Record<BotLevel, number> = { easy: 0.3, normal: 0.6, expert: 0.85 };
const LATE_REACH = steps(0.2);

function botInput(state: ClayState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me) return IDLE_INPUT;
  const target = botTarget(state, me, level);
  if (!target) return IDLE_INPUT;
  const move =
    target.zone === 'up' ? { x: 0, z: -1 } : { x: target.zone === 'left' ? -1 : 1, z: 0 };
  const key = `${state.seed}:${player}:${target.disc.id}:${me.shells}`;
  const error = steps((hashUnit(key) * 2 - 1) * TIMING[level]);
  const isTime = state.tick + 1 >= target.at + error;
  return {
    move,
    primary: isTime && me.aim === target.zone && me.shells > 0 && !me.held,
    secondary: false,
  };
}

/** Le plateau et la zone que vise le bot, et le pas où il y passe au plus près ; null s'il n'a rien à viser. */
function botTarget(
  state: ClayState,
  me: ClayShooter,
  level: BotLevel,
): { disc: ClayDisc; zone: ClayZone; at: number } | null {
  const options: { disc: ClayDisc; zone: ClayZone; at: number }[] = [];
  for (const disc of state.discs) {
    if (disc.owner !== me.id && disc.owner !== null) continue;
    if (disc.brokenAt !== null || discPosition(disc, state.tick).y < 0) continue;
    if (
      disc.owner === null &&
      hashUnit(`${state.seed}:${me.id}:greed:${disc.id}`) >= SILVER_GREED[level]
    )
      continue;
    for (const zone of ['left', 'up', 'right'] as const) {
      const at = zoneCrossing(disc, zone);
      // Un passage tout juste dépassé compte encore : un bot en retard tire après lui.
      if (at !== null && at + LATE_REACH >= state.tick) options.push({ disc, zone, at });
    }
  }
  const next = options.sort((a, b) => a.at - b.at)[0];
  if (!next) return null;
  if (hashUnit(`${state.seed}:${me.id}:wrong:${next.disc.id}`) < WRONG_ZONE[level]) {
    const wrong = (['left', 'up', 'right'] as const).find((zone) => zone !== next.zone) ?? 'up';
    return { ...next, zone: wrong };
  }
  return next;
}

export const CLAY_SHOOT: ArenaGame<ClayState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
