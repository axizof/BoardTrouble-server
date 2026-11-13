import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import { forestUnit } from '../offPiste/forest';

// Bille en tête (02-mini-jeux.md, fiche 54) : chacun dans sa boule de hamster sur un plateau
// carré au-dessus du vide. Une boule roule : on la pousse, elle prend de l'élan et glisse sur sa
// lancée ; deux boules qui se touchent rebondissent vraiment (un choc presque élastique, à poids
// égal : celui qui fonce s'arrête, l'autre repart à sa place). Action maintenue charge un élan
// (la boule freine et tourne sur place, on vise), lâchée elle le lance. Le plateau vit : toutes
// les quelques secondes, un événement annoncé (le centre s'ouvre, un champignon en sort, les
// rambardes s'abaissent, le plateau penche) ; vers 40 s, les rambardes tombent pour de bon. Qui
// sort du plateau ou tombe dans le trou est éliminé ; le dernier qui roule gagne.

/** Le plateau : un carré de 2 × BALL_HALF mètres de côté, centré sur l'origine. */
export const BALL_HALF = 7.5;
export const BALL_RADIUS = 0.75;
/**
 * Le roulis : la poussée de la commande (m/s²) et le frottement (part de la vitesse perdue par
 * seconde). Vitesse de croisière ROLL_ACCEL / ROLL_DRAG, environ 7 m/s, atteinte en 2 s : la
 * boule part lentement, glisse longtemps, et freiner, c'est pousser dans l'autre sens.
 */
const ROLL_ACCEL = 6;
const ROLL_DRAG = 0.85;
/**
 * Pousser contre sa lancée freine plus fort (jusqu'à 1 + BRAKE_BONUS fois la poussée, pile à
 * contresens) : un choc moyen se rattrape avec un bon réflexe.
 */
const BRAKE_BONUS = 0.6;
/** Deux boules se touchent : la part de la vitesse de choc rendue (1 : parfaitement élastique). */
const BALL_BOUNCE = 0.95;
/** Un choc plus fort que ça (m/s) se voit et s'entend. */
const KNOCK_MIN = 1.5;

/**
 * L'élan : maintenir Action le charge (BALL_CHARGE_TIME au plus ; tenu plein HOLD_MAX de plus, il part
 * tout seul). En chargeant, la boule freine fort (CHARGE_DRAG) et l'on vise. Lâché, elle part à
 * BOOST_SPEED (tapoté) jusqu'à FULL_BOOST (chargé à fond), dans la direction visée ; pendant
 * BALL_BOOST_TIME, elle ne se dirige plus et frotte moins ; si elle n'a rien touché, le hamster
 * plante ensuite ses pattes (BRAKE_TIME, frottement BRAKE_DRAG). Retour de capture : sans ce
 * freinage, un élan raté traversait tout le plateau et sortait de l'autre côté. Puis il faut
 * BALL_COOLDOWN pour recharger. Un choc en pleine charge la fait perdre.
 */
export const BALL_CHARGE_TIME = 1;
const HOLD_MAX = 0.6;
const CHARGE_DRAG = 3.5;
const AIM_RATE = 9;
const BOOST_SPEED = 10;
const FULL_BOOST = 16;
const BALL_BOOST_TIME = 0.4;
const BOOST_DRAG = 0.3;
const BRAKE_TIME = 0.35;
const BRAKE_DRAG = 3;
export const BALL_COOLDOWN = 2;
/** Un choc reçu plus fort que ça (m/s) coupe la charge. */
const CHARGE_BREAK = 3;

/**
 * Les événements du plateau : annoncés EVENT_WARNING secondes avant, ils durent chacun leur
 * temps, ouverture et fermeture comprises (EVENT_RAMP). Le premier s'annonce à FIRST_EVENT, puis
 * un après l'autre, séparés de EVENT_GAP secondes au début, de moins en moins (EVENT_GAP_MIN
 * vers la fin). Jamais deux fois le même de suite.
 */
export type BallEventKind = 'hole' | 'mushroom' | 'rails' | 'tilt';
const EVENT_WARNING = 2;
const EVENT_RAMP = 0.6;
const FIRST_EVENT = 5;
const EVENT_GAP = 3;
const EVENT_GAP_MIN = 1;
/** L'écart entre deux événements raccourcit de tant par seconde de jeu. */
const EVENT_GAP_SHRINK = 0.04;
const EVENT_LENGTH: Record<BallEventKind, number> = { hole: 5, mushroom: 6, rails: 6, tilt: 5 };
/**
 * Les rambardes tombent pour de bon au premier événement annoncé après RAILS_GONE secondes (en
 * EVENT_RAMP, plus un moment pour qu'on le voie) : la fin de partie se joue sans filet. Plus
 * d'abaissement passager ensuite.
 */
