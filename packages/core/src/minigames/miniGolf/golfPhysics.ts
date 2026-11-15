import type { GolfFeature, GolfHole } from './holes';

// La physique d'une balle de mini-golf sur un trou (holes.ts) : elle roule (le frottement la
// freine), rebondit sur les bordures, les plots et les obstacles qui tournent, est poussée par les
// pentes et les tapis, s'envole d'un tremplin, passe dans les tuyaux, tombe dans le vide hors des
// sols, et entre dans le trou si elle y arrive assez lentement. Pure et déterministe : la même
// pour la partie et pour les bots qui essaient leurs coups.

export const GOLF_BALL_RADIUS = 0.12;
export const CUP_RADIUS = 0.2;
/**
 * Le trou est un vrai trou (retour de test : "c'est pas juste elle touche et ça passe") : au-
 * dessus de lui, la balle n'est plus portée et bascule vers le fond (CUP_PULL, m/s²) ; elle est
 * dedans quand son centre passe sous le bord (CUP_DROP du centre) assez lentement (CUP_SINK) ;
 * plus vite, elle tape la paroi d'en face et rebondit (CUP_WALL) : elle peut tourner sur le bord
 * et ressortir. Au-delà de CUP_SKIP, elle passe par-dessus sans toucher le fond.
 */
const CUP_PULL = 22;
const CUP_SINK = 2.3;
const CUP_WALL = 0.35;
const CUP_SKIP = 5.5;
/** Le frottement : une décélération fixe (m/s²) et une part de la vitesse par seconde. */
const ROLL = 1.1;
const DRAG = 0.35;
/** Plus lente que ça, la balle s'arrête. */
const STOP_SPEED = 0.08;
/** Les rebonds : sur une bordure, sur un obstacle ; un plot renvoie au moins à BUMPER_KICK. */
const WALL_BOUNCE = 0.72;
const BLADE_BOUNCE = 0.85;
const BUMPER_KICK = 4.5;
/** Les pas de calcul par pas de jeu (les rebonds restent nets à pleine vitesse). */
const SUBSTEPS = 4;
/** Les pales d'un moulin. */
export const BLADES = 4;
/** Un tuyau aspire la balle à tant de son entrée, et la recrache au moins à cette vitesse. */
export const PIPE_RADIUS = 0.5;
const PIPE_SPEED = 3.5;

/**
 * La longueur d'un vecteur. Pas Math.hypot : bien plus lent (la balle est simulée des centaines
 * de fois par coup de bot), et son arrondi n'est pas garanti identique d'un moteur JS à l'autre,
 * celui de Math.sqrt si.
 */
function lengthOf(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** Les bordures d'un trou, avec leur boîte élargie de la balle (pour ignorer d'emblée les loin). */
type WallBox = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};
const wallBoxes = new WeakMap<GolfHole, WallBox[]>();

function wallsOf(hole: GolfHole): WallBox[] {
  let boxes = wallBoxes.get(hole);
  if (!boxes) {
    boxes = hole.walls.map((wall) => ({
      ...wall,
      minX: Math.min(wall.ax, wall.bx) - GOLF_BALL_RADIUS,
      maxX: Math.max(wall.ax, wall.bx) + GOLF_BALL_RADIUS,
      minZ: Math.min(wall.az, wall.bz) - GOLF_BALL_RADIUS,
      maxZ: Math.max(wall.az, wall.bz) + GOLF_BALL_RADIUS,
    }));
    wallBoxes.set(hole, boxes);
  }
  return boxes;
}

/** Ce qu'on sait d'une balle qui roule. */
export type BallMotion = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Secondes restantes en l'air (tremplin), 0 au sol. */
  airborne: number;
  /** Le pas où elle est sortie d'un tuyau (elle n'y rentre pas aussitôt), ou -1. */
  piped: number;
};

export type GolfBallEvent = 'holed' | 'fell' | 'stopped' | null;

/** L'angle d'une pièce qui tourne (moulin, barre) à ce temps (secondes). */
export function spinAngle(feature: { speed: number }, time: number): number {
  return feature.speed * time;
}

/** Le décalage en x d'un pont qui va et vient, à ce temps. */
export function bridgeOffset(feature: { travel: number; period: number }, time: number): number {
  return Math.sin((time / feature.period) * Math.PI * 2) * feature.travel;
}

/** Le point (x, z) est sur un sol du trou à ce temps (les ponts bougent). */
export function isOnGround(hole: GolfHole, x: number, z: number, time: number): boolean {
  for (const surface of hole.surfaces) {
    if (surface.kind === 'rect') {
      if (Math.abs(x - surface.x) <= surface.hx && Math.abs(z - surface.z) <= surface.hz)
        return true;
    } else if (lengthOf(x - surface.x, z - surface.z) <= surface.r) {
      return true;
    }
  }
  for (const feature of hole.features) {
    if (feature.kind !== 'bridge' && feature.kind !== 'ramp') continue;
    const offset = feature.kind === 'bridge' ? bridgeOffset(feature, time) : 0;
    if (Math.abs(x - feature.x - offset) <= feature.hx && Math.abs(z - feature.z) <= feature.hz) {
      return true;
    }
  }
  return false;
}

