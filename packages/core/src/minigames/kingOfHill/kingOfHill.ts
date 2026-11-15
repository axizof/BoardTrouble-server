import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  type ArenaBody,
  type BodyTuning,
  collideBodies,
  createBody,
  isAirborne,
  isSteady,
  jumpBody,
  knockDown,
  moveBodies,
  WALKER,
  walkBody,
} from '../arena/body';
import { forestUnit } from '../offPiste/forest';
import {
  distanceToSpot,
  HILL_SPOTS,
  HILL_STARTS,
  type HillSpot,
  isInSpot,
  keepInRuins,
  nodeAt,
  ruinGround,
  WEAPON_SPOTS,
  wayToSpot,
} from './ruins';

// Roi de la colline (02-mini-jeux.md, fiche 4) : dans les ruines de la jungle (ruins.ts), une
// zone de lumière se pose sur un relief, y reste ZONE_TIME secondes, puis saute ailleurs ; sa
// prochaine place s'annonce PREVIEW secondes avant. Seul dedans, on marque (un point par
// seconde) ; à plusieurs, personne. Espace / A : un coup d'épaule, court et sec, qui fait
// glisser celui qu'il touche de 2,5 m environ, à terre (hors de la zone, ou en bas d'un gradin) ;
// Maj / B : sauter (les gradins font un mètre, on les saute ; un coup d'épaule passe sous celui
// qui saute). De temps en temps, une arme apparaît sur un côté de la cour (une seule à la fois) :
// une batte (deux coups qui envoient loin) ou un marteau (un tour sur soi qui renverse tout le
// monde autour). Le plus de points au bout de HILL_TIME secondes gagne.

/** Le marcheur des arènes, avec un saut d'environ 1,2 m : de quoi monter un gradin. */
const HILL_WALKER: BodyTuning = { ...WALKER, jumpSpeed: 7 };
/** Le coup d'épaule : un élan bref (environ 1,5 m), puis une recharge. */
const SHOVE_SPEED = 9;
export const SHOVE_TIME = 0.16;
export const SHOVE_COOLDOWN = 1;
/** Il touche ce qui est à sa portée devant lui (corps qui se frôlent, un peu plus). */
const SHOVE_REACH = WALKER.radius * 2 + 0.2;
const SHOVE_CONE = 0.5;
/**
 * Touché : il tombe, glisse à HIT_SPEED (environ 2,3 m) et reste HIT_DOWN secondes au sol, puis
 * se relève encore un peu sonné (retour de test : touché, on se relevait trop vite). Deux coups
 * d'épaule de face : chacun repart à HEAD_ON de cette vitesse. On ne frappe pas qui est à terre.
 */
const HIT_SPEED = 7.5;
export const HIT_DOWN = 1.6;
const HEAD_ON = 0.7;
const PASS_UNDER = 0.4;
/** Descendre une rampe : on garde les pieds au sol tant que le sol ne s'enfonce pas plus vite. */
const SNAP_DOWN = 0.25;
/** La partie, la zone (la première se pose un peu plus tôt), et l'annonce de la suivante. */
export const HILL_TIME = 80;
export const ZONE_TIME = 10;
const FIRST_ZONE_TIME = 9;
export const PREVIEW = 3;
/** Le pas qui compte : un point par seconde seul dans la zone (le score est en pas). */
export const HILL_POINT_STEPS = Math.round(1 / ARENA_STEP);
/**
 * Les armes (retour de test : pour pimenter la bagarre) : une seule à la fois, au sol ou en main.
 * La première apparaît après FIRST_WEAPON secondes, la suivante WEAPON_PAUSE à WEAPON_PAUSE +
 * WEAPON_SPREAD secondes après la fin de la précédente. On la ramasse en passant dessus. Tenue
 * WEAPON_HOLD secondes sans servir, elle casse. La zone qui se pose sur une arme l'avale.
 */
