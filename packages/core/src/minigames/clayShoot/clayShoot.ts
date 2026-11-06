import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Ball-trap (02-mini-jeux.md, fiche 45, ton idée), un duel (et une finale à deux). Chacun sa
// moitié du ciel : à chaque volée, un plateau part dans la sienne (le même en miroir chez
// l'autre, au même moment), lancé à plat, à des moments et d'endroits qu'on ne peut pas
// prévoir. On vise librement (souris, stick ou flèches) avec un viseur de la taille d'un
// plateau, qui ne sort pas de sa moitié (jusqu'au milieu, où passent les argentés), et on tire :
// la gerbe arrive un instant après, au point visé (il faut viser un peu devant un plateau
// rapide). Deux cartouches, puis une seconde pour recharger. Un plateau argenté, commun, passe de
// temps en temps au milieu : le premier qui le casse marque 2 points. Tout se joue dans le plan
// du ciel, face à la caméra : x à droite, y en haut, en mètres.

/** Les volées, et l'écart au hasard entre deux (secondes). La première part à FIRST_VOLLEY. */
export const CLAY_VOLLEYS = 10;
const FIRST_VOLLEY = 2;
const VOLLEY_GAP_MIN = 2.2;
const VOLLEY_GAP_MAX = 3.4;
/** Les plateaux argentés : combien, et leur décalage au hasard sur leur volée (secondes). */
export const SILVER_COUNT = 3;
const SILVER_OFFSET_MIN = -0.3;
const SILVER_OFFSET_MAX = 0.8;
export const SILVER_POINTS = 2;
/** Le fusil : deux cartouches, puis CLAY_RELOAD_TIME secondes pour recharger. */
export const SHELLS = 2;
export const CLAY_RELOAD_TIME = 1;
/** La gerbe arrive au point visé SHOT_DELAY secondes après le tir. */
export const SHOT_DELAY = 0.1;
/** Le rayon d'un plateau, et la marge de la gerbe autour : touché à cette distance du point visé. */
export const DISC_RADIUS = 0.35;
export const HIT_RADIUS = 0.5;
/**
 * Le ciel : sa demi-largeur et ses hauteurs (le viseur y reste). Plus bas que SKY_BOTTOM, les
 * stands et la haie du premier plan le cachent.
 */
export const SKY_HALF_WIDTH = 9;
export const SKY_BOTTOM = 1.8;
export const SKY_TOP = 8;
/** Chaque viseur va de son bord jusqu'à MIDDLE_REACH au-delà du milieu (là où passent les argentés). */
export const MIDDLE_REACH = 1.6;
/** Les plateaux planent : moins de pesanteur qu'une pierre. */
const GLIDE_GRAVITY = 4;
/** Après le dernier plateau, la partie finit au bout de ce temps (secondes). */
const END_PAUSE = 1.5;

/**
 * Un plateau : à qui il est (null : l'argenté, commun), d'où et comment il part. Il vole tant
 * qu'il est dans le ciel ; `brokenAt` : le pas où il a été cassé, et par qui.
 */
export type ClayDisc = {
  id: number;
  owner: PlayerId | null;
  launchAt: number;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  brokenAt: number | null;
  brokenBy: PlayerId[];
};

/** Un tir : le point visé, et les pas où il part et où la gerbe y arrive. */
export type ClayShot = { owner: PlayerId; x: number; y: number; firedAt: number; landsAt: number };

export type ClayShooter = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  points: number;
  shells: number;
  /** En train de recharger : le pas où le fusil sera prêt ; null sinon. */
  reloadedAt: number | null;
  /** Le viseur, dans le plan du ciel. */
  aimX: number;
  aimY: number;
  held: boolean;
  heldReload: boolean;
};

export type ClayState = {
  tick: number;
  practice: boolean;
  seed: number;
  discs: ClayDisc[];
  shots: ClayShot[];
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

const between = (key: string, min: number, max: number) => min + hashUnit(key) * (max - min);

/** Le côté d'un tireur : -1 la moitié gauche du ciel (le premier), 1 la droite. */
export function sideOf(state: ClayState, player: PlayerId): -1 | 1 {
  return state.fighters.findIndex((fighter) => fighter.id === player) % 2 === 0 ? -1 : 1;
}

/** Où peut aller le viseur de ce côté : sa moitié, jusqu'un peu au-delà du milieu. */
export function aimBounds(side: -1 | 1): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  return side < 0
    ? { minX: -SKY_HALF_WIDTH, maxX: MIDDLE_REACH, minY: SKY_BOTTOM, maxY: SKY_TOP }
    : { minX: -MIDDLE_REACH, maxX: SKY_HALF_WIDTH, minY: SKY_BOTTOM, maxY: SKY_TOP };
}

