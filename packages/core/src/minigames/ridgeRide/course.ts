// La crête de Sur le fil (02-mini-jeux.md, fiche 56) : une fine arête de rocher qui serpente en
// descendant au-dessus d'un canyon. Elle est tirée de la graine de la partie (la même pour tous,
// chez l'hôte comme chez les joueurs, qui la dessinent), faite de lignes droites et de virages
// de rayon minimum garanti. Sa direction reste à moins de MAX_HEADING de l'axe de la descente
// (-z) : elle avance toujours, sans jamais repasser sur elle-même. Le portail des commandes
// inversées est au milieu, sur une ligne droite. Plan (x, z) en mètres, hauteur y.

/** Un point de la crête tous les SAMPLE mètres le long de son milieu. */
export const COURSE_SAMPLE = 0.5;
/** La longueur visée jusqu'à l'arrivée (mètres) ; la course continue un peu après la ligne. */
const TARGET_LENGTH = 280;
const START_STRAIGHT = 16;
const PORTAL_STRAIGHT = 18;
const FINISH_STRAIGHT = 14;
const RUN_OUT = 26;
/** La direction ne s'écarte pas plus de ça de la descente (radians). */
const MAX_HEADING = (70 * Math.PI) / 180;
/** La pente moyenne (mètres de descente par mètre), et ses ondulations (le départ descend). */
const SLOPE = 0.07;
const WAVE_HEIGHT = 0.4;
const WAVE_LENGTH = 23;
/** Les largeurs se fondent de l'une à l'autre sur cette longueur (mètres). */
const WIDTH_BLEND = 6;

export type CourseSample = {
  x: number;
  z: number;
  y: number;
  /** La direction du milieu de la crête (radians : 0 vers -z, positif vers +x). */
  heading: number;
  width: number;
  /** La courbure (1 / rayon, par mètre) : 0 en ligne droite. */
  curvature: number;
};

export type Course = {
  samples: CourseSample[];
  /** La distance (le long du milieu) de la ligne d'arrivée, et celle du portail. */
  finish: number;
  portal: number;
};

type Piece =
  | { kind: 'straight'; length: number; width: number }
  | { kind: 'arc'; radius: number; angle: number; width: number };

/** Une suite de valeurs entre 0 et 1, toujours la même pour une même graine. */
function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<number, Course>();

/** La crête de cette graine (calculée une fois). */
export function courseOf(seed: number): Course {
  const known = cache.get(seed);
  if (known) return known;
  const course = buildCourse(seed);
  cache.set(seed, course);
  return course;
}

function buildCourse(seed: number): Course {
  const next = random(seed);
  const between = (min: number, max: number) => min + next() * (max - min);
  const pieces: Piece[] = [{ kind: 'straight', length: START_STRAIGHT, width: 3.2 }];
  let heading = 0;
  let length = START_STRAIGHT;
  let portal = 0;
  let wasArc = false;
  while (length < TARGET_LENGTH - FINISH_STRAIGHT) {
    // Plus loin, plus dur : des virages plus serrés et une crête plus fine.
    const progress = length / TARGET_LENGTH;
    if (portal === 0 && length >= TARGET_LENGTH / 2) {
      pieces.push({ kind: 'straight', length: PORTAL_STRAIGHT, width: 2.4 });
      portal = length + PORTAL_STRAIGHT / 2;
      length += PORTAL_STRAIGHT;
      wasArc = false;
      continue;
    }
    if (wasArc && next() < 0.55) {
      const piece = {
        kind: 'straight' as const,
        length: between(6, 16),
        width: between(2.6 - progress * 0.9, 3 - progress * 0.9),
      };
      pieces.push(piece);
      length += piece.length;
      wasArc = false;
      continue;
    }
    const radius = between(10 - progress * 2, 22 - progress * 6);
    let angle = between(0.5, 1.35) * (next() < 0.5 ? -1 : 1);
    // Trop tournée d'un côté : on repart de l'autre, sans dépasser l'écart permis.
    if (Math.abs(heading + angle) > MAX_HEADING) angle = -angle;
    angle = Math.max(-MAX_HEADING - heading, Math.min(MAX_HEADING - heading, angle));
    const width = between(2.2 - progress * 0.4, 2.7 - progress * 0.5);
    pieces.push({ kind: 'arc', radius, angle, width });
    heading += angle;
    length += Math.abs(angle) * radius;
    wasArc = true;
  }
  pieces.push({ kind: 'straight', length: FINISH_STRAIGHT, width: 2.2 });
  const finish = length + FINISH_STRAIGHT;
  pieces.push({ kind: 'straight', length: RUN_OUT, width: 3.2 });
  return { samples: sample(pieces), finish, portal };
}