const FIRST_WEAPON = 6;
const WEAPON_PAUSE = 7;
const WEAPON_SPREAD = 5;
export const WEAPON_HOLD = 12;
const PICK_REACH = 0.9;
/** Une arme partie (cassée, avalée) reste dans l'état ce temps-là : le client montre sa fin. */
const WEAPON_KEPT = 1;
/**
 * La batte : BAT_USES coups, chacun touche ce qui est devant à BAT_REACH (tous) et l'envoie à
 * BAT_SPEED (environ 6 m), au sol BAT_DOWN secondes. Un coup, touché ou non, compte.
 */
export const BAT_USES = 2;
const BAT_REACH = 1.9;
const BAT_CONE = 0.3;
const BAT_SPEED = 12;
const BAT_DOWN = 2.6;
/**
 * Le marteau : un seul tour sur soi (SPIN_TIME, sur place), qui renverse tout le monde à
 * SPIN_RADIUS autour (environ 3,4 m de glissade), au sol SPIN_DOWN secondes.
 */
export const HAMMER_USES = 1;
export const SPIN_TIME = 0.5;
export const SPIN_RADIUS = 2.4;
const SPIN_SPEED = 9;
const SPIN_DOWN = 2.2;
/** Un coup de batte occupe le frappeur tant de secondes (le geste). */
export const SWING_TIME = 0.3;

export type HillWeaponKind = 'bat' | 'hammer';

export type HillWeapon = {
  id: number;
  kind: HillWeaponKind;
  /** Sa place au sol (WEAPON_SPOTS), tant que personne ne l'a ramassée. */
  spot: number;
  x: number;
  y: number;
  z: number;
  /** Qui la tient, ou null (au sol) ; les coups qui lui restent. */
  holder: PlayerId | null;
  uses: number;
  /** Le pas où elle est apparue, où on l'a ramassée. */
  spawnedAt: number;
  pickedAt: number | null;
  /** Le pas où elle est partie, et comment (cassée, ou avalée par la zone), ou null. */
  goneAt: number | null;
  gone: 'broken' | 'swallowed' | null;
};

export type HillFighter = ArenaBody & {
  /** Personne n'est éliminé : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Ses pas seul dans la zone (HILL_POINT_STEPS par point). */
  score: number;
  /** Secondes restantes de coup d'épaule, et avant le suivant ; le pas du dernier, ou null. */
  shoving: number;
  shoveReady: number;
  shovedAt: number | null;
  /** Le pas où un coup l'a touché, et lequel, ou null (le client montre le choc). */
  hitAt: number | null;
  hitBy: 'shove' | HillWeaponKind | null;
  /** Secondes restantes de geste d'arme, le pas du dernier coup et son arme, ou null. */
  attacking: number;
  attackedAt: number | null;
  attackKind: HillWeaponKind | null;
  /** Les touches tenues au pas précédent : on agit en appuyant, pas en tenant. */
  heldShove: boolean;
  heldJump: boolean;
};

/** La zone : sa place (HILL_SPOTS), la précédente, la suivante, quand elle s'est posée et part. */
export type HillZone = {
  index: number;
  spot: number;
  previous: number | null;
  next: number;
  startAt: number;
  endAt: number;
};

export type HillState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: HillFighter[];
  zone: HillZone;
  /** Ceux qui sont dans la zone à ce pas ; celui qui marque (seul dedans), ou null. */
  inside: PlayerId[];
  king: PlayerId | null;
  /** L'arme du moment (au sol, en main, ou qui vient de partir), ou null. */
  weapon: HillWeapon | null;
  /** Le pas où la prochaine arme apparaît, ou null (il y en a une). */
  nextWeaponAt: number | null;
  /** Combien d'armes sont déjà apparues. */
  weapons: number;
};

function steps(seconds: number): number {
  return Math.round(seconds / ARENA_STEP);
}

