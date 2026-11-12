import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
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
  isClearLine,
  isWalkable,
  keepInOffice,
  opennessAt,
  pathDistance,
  pathToward,
  START_SPOTS,
} from './office';

// Patate explosive (02-mini-jeux.md, fiche 5 reprise) : une bombe tombe sur quelqu'un au hasard
// dans un bureau du Plateau en désordre ; on la refile en touchant quelqu'un. Son décompte se voit
// au-dessus d'elle, mais les dernières secondes sont brouillées : elle saute un peu avant ou un
// peu après le zéro, et l'heure exacte n'est connue que de l'hôte (`viewFor`). Son porteur est
// éliminé ; une autre bombe tombe, à la mèche plus courte. Tant qu'il reste au moins
// TWO_BOMBS_FROM joueurs, il y en a deux à la fois. Le dernier en vie gagne. Chacun a une ruée
// (Espace / A) : pour attraper quelqu'un à bout de bras, ou pour fuir.

/** Le porteur d'une bombe court un peu plus vite que les autres : il peut rattraper. */
const HOLDER: BodyTuning = { ...WALKER, walkSpeed: 5 };
/** La ruée : une poussée brève (environ 2 m, freinage compris), puis une recharge. */
const RUSH_SPEED = 11;
export const RUSH_TIME = 0.16;
export const RUSH_COOLDOWN = 2;
/** On refile la bombe dès qu'on se touche (un peu plus loin que les corps qui se frôlent). */
const PASS_REACH = WALKER.radius * 2 + 0.15;
/** Celui qui vient de la refiler ne peut pas la reprendre tout de suite. */
export const PASS_SHIELD = 1;

/** La première bombe tombe après tant de secondes, puis chaque nouvelle après une explosion. */
const FIRST_DROP = 1.5;
const DROP_PAUSE = 1.5;
/** Elle met tant de secondes à tomber du plafond : on ne peut pas la refiler avant. */
export const BOMB_FALL = 0.6;
/**
 * Le décompte affiché d'une bombe : FUSE_FIRST secondes pour la première, FUSE_STEP de moins à
 * chaque joueur éliminé, jamais moins de FUSE_MIN. Une partie dure ainsi de 50 à 80 s.
 */
const FUSE_FIRST = 20;
const FUSE_STEP = 2.5;
const FUSE_MIN = 10;
/**
 * À SCRAMBLE secondes du zéro, le décompte se brouille ; elle saute entre SCRAMBLE_EARLY avant le
 * zéro et SCRAMBLE_LATE après (de 1 à 4 s après le brouillage) : on sait quand paniquer, pas la
 * seconde exacte.
 */
export const SCRAMBLE = 3;
const SCRAMBLE_EARLY = 2;
const SCRAMBLE_LATE = 1;
/** Deux bombes à la fois tant qu'il reste au moins ce nombre de joueurs. */
const TWO_BOMBS_FROM = 5;
/** Le souffle : ceux qui sont à moins de tant de mètres sont projetés au sol (pas éliminés). */
export const BLAST_RADIUS = 2.6;
const BLAST_SPEED = 7;
const BLAST_DOWN = 0.7;
/** Une bombe qui a sauté reste dans l'état ce temps-là : le client montre l'explosion. */
const BLAST_KEPT = 1.5;
/** Au bac à sable : une mèche courte, et l'on n'est pas éliminé (on est projeté). */
const PRACTICE_FUSE = 8;

export type PotatoFighter = ArenaBody & {
  /** Le pas où sa bombe a sauté (éliminé), ou null. */
  fellAt: number | null;
  /** Secondes restantes de ruée, et avant la suivante. */
  dashing: number;
  dashReady: number;
  /** La touche tenue au pas précédent : la ruée part quand on appuie, pas en tenant. */
  held: boolean;
  /** Le pas jusqu'où il ne peut pas recevoir de bombe (il vient d'en refiler une). */
  shieldUntil: number;
};