/** Où est le plateau à ce pas (fraction comprise), dans le plan du ciel. */
export function discPosition(disc: ClayDisc, tick: number): { x: number; y: number } {
  const time = Math.max(0, tick - disc.launchAt) * ARENA_STEP;
  return {
    x: disc.x0 + disc.vx * time,
    y: disc.y0 + disc.vy * time - 0.5 * GLIDE_GRAVITY * time * time,
  };
}

/** Le plateau est en l'air (parti, ni cassé ni sorti du ciel). */
export function isFlying(disc: ClayDisc, tick: number): boolean {
  if (disc.brokenAt !== null || tick < disc.launchAt) return false;
  const { x, y } = discPosition(disc, tick);
  return y > 0 && Math.abs(x) < SKY_HALF_WIDTH + 1.5;
}

/**
 * Le plateau de la volée pour un côté (le droit en miroir du gauche) : lancé à plat depuis le
 * bord, ou d'en bas, vers le milieu ; d'où, à quelle hauteur et à quelle vitesse, au hasard de
 * la partie (le même des deux côtés).
 */
function playerDisc(
  seed: number,
  volley: number,
  side: -1 | 1,
  launchAt: number,
  owner: PlayerId,
  id: number,
): ClayDisc {
  const key = `${seed}:clay:${volley}`;
  const mirror = (x: number) => (side < 0 ? x : -x);
  const flight = { id, owner, launchAt, brokenAt: null, brokenBy: [] };
  if (hashUnit(`${key}:below`) < 0.35) {
    // D'une fosse devant, il monte en travers du ciel.
    return {
      ...flight,
      x0: mirror(-between(`${key}:x`, 3, 7.5)),
      y0: 0.2,
      vx: mirror(between(`${key}:vx`, 1.5, 4)),
      vy: between(`${key}:vy`, 6.5, 8.5),
    };
  }
  // Du bord, à plat, il traverse sa moitié en montant un peu, puis plane et retombe. Assez haut
  // pour passer au-dessus des stands (retour de test : lancés trop bas, ils passaient derrière).
  return {
    ...flight,
    x0: mirror(-SKY_HALF_WIDTH - 1),
    y0: between(`${key}:y`, 2.8, 5),
    vx: mirror(between(`${key}:vx`, 6.5, 10)),
    vy: between(`${key}:vy`, 1.5, 4),
  };
}

/** L'argenté : il monte du milieu, en dérivant un peu d'un côté. */
function silverDisc(seed: number, volley: number, launchAt: number, id: number): ClayDisc {
  const key = `${seed}:silver:${volley}`;
  return {
    id,
    owner: null,
    launchAt,
    x0: between(`${key}:x`, -0.8, 0.8),
    y0: 0.2,
    vx: (hashUnit(`${key}:side`) < 0.5 ? 1 : -1) * between(`${key}:vx`, 0.3, 1.2),
    vy: between(`${key}:vy`, 7, 8.5),
    brokenAt: null,
    brokenBy: [],
  };
}

/** Les volées qui ont un plateau argenté (au hasard de la partie, jamais la première). */
function silverVolleys(seed: number): Set<number> {
  const chosen = new Set<number>();
  for (let k = 0; chosen.size < SILVER_COUNT && k < 100; k++) {
    chosen.add(2 + Math.floor(hashUnit(`${seed}:silver:${k}`) * (CLAY_VOLLEYS - 1)));
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
    shots: [],
    volley: 0,
    nextVolleyAt: steps(FIRST_VOLLEY),
    fighters: players.map((id, index) => ({
      id,
      fellAt: null,
      points: 0,
      shells: SHELLS,
      reloadedAt: null,
      // Au départ, au milieu de sa moitié.
      aimX: (index % 2 === 0 ? -1 : 1) * SKY_HALF_WIDTH * 0.45,
      aimY: 4,
      held: false,
      heldReload: false,
    })),
  };
}