/** Les segments des pièces qui tournent à ce temps : leur centre, leurs bouts, leur vitesse. */
function spinningSegments(feature: GolfFeature, time: number) {
  if (feature.kind === 'windmill') {
    const base = spinAngle(feature, time);
    return Array.from({ length: BLADES }, (_, index) => {
      const angle = base + (index / BLADES) * Math.PI * 2;
      return {
        ax: feature.x,
        az: feature.z,
        bx: feature.x + Math.sin(angle) * feature.length,
        bz: feature.z + Math.cos(angle) * feature.length,
        speed: feature.speed,
      };
    });
  }
  if (feature.kind === 'spinner') {
    const angle = spinAngle(feature, time);
    return [
      {
        ax: feature.x - Math.sin(angle) * feature.length,
        az: feature.z - Math.cos(angle) * feature.length,
        bx: feature.x + Math.sin(angle) * feature.length,
        bz: feature.z + Math.cos(angle) * feature.length,
        speed: feature.speed,
      },
    ];
  }
  return [];
}

/**
 * Rebond sur un segment : la balle est sortie de lui et sa vitesse (relative au segment qui
 * bouge, `wx`, `wz` au point de contact) renvoyée avec `bounce`.
 */
function bounceOffSegment(
  ball: BallMotion,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  bounce: number,
  wx = 0,
  wz = 0,
): boolean {
  const ex = bx - ax;
  const ez = bz - az;
  const length = ex * ex + ez * ez;
  const share =
    length > 0 ? Math.max(0, Math.min(1, ((ball.x - ax) * ex + (ball.z - az) * ez) / length)) : 0;
  const px = ax + ex * share;
  const pz = az + ez * share;
  let nx = ball.x - px;
  let nz = ball.z - pz;
  const gap = lengthOf(nx, nz);
  if (gap >= GOLF_BALL_RADIUS) return false;
  if (gap === 0) {
    nx = -ez;
    nz = ex;
  }
  const norm = lengthOf(nx, nz) || 1;
  nx /= norm;
  nz /= norm;
  ball.x = px + nx * GOLF_BALL_RADIUS;
  ball.z = pz + nz * GOLF_BALL_RADIUS;
  const rvx = ball.vx - wx;
  const rvz = ball.vz - wz;
  const into = rvx * nx + rvz * nz;
  if (into < 0) {
    ball.vx = wx + rvx - (1 + bounce) * into * nx;
    ball.vz = wz + rvz - (1 + bounce) * into * nz;
  }
  return true;
}

/**
 * Fait avancer la balle d'un pas (`dt`) sur ce trou, au temps `time` (secondes, pour ce qui
 * bouge) et au pas `tick` (pour les tuyaux). Ce qui lui arrive : rentrée, tombée, arrêtée.
 */