export type PotatoBomb = {
  id: number;
  holder: PlayerId;
  /** Le pas où elle a commencé à tomber sur son premier porteur. */
  droppedAt: number;
  /** Le pas où son décompte affiché arrive à zéro (public). */
  zeroAt: number;
  /** Le pas où elle saute vraiment : connu de l'hôte seul (null dans la vue des joueurs). */
  explodeAt: number | null;
  /** Sa dernière passe : le pas et celui qui l'a refilée, ou null (pour le dessin et le son). */
  passedAt: number | null;
  passedFrom: PlayerId | null;
  /** Le pas où elle a sauté, et où ; null tant qu'elle tient. */
  explodedAt: number | null;
  x: number;
  z: number;
};

export type PotatoState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: PotatoFighter[];
  bombs: PotatoBomb[];
  /** Le pas où tombent les prochaines bombes, ou null s'il y en a assez. */
  nextDropAt: number | null;
  /** Combien de bombes sont déjà tombées. */
  dropped: number;
};

/** Les secondes affichées sur une bombe (null : brouillé). */
export function shownFuse(bomb: PotatoBomb, tick: number): number | null {
  const left = (bomb.zeroAt - tick) * ARENA_STEP;
  return left > SCRAMBLE ? Math.ceil(left) : null;
}

/** La bombe de ce joueur, s'il en a une qui tient encore. */
export function bombOf(state: PotatoState, id: PlayerId): PotatoBomb | undefined {
  return state.bombs.find((bomb) => bomb.holder === id && bomb.explodedAt === null);
}

function steps(seconds: number): number {
  return Math.round(seconds / ARENA_STEP);
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): PotatoState {
  return {
    tick: 0,
    practice,
    seed,
    bombs: [],
    nextDropAt: steps(practice ? 0.5 : FIRST_DROP),
    dropped: 0,
    fighters: players.map((id, index) => {
      const spot = START_SPOTS[index % START_SPOTS.length] ?? { x: 0, z: 4 };
      // Chacun regarde le milieu de la salle.
      const body = createBody(id, spot.x, spot.z, Math.atan2(-spot.x, -spot.z));
      return { ...body, fellAt: null, dashing: 0, dashReady: 0, held: false, shieldUntil: 0 };
    }),
  };
}

function alive(state: PotatoState): PotatoFighter[] {
  return state.fighters.filter((fighter) => fighter.fellAt === null);
}

function step(state: PotatoState, inputs: Partial<Record<PlayerId, ArenaInput>>): PotatoState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  let bombs = state.bombs.map((bomb) => ({ ...bomb }));
  const standing = fighters.filter((fighter) => fighter.fellAt === null);
  const holders = new Set(bombs.filter((bomb) => bomb.explodedAt === null).map((b) => b.holder));
  for (const fighter of standing) {
    act(fighter, inputs[fighter.id] ?? IDLE_INPUT, holders.has(fighter.id) ? HOLDER : WALKER, dt);
  }
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas (pawnSumo.ts).
  const shift = tick % Math.max(1, standing.length);
  const order = [...standing.slice(shift), ...standing.slice(0, shift)];
  collideBodies(order, WALKER, new Set());
  moveBodies(standing, WALKER, dt);
  for (const fighter of standing) keepInOffice(fighter, WALKER.radius);
  passBombs(bombs, order, tick);
  const next: PotatoState = { ...state, tick, fighters, bombs };
  bombs = explode(next, tick);
  next.bombs = bombs.filter(
    (bomb) => bomb.explodedAt === null || tick - bomb.explodedAt < steps(BLAST_KEPT),
  );
  dropBombs(next, tick);
  return next;
}

/** Les commandes d'un joueur : marcher, et la ruée. */
function act(fighter: PotatoFighter, input: ArenaInput, tuning: BodyTuning, dt: number): void {
  const pressed = input.primary && !fighter.held;
  fighter.held = input.primary;
  fighter.dashReady = Math.max(0, fighter.dashReady - dt);
  if (fighter.dashing > 0) {
    // Lancé : il ne freine ni ne tourne.
    fighter.dashing = Math.max(0, fighter.dashing - dt);
    return;
  }
  if (pressed && fighter.dashReady <= 0 && isSteady(fighter)) {
    const isMoving = Math.hypot(input.move.x, input.move.z) > 0.1;
    if (isMoving) fighter.facing = Math.atan2(input.move.x, input.move.z);
    fighter.dashing = RUSH_TIME;
    fighter.dashReady = RUSH_COOLDOWN;
    fighter.vx = Math.sin(fighter.facing) * RUSH_SPEED;
    fighter.vz = Math.cos(fighter.facing) * RUSH_SPEED;
    return;
  }
  walkBody(fighter, input.move, tuning, dt);
}

