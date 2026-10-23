import type { PlayerId } from '../../game/types';

// Les corps des arènes à personnages : on marche avec ses jambes (une force, pas une vitesse
// imposée), on tient sur ses pieds, on se tourne avec un peu d'inertie, on saute si le mini-jeu
// le permet, on se fait bousculer ou projeter au sol puis on se relève. Chaque mini-jeu part de
// là avec ses réglages (BodyTuning) ; ses règles à lui (coups, objets, plateau) restent chez lui.
// Plan (x, z) en mètres, hauteur y, secondes.

export type BodyTuning = {
  /** Le rayon du disque qui le représente au sol. */
  radius: number;
  walkSpeed: number;
  /**
   * La poussée des jambes (m/s², de moins en moins près de la vitesse de marche) et l'appui des
   * pieds, qui freine tout le reste. Les deux se valent presque : on démarre et on s'arrête vite,
   * mais en marchant dans quelqu'un on le fait à peine reculer.
   */
  walkForce: number;
  grip: number;
  /** La part d'appui qui reste sonné (on glisse), et à terre (on glisse sur l'élan). */
  stunGrip: number;
  downGrip: number;
  /** Celui qui reste planté (sans marcher, sur ses pieds) pèse ça dans un contact. */
  braceWeight: number;
  /** Vitesse à laquelle il se tourne vers où il va (radians par seconde) : son poids. */
  turnRate: number;
  /** Vitesse verticale d'un saut (0 : pas de saut dans ce mini-jeu) et pesanteur. */
  jumpSpeed: number;
  gravity: number;
};

/** Le marcheur de base : celui du Sumo des pions. */
export const WALKER: BodyTuning = {
  radius: 0.5,
  walkSpeed: 4.5,
  walkForce: 32,
  grip: 30,
  stunGrip: 0.15,
  downGrip: 0.4,
  braceWeight: 3,
  turnRate: 14,
  jumpSpeed: 0,
  gravity: 20,
};

/** En l'air, on ne contrôle qu'un peu sa course. */
const AIR_CONTROL = 0.3;
/** Deux corps à des hauteurs trop différentes se croisent sans se toucher (l'un saute). */
const CONTACT_HEIGHT = 0.8;

export type ArenaBody = {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Où il regarde (angle autour de la verticale, comme `atan2(x, z)`). */
  facing: number;
  /** Secondes restantes sonné (moins d'appui), et à terre (sans commandes). */
  stunned: number;
  downed: number;
};

export function createBody(id: PlayerId, x: number, z: number, facing: number): ArenaBody {
  return { id, x, y: 0, z, vx: 0, vy: 0, vz: 0, facing, stunned: 0, downed: 0 };
}

export function isAirborne(body: ArenaBody): boolean {
  return body.y > 0 || body.vy > 0;
}

/** Sur ses pieds et maître de ses gestes : ni à terre, ni sonné. */
export function isSteady(body: ArenaBody): boolean {
  return body.downed <= 0 && body.stunned <= 0;
}

/**
 * Un pas de commandes : il marche vers `move` (longueur 0 à 1) et s'y tourne. À terre, il glisse
 * sur son élan sans commandes, puis se relève. `control` (0 à 1) réduit ce qu'il maîtrise de sa
 * marche (en train de frapper, de viser...).
 */
export function walkBody(
  body: ArenaBody,
  move: { x: number; z: number },
  tuning: BodyTuning,
  dt: number,
  control = 1,
): void {
  body.stunned = Math.max(0, body.stunned - dt);
  if (body.downed > 0) {
    body.downed = Math.max(0, body.downed - dt);
    slow(body, tuning.grip * tuning.downGrip * dt);
    return;
  }
  const strength = Math.min(1, Math.hypot(move.x, move.z));
  if (strength > 0.1) turn(body, Math.atan2(move.x, move.z), tuning.turnRate * dt);
  const footing =
    (body.stunned > 0 ? tuning.stunGrip : 1) * (isAirborne(body) ? AIR_CONTROL : 1) * control;
  const dirX = strength > 0.1 ? move.x / strength : 0;
  const dirZ = strength > 0.1 ? move.z / strength : 0;
  const along = body.vx * dirX + body.vz * dirZ;
  // Freinage : l'élan qui n'est pas dans la direction voulue (tout l'élan, sans direction). Il
  // ne dépend pas de `control` : celui qui frappe tient toujours sur ses pieds.
  const grip = tuning.grip * (body.stunned > 0 ? tuning.stunGrip : 1) * (isAirborne(body) ? 0 : 1);
  let restX = body.vx - dirX * Math.max(0, along);
  let restZ = body.vz - dirZ * Math.max(0, along);
  const rest = Math.hypot(restX, restZ);
  if (rest > 0) {
    const kept = Math.max(0, rest - grip * dt) / rest;
    restX *= kept;
    restZ *= kept;
  }
  // Poussée : forte à l'arrêt, nulle à la vitesse de marche.
  const target = tuning.walkSpeed * strength * control;
  const drive =
    along < target ? tuning.walkForce * footing * (1 - Math.max(0, along) / tuning.walkSpeed) : 0;
  const forward = Math.min(target, Math.max(0, along) + drive * dt);
  const slowing = along > target ? Math.max(target, along - grip * dt) : forward;
  body.vx = restX + dirX * slowing;
  body.vz = restZ + dirZ * slowing;
}