/** La place suivante : une autre que l'actuelle et la précédente, tirée de la graine. */
function nextSpot(seed: number, index: number, spot: number, previous: number | null): number {
  const choices = HILL_SPOTS.map((_, id) => id).filter((id) => id !== spot && id !== previous);
  return choices[Math.floor(forestUnit(seed, index, 401) * choices.length)] ?? 0;
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): HillState {
  const first = 0;
  const firstZone = HILL_SPOTS[first];
  return {
    tick: 0,
    practice,
    seed,
    fighters: players.map((id, index) => {
      const start = HILL_STARTS[index % HILL_STARTS.length] ?? { x: 0, z: 8 };
      // Au bac à sable, le mannequin attend dans la zone : on s'entraîne à l'en sortir.
      const spot = practice && index === 1 && firstZone ? firstZone : start;
      const body = createBody(id, spot.x, spot.z, Math.atan2(-spot.x, -spot.z));
      return {
        ...body,
        fellAt: null,
        score: 0,
        shoving: 0,
        shoveReady: 0,
        shovedAt: null,
        hitAt: null,
        hitBy: null,
        attacking: 0,
        attackedAt: null,
        attackKind: null,
        heldShove: false,
        heldJump: false,
      };
    }),
    zone: {
      index: 0,
      spot: first,
      previous: null,
      next: nextSpot(seed, 0, first, null),
      startAt: 0,
      endAt: steps(FIRST_ZONE_TIME),
    },
    inside: [],
    king: null,
    weapon: null,
    nextWeaponAt: steps(practice ? 1 : FIRST_WEAPON),
    weapons: 0,
  };
}

function step(state: HillState, inputs: Partial<Record<PlayerId, ArenaInput>>): HillState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const fighters = state.fighters.map((fighter) => ({ ...fighter }));
  const weapon = state.weapon ? { ...state.weapon } : null;
  const next: HillState = { ...state, tick, fighters, zone: { ...state.zone }, weapon };
  if (isOver(state)) return next;
  for (const fighter of fighters) act(next, fighter, inputs[fighter.id] ?? IDLE_INPUT, tick, dt);
  shoves(fighters, tick);
  // Les contacts se règlent l'un après l'autre : l'ordre change à chaque pas (pawnSumo.ts).
  const shift = tick % Math.max(1, fighters.length);
  collideBodies([...fighters.slice(shift), ...fighters.slice(0, shift)], HILL_WALKER, new Set());
  const grounded = new Set(fighters.filter((one) => !isAirborne(one)).map((one) => one.id));
  moveBodies(fighters, HILL_WALKER, dt, (body) => ruinGround(body.x, body.z, body.y));
  for (const fighter of fighters) {
    // Le long d'une rampe qui descend, les pieds suivent le sol au lieu de rebondir dessus.
    const ground = ruinGround(fighter.x, fighter.z, fighter.y);
    const isDrop = fighter.y - ground;
    if (grounded.has(fighter.id) && fighter.vy <= 0 && isDrop > 0 && isDrop < SNAP_DOWN) {
      Object.assign(fighter, { y: ground, vy: 0, onGround: true });
    }
    keepInRuins(fighter, HILL_WALKER.radius);
  }
  pickWeapon(next, tick);
  score(next);
  moveZone(next, tick);
  updateWeapon(next, tick);
  return next;
}