/**
 * Chaque porteur refile sa bombe au plus proche qu'il touche : pas à un autre porteur, ni à
 * celui qui vient de la lui refiler. Une bombe ne change de main qu'une fois par pas.
 */
function passBombs(bombs: PotatoBomb[], fighters: PotatoFighter[], tick: number): void {
  for (const bomb of bombs) {
    if (bomb.explodedAt !== null || tick - bomb.droppedAt < steps(BOMB_FALL)) continue;
    const holder = fighters.find((fighter) => fighter.id === bomb.holder);
    if (!holder) continue;
    let closest: { fighter: PotatoFighter; gap: number } | null = null;
    for (const other of fighters) {
      if (other === holder || other.shieldUntil > tick) continue;
      if (bombs.some((one) => one.explodedAt === null && one.holder === other.id)) continue;
      const gap = Math.hypot(other.x - holder.x, other.z - holder.z);
      if (gap <= PASS_REACH && (!closest || gap < closest.gap)) closest = { fighter: other, gap };
    }
    if (!closest) continue;
    holder.shieldUntil = tick + steps(PASS_SHIELD);
    bomb.passedFrom = holder.id;
    bomb.holder = closest.fighter.id;
    bomb.passedAt = tick;
  }
}

/** Les bombes dont c'est l'heure sautent : leur porteur est éliminé, les voisins projetés. */
function explode(state: PotatoState, tick: number): PotatoBomb[] {
  return state.bombs.map((bomb) => {
    if (bomb.explodedAt !== null || bomb.explodeAt === null || tick < bomb.explodeAt) return bomb;
    const holder = state.fighters.find((fighter) => fighter.id === bomb.holder);
    if (!holder) return bomb;
    for (const other of state.fighters) {
      if (other.fellAt !== null) continue;
      const dx = other.x - holder.x;
      const dz = other.z - holder.z;
      const gap = Math.hypot(dx, dz);
      if (gap > BLAST_RADIUS) continue;
      const nx = gap > 0 ? dx / gap : Math.sin(other.facing);
      const nz = gap > 0 ? dz / gap : Math.cos(other.facing);
      knockDown(other, nx, nz, BLAST_SPEED * (1 - gap / (BLAST_RADIUS * 1.5)), BLAST_DOWN);
      other.dashing = 0;
    }
    if (!state.practice) holder.fellAt = tick;
    state.nextDropAt ??= tick + steps(DROP_PAUSE);
    return { ...bomb, explodedAt: tick, x: holder.x, z: holder.z };
  });
}

/** Combien de bombes à la fois pour autant de joueurs encore là. */
function bombsFor(players: number): number {
  return players >= TWO_BOMBS_FROM ? 2 : players >= 2 ? 1 : 0;
}

/** À l'heure, de nouvelles bombes tombent sur des joueurs tirés au hasard, jusqu'au compte. */
function dropBombs(state: PotatoState, tick: number): void {
  if (state.nextDropAt === null || tick < state.nextDropAt) return;
  state.nextDropAt = null;
  const standing = alive(state);
  const live = state.bombs.filter((bomb) => bomb.explodedAt === null);
  const wanted = state.practice ? 1 : bombsFor(standing.length);
  const eliminated = state.fighters.length - standing.length;
  const fuse = state.practice
    ? PRACTICE_FUSE
    : Math.max(FUSE_MIN, FUSE_FIRST - FUSE_STEP * eliminated);
  for (let count = live.length; count < wanted; count++) {
    const free = standing.filter(
      (fighter) =>
        !state.bombs.some((bomb) => bomb.explodedAt === null && bomb.holder === fighter.id),
    );
    const id = state.dropped;
    // Au bac à sable, la première tombe sur toi : on s'entraîne à la refiler.
    const pick =
      state.practice && id === 0 ? 0 : Math.floor(forestUnit(state.seed, id, 1) * free.length);
    const target = free[Math.min(free.length - 1, pick)];
    if (!target) return;
    const zeroAt = tick + steps(BOMB_FALL + fuse);
    const offset =
      -SCRAMBLE_EARLY + forestUnit(state.seed, id, 2) * (SCRAMBLE_EARLY + SCRAMBLE_LATE);
    state.bombs = [
      ...state.bombs,
      {
        id,
        holder: target.id,
        droppedAt: tick,
        zeroAt,
        explodeAt: zeroAt + steps(offset),
        passedAt: null,
        passedFrom: null,
        explodedAt: null,
        x: target.x,
        z: target.z,
      },
    ];
    state.dropped = id + 1;
  }
}