/** Il saute, s'il a les pieds au sol, qu'il tient debout et que le mini-jeu le permet. */
export function jumpBody(body: ArenaBody, tuning: BodyTuning): void {
  if (tuning.jumpSpeed <= 0 || isAirborne(body) || !isSteady(body)) return;
  body.vy = tuning.jumpSpeed;
}

/** Projeté vers `(nx, nz)` : il tombe, glisse, reste `downTime` au sol puis se relève. */
export function knockDown(
  body: ArenaBody,
  nx: number,
  nz: number,
  speed: number,
  downTime: number,
): void {
  body.vx = nx * speed;
  body.vz = nz * speed;
  body.downed = downTime;
  // Il se relève encore un peu étourdi.
  body.stunned = downTime + 0.35;
}

/** Fait avancer les corps de `dt` : la marche au sol, la pesanteur en l'air. */
export function moveBodies(bodies: ArenaBody[], tuning: BodyTuning, dt: number): void {
  for (const body of bodies) {
    body.x += body.vx * dt;
    body.z += body.vz * dt;
    if (!isAirborne(body)) continue;
    body.vy -= tuning.gravity * dt;
    body.y += body.vy * dt;
    if (body.y <= 0) {
      body.y = 0;
      body.vy = 0;
    }
  }
}

/**
 * Les contacts : ils ne se chevauchent pas, et finissent à la même vitesse le long du contact,
 * sans rebond. Celui qui s'arc-boute (`braced`) pèse plus lourd : on le fait à peine reculer.
 * L'ordre de `bodies` compte (les contacts se règlent l'un après l'autre) : à l'appelant de le
 * faire tourner d'un pas à l'autre pour que la place dans la liste ne donne pas l'avantage.
 */
export function collideBodies(
  bodies: ArenaBody[],
  tuning: BodyTuning,
  braced: ReadonlySet<PlayerId>,
): void {
  const weight = (body: ArenaBody) => (braced.has(body.id) ? tuning.braceWeight : 1);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      if (!a || !b || Math.abs(a.y - b.y) > CONTACT_HEIGHT) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= tuning.radius * 2) continue;
      if (distance === 0) {
        dx = 1;
        dz = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const nz = dz / distance;
      // `a` prend cette part de l'écart (la moitié à poids égal), le plus léger davantage.
      const share = weight(b) / (weight(a) + weight(b));
      const overlap = tuning.radius * 2 - distance;
      a.x -= nx * overlap * share;
      a.z -= nz * overlap * share;
      b.x += nx * overlap * (1 - share);
      b.z += nz * overlap * (1 - share);
      const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (closing <= 0) continue;
      a.vx -= nx * closing * share;
      a.vz -= nz * closing * share;
      b.vx += nx * closing * (1 - share);
      b.vz += nz * closing * (1 - share);
    }
  }
}

/** Retire `amount` à la vitesse au sol, sans la faire changer de sens. */
function slow(body: ArenaBody, amount: number): void {
  const speed = Math.hypot(body.vx, body.vz);
  const kept = speed > 0 ? Math.max(0, speed - amount) / speed : 0;
  body.vx *= kept;
  body.vz *= kept;
}

/** Tourne `body` vers `toward`, d'au plus `step` radians, par le plus court. */
function turn(body: ArenaBody, toward: number, step: number): void {
  let gap = (toward - body.facing) % (Math.PI * 2);
  if (gap > Math.PI) gap -= Math.PI * 2;
  if (gap < -Math.PI) gap += Math.PI * 2;
  body.facing += Math.max(-step, Math.min(step, gap));
}