const RAILS_GONE = 38;
const RAILS_GONE_LENGTH = 2;
/** Au bac à sable : un événement de chaque, dans l'ordre, sans fin ; jamais les rambardes pour de bon. */
const PRACTICE_ORDER: readonly BallEventKind[] = ['hole', 'mushroom', 'rails', 'tilt'];
const PRACTICE_GAP = 3;

/** Le trou du centre (rayon) ; une boule qui le borde y est aspirée (m/s²). */
export const HOLE_RADIUS = 2.4;
const HOLE_PULL = 4;
const HOLE_RIM = 0.8;
/** Le champignon du centre (rayon du chapeau) : qui le touche repart au moins à MUSHROOM_KICK. */
export const MUSHROOM_RADIUS = 1.5;
const MUSHROOM_KICK = 11;
/**
 * Les rambardes : au milieu de chaque bord, sur 2 × RAIL_HALF mètres (70 % du bord) ; elles
 * renvoient mollement. Les coins restent ouverts : plus courtes, un quart des chutes arrivaient
 * dans les 12 premières secondes.
 */
export const RAIL_HALF = 5.25;
const RAIL_BOUNCE = 0.5;
/** Le plateau penché : la boule y est entraînée à cette accélération (m/s²), vers le bas. */
const TILT_ACCEL = 3.5;

/** Le chrono : ceux qui roulent encore à la fin sont ex aequo (les dés les départagent). */
export const BALL_TIME_LIMIT = 90;
/** Départ : en cercle, à cette distance du centre. */
const START_RING = 4;

/**
 * Un événement du plateau : annoncé au pas `warnAt`, actif de `startAt` à `endAt` (null : pour de
 * bon). `angle` : pour le plateau penché, le côté qui descend (comme `atan2(x, z)`).
 */
export type BallEvent = {
  id: number;
  kind: BallEventKind;
  warnAt: number;
  startAt: number;
  endAt: number | null;
  angle: number;
};

/** Ce qui vient de cogner une boule : une autre boule, le champignon ou une rambarde. */
export type BallKnock = { at: number; by: 'ball' | 'mushroom' | 'rail'; force: number };

export type BallRoller = {
  id: PlayerId;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Où regarde le hamster (où il court, ou où il vise en chargeant), comme `atan2(x, z)`. */
  facing: number;
  /** Secondes de charge, tant qu'il charge ; null sinon. */
  charge: number | null;
  /** Secondes restantes d'élan, sa force (0 tapoté, 1 chargé à fond), et avant de recharger. */
  boosting: number;
  power: number;
  /** Secondes restantes du freinage après un élan qui n'a rien touché. */
  braking: number;
  boostReady: number;
  /** La touche tenue au pas précédent : la charge part quand on appuie, pas en tenant. */
  held: boolean;
  /** Le dernier choc reçu, ou null. */
  knock: BallKnock | null;
  /** Le pas où il est tombé, et par où (le bord ou le trou) ; null tant qu'il roule. */
  fellAt: number | null;
  fall: 'edge' | 'hole' | null;
};

export type BallState = {
  tick: number;
  practice: boolean;
  seed: number;
  fighters: BallRoller[];
  /** Tous les événements de la partie, tirés d'avance de la graine. */
  events: BallEvent[];
};

const toTick = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Le programme des événements : tiré de la graine, le même pour tous. */
export function ballEvents(seed: number, practice: boolean): BallEvent[] {
  const events: BallEvent[] = [];
  let time = FIRST_EVENT;
  let previous: BallEventKind | null = null;
  let railsGone = false;
  for (let id = 0; time < BALL_TIME_LIMIT; id++) {
    let kind: BallEventKind;
    let length: number | null;
    if (practice) {
      kind = PRACTICE_ORDER[id % PRACTICE_ORDER.length] ?? 'hole';
      length = EVENT_LENGTH[kind];
    } else if (!railsGone && time >= RAILS_GONE && previous !== 'rails') {
      // Juste après un abaissement passager, on attend l'événement suivant (jamais deux fois le
      // même de suite).
      kind = 'rails';
      length = null;
      railsGone = true;
    } else {
      const pool = (['hole', 'mushroom', 'rails', 'tilt'] as const).filter(
        // Pas de rambardes abaissées en premier : le début de partie reste à l'abri.
        (one) => one !== previous && !((railsGone || id === 0) && one === 'rails'),
      );
      kind = pool[Math.floor(forestUnit(seed, id, 91) * pool.length)] ?? 'hole';
      length = EVENT_LENGTH[kind];
    }
    const startAt = time + EVENT_WARNING;
    events.push({
      id,
      kind,
      warnAt: toTick(time),
      startAt: toTick(startAt),
      endAt: length === null ? null : toTick(startAt + length),
      angle: forestUnit(seed, id, 92) * Math.PI * 2,
    });
    const gap = practice
      ? PRACTICE_GAP
      : Math.max(EVENT_GAP_MIN, EVENT_GAP - time * EVENT_GAP_SHRINK);
    time = startAt + (length ?? RAILS_GONE_LENGTH) + gap;
    previous = kind;
    // Au bac à sable, le programme tourne en boucle : quatre tours suffisent largement.
    if (practice && id >= 40) break;
  }
  return events;
}

