import type { Point } from '../board/board';

// Géométrie du chemin d'un étage (04-carte.md, section 3) : il contourne la montagne en
// montant, en grands lacets, mais jamais en ligne droite. On le décrit par des points de
// passage autour de la montagne (angle en tours, rayon) ; la courbe passe par eux en douceur,
// monte régulièrement, et les cases sont posées à intervalles réguliers le long de la courbe.

export type Waypoint = {
  /** Angle autour de la montagne, en tours : 0 face à la plage, positif vers la gauche. */
  turn: number;
  /** Distance à l'axe de la montagne, en mètres. */
  radius: number;
};

export type FloorRoute = {
  waypoints: Waypoint[];
  /** Hauteur du chemin au début et à la fin de l'étage. */
  height: [number, number];
};

/** Le point "0 tour" est face à la plage, devant la caméra de départ. */
const FRONT_ANGLE = Math.PI / 2;
/** Finesse du calcul de longueur : assez pour des cases régulières au centimètre près. */
const SAMPLES = 2000;

export type Curve = (s: number) => Point;

/**
 * La courbe d'un étage, `s` allant de 0 (début) à 1 (fin) en proportion de la distance
 * parcourue : le chemin monte régulièrement, et `s = k / (n - 1)` tombe sur la case k.
 */
export function routeCurve(route: FloorRoute): Curve {
  const points = route.waypoints.map(({ turn, radius }) => {
    const angle = FRONT_ANGLE + 2 * Math.PI * turn;
    return { x: radius * Math.cos(angle), z: radius * Math.sin(angle) };
  });
  const samples = Array.from({ length: SAMPLES + 1 }, (_, i) => catmullRom(points, i / SAMPLES));
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]];
    lengths.push((lengths[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0));
  }
  const total = lengths.at(-1) ?? 0;
  const [low, high] = route.height;
  return (s) => {
    const clamped = Math.min(1, Math.max(0, s));
    const target = clamped * total;
    // Recherche dichotomique de l'échantillon à cette distance, puis interpolation.
    let lowIndex = 0;
    let highIndex = SAMPLES;
    while (highIndex - lowIndex > 1) {
      const middle = (lowIndex + highIndex) >> 1;
      if ((lengths[middle] ?? 0) < target) lowIndex = middle;
      else highIndex = middle;
    }
    const start = lengths[lowIndex] ?? 0;
    const span = (lengths[highIndex] ?? start) - start;
    const t = span > 0 ? (target - start) / span : 0;
    const a = samples[lowIndex] ?? { x: 0, z: 0 };
    const b = samples[highIndex] ?? a;
    return { x: a.x + (b.x - a.x) * t, y: low + (high - low) * clamped, z: a.z + (b.z - a.z) * t };
  };
}

/**
 * Courbe de Catmull-Rom qui passe par tous les points, `s` de 0 au premier à 1 au dernier.
 * Écrite ici plutôt que tirée de three : core ne dépend de rien (il tourne aussi sur le
 * serveur). Les cases sont ensuite réparties par longueur, pas par `s`.
 */
function catmullRom(points: { x: number; z: number }[], s: number): { x: number; z: number } {
  const segments = points.length - 1;
  const at = Math.min(segments - 1e-9, Math.max(0, s * segments));
  const i = Math.floor(at);
  const t = at - i;
  const p = (k: number) => points[Math.min(points.length - 1, Math.max(0, k))] ?? { x: 0, z: 0 };
  const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
  const blend = (a: number, b: number, c: number, d: number) =>
    0.5 *
    (2 * b +
      (-a + c) * t +
      (2 * a - 5 * b + 4 * c - d) * t * t +
      (-a + 3 * b - 3 * c + d) * t ** 3);
  return { x: blend(p0.x, p1.x, p2.x, p3.x), z: blend(p0.z, p1.z, p2.z, p3.z) };
}

/**
 * `count` points répartis à intervalles réguliers le long de la courbe, de `from` à `to`
 * (positions entre 0 et 1), extrémités comprises.
 */
export function spacedAlong(curve: Curve, count: number, from = 0, to = 1): Point[] {
  const samples = Array.from({ length: SAMPLES + 1 }, (_, i) =>
    curve(from + ((to - from) * i) / SAMPLES),
  );
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) {
    lengths.push((lengths[i - 1] ?? 0) + horizontalDistance(samples[i - 1], samples[i]));
  }
  const total = lengths.at(-1) ?? 0;
  const points: Point[] = [];
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = count === 1 ? 0 : (total * k) / (count - 1);
    while (cursor < SAMPLES && (lengths[cursor + 1] ?? total) < target) cursor++;
    points.push(round(samples[cursor] ?? curve(to)));
  }
  return points;
}

/**
 * La courbe d'une voie annexe : de l'embranchement (`a`) à la jonction (`b`), elle coupe en
 * travers et se bombe de `bow` mètres sur le côté (positif : vers l'extérieur de la
 * montagne), et monte de `rise` mètres. Le chemin principal fait une bosse d'un côté, la
 * voie annexe passe de l'autre : deux vraies routes autour d'un rocher, d'une mare.
 */
export function laneCurve(a: Point, b: Point, bow: number, rise = 0): Curve {
  // La normale de la corde, tournée vers l'extérieur de la montagne.
  let nx = b.z - a.z;
  let nz = -(b.x - a.x);
  const length = Math.hypot(nx, nz) || 1;
  nx /= length;
  nz /= length;
  const middle = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  if (nx * middle.x + nz * middle.z < 0) {
    nx = -nx;
    nz = -nz;
  }
  return (s) => {
    const bulge = Math.sin(Math.PI * s);
    return {
      x: a.x + (b.x - a.x) * s + nx * bow * bulge,
      y: a.y + (b.y - a.y) * s + rise * bulge,
      z: a.z + (b.z - a.z) * s + nz * bow * bulge,
    };
  };
}

export function horizontalDistance(a: Point | undefined, b: Point | undefined): number {
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function round({ x, y, z }: Point): Point {
  const r = (value: number) => Math.round(value * 100) / 100;
  return { x: r(x), y: r(y), z: r(z) };
}