/** L'heure exacte de l'explosion reste chez l'hôte : les joueurs n'ont que le décompte. */
function viewFor(state: PotatoState, _viewer: Viewer): PotatoState {
  return {
    ...state,
    bombs: state.bombs.map((bomb) =>
      bomb.explodedAt === null ? { ...bomb, explodeAt: null } : bomb,
    ),
  };
}

function isOver(state: PotatoState): boolean {
  return !state.practice && state.fighters.length > 1 && alive(state).length <= 1;
}

/** Le dernier en vie, puis les éliminés du dernier au premier ; sautés au même pas : ex aequo. */
function ranking(state: PotatoState): PlayerId[][] {
  const survivors = alive(state).map((fighter) => fighter.id);
  const out = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    if (fighter.fellAt === null) continue;
    out.set(fighter.fellAt, [...(out.get(fighter.fellAt) ?? []), fighter.id]);
  }
  const byOut = [...out.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return [...(survivors.length > 0 ? [survivors] : []), ...byOut];
}

// Le bot (02-mini-jeux.md, fiche 5) : porteur, il court après le plus proche par le plus court
// chemin et se rue sur lui à bout de bras ; sinon, il fuit les porteurs en gardant de la place
// autour de lui (pas dans un coin), et se rue de côté quand un porteur arrive sur lui. Il ne
// connaît que ce que voit un joueur : le décompte, pas l'heure exacte.

/** Il vise sa course avec tant d'écart au hasard (radians). */
const AIM_NOISE: Record<BotLevel, number> = { easy: 0.7, normal: 0.35, expert: 0.12 };
/** Il anticipe la course de celui qu'il chasse de tant de secondes. */
const LEAD: Record<BotLevel, number> = { easy: 0, normal: 0.25, expert: 0.45 };
/** Sa chance, à chaque pas, de se ruer quand c'est le moment (il hésite plus ou moins). */
const DASH_EAGERNESS: Record<BotLevel, number> = { easy: 0.04, normal: 0.12, expert: 0.3 };
/** Il commence à fuir un porteur à moins de tant de mètres de chemin. */
const ALERT: Record<BotLevel, number> = { easy: 4.5, normal: 6.5, expert: 9 };
/** Le poids de la place autour de lui dans sa fuite (ne pas finir dans un coin). */
const ROOM_WEIGHT: Record<BotLevel, number> = { easy: 0, normal: 2.5, expert: 5 };
/** Il se rue sur sa proie à moins de tant de mètres, et pour fuir un porteur à moins de tant. */
const DASH_CATCH = 2.2;
const DASH_ESCAPE = 1.7;
/** Les directions qu'il essaie pour fuir, et jusqu'où il regarde dans chacune. */
const FLEE_DIRECTIONS = 16;
const FLEE_LOOK = 1.5;

function botInput(state: PotatoState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.fellAt !== null || !isSteady(me) || me.dashing > 0) return IDLE_INPUT;
  const others = alive(state).filter((fighter) => fighter.id !== player);
  const noise = (rng.next() - 0.5) * AIM_NOISE[level];
  if (bombOf(state, player)) return chase(state, me, others, level, rng, noise);
  return flee(state, me, others, level, rng, noise);
}