/**
 * Où en est un événement à ce pas (fraction comprise) : 0 avant et après, 1 en plein, entre les
 * deux pendant qu'il s'ouvre ou se referme.
 */
function eventShare(event: BallEvent, tick: number): number {
  const ramp = EVENT_RAMP / ARENA_STEP;
  const opening = (tick - event.startAt) / ramp;
  const closing = event.endAt === null ? 1 : (event.endAt - tick) / ramp;
  return Math.max(0, Math.min(1, opening, closing));
}

/** La part d'ouverture de l'événement de ce genre en cours (0 s'il n'y en a pas). */
function kindShare(state: { events: BallEvent[] }, kind: BallEventKind, tick: number): number {
  let share = 0;
  for (const event of state.events) {
    if (event.kind !== kind || tick < event.startAt) continue;
    share = Math.max(share, eventShare(event, tick));
  }
  return share;
}

/** L'événement annoncé (pas encore commencé) à ce pas, ou null. */
export function announcedEvent(state: BallState, tick = state.tick): BallEvent | null {
  return state.events.find((event) => event.warnAt <= tick && tick < event.startAt) ?? null;
}

/** Le rayon du trou du centre à ce pas (0 : fermé). */
export function holeRadius(state: BallState, tick = state.tick): number {
  return HOLE_RADIUS * kindShare(state, 'hole', tick);
}

/** La hauteur du champignon à ce pas (0 : rentré, 1 : sorti). */
export function mushroomShare(state: BallState, tick = state.tick): number {
  return kindShare(state, 'mushroom', tick);
}

/** Les rambardes à ce pas : 1 levées, 0 abaissées. */
export function railsShare(state: BallState, tick = state.tick): number {
  return 1 - kindShare(state, 'rails', tick);
}

/** Le plateau penché à ce pas : le côté qui descend (vecteur unité) et de combien (0 à 1). */
export function tiltOf(
  state: BallState,
  tick = state.tick,
): { x: number; z: number; share: number } {
  for (const event of state.events) {
    if (event.kind !== 'tilt' || tick < event.startAt) continue;
    const share = eventShare(event, tick);
    if (share > 0) return { x: Math.sin(event.angle), z: Math.cos(event.angle), share };
  }
  return { x: 0, z: 0, share: 0 };
}

/** Les rambardes : un segment au milieu de chaque bord, d'un bout à l'autre. */
export const RAILS: readonly { ax: number; az: number; bx: number; bz: number }[] = [
  { ax: BALL_HALF, az: -RAIL_HALF, bx: BALL_HALF, bz: RAIL_HALF },
  { ax: -BALL_HALF, az: -RAIL_HALF, bx: -BALL_HALF, bz: RAIL_HALF },
  { ax: -RAIL_HALF, az: BALL_HALF, bx: RAIL_HALF, bz: BALL_HALF },
  { ax: -RAIL_HALF, az: -BALL_HALF, bx: RAIL_HALF, bz: -BALL_HALF },
];

function startSpot(index: number, count: number): { x: number; z: number } {
  if (count === 1) return { x: 0, z: START_RING };
  const angle = (index / count) * Math.PI * 2;
  return { x: Math.sin(angle) * START_RING, z: Math.cos(angle) * START_RING };
}