/** Le milieu de la crête, point par point, et ses largeurs fondues. */
function sample(pieces: Piece[]): CourseSample[] {
  const raw: { x: number; z: number; heading: number; width: number; curvature: number }[] = [];
  let x = 0;
  let z = 0;
  let heading = 0;
  for (const piece of pieces) {
    const length = piece.kind === 'straight' ? piece.length : Math.abs(piece.angle) * piece.radius;
    const count = Math.max(1, Math.round(length / COURSE_SAMPLE));
    const turn = piece.kind === 'arc' ? piece.angle / count : 0;
    const curvature = piece.kind === 'arc' ? 1 / piece.radius : 0;
    for (let index = 0; index < count; index++) {
      raw.push({ x, z, heading, width: piece.width, curvature });
      heading += turn / 2;
      x += Math.sin(heading) * COURSE_SAMPLE;
      z -= Math.cos(heading) * COURSE_SAMPLE;
      heading += turn / 2;
    }
  }
  raw.push({ x, z, heading, width: raw.at(-1)?.width ?? 3, curvature: 0 });
  const blend = Math.round(WIDTH_BLEND / COURSE_SAMPLE / 2);
  return raw.map((point, index) => {
    let sum = 0;
    let weights = 0;
    for (let k = -blend; k <= blend; k++) {
      const other = raw[Math.min(raw.length - 1, Math.max(0, index + k))];
      if (!other) continue;
      sum += other.width;
      weights += 1;
    }
    const s = index * COURSE_SAMPLE;
    const y = -SLOPE * s - WAVE_HEIGHT * Math.sin((s / WAVE_LENGTH) * Math.PI * 2);
    return { ...point, y, width: sum / weights };
  });
}

/** La pente sous ce point (mètres de descente par mètre, positive en descente). */
export function slopeAt(course: Course, s: number): number {
  const index = Math.max(0, Math.min(course.samples.length - 2, Math.floor(s / COURSE_SAMPLE)));
  const here = course.samples[index];
  const ahead = course.samples[index + 1];
  if (!here || !ahead) return 0;
  return (here.y - ahead.y) / COURSE_SAMPLE;
}

/** Le point de la crête à la distance `s` (le plus proche échantillon). */
export function sampleAt(course: Course, s: number): CourseSample {
  const index = Math.max(0, Math.min(course.samples.length - 1, Math.round(s / COURSE_SAMPLE)));
  return course.samples[index] as CourseSample;
}

/**
 * Où est ce point par rapport à la crête, en cherchant près de l'échantillon `near` : sa distance
 * le long du milieu, son écart de côté (positif à droite), et le rang de l'échantillon.
 */
export function locate(
  course: Course,
  x: number,
  z: number,
  near: number,
): { s: number; lateral: number; index: number } {
  let best = near;
  let bestDistance = Number.POSITIVE_INFINITY;
  const from = Math.max(0, near - 8);
  const to = Math.min(course.samples.length - 1, near + 16);
  for (let index = from; index <= to; index++) {
    const point = course.samples[index];
    if (!point) continue;
    const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  const point = course.samples[best] as CourseSample;
  const dx = x - point.x;
  const dz = z - point.z;
  const along = Math.sin(point.heading) * dx - Math.cos(point.heading) * dz;
  const lateral = Math.cos(point.heading) * dx + Math.sin(point.heading) * dz;
  return { s: best * COURSE_SAMPLE + along, lateral, index: best };
}