/** Les commandes d'un joueur : marcher, sauter, le coup d'épaule, ou son arme s'il en tient une. */
function act(
  state: HillState,
  fighter: HillFighter,
  input: ArenaInput,
  tick: number,
  dt: number,
): void {
  const pressedShove = input.primary && !fighter.heldShove;
  const pressedJump = input.secondary && !fighter.heldJump;
  fighter.heldShove = input.primary;
  fighter.heldJump = input.secondary;
  fighter.shoveReady = Math.max(0, fighter.shoveReady - dt);
  if (fighter.attacking > 0) {
    // Le geste de l'arme, sur place ; au marteau, il tourne sur lui-même.
    fighter.attacking = Math.max(0, fighter.attacking - dt);
    if (fighter.attackKind === 'hammer') {
      fighter.facing += ((Math.PI * 2) / SPIN_TIME) * dt;
    }
    walkBody(fighter, { x: 0, z: 0 }, HILL_WALKER, dt);
    return;
  }
  const weapon = weaponOf(state, fighter.id);
  if (weapon && pressedShove && isSteady(fighter) && !isAirborne(fighter)) {
    if (Math.hypot(input.move.x, input.move.z) > 0.1) {
      fighter.facing = Math.atan2(input.move.x, input.move.z);
    }
    strike(state, fighter, weapon, tick);
    return;
  }
  if (fighter.shoving > 0) {
    // Lancé : il ne freine ni ne tourne.
    fighter.shoving = Math.max(0, fighter.shoving - dt);
    return;
  }
  if (pressedShove && fighter.shoveReady <= 0 && isSteady(fighter) && !isAirborne(fighter)) {
    if (Math.hypot(input.move.x, input.move.z) > 0.1) {
      fighter.facing = Math.atan2(input.move.x, input.move.z);
    }
    Object.assign(fighter, {
      shoving: SHOVE_TIME,
      shoveReady: SHOVE_COOLDOWN,
      shovedAt: tick,
      vx: Math.sin(fighter.facing) * SHOVE_SPEED,
      vz: Math.cos(fighter.facing) * SHOVE_SPEED,
    });
    return;
  }
  if (pressedJump) jumpBody(fighter, HILL_WALKER);
  walkBody(fighter, input.move, HILL_WALKER, dt);
}

/** Celui qui donne un coup d'épaule touche ce qui est devant lui, à sa hauteur. */
function shoves(fighters: HillFighter[], tick: number): void {
  for (const shover of fighters) {
    if (shover.shoving <= 0) continue;
    const dirX = Math.sin(shover.facing);
    const dirZ = Math.cos(shover.facing);
    for (const other of fighters) {
      if (other === shover || other.hitAt === tick || other.downed > 0) continue;
      const dx = other.x - shover.x;
      const dz = other.z - shover.z;
      const gap = Math.hypot(dx, dz);
      const isInFront = gap > 0 && (dx * dirX + dz * dirZ) / gap > SHOVE_CONE;
      // Le coup passe sous celui qui a sauté (dès qu'il a quitté le sol de PASS_UNDER).
      const rise = other.y - shover.y;
      if (!isInFront || gap > SHOVE_REACH || rise > PASS_UNDER || rise < -0.8) continue;
      // De face, deux coups d'épaule se repoussent l'un l'autre.
      const isHeadOn =
        other.shoving > 0 &&
        -(dx * Math.sin(other.facing) + dz * Math.cos(other.facing)) / gap > SHOVE_CONE;
      const speed = isHeadOn ? HIT_SPEED * HEAD_ON : HIT_SPEED;
      hit(other, dx / gap, dz / gap, speed, HIT_DOWN, 'shove', tick);
      if (isHeadOn) hit(shover, -dx / gap, -dz / gap, speed, HIT_DOWN, 'shove', tick);
      else Object.assign(shover, { shoving: 0, vx: shover.vx * 0.2, vz: shover.vz * 0.2 });
      break;
    }
  }
}

/** Touché : il tombe et glisse dans le sens du coup, et lâche ce qu'il faisait. */
function hit(
  body: HillFighter,
  nx: number,
  nz: number,
  speed: number,
  down: number,
  by: HillFighter['hitBy'],
  tick: number,
): void {
  knockDown(body, nx, nz, speed, down);
  Object.assign(body, { shoving: 0, attacking: 0, hitAt: tick, hitBy: by });
}

/**
 * Un coup d'arme : la batte frappe tout ce qui est devant elle, le marteau tout ce qui est
 * autour ; elle s'use d'un coup, touché ou non, et casse au dernier.
 */