export function advanceBall(
  ball: BallMotion,
  hole: GolfHole,
  time: number,
  tick: number,
  dt: number,
): GolfBallEvent {
  const sub = dt / SUBSTEPS;
  const walls = wallsOf(hole);
  for (let step = 0; step < SUBSTEPS; step++) {
    const now = time + step * sub;
    if (ball.airborne > 0) {
      ball.airborne = Math.max(0, ball.airborne - sub);
      ball.x += ball.vx * sub;
      ball.z += ball.vz * sub;
      continue;
    }
    // Les pentes, les tapis, la butte.
    for (const feature of hole.features) {
      if (feature.kind === 'slope') {
        if (
          Math.abs(ball.x - feature.x) <= feature.hx &&
          Math.abs(ball.z - feature.z) <= feature.hz
        ) {
          ball.vx += feature.ax * sub;
          ball.vz += feature.az * sub;
        }
      } else if (feature.kind === 'mound') {
        const dx = ball.x - feature.x;
        const dz = ball.z - feature.z;
        const gap = lengthOf(dx, dz);
        if (gap > 0.25 && gap < feature.r) {
          const push = feature.push * (gap / feature.r);
          ball.vx += (dx / gap) * push * sub;
          ball.vz += (dz / gap) * push * sub;
        }
      }
    }
    // Le frottement.
    const speed = lengthOf(ball.vx, ball.vz);
    if (speed > 0) {
      const kept = Math.max(0, speed - (ROLL + DRAG * speed) * sub) / speed;
      ball.vx *= kept;
      ball.vz *= kept;
    }
    ball.x += ball.vx * sub;
    ball.z += ball.vz * sub;
    for (const wall of walls) {
      if (ball.x < wall.minX || ball.x > wall.maxX || ball.z < wall.minZ || ball.z > wall.maxZ)
        continue;
      bounceOffSegment(ball, wall.ax, wall.az, wall.bx, wall.bz, WALL_BOUNCE);
    }
    for (const feature of hole.features) {
      if (feature.kind === 'bumper') {
        const dx = ball.x - feature.x;
        const dz = ball.z - feature.z;
        const gap = lengthOf(dx, dz);
        if (gap < feature.r + GOLF_BALL_RADIUS && gap > 0) {
          const nx = dx / gap;
          const nz = dz / gap;
          ball.x = feature.x + nx * (feature.r + GOLF_BALL_RADIUS);
          ball.z = feature.z + nz * (feature.r + GOLF_BALL_RADIUS);
          const into = ball.vx * nx + ball.vz * nz;
          const out = Math.max(BUMPER_KICK, -into);
          ball.vx += (out - into) * nx;
          ball.vz += (out - into) * nz;
        }
      } else if (feature.kind === 'windmill' || feature.kind === 'spinner') {
        const reach = feature.length + GOLF_BALL_RADIUS;
        const fx = ball.x - feature.x;
        const fz = ball.z - feature.z;
        if (fx * fx + fz * fz > reach * reach) continue;
        for (const blade of spinningSegments(feature, now)) {
          // La vitesse de la pale au point le plus proche : elle pousse la balle.
          const rx = ball.x - feature.x;
          const rz = ball.z - feature.z;
          const wx = blade.speed * rz;
          const wz = -blade.speed * rx;
          bounceOffSegment(ball, blade.ax, blade.az, blade.bx, blade.bz, BLADE_BOUNCE, wx, wz);
        }
      } else if (feature.kind === 'ramp') {
        const isOnRamp =
          Math.abs(ball.x - feature.x) <= feature.hx && Math.abs(ball.z - feature.z) <= feature.hz;
        if (isOnRamp && lengthOf(ball.vx, ball.vz) >= feature.speed) ball.airborne = feature.flight;
      } else if (feature.kind === 'pipe') {
        if (
          tick - ball.piped > 10 &&
          lengthOf(ball.x - feature.ax, ball.z - feature.az) < PIPE_RADIUS
        ) {
          const out = Math.max(PIPE_SPEED, lengthOf(ball.vx, ball.vz));
          ball.x = feature.bx;
          ball.z = feature.bz;
          ball.vx = feature.dx * out;
          ball.vz = feature.dz * out;
          ball.piped = tick;
        }
      }
    }
    if (cup(ball, hole, sub)) return 'holed';
    if (!isOnGround(hole, ball.x, ball.z, now)) return 'fell';
  }
  if (ball.airborne <= 0 && lengthOf(ball.vx, ball.vz) < STOP_SPEED) {
    ball.vx = 0;
    ball.vz = 0;
    return 'stopped';
  }
  return null;
}

/** La distance du centre de la balle au centre du trou en dessous de laquelle elle est tombée. */
const CUP_DROP = CUP_RADIUS - GOLF_BALL_RADIUS * 0.55;

/**
 * Le trou, pendant un pas de calcul : au-dessus de lui, la balle bascule vers le centre ; passée
 * sous le bord, elle tombe si elle est assez lente, sinon elle rebondit sur la paroi d'en face.
 * Vrai : elle est dedans.
 */
function cup(ball: BallMotion, hole: GolfHole, sub: number): boolean {
  const dx = ball.x - hole.cup.x;
  const dz = ball.z - hole.cup.z;
  const gap = lengthOf(dx, dz);
  const speed = lengthOf(ball.vx, ball.vz);
  if (gap >= CUP_RADIUS || speed >= CUP_SKIP) return false;
  const nx = gap > 0 ? dx / gap : 0;
  const nz = gap > 0 ? dz / gap : 0;
  // Elle bascule vers le fond, d'autant plus qu'elle est loin du bord.
  ball.vx -= nx * CUP_PULL * sub;
  ball.vz -= nz * CUP_PULL * sub;
  if (gap >= CUP_DROP) return false;
  if (speed < CUP_SINK) {
    ball.vx = 0;
    ball.vz = 0;
    ball.x = hole.cup.x;
    ball.z = hole.cup.z;
    return true;
  }
  // Trop vite : elle tape la paroi d'en face (en sortant) et rebondit vers le milieu, ralentie.
  const out = ball.vx * nx + ball.vz * nz;
  if (out > 0) {
    ball.vx -= (1 + CUP_WALL) * out * nx;
    ball.vz -= (1 + CUP_WALL) * out * nz;
    ball.vx *= 0.8;
    ball.vz *= 0.8;
  }
  return false;
}