function freshRoller(id: PlayerId, x: number, z: number): BallRoller {
  return {
    id,
    x,
    z,
    vx: 0,
    vz: 0,
    // Chacun regarde le centre.
    facing: Math.atan2(-x, -z),
    charge: null,
    boosting: 0,
    power: 0,
    braking: 0,
    boostReady: 0,
    held: false,
    knock: null,
    fellAt: null,
    fall: null,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): BallState {
  return {
    tick: 0,
    practice,
    seed,
    events: ballEvents(seed, practice),
    fighters: players.map((id, index) => {
      const { x, z } = startSpot(index, players.length);
      return freshRoller(id, x, z);
    }),
  };
}

function step(state: BallState, inputs: Partial<Record<PlayerId, ArenaInput>>): BallState {
  const dt = ARENA_STEP;
  const tick = state.tick + 1;
  const next: BallState = { ...state, tick, fighters: state.fighters.map((one) => ({ ...one })) };
  const rolling = next.fighters.filter((roller) => roller.fellAt === null);
  const tilt = tiltOf(next);
  const hole = holeRadius(next);
  for (const roller of rolling) {
    act(roller, inputs[roller.id] ?? IDLE_INPUT, dt);
    roller.vx += tilt.x * TILT_ACCEL * tilt.share * dt;
    roller.vz += tilt.z * TILT_ACCEL * tilt.share * dt;
    pullIntoHole(roller, hole, dt);
    roller.x += roller.vx * dt;
    roller.z += roller.vz * dt;
  }
  // Les chocs se règlent l'un après l'autre : l'ordre change à chaque pas, pour que la place
  // dans la liste ne donne jamais l'avantage.
  const shift = tick % Math.max(1, rolling.length);
  collide([...rolling.slice(shift), ...rolling.slice(0, shift)], tick);
  const mushroom = mushroomShare(next);
  const rails = railsShare(next) > 0.5;
  for (const roller of rolling) {
    if (mushroom > 0) bounceOffMushroom(roller, mushroom, tick);
    if (rails) for (const rail of RAILS) bounceOffRail(roller, rail, tick);
    const fall = fallOf(roller, hole);
    if (fall === null) continue;
    if (state.practice) {
      // Au bac à sable, on revient à sa place de départ.
      const index = state.fighters.findIndex((one) => one.id === roller.id);
      const { x, z } = startSpot(index, state.fighters.length);
      Object.assign(roller, freshRoller(roller.id, x, z));
      continue;
    }
    roller.fellAt = tick;
    roller.fall = fall;
    roller.charge = null;
  }
  return next;
}

/** Les commandes d'une boule : rouler, charger un élan, le lancer. */
function act(roller: BallRoller, input: ArenaInput, dt: number): void {
  const pressed = input.primary && !roller.held;
  roller.held = input.primary;
  roller.boostReady = Math.max(0, roller.boostReady - dt);
  const strength = Math.min(1, Math.hypot(input.move.x, input.move.z));
  const isSteering = strength > 0.1;
  const wanted = Math.atan2(input.move.x, input.move.z);
  if (roller.boosting > 0) {
    // Lancée : elle file sans se diriger, et frotte moins.
    roller.boosting = Math.max(0, roller.boosting - dt);
    drag(roller, BOOST_DRAG, dt);
    if (roller.boosting <= 0) roller.braking = BRAKE_TIME;
    return;
  }
  roller.braking = Math.max(0, roller.braking - dt);
  if (pressed && roller.charge === null && roller.boostReady <= 0) roller.charge = 0;
  if (roller.charge !== null) {
    roller.charge += dt;
    if (isSteering) roller.facing = turnToward(roller.facing, wanted, AIM_RATE * dt);
    const isHeld = input.primary && roller.charge < BALL_CHARGE_TIME + HOLD_MAX;
    if (isHeld) {
      // Elle charge : elle freine fort et tourne sur place.
      drag(roller, CHARGE_DRAG, dt);
      return;
    }
    // Tapoté en poussant le stick : l'élan part où il pousse, sans attendre qu'il ait tourné.
    if (isSteering && roller.charge < 0.2) roller.facing = wanted;
    launch(roller, Math.min(1, roller.charge / BALL_CHARGE_TIME));
    return;
  }
  const speed = Math.hypot(roller.vx, roller.vz);
  const against =
    speed > 0.1 && isSteering
      ? Math.max(0, -(input.move.x * roller.vx + input.move.z * roller.vz) / (speed * strength))
      : 0;
  const accel = ROLL_ACCEL * (1 + BRAKE_BONUS * against);
  roller.vx += input.move.x * accel * dt;
  roller.vz += input.move.z * accel * dt;
  drag(roller, roller.braking > 0 ? BRAKE_DRAG : ROLL_DRAG, dt);
  // Le hamster court où va sa boule ; à l'arrêt, il se tourne vers où on la pousse.
  if (speed > 0.6)
    roller.facing = turnToward(roller.facing, Math.atan2(roller.vx, roller.vz), 10 * dt);
  else if (isSteering) roller.facing = turnToward(roller.facing, wanted, 10 * dt);
}

/** Elle s'élance, de la force `power` (0 tapoté, 1 chargé à fond), où regarde le hamster. */
function launch(roller: BallRoller, power: number): void {
  const speed = BOOST_SPEED + (FULL_BOOST - BOOST_SPEED) * power;
  roller.vx = Math.sin(roller.facing) * speed;
  roller.vz = Math.cos(roller.facing) * speed;
  Object.assign(roller, {
    charge: null,
    power,
    boosting: BALL_BOOST_TIME,
    boostReady: BALL_COOLDOWN,
  });
}

function drag(roller: BallRoller, rate: number, dt: number): void {
  const kept = Math.exp(-rate * dt);
  roller.vx *= kept;
  roller.vz *= kept;
}

/** Au bord du trou ouvert, la boule glisse vers le centre. */
function pullIntoHole(roller: BallRoller, hole: number, dt: number): void {
  if (hole <= 0) return;
  const distance = Math.hypot(roller.x, roller.z);
  if (distance >= hole + HOLE_RIM || distance === 0) return;
  roller.vx -= (roller.x / distance) * HOLE_PULL * dt;
  roller.vz -= (roller.z / distance) * HOLE_PULL * dt;
}

/**
 * Les chocs entre boules : elles ne se chevauchent pas, et rebondissent presque sans perte. À
 * poids égal, celle qui fonce sur une boule arrêtée s'arrête, et l'autre repart à sa place.
 */
function collide(rollers: BallRoller[], tick: number): void {
  for (let i = 0; i < rollers.length; i++) {
    for (let j = i + 1; j < rollers.length; j++) {
      const a = rollers[i];
      const b = rollers[j];
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= BALL_RADIUS * 2) continue;
      if (distance === 0) {
        dx = 1;
        dz = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const nz = dz / distance;
      const overlap = BALL_RADIUS * 2 - distance;
      a.x -= (nx * overlap) / 2;
      a.z -= (nz * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.z += (nz * overlap) / 2;
      const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (closing <= 0) continue;
      const impulse = ((1 + BALL_BOUNCE) * closing) / 2;
      a.vx -= nx * impulse;
      a.vz -= nz * impulse;
      b.vx += nx * impulse;
      b.vz += nz * impulse;
      if (closing < KNOCK_MIN) continue;
      for (const hit of [a, b]) {
        hit.knock = { at: tick, by: 'ball', force: closing };
        if (closing > CHARGE_BREAK) hit.charge = null;
      }
      // Un élan s'arrête au premier choc.
      a.boosting = 0;
      b.boosting = 0;
    }
  }
}

/** Le champignon du centre : qui le touche est renvoyé vers l'extérieur, fort. */
function bounceOffMushroom(roller: BallRoller, share: number, tick: number): void {
  const reach = MUSHROOM_RADIUS * share + BALL_RADIUS;
  let distance = Math.hypot(roller.x, roller.z);
  if (distance >= reach) return;
  if (distance === 0) {
    roller.x = 0.01;
    distance = 0.01;
  }
  const nx = roller.x / distance;
  const nz = roller.z / distance;
  roller.x = nx * reach;
  roller.z = nz * reach;
  const outward = roller.vx * nx + roller.vz * nz;
  const kick = Math.max(MUSHROOM_KICK, -outward);
  roller.vx += nx * (kick - outward);
  roller.vz += nz * (kick - outward);
  roller.boosting = 0;
  roller.charge = null;
  roller.knock = { at: tick, by: 'mushroom', force: kick };
}

/** Une rambarde levée : la boule ne passe pas, elle rebondit mollement (bouts compris). */
function bounceOffRail(
  roller: BallRoller,
  rail: { ax: number; az: number; bx: number; bz: number },
  tick: number,
): void {
  const ex = rail.bx - rail.ax;
  const ez = rail.bz - rail.az;
  const along = Math.max(
    0,
    Math.min(1, ((roller.x - rail.ax) * ex + (roller.z - rail.az) * ez) / (ex * ex + ez * ez)),
  );
  const px = rail.ax + ex * along;
  const pz = rail.az + ez * along;
  const dx = roller.x - px;
  const dz = roller.z - pz;
  const distance = Math.hypot(dx, dz);
  // Une boule fait au plus 0,55 m par pas (élan chargé à fond) : elle touche la rambarde avant
  // d'avoir pu passer de l'autre côté.
  if (distance >= BALL_RADIUS) return;
  const toCenter = Math.hypot(px, pz) || 1;
  const nx = distance > 0 ? dx / distance : -px / toCenter;
  const nz = distance > 0 ? dz / distance : -pz / toCenter;
  roller.x = px + nx * BALL_RADIUS;
  roller.z = pz + nz * BALL_RADIUS;
  const into = roller.vx * nx + roller.vz * nz;
  if (into >= 0) return;
  roller.vx -= nx * into * (1 + RAIL_BOUNCE);
  roller.vz -= nz * into * (1 + RAIL_BOUNCE);
  if (-into > KNOCK_MIN) roller.knock = { at: tick, by: 'rail', force: -into };
}

/** Elle tombe : son centre a passé le bord du plateau, ou il est au-dessus du trou. */
function fallOf(roller: BallRoller, hole: number): 'edge' | 'hole' | null {
  if (Math.abs(roller.x) > BALL_HALF || Math.abs(roller.z) > BALL_HALF) return 'edge';
  if (hole > BALL_RADIUS && Math.hypot(roller.x, roller.z) < hole - BALL_RADIUS * 0.5)
    return 'hole';
  return null;
}

function turnToward(from: number, to: number, step: number): number {
  let gap = (to - from) % (Math.PI * 2);
  if (gap > Math.PI) gap -= Math.PI * 2;
  if (gap < -Math.PI) gap += Math.PI * 2;
  return from + Math.max(-step, Math.min(step, gap));
}

function rollingOf(state: BallState): BallRoller[] {
  return state.fighters.filter((roller) => roller.fellAt === null);
}

function isOver(state: BallState): boolean {
  if (state.practice) return false;
  const alive = rollingOf(state).length;
  return (
    alive === 0 ||
    (state.fighters.length > 1 && alive <= 1) ||
    state.tick * ARENA_STEP >= BALL_TIME_LIMIT
  );
}

/**
 * Le classement : ceux qui roulent encore d'abord (à la fin du chrono, ex aequo : les dés les
 * départageront), puis les tombés, du dernier tombé au premier. Tombés au même pas : ex aequo.
 */
function ranking(state: BallState): PlayerId[][] {
  const survivors = rollingOf(state).map((roller) => roller.id);
  const alive = survivors.length > 0 ? [survivors] : [];
  const fallen = new Map<number, PlayerId[]>();
  for (const roller of state.fighters) {
    if (roller.fellAt === null) continue;
    fallen.set(roller.fellAt, [...(fallen.get(roller.fellAt) ?? []), roller.id]);
  }
  const byFall = [...fallen.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
  return [...alive, ...byFall];
}

function timeLeft(state: BallState): number | null {
  return state.practice ? null : Math.max(0, BALL_TIME_LIMIT - state.tick * ARENA_STEP);
}

/**
 * Les bots, selon leur niveau : le temps qu'ils mettent à réagir à une annonce (secondes),
 * l'écart de leur visée (radians), leur envie de lancer un élan (chance par pas une fois
 * placés), la charge qu'ils osent (part de BALL_CHARGE_TIME, tirée entre ces bornes), la part des
 * élans qu'ils esquivent, la marge qu'ils gardent au bord (m), combien de secondes de glisse ils
 * anticipent, et combien ils compensent la pente du plateau penché. L'Expert tient le milieu
 * (sans ça, il ne gagnait pas plus que le Normal : on tombe surtout quand on traîne au bord).
 */
const BOT: Record<
  BotLevel,
  {
    react: number;
    aim: number;
    eager: number;
    wish: readonly [number, number];
    dodge: number;
    margin: number;
    lookahead: number;
    compensate: number;
  }
> = {
  easy: {
    react: 1.1,
    aim: 0.6,
    eager: 0.015,
    wish: [0, 0.4],
    dodge: 0.15,
    margin: 2,
    lookahead: 0.5,
    compensate: 0.4,
  },
  normal: {
    react: 0.6,
    aim: 0.3,
    eager: 0.025,
    wish: [0.2, 0.7],
    dodge: 0.35,
    margin: 1.9,
    lookahead: 0.8,
    compensate: 0.8,
  },
  expert: {
    react: 0.25,
    aim: 0.05,
    eager: 0.1,
    wish: [0.3, 0.8],
    dodge: 0.8,
    margin: 3,
    lookahead: 1.1,
    compensate: 1,
  },
};
/** Il se place à tant de sa cible, de son côté du centre, et lance quand elle est assez près. */
const BEHIND_TARGET = 2;
const BOOST_RANGE = 5;
/** Sa vitesse de croisière quand il se place, et combien il corrige l'écart à la vitesse voulue. */
const CRUISE = 4.5;
const STEER_GAIN = 0.8;
/** Il fuit la ligne d'un élan qui arrive à plus de ça (m/s), à moins de ça (m). */
const THREAT_SPEED = 6;
const THREAT_RANGE = 4.5;
/** Le nombre de pas d'un élan : la chance d'esquive se tire à chacun. */
const DODGE_STEPS = BALL_BOOST_TIME / ARENA_STEP;
/** Une cible perd tant de points par autre boule déjà plus près d'elle que lui. */
const CROWDED = 1;
/** Il évite le centre de tant de plus que le trou ou le champignon. */
const CENTER_ROOM = 1.3;

/** Un nombre propre à chaque joueur, pour varier les tirages d'un bot à l'autre. */
function saltOf(player: PlayerId): number {
  let hash = 0;
  for (const char of player) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

/**
 * Le bot (02-mini-jeux.md, fiche 54) : il vise la boule la plus près d'un bord, se place entre
 * elle et le centre, et lance un élan quand il la pousserait dehors. Il règle sa vitesse plutôt
 * que sa direction (la boule glisse) : il regarde où le mène sa lancée et freine avant le bord.
 * Il quitte le centre quand le trou ou le champignon s'annoncent (une fois qu'il a réagi),
 * compense la pente, et s'écarte parfois d'un élan qui arrive.
 */
function botInput(state: BallState, player: PlayerId, level: BotLevel, rng: Rng): ArenaInput {
  const me = state.fighters.find((roller) => roller.id === player);
  if (!me || me.fellAt !== null || me.boosting > 0) return IDLE_INPUT;
  const bot = BOT[level];
  const others = rollingOf(state).filter((roller) => roller.id !== player);
  const salt = saltOf(player);
  const known = (event: BallEvent) => state.tick >= event.warnAt + toTick(bot.react);
  const isLive = (event: BallEvent) => event.endAt === null || state.tick < event.endAt;
  const centerDanger = state.events.some(
    (event) =>
      (event.kind === 'hole' || event.kind === 'mushroom') && known(event) && isLive(event),
  )
    ? HOLE_RADIUS + CENTER_ROOM
    : 0;
  const tilt = tiltOf(state);
  const seenTilt = state.events.some(
    (event) => event.kind === 'tilt' && known(event) && isLive(event),
  )
    ? tilt
    : { x: 0, z: 0, share: 0 };
  const limit = BALL_HALF - bot.margin;

  // Il charge : il vise sa cible (là où elle sera), et lâche à la charge voulue.
  if (me.charge !== null) {
    const target = nearestTarget(state, me, others, salt);
    const startTick = state.tick - toTick(me.charge);
    const [from, to] = bot.wish;
    const wish = from + (to - from) * forestUnit(state.seed, startTick, 93 + salt);
    const aim = target
      ? aimAt(me, target, bot.aim * (forestUnit(state.seed, startTick, 94 + salt) * 2 - 1))
      : me.facing;
    return {
      move: { x: Math.sin(aim), z: Math.cos(aim) },
      primary: me.charge < wish * BALL_CHARGE_TIME,
      secondary: false,
    };
  }

  // Un élan arrive sur lui : il s'écarte de sa ligne, s'il le voit venir.
  const threat = others.find((other) => {
    if (other.boosting <= 0) return false;
    const dx = me.x - other.x;
    const dz = me.z - other.z;
    const gap = Math.hypot(dx, dz);
    return gap < THREAT_RANGE && (other.vx * dx + other.vz * dz) / (gap || 1) > THREAT_SPEED;
  });
  let want: { x: number; z: number } | null = null;
  if (threat) {
    const perStep = 1 - (1 - bot.dodge) ** (1 / DODGE_STEPS);
    if (rng.chance(perStep)) {
      const speed = Math.hypot(threat.vx, threat.vz) || 1;
      const side = { x: -threat.vz / speed, z: threat.vx / speed };
      const towardCenter = side.x * -me.x + side.z * -me.z >= 0 ? 1 : -1;
      want = { x: side.x * towardCenter * CRUISE, z: side.z * towardCenter * CRUISE };
    }
  }

  const target = nearestTarget(state, me, others, salt);
  let attack = false;
  if (!want) {
    const spot = target ? behind(target) : { x: 0, z: 0 };
    const safe = safeSpot(spot, limit, centerDanger);
    const dx = safe.x - me.x;
    const dz = safe.z - me.z;
    const gap = Math.hypot(dx, dz);
    const speed = Math.min(CRUISE, gap * 1.5);
    want = gap > 0.05 ? { x: (dx / gap) * speed, z: (dz / gap) * speed } : { x: 0, z: 0 };
    if (target && me.boostReady <= 0) {
      const tx = target.x - me.x;
      const tz = target.z - me.z;
      const reach = Math.hypot(tx, tz);
      const out = Math.hypot(target.x, target.z) || 1;
      const outward = (tx * target.x + tz * target.z) / ((reach || 1) * out);
      const isSafe = Math.abs(me.x) < limit && Math.abs(me.z) < limit;
      attack = reach < BOOST_RANGE && outward > 0.4 && isSafe && rng.chance(bot.eager);
    }
  }

  // Sa lancée l'emmène trop près du bord, ou au centre dangereux : il freine, il s'en écarte.
  const ahead = { x: me.x + me.vx * bot.lookahead, z: me.z + me.vz * bot.lookahead };
  if (Math.abs(ahead.x) > limit) want.x = -Math.sign(ahead.x) * CRUISE;
  if (Math.abs(ahead.z) > limit) want.z = -Math.sign(ahead.z) * CRUISE;
  const fromCenter = Math.hypot(ahead.x, ahead.z);
  if (centerDanger > 0 && fromCenter < centerDanger) {
    const length = fromCenter || 1;
    want = { x: (ahead.x / length) * CRUISE, z: (ahead.z / length) * CRUISE };
  }
  // La pente : il pousse vers le haut ce qu'elle l'entraîne vers le bas.
  const lean = (TILT_ACCEL * seenTilt.share * bot.compensate) / ROLL_ACCEL;
  let mx = (want.x - me.vx) * STEER_GAIN - seenTilt.x * lean;
  let mz = (want.z - me.vz) * STEER_GAIN - seenTilt.z * lean;
  const length = Math.hypot(mx, mz);
  if (length > 1) {
    mx /= length;
    mz /= length;
  }
  if (attack && target) {
    const aim = aimAt(me, target, 0);
    return { move: { x: Math.sin(aim), z: Math.cos(aim) }, primary: true, secondary: false };
  }
  return { move: { x: mx, z: mz }, primary: false, secondary: false };
}

/**
 * Sa cible : une boule près d'un bord et pas trop loin de lui. Chaque bot a ses têtes (une
 * préférence par paire, tirée pour la partie) : sans elle, à égalité, tous visaient le même. Il
 * laisse aussi une boule que d'autres serrent déjà de plus près (retour de capture : les trois
 * bots fondaient ensemble sur le joueur dès le départ).
 */
function nearestTarget(
  state: BallState,
  me: BallRoller,
  others: BallRoller[],
  salt: number,
): BallRoller | null {
  const score = (other: BallRoller) => {
    const reach = Math.hypot(other.x - me.x, other.z - me.z);
    const closer = others.filter(
      (third) => third !== other && Math.hypot(other.x - third.x, other.z - third.z) < reach,
    ).length;
    return (
      Math.max(Math.abs(other.x), Math.abs(other.z)) -
      0.3 * reach -
      CROWDED * closer +
      forestUnit(state.seed, salt, saltOf(other.id)) * 1.5
    );
  };
  return [...others].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** La place d'où la pousser dehors : de son côté du centre. */
function behind(target: BallRoller): { x: number; z: number } {
  const out = Math.hypot(target.x, target.z);
  if (out < 0.1) return { x: target.x, z: target.z - BEHIND_TARGET };
  return {
    x: target.x - (target.x / out) * BEHIND_TARGET,
    z: target.z - (target.z / out) * BEHIND_TARGET,
  };
}

/** Une place ramenée dans le carré sûr, et hors du centre s'il est dangereux. */
function safeSpot(spot: { x: number; z: number }, limit: number, centerDanger: number) {
  const x = Math.max(-limit, Math.min(limit, spot.x));
  const z = Math.max(-limit, Math.min(limit, spot.z));
  const fromCenter = Math.hypot(x, z);
  if (fromCenter >= centerDanger) return { x, z };
  const length = fromCenter || 1;
  const room = centerDanger + 0.3;
  return fromCenter < 0.1 ? { x: 0, z: room } : { x: (x / length) * room, z: (z / length) * room };
}

/** La direction pour toucher `target` là où elle sera à l'arrivée de l'élan, à `error` près. */
function aimAt(me: BallRoller, target: BallRoller, error: number): number {
  const reach = Math.hypot(target.x - me.x, target.z - me.z);
  const lead = reach / BOOST_SPEED;
  return Math.atan2(target.x + target.vx * lead - me.x, target.z + target.vz * lead - me.z) + error;
}

export const HAMSTER_BALL: ArenaGame<BallState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