function strike(state: HillState, fighter: HillFighter, weapon: HillWeapon, tick: number): void {
  const isBat = weapon.kind === 'bat';
  Object.assign(fighter, {
    attacking: isBat ? SWING_TIME : SPIN_TIME,
    attackedAt: tick,
    attackKind: weapon.kind,
    shoving: 0,
    vx: 0,
    vz: 0,
  });
  const dirX = Math.sin(fighter.facing);
  const dirZ = Math.cos(fighter.facing);
  for (const other of state.fighters) {
    if (other === fighter || other.downed > 0 || Math.abs(other.y - fighter.y) > 1) continue;
    const dx = other.x - fighter.x;
    const dz = other.z - fighter.z;
    const gap = Math.hypot(dx, dz);
    if (gap === 0) continue;
    const nx = dx / gap;
    const nz = dz / gap;
    if (isBat && gap <= BAT_REACH && nx * dirX + nz * dirZ > BAT_CONE) {
      hit(other, nx, nz, BAT_SPEED, BAT_DOWN, 'bat', tick);
    } else if (!isBat && gap <= SPIN_RADIUS) {
      hit(other, nx, nz, SPIN_SPEED, SPIN_DOWN, 'hammer', tick);
    }
  }
  weapon.uses -= 1;
  if (weapon.uses <= 0) Object.assign(weapon, { goneAt: tick, gone: 'broken' });
}

/** Celui qui passe sur l'arme au sol, debout, la ramasse. */
function pickWeapon(state: HillState, tick: number): void {
  const { weapon } = state;
  if (!weapon || weapon.holder !== null || weapon.goneAt !== null) return;
  const taker = state.fighters.find(
    (one) =>
      isSteady(one) &&
      Math.hypot(one.x - weapon.x, one.z - weapon.z) <= PICK_REACH &&
      Math.abs(one.y - weapon.y) < 1,
  );
  if (taker) Object.assign(weapon, { holder: taker.id, pickedAt: tick });
}

/**
 * L'arme : avalée si la zone se pose sur elle, cassée si on la garde trop sans s'en servir ;
 * partie, elle disparaît un peu plus tard et la suivante se prépare ; sans arme, la suivante
 * apparaît à l'heure, sur une place des côtés loin de la zone et de la prochaine.
 */
function updateWeapon(state: HillState, tick: number): void {
  const { weapon } = state;
  if (weapon && weapon.goneAt === null) {
    const spot = HILL_SPOTS[state.zone.spot];
    const isSwallowed =
      weapon.holder === null &&
      spot !== undefined &&
      isInSpot({ ...spot, radius: spot.radius + 0.5 }, weapon.x, weapon.y, weapon.z);
    const isStale =
      weapon.pickedAt !== null && (tick - weapon.pickedAt) * ARENA_STEP >= WEAPON_HOLD;
    if (isSwallowed) Object.assign(weapon, { goneAt: tick, gone: 'swallowed' });
    else if (isStale) Object.assign(weapon, { goneAt: tick, gone: 'broken' });
  }
  if (weapon && weapon.goneAt !== null && tick - weapon.goneAt >= steps(WEAPON_KEPT)) {
    state.weapon = null;
    const pause = WEAPON_PAUSE + forestUnit(state.seed, state.weapons, 411) * WEAPON_SPREAD;
    state.nextWeaponAt = tick + steps(state.practice ? 2 : pause);
  }
  if (state.weapon !== null || state.nextWeaponAt === null || tick < state.nextWeaponAt) return;
  spawnWeapon(state, tick);
}

/** Une nouvelle arme, batte ou marteau, sur une place des côtés loin de la zone et de la suivante. */
function spawnWeapon(state: HillState, tick: number): void {
  const zones = [HILL_SPOTS[state.zone.spot], HILL_SPOTS[state.zone.next]];
  const free = WEAPON_SPOTS.map((_, id) => id).filter((id) => {
    const place = WEAPON_SPOTS[id];
    return (
      place !== undefined &&
      zones.every(
        (zone) => !zone || Math.hypot(zone.x - place.x, zone.z - place.z) > zone.radius + 2,
      )
    );
  });
  const id = state.weapons;
  const spot = free[Math.floor(forestUnit(state.seed, id, 412) * free.length)] ?? 0;
  const place = WEAPON_SPOTS[spot] ?? { x: 0, y: 0, z: 0 };
  const kind: HillWeaponKind = forestUnit(state.seed, id, 413) < 0.5 ? 'bat' : 'hammer';
  state.weapon = {
    id,
    kind,
    spot,
    x: place.x,
    y: place.y,
    z: place.z,
    holder: null,
    uses: kind === 'bat' ? BAT_USES : HAMMER_USES,
    spawnedAt: tick,
    pickedAt: null,
    goneAt: null,
    gone: null,
  };
  state.weapons = id + 1;
  state.nextWeaponAt = null;
}