function chase(
  state: PotatoState,
  me: PotatoFighter,
  others: PotatoFighter[],
  level: BotLevel,
  rng: Rng,
  noise: number,
): ArenaInput {
  const prey = others
    .filter((other) => other.shieldUntil <= state.tick && !bombOf(state, other.id))
    .map((other) => ({ other, gap: pathDistance(me, other) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (!prey) return IDLE_INPUT;
  const { other } = prey;
  const lead = LEAD[level] * Math.min(1, prey.gap / 4);
  const aim = { x: other.x + other.vx * lead, z: other.z + other.vz * lead };
  const way = pathToward(me, isWalkable(aim.x, aim.z) ? aim : other);
  if (!way) return IDLE_INPUT;
  const move = rotate(way, noise);
  const isClose = Math.hypot(other.x - me.x, other.z - me.z) < DASH_CATCH;
  const wantsDash =
    isClose && me.dashReady <= 0 && isClearLine(me, other) && rng.chance(DASH_EAGERNESS[level]);
  return { move, primary: wantsDash, secondary: false };
}

function flee(
  state: PotatoState,
  me: PotatoFighter,
  others: PotatoFighter[],
  level: BotLevel,
  rng: Rng,
  noise: number,
): ArenaInput {
  const holders = others.filter((other) => bombOf(state, other.id));
  const isShielded = me.shieldUntil > state.tick;
  const threats = holders
    .map((holder) => ({ holder, gap: pathDistance(me, holder) }))
    .filter(({ gap }) => gap < ALERT[level] * (isShielded ? 0.5 : 1));
  if (threats.length === 0) {
    // Personne en vue : il se met au large, là où l'on a de la place.
    return { move: rotate(roomiest(me), noise), primary: false, secondary: false };
  }
  // Chaque direction : la distance de chemin aux porteurs depuis là, plus la place qu'il y a.
  let best: { x: number; z: number } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < FLEE_DIRECTIONS; k++) {
    const angle = (k / FLEE_DIRECTIONS) * Math.PI * 2;
    const dir = { x: Math.sin(angle), z: Math.cos(angle) };
    const spot = { x: me.x + dir.x * FLEE_LOOK, z: me.z + dir.z * FLEE_LOOK };
    if (!isWalkable(spot.x, spot.z) || !isClearLine(me, spot)) continue;
    const away = Math.min(...threats.map(({ holder }) => pathDistance(holder, spot)));
    const score = away + ROOM_WEIGHT[level] * opennessAt(spot.x, spot.z);
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  if (!best) return IDLE_INPUT;
  const closest = Math.min(
    ...threats.map(({ holder }) => Math.hypot(holder.x - me.x, holder.z - me.z)),
  );
  const wantsDash = closest < DASH_ESCAPE && me.dashReady <= 0 && rng.chance(DASH_EAGERNESS[level]);
  return { move: rotate(best, noise), primary: wantsDash, secondary: false };
}

/** La direction, parmi quelques-unes, vers le plus de place autour (il se met au large). */
function roomiest(me: PotatoFighter): { x: number; z: number } {
  let best = { x: 0, z: 0 };
  let bestRoom = opennessAt(me.x, me.z) + 0.05;
  for (let k = 0; k < 8; k++) {
    const angle = (k / 8) * Math.PI * 2;
    const spot = { x: me.x + Math.sin(angle) * 1.5, z: me.z + Math.cos(angle) * 1.5 };
    if (!isWalkable(spot.x, spot.z)) continue;
    const room = opennessAt(spot.x, spot.z);
    if (room > bestRoom) {
      bestRoom = room;
      best = { x: Math.sin(angle) * 0.5, z: Math.cos(angle) * 0.5 };
    }
  }
  return best;
}

function rotate(dir: { x: number; z: number }, angle: number): { x: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: dir.x * cos + dir.z * sin, z: -dir.x * sin + dir.z * cos };
}

export const HOT_POTATO: ArenaGame<PotatoState> = {
  create,
  step,
  botInput,
  isOver,
  // Pas de chrono : chaque bombe élimine quelqu'un, la partie finit toujours.
  timeLeft: () => null,
  ranking,
  viewFor,
};