/** Lance la volée suivante : un plateau par tireur, en miroir, et l'argenté si c'en est une. */
function launchVolley(state: ClayState, tick: number): void {
  const volley = state.volley + 1;
  let id = state.discs.reduce((most, disc) => Math.max(most, disc.id + 1), 0);
  for (const fighter of state.fighters) {
    const side = sideOf(state, fighter.id);
    state.discs.push(playerDisc(state.seed, volley, side, tick, fighter.id, id));
    id += 1;
  }
  // Au bac à sable, une volée sur trois a son argenté.
  const isSilver = state.practice ? volley % 3 === 0 : silverVolleys(state.seed).has(volley);
  if (isSilver) {
    const key = `${state.seed}:silver-at:${volley}`;
    const offset = between(key, SILVER_OFFSET_MIN, SILVER_OFFSET_MAX);
    state.discs.push(silverDisc(state.seed, volley, tick + steps(offset), id));
  }
  state.volley = volley;
  const gap = between(`${state.seed}:gap:${volley}`, VOLLEY_GAP_MIN, VOLLEY_GAP_MAX);
  state.nextVolleyAt = tick + steps(gap);
}

/** Le viseur suit le point reçu (souris, ou stick et flèches intégrés par le client), dans sa moitié. */
function aim(fighter: ClayShooter, input: ArenaInput, side: -1 | 1): void {
  const point = input.point;
  if (!point) return;
  const bounds = aimBounds(side);
  // Le point reçu porte la hauteur dans `z` (le plan du ciel).
  fighter.aimX = Math.max(bounds.minX, Math.min(bounds.maxX, point.x));
  fighter.aimY = Math.max(bounds.minY, Math.min(bounds.maxY, point.z));
}

/** Tirer (s'il a une cartouche et ne recharge pas), recharger à la demande ou fusil vide. */
function shoot(state: ClayState, fighter: ClayShooter, input: ArenaInput): void {
  const { tick } = state;
  if (fighter.reloadedAt !== null && tick >= fighter.reloadedAt) {
    fighter.shells = SHELLS;
    fighter.reloadedAt = null;
  }
  const isPress = input.primary && !fighter.held;
  const isReloadPress = input.secondary && !fighter.heldReload;
  fighter.held = input.primary;
  fighter.heldReload = input.secondary;
  if (fighter.reloadedAt === null && isPress && fighter.shells > 0) {
    fighter.shells -= 1;
    state.shots.push({
      owner: fighter.id,
      x: fighter.aimX,
      y: fighter.aimY,
      firedAt: tick,
      landsAt: tick + steps(SHOT_DELAY),
    });
  }
  const wantsReload = fighter.shells === 0 || (isReloadPress && fighter.shells < SHELLS);
  if (fighter.reloadedAt === null && wantsReload)
    fighter.reloadedAt = tick + steps(CLAY_RELOAD_TIME);
}

/** Les gerbes qui arrivent à ce pas : ce qu'elles cassent (deux sur l'argenté au même pas : 1 point chacun). */
function landShots(state: ClayState): void {
  const { tick } = state;
  const silverHits = new Map<number, PlayerId[]>();
  for (const shot of state.shots) {
    if (shot.landsAt !== tick) continue;
    for (const disc of state.discs) {
      const isMine = disc.owner === shot.owner || disc.owner === null;
      if (!isMine || !isFlying(disc, tick)) continue;
      const { x, y } = discPosition(disc, tick);
      if (Math.hypot(x - shot.x, y - shot.y) > HIT_RADIUS) continue;
      if (disc.owner === null) {
        silverHits.set(disc.id, [...(silverHits.get(disc.id) ?? []), shot.owner]);
        continue;
      }
      Object.assign(disc, { brokenAt: tick, brokenBy: [shot.owner] });
      const fighter = state.fighters.find((one) => one.id === shot.owner);
      if (fighter) fighter.points += 1;
    }
  }
  for (const [id, shooters] of silverHits) {
    const disc = state.discs.find((one) => one.id === id);
    if (!disc) continue;
    Object.assign(disc, { brokenAt: tick, brokenBy: shooters });
    const points = shooters.length === 1 ? SILVER_POINTS : 1;
    for (const fighter of state.fighters) {
      if (shooters.includes(fighter.id)) fighter.points += points;
    }
  }
}

function step(state: ClayState, inputs: Partial<Record<PlayerId, ArenaInput>>): ClayState {
  const tick = state.tick + 1;
  const next: ClayState = {
    ...state,
    tick,
    discs: state.discs.map((disc) => ({ ...disc })),
    // Un tir arrivé reste un instant : le client montre sa gerbe.
    shots: state.shots.filter((shot) => tick - shot.landsAt < steps(1)),
    fighters: state.fighters.map((fighter) => ({ ...fighter })),
  };
  const isLastDone = !state.practice && state.volley >= CLAY_VOLLEYS;
  if (tick >= next.nextVolleyAt && !isLastDone) launchVolley(next, tick);
  for (const fighter of next.fighters) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    aim(fighter, input, sideOf(next, fighter.id));
    shoot(next, fighter, input);
  }
  landShots(next);
  // Les plateaux finis depuis un moment s'en vont (le client a montré leurs éclats).
  next.discs = next.discs.filter((disc) => tick - disc.launchAt < steps(8));
  return next;
}