/** L'arme que tient ce joueur (pas encore partie), s'il en tient une. */
export function weaponOf(state: HillState, id: PlayerId): HillWeapon | null {
  const { weapon } = state;
  return weapon && weapon.holder === id && weapon.goneAt === null ? weapon : null;
}

/** Seul dans la zone, on marque ; à plusieurs, personne. */
function score(state: HillState): void {
  const spot = HILL_SPOTS[state.zone.spot];
  state.inside = spot
    ? state.fighters.filter((one) => isInSpot(spot, one.x, one.y, one.z)).map((one) => one.id)
    : [];
  state.king = state.inside.length === 1 ? (state.inside[0] ?? null) : null;
  const king = state.fighters.find((one) => one.id === state.king);
  if (king) king.score += 1;
}

/** À l'heure, la zone saute à la place annoncée, et tire la suivante. */
function moveZone(state: HillState, tick: number): void {
  const { zone } = state;
  if (tick < zone.endAt) return;
  const index = zone.index + 1;
  state.zone = {
    index,
    spot: zone.next,
    previous: zone.spot,
    next: nextSpot(state.seed, index, zone.next, zone.spot),
    startAt: tick,
    endAt: tick + steps(ZONE_TIME),
  };
}

/** Le score affiché d'un joueur : ses secondes seul dans la zone. */
export function hillPoints(fighter: HillFighter): number {
  return Math.floor(fighter.score / HILL_POINT_STEPS);
}

function isOver(state: HillState): boolean {
  return !state.practice && state.tick >= steps(HILL_TIME);
}

function timeLeft(state: HillState): number | null {
  if (state.practice) return null;
  return Math.max(0, HILL_TIME - state.tick * ARENA_STEP);
}

/** Du plus de points au moins ; à points égaux (en secondes entières), ex aequo. */
function ranking(state: HillState): PlayerId[][] {
  const groups = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    const points = hillPoints(fighter);
    groups.set(points, [...(groups.get(points) ?? []), fighter.id]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

// Le bot (02-mini-jeux.md, fiche 4) : il va à la zone par le chemin des ruines (escaliers,
// rampes, sauts de gradin) ; dedans, il reste au milieu s'il est seul, sinon il se place entre le
// milieu et l'intrus et le pousse dehors d'un coup d'épaule. Il saute pour esquiver un coup
// d'épaule qui arrive sur lui. Une arme au sol pas trop loin, il fait parfois le détour pour la
// prendre ; armé, il frappe à la batte un intrus devant lui, ou tourne au marteau quand il y a du
// monde autour. Selon son niveau : le temps qu'il met à voir que la zone a sauté, s'il part
// d'avance vers la prochaine, la justesse de sa visée, son envie de frapper, ses esquives, son
// goût pour les armes.

const BOT: Record<
  BotLevel,
  { reaction: number; noise: number; eager: number; dodge: number; ahead: number; arms: number }
> = {
  easy: { reaction: 1, noise: 0.6, eager: 0.2, dodge: 0.1, ahead: 0, arms: 0.35 },
  normal: { reaction: 0.7, noise: 0.35, eager: 0.4, dodge: 0.3, ahead: 0.15, arms: 0.65 },
  expert: { reaction: 0.5, noise: 0.2, eager: 0.6, dodge: 0.5, ahead: 0.3, arms: 0.9 },
};
/** Il va chercher une arme à moins de tant de mètres de chemin (pas s'il marque). */
const WEAPON_DETOUR = 13;
/** Son temps de réaction varie d'une zone à l'autre, jusqu'à tant de secondes en plus. */
const REACTION_SPREAD = 0.8;
/** Seul dans la zone, il revient au milieu s'il s'en écarte de plus que ça. */
const CENTER_SLACK = 0.4;
/** Il frappe un intrus à moins de tant de mètres. */
const STRIKE_RANGE = 1.5;

function botInput(state: HillState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  if (!me || !isSteady(me) || me.shoving > 0 || me.attacking > 0) return IDLE_INPUT;
  const bot = BOT[level];
  const noise = (rng.next() - 0.5) * bot.noise;
  if (shouldDodge(state, me, bot.dodge))
    return { move: { x: 0, z: 0 }, primary: false, secondary: true };
  const armed = weaponOf(state, me.id);
  if (armed) {
    const blow = armedBlow(state, me, armed, noise, bot.eager, rng);
    if (blow) return blow;
  }
  const loot = wantedWeapon(state, me, bot.arms);
  const goal = goalSpot(state, me, bot);
  const spot = loot ?? HILL_SPOTS[goal];
  if (!spot) return IDLE_INPUT;
  if (!loot && isInSpot(spot, me.x, me.y, me.z) && goal === state.zone.spot) {
    return holdZone(state, me, spot, bot.eager, noise, rng);
  }
  const node = nodeAt(me.x, me.z, me.y);
  const way = node === null ? null : wayToSpot(node, spot);
  // Hors de la grille (contre un mur) ou déjà dedans : droit vers le milieu de la zone.
  const target = way ?? { x: spot.x, z: spot.z, isJump: false };
  const move = rotate(toward(me, target), noise);
  return { move, primary: false, secondary: target.isJump && !isAirborne(me) };
}

/** La place où il va : la zone qu'il a vue (il met du temps à voir qu'elle a sauté), ou la suivante. */
function goalSpot(
  state: HillState,
  me: HillFighter,
  bot: { reaction: number; ahead: number },
): number {
  const { zone } = state;
  const salt = saltOf(me.id);
  const reaction = bot.reaction + forestUnit(state.seed, zone.index, 404 + salt) * REACTION_SPREAD;
  const isLate = state.tick - zone.startAt < steps(reaction);
  if (isLate && zone.previous !== null) return zone.previous;
  const isAnnounced = state.tick >= zone.endAt - steps(PREVIEW);
  const thinksAhead = forestUnit(state.seed, zone.index, 405 + salt) < bot.ahead;
  if (!thinksAhead || !isAnnounced || state.king === me.id) return zone.spot;
  // L'Expert part d'avance quand il n'y marque pas, ou que la prochaine est loin.
  const node = nodeAt(me.x, me.z, me.y);
  const upcoming = HILL_SPOTS[zone.next];
  const far = node === null || !upcoming ? 0 : distanceToSpot(node, upcoming);
  const left = (zone.endAt - state.tick) * ARENA_STEP;
  return state.inside.length > 1 || far > left * HILL_WALKER.walkSpeed * 0.8
    ? zone.next
    : zone.spot;
}

/** Dans la zone : au milieu s'il est seul ; sinon, pousser l'intrus le plus proche dehors. */
function holdZone(
  state: HillState,
  me: HillFighter,
  spot: { x: number; z: number },
  eager: number,
  noise: number,
  rng: Rng,
): ArenaInput {
  const rivals = state.fighters
    .filter((one) => one.id !== me.id && state.inside.includes(one.id))
    .map((one) => ({ one, gap: Math.hypot(one.x - me.x, one.z - me.z) }))
    .sort((a, b) => a.gap - b.gap);
  const rival = rivals[0];
  if (!rival) {
    const off = Math.hypot(spot.x - me.x, spot.z - me.z);
    const move = off > CENTER_SLACK ? toward(me, spot) : { x: 0, z: 0 };
    return { move, primary: false, secondary: false };
  }
  const { one, gap } = rival;
  // Se placer côté milieu : le coup l'envoie vers l'extérieur.
  const outX = one.x - spot.x;
  const outZ = one.z - spot.z;
  const out = Math.hypot(outX, outZ) || 1;
  const behind = { x: one.x - (outX / out) * 0.9, z: one.z - (outZ / out) * 0.9 };
  const facing = rotate(toward(me, one), noise);
  if (gap < STRIKE_RANGE && me.shoveReady <= 0 && rng.chance(eager)) {
    return { move: facing, primary: true, secondary: false };
  }
  const isPlaced = Math.hypot(behind.x - me.x, behind.z - me.z) < 0.5;
  return {
    move: isPlaced ? facing : rotate(toward(me, behind), noise),
    primary: false,
    secondary: false,
  };
}

/**
 * L'arme au sol qu'il va chercher, ou null : s'il en a le goût (une fois par arme), qu'il ne
 * marque pas, et qu'elle est à moins de WEAPON_DETOUR mètres de chemin.
 */
function wantedWeapon(state: HillState, me: HillFighter, taste: number): HillSpot | null {
  const { weapon } = state;
  if (!weapon || weapon.holder !== null || weapon.goneAt !== null || state.king === me.id) {
    return null;
  }
  if (forestUnit(state.seed, weapon.id, 414 + saltOf(me.id)) >= taste) return null;
  const place = WEAPON_SPOTS[weapon.spot];
  const node = nodeAt(me.x, me.z, me.y);
  if (!place || node === null || distanceToSpot(node, place) > WEAPON_DETOUR) return null;
  return place;
}

/**
 * Armé : à la batte, il frappe un adversaire debout tout près (il se tourne vers lui) ; au
 * marteau, il tourne dès qu'il y a quelqu'un autour, et plus volontiers s'ils sont plusieurs.
 */
function armedBlow(
  state: HillState,
  me: HillFighter,
  weapon: HillWeapon,
  noise: number,
  eager: number,
  rng: Rng,
): ArenaInput | null {
  const near = state.fighters
    .filter((one) => one.id !== me.id && one.downed <= 0 && Math.abs(one.y - me.y) < 1)
    .map((one) => ({ one, gap: Math.hypot(one.x - me.x, one.z - me.z) }))
    .sort((a, b) => a.gap - b.gap);
  const reach = weapon.kind === 'bat' ? BAT_REACH - 0.3 : SPIN_RADIUS - 0.4;
  const inReach = near.filter(({ gap }) => gap < reach);
  const first = inReach[0];
  if (!first || !rng.chance(eager * inReach.length)) return null;
  return { move: rotate(toward(me, first.one), noise), primary: true, secondary: false };
}

/** Un coup d'épaule arrive droit sur lui, tout près : il saute (s'il le voit à temps). */
function shouldDodge(state: HillState, me: HillFighter, dodge: number): boolean {
  if (isAirborne(me)) return false;
  return state.fighters.some((other) => {
    if (other.id === me.id || other.shoving <= 0 || other.shovedAt === null) return false;
    const dx = me.x - other.x;
    const dz = me.z - other.z;
    const gap = Math.hypot(dx, dz);
    const isAimed =
      gap > 0 && (dx * Math.sin(other.facing) + dz * Math.cos(other.facing)) / gap > 0.7;
    const sees = forestUnit(state.seed, other.shovedAt, 403 + saltOf(me.id)) < dodge;
    return isAimed && gap < 2.2 && sees;
  });
}

/** Un nombre propre à chaque joueur. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

function toward(me: { x: number; z: number }, target: { x: number; z: number }) {
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const gap = Math.hypot(dx, dz);
  return gap > 1e-6 ? { x: dx / gap, z: dz / gap } : { x: 0, z: 0 };
}

function rotate(dir: { x: number; z: number }, angle: number): { x: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: dir.x * cos + dir.z * sin, z: -dir.x * sin + dir.z * cos };
}

export const KING_OF_HILL: ArenaGame<HillState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