/** Le pas où un plateau a fini : cassé, ou sorti du ciel. */
function endOf(disc: ClayDisc): number {
  if (disc.brokenAt !== null) return disc.brokenAt;
  let tick = disc.launchAt;
  while (isFlying(disc, tick)) tick += 1;
  return tick;
}

/** Toutes les volées sont parties, et plus rien ne vole depuis un moment. */
function isOver(state: ClayState): boolean {
  if (state.practice || state.volley < CLAY_VOLLEYS) return false;
  const lastEnd = Math.max(0, ...state.discs.map(endOf));
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
 * Le bot vise comme un joueur au stick : il voit le plateau un temps après son départ, déplace
 * son viseur à une vitesse bornée vers l'endroit où le plateau sera quand la gerbe arrivera, et
 * tire dès qu'il est dessus, à son erreur près (tirée une fois par plateau et par cartouche).
 * Raté, il retire, ou attend la recharge. Un argenté en l'air, il le vise d'abord (plus ou moins
 * souvent selon son niveau).
 */
const REACTION: Record<BotLevel, number> = { easy: 0.35, normal: 0.25, expert: 0.17 };
const AIM_SPEED: Record<BotLevel, number> = { easy: 9, normal: 12, expert: 16 };
const AIM_ERROR: Record<BotLevel, number> = { easy: 0.8, normal: 0.7, expert: 0.55 };
const SILVER_GREED: Record<BotLevel, number> = { easy: 0.3, normal: 0.6, expert: 0.85 };
/** Il tire quand son viseur est à moins de ça (plus un pas de visée) du point voulu. */
const ON_TARGET = 0.15;

function botInput(state: ClayState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me) return IDLE_INPUT;
  const target = botTarget(state, me, level);
  const stay = { ...IDLE_INPUT, point: { x: me.aimX, z: me.aimY } };
  if (!target) return stay;
  const lead = steps(SHOT_DELAY) + 1;
  const key = `${state.seed}:${player}:${target.id}:${me.shells}`;
  const angle = hashUnit(`${key}:angle`) * Math.PI * 2;
  const miss = hashUnit(`${key}:miss`) * AIM_ERROR[level];
  const goal = discPosition(target, state.tick + lead);
  const wanted = { x: goal.x + Math.cos(angle) * miss, y: goal.y + Math.sin(angle) * miss };
  const gap = Math.hypot(wanted.x - me.aimX, wanted.y - me.aimY);
  const most = AIM_SPEED[level] * ARENA_STEP;
  const t = gap <= most ? 1 : most / gap;
  const point = { x: me.aimX + (wanted.x - me.aimX) * t, z: me.aimY + (wanted.y - me.aimY) * t };
  // Une gerbe encore en route : il attend de voir avant de retirer.
  const isWaiting = state.shots.some((shot) => shot.owner === player && shot.landsAt > state.tick);
  const canShoot = me.reloadedAt === null && me.shells > 0 && !me.held && !isWaiting;
  return { ...IDLE_INPUT, point, primary: canShoot && gap <= ON_TARGET + most };
}

/** Le plateau que le bot vise : un argenté s'il le veut, sinon le sien, vu et à sa portée. */
function botTarget(state: ClayState, me: ClayShooter, level: BotLevel): ClayDisc | null {
  const bounds = aimBounds(sideOf(state, me.id));
  const reaction = steps(REACTION[level]);
  const lead = steps(SHOT_DELAY) + 1;
  const targets = state.discs.filter((disc) => {
    if (disc.owner !== me.id && disc.owner !== null) return false;
    if (!isFlying(disc, state.tick + lead) || state.tick < disc.launchAt + reaction) return false;
    const greed = hashUnit(`${state.seed}:${me.id}:greed:${disc.id}`);
    if (disc.owner === null && greed >= SILVER_GREED[level]) return false;
    const { x, y } = discPosition(disc, state.tick + lead);
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  });
  return targets.find((disc) => disc.owner === null) ?? targets[0] ?? null;
}

export const CLAY_SHOOT: ArenaGame<ClayState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
};
