import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Clic-clac ! (02-mini-jeux.md, fiche 53) : chacun derrière son appareil photo, en haut du phare.
// On montre d'abord le sujet à photographier, au milieu du ciel ; puis des choses passent : la
// cible trois fois, chaque fois précédée de son sosie (l'oiseau bleu quand il faut le rouge,
// l'avion à hélice quand il faut le jet), et des leurres variés tout du long. On cadre librement
// (souris, stick ou flèches) et on déclenche : UNE seule photo. Le sujet le plus proche du centre
// de la photo est celui qu'elle montre : la cible, et elle vaut ses points (plus elle est au
// centre, plus elle en vaut) ; un leurre ou du ciel vide, zéro. Tout se joue dans le plan du ciel,
// face à la caméra : x à droite, y en haut, en mètres.

export type SubjectKind =
  | 'redBird'
  | 'blueBird'
  | 'jet'
  | 'propeller'
  | 'yellowCopter'
  | 'greenCopter'
  | 'rocket'
  | 'ufo';

/** Comment vole un sujet : en battant des ailes, en ligne droite (vite ou non), par bonds... */
type Flight = 'flap' | 'glide' | 'cruise' | 'hover' | 'climb' | 'hop';

/** Chaque sujet : son vol, sa vitesse (m/s, au hasard entre les deux), et son sosie. */
const SUBJECTS: Record<
  SubjectKind,
  { flight: Flight; speed: [number, number]; twin: SubjectKind | null }
> = {
  redBird: { flight: 'flap', speed: [2.6, 3.6], twin: 'blueBird' },
  blueBird: { flight: 'flap', speed: [2.6, 3.6], twin: 'redBird' },
  jet: { flight: 'glide', speed: [8.5, 10.5], twin: 'propeller' },
  propeller: { flight: 'cruise', speed: [4.2, 5.4], twin: 'jet' },
  yellowCopter: { flight: 'hover', speed: [2.4, 3.2], twin: 'greenCopter' },
  greenCopter: { flight: 'hover', speed: [2.4, 3.2], twin: 'yellowCopter' },
  // La fusée monte : sa vitesse est sa dérive de côté.
  rocket: { flight: 'climb', speed: [0.6, 1.6], twin: null },
  ufo: { flight: 'hop', speed: [2.2, 2.8], twin: null },
};
export const SUBJECT_KINDS = Object.keys(SUBJECTS) as SubjectKind[];

/** Le ciel où l'on vise (mètres) : plus bas que `bottom`, la rambarde du phare le cache. */
export const PHOTO_SKY = { halfWidth: 10, bottom: 2.2, top: 9 } as const;
/** Le cadre d'une photo (mètres), et le pas de ses points : ce que l'œil distingue. */
export const PHOTO_FRAME = { width: 3, height: 2 } as const;
const POINTS_GRAIN = 5;
export const MAX_PHOTO_POINTS = 100;
/** On montre la cible pendant ce temps (secondes) ; on ne peut pas déclencher avant. */
export const SHOWCASE_TIME = 3;
/** Où la cible est montrée au début : au milieu du ciel. */
export const SHOWCASE_SPOT = { x: 0, y: 5.8 } as const;
/** Les passages de la cible, et quand (secondes, plus un retard au hasard jusqu'à PASS_JITTER). */
export const PHOTO_PASSES = 3;
const PASS_TIMES = [5, 14, 23] as const;
const PASS_JITTER = 1.5;
/** Au bac à sable, la cible repasse sans fin : la première fois à ce temps, puis à cet écart. */
const PRACTICE_FIRST_PASS = 4;
const PRACTICE_PASS_GAP = 7;
/** Le sosie passe ce temps avant la cible (secondes, au hasard entre les deux). */
const TRAP_LEAD: [number, number] = [0.5, 1.1];
/** L'écart entre deux leurres (secondes, au hasard entre les deux). */
const DECOY_GAP: [number, number] = [0.9, 1.7];
/** Parmi les leurres, la part de sosies de la cible (s'il y en a un). */
const TWIN_SHARE = 0.3;
/** La partie finit ce temps après la dernière photo, ou après le dernier passage (secondes). */
const END_PAUSE = 1.2;
/** Au bac à sable, on peut reprendre une photo au bout de ce temps (secondes). */
const PRACTICE_RETAKE = 1;
/** Un sujet qui vole depuis plus longtemps est parti (secondes). */
const LONGEST_FLIGHT = 16;
/** Les sujets entrent et sortent du ciel à cette distance de son bord (mètres). */
const EDGE_MARGIN = 1.5;

/**
 * Un sujet dans le ciel : quoi, son rôle (la cible, un leurre, ou la cible montrée au début, qui
 * ne compte pas), le passage de la cible qu'il est (0, 1, 2 ; -1 sinon), et comment il vole :
 * d'où, dans quel sens, à quelle vitesse ; `slope` et `phase` varient sa trajectoire.
 */
export type SkySubject = {
  id: number;
  kind: SubjectKind;
  role: 'target' | 'decoy' | 'showcase';
  pass: number;
  launchAt: number;
  x0: number;
  y0: number;
  dir: -1 | 1;
  speed: number;
  slope: number;
  phase: number;
};

/** Une photo : où était son centre, quand, le sujet qu'elle montre (ou null : du ciel), ses points. */
export type SkyPhoto = {
  x: number;
  y: number;
  takenAt: number;
  kind: SubjectKind | null;
  points: number;
};

export type Photographer = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Le centre de son cadre, dans le plan du ciel. */
  aimX: number;
  aimY: number;
  held: boolean;
  photo: SkyPhoto | null;
};

export type SkyPhotoState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** Le sujet à photographier. */
  target: SubjectKind;
  subjects: SkySubject[];
  nextId: number;
  /** Les passages de la cible déjà partis, et le pas où part le prochain leurre. */
  passes: number;
  nextDecoyAt: number;
  fighters: Photographer[];
};

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const between = (key: string, [min, max]: readonly [number, number]) =>
  min + hashUnit(key) * (max - min);
const pick = <T>(key: string, items: readonly T[]): T =>
  items[Math.min(items.length - 1, Math.floor(hashUnit(key) * items.length))] as T;

/** Où peut aller le centre du cadre : le cadre entier reste dans le ciel. */
export function photoAimBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: -PHOTO_SKY.halfWidth + PHOTO_FRAME.width / 2,
    maxX: PHOTO_SKY.halfWidth - PHOTO_FRAME.width / 2,
    minY: PHOTO_SKY.bottom + PHOTO_FRAME.height / 2,
    maxY: PHOTO_SKY.top - PHOTO_FRAME.height / 2,
  };
}

export function twinOf(kind: SubjectKind): SubjectKind | null {
  return SUBJECTS[kind].twin;
}

/** La soucoupe : un bond (HOP_STEP de sa vitesse) toutes les HOP_TIME secondes, puis du surplace. */
const HOP_TIME = 1.3;
const HOP_DASH = 0.35;
const smooth = (u: number) => u * u * (3 - 2 * u);

/** Où est le sujet à ce pas (fraction comprise), dans le plan du ciel. */
export function subjectPosition(subject: SkySubject, tick: number): { x: number; y: number } {
  const t = Math.max(0, tick - subject.launchAt) * ARENA_STEP;
  const { x0, y0, dir, speed, slope, phase } = subject;
  if (subject.role === 'showcase') {
    // Il flotte au milieu, puis file vers le haut à la fin de la présentation.
    const leaving = Math.max(0, t - SHOWCASE_TIME);
    return {
      x: x0 + dir * 2 * leaving * leaving,
      y: y0 + 0.2 * Math.sin(t * 2.4) + 7 * leaving * leaving,
    };
  }
  switch (SUBJECTS[subject.kind].flight) {
    case 'flap':
      return { x: x0 + dir * speed * t, y: y0 + 0.35 * Math.sin(Math.PI * 1.6 * t + phase) };
    case 'glide':
      return { x: x0 + dir * speed * t, y: y0 + slope * t };
    case 'cruise':
      return { x: x0 + dir * speed * t, y: y0 + 0.15 * Math.sin(Math.PI * t + phase) };
    case 'hover':
      return { x: x0 + dir * speed * t, y: y0 + 0.3 * Math.sin(Math.PI * 0.9 * t + phase) };
    case 'climb':
      return { x: x0 + dir * speed * t, y: y0 + 1.2 * t + 0.9 * t * t };
    case 'hop': {
      const hop = Math.floor(t / HOP_TIME);
      const u = (t - hop * HOP_TIME) / HOP_TIME;
      const ease = u < HOP_DASH ? smooth(u / HOP_DASH) : 1;
      const lift = (k: number) => Math.sin(phase * 7.13 + k * 2.71) * 1.1;
      return {
        x: x0 + dir * (hop + ease) * speed * HOP_TIME,
        y: y0 + lift(hop) + (lift(hop + 1) - lift(hop)) * ease,
      };
    }
  }
}

/** Le sujet est dans le ciel (parti, pas encore sorti). */
export function isInSky(subject: SkySubject, tick: number): boolean {
  if (tick < subject.launchAt || tick - subject.launchAt > steps(LONGEST_FLIGHT)) return false;
  const { x, y } = subjectPosition(subject, tick);
  const margin = EDGE_MARGIN + 0.5;
  return (
    Math.abs(x) < PHOTO_SKY.halfWidth + margin &&
    y > PHOTO_SKY.bottom - 2.5 &&
    y < PHOTO_SKY.top + margin
  );
}

/** Le pas où le sujet a quitté le ciel. */
function flightEnd(subject: SkySubject): number {
  let tick = subject.launchAt;
  while (isInSky(subject, tick)) tick += 1;
  return tick;
}

/**
 * Un sujet qui part : d'un bord, dans le sens `dir`, à la hauteur `y0` (ou de sous la rambarde
 * pour la fusée). `key` tire sa vitesse et sa trajectoire.
 */
function launch(
  base: { id: number; kind: SubjectKind; role: SkySubject['role']; pass: number; launchAt: number },
  key: string,
  dir: -1 | 1,
  y0: number,
): SkySubject {
  const { flight, speed } = SUBJECTS[base.kind];
  const flying = {
    ...base,
    dir,
    speed: between(`${key}:speed`, speed),
    slope: between(`${key}:slope`, [-0.4, 0.4]),
    phase: hashUnit(`${key}:phase`) * Math.PI * 2,
  };
  if (flight === 'climb') {
    const reach = PHOTO_SKY.halfWidth - 3;
    return { ...flying, x0: between(`${key}:x`, [-reach, reach]), y0: PHOTO_SKY.bottom - 1.6 };
  }
  return { ...flying, x0: -dir * (PHOTO_SKY.halfWidth + EDGE_MARGIN), y0 };
}

const skyHeight = (key: string) =>
  between(key, [PHOTO_SKY.bottom + 0.8, PHOTO_SKY.top - 0.8] as const);
const side = (key: string): -1 | 1 => (hashUnit(key) < 0.5 ? -1 : 1);

/** Le pas où part le passage `pass` de la cible. */
function passAt(state: Pick<SkyPhotoState, 'seed' | 'practice'>, pass: number): number {
  if (state.practice) return steps(PRACTICE_FIRST_PASS + pass * PRACTICE_PASS_GAP);
  const base = PASS_TIMES[pass] ?? Number.POSITIVE_INFINITY;
  return steps(base + between(`${state.seed}:pass:${pass}`, [0, PASS_JITTER]));
}

/** Le pas où part le sosie qui précède ce passage. */
function trapAt(state: Pick<SkyPhotoState, 'seed' | 'practice'>, pass: number): number {
  return passAt(state, pass) - steps(between(`${state.seed}:trap-lead:${pass}`, TRAP_LEAD));
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): SkyPhotoState {
  const target = pick(`${seed}:target`, SUBJECT_KINDS);
  const showcase: SkySubject = {
    id: 0,
    kind: target,
    role: 'showcase',
    pass: -1,
    launchAt: 0,
    x0: SHOWCASE_SPOT.x,
    y0: SHOWCASE_SPOT.y,
    dir: side(`${seed}:showcase`),
    speed: 0,
    slope: 0,
    phase: 0,
  };
  return {
    tick: 0,
    practice,
    seed,
    target,
    subjects: [showcase],
    nextId: 1,
    passes: 0,
    nextDecoyAt: steps(SHOWCASE_TIME + 0.4),
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      aimX: SHOWCASE_SPOT.x,
      aimY: SHOWCASE_SPOT.y,
      held: false,
      photo: null,
    })),
  };
}

/** Les sujets qui partent à ce pas : le passage de la cible, le sosie qui le précède, un leurre. */
function launchSubjects(state: SkyPhotoState): void {
  const { tick, seed, target } = state;
  // Après le dernier passage, passAt et trapAt sont infinis : seuls les leurres partent encore.
  const pass = state.passes;
  const passKey = `${seed}:pass:${pass}`;
  const passDir = side(`${passKey}:dir`);
  const passY = skyHeight(`${passKey}:y`);
  const add = (
    kind: SubjectKind,
    role: SkySubject['role'],
    key: string,
    dir: -1 | 1,
    y: number,
  ) => {
    const base = {
      id: state.nextId,
      kind,
      role,
      pass: role === 'target' ? pass : -1,
      launchAt: tick,
    };
    state.subjects.push(launch(base, key, dir, y));
    state.nextId += 1;
  };
  if (tick === trapAt(state, pass)) {
    // Par le même côté, un peu plus haut ou plus bas : on le prend pour la cible.
    const lookalike = twinOf(target) ?? pick(`${passKey}:trap-kind`, otherKinds(target));
    const offset =
      (hashUnit(`${passKey}:trap-y`) < 0.5 ? -1 : 1) * between(`${passKey}:trap-dy`, [0.4, 0.9]);
    add(lookalike, 'decoy', `${passKey}:trap`, passDir, clampHeight(passY + offset));
  }
  if (tick === passAt(state, pass)) {
    add(target, 'target', passKey, passDir, passY);
    state.passes += 1;
  }
  if (tick >= state.nextDecoyAt) {
    const key = `${seed}:decoy:${state.nextId}`;
    const twin = twinOf(target);
    const kind =
      twin && hashUnit(`${key}:twin`) < TWIN_SHARE ? twin : pick(`${key}:kind`, otherKinds(target));
    add(kind, 'decoy', key, side(`${key}:dir`), skyHeight(`${key}:y`));
    state.nextDecoyAt = tick + steps(between(`${key}:gap`, DECOY_GAP));
  }
}

const otherKinds = (target: SubjectKind) => SUBJECT_KINDS.filter((kind) => kind !== target);
const clampHeight = (y: number) =>
  Math.max(PHOTO_SKY.bottom + 0.6, Math.min(PHOTO_SKY.top - 0.6, y));

/** Le cadre suit le point reçu (souris, ou stick et flèches intégrés par le client), dans le ciel. */
function aim(fighter: Photographer, input: ArenaInput): void {
  const point = input.point;
  if (!point) return;
  const bounds = photoAimBounds();
  // Le point reçu porte la hauteur dans `z` (le plan du ciel).
  fighter.aimX = Math.max(bounds.minX, Math.min(bounds.maxX, point.x));
  fighter.aimY = Math.max(bounds.minY, Math.min(bounds.maxY, point.z));
}

/** Ce que montre une photo prise là, à ce pas : le sujet le plus proche du centre du cadre. */
export function developPhoto(state: SkyPhotoState, x: number, y: number, tick: number): SkyPhoto {
  let shown: { subject: SkySubject; distance: number } | null = null;
  for (const subject of state.subjects) {
    if (subject.role === 'showcase' || !isInSky(subject, tick)) continue;
    const at = subjectPosition(subject, tick);
    const dx = Math.abs(at.x - x);
    const dy = Math.abs(at.y - y);
    if (dx > PHOTO_FRAME.width / 2 || dy > PHOTO_FRAME.height / 2) continue;
    const distance = Math.hypot(dx, dy);
    if (!shown || distance < shown.distance) shown = { subject, distance };
  }
  if (!shown) return { x, y, takenAt: tick, kind: null, points: 0 };
  const isTarget = shown.subject.role === 'target';
  return {
    x,
    y,
    takenAt: tick,
    kind: shown.subject.kind,
    points: isTarget ? photoPoints(shown.distance) : 0,
  };
}

/** Les points d'une photo de la cible : 100 au centre, par crans de 5, au moins 5 dans le cadre. */
export function photoPoints(distance: number): number {
  const corner = Math.hypot(PHOTO_FRAME.width, PHOTO_FRAME.height) / 2;
  const share = Math.max(0, 1 - distance / corner);
  return Math.max(
    POINTS_GRAIN,
    Math.round((share * MAX_PHOTO_POINTS) / POINTS_GRAIN) * POINTS_GRAIN,
  );
}

/** Déclencher : une seule photo (au bac à sable, on peut la reprendre), pas pendant la présentation. */
function shoot(state: SkyPhotoState, fighter: Photographer, input: ArenaInput): void {
  const isPress = input.primary && !fighter.held;
  fighter.held = input.primary;
  if (!isPress || state.tick < steps(SHOWCASE_TIME)) return;
  const { photo } = fighter;
  const canRetake = state.practice && photo && state.tick - photo.takenAt >= steps(PRACTICE_RETAKE);
  if (photo && !canRetake) return;
  fighter.photo = developPhoto(state, fighter.aimX, fighter.aimY, state.tick);
}

function step(state: SkyPhotoState, inputs: Partial<Record<PlayerId, ArenaInput>>): SkyPhotoState {
  const tick = state.tick + 1;
  const next: SkyPhotoState = {
    ...state,
    tick,
    subjects: [...state.subjects],
    fighters: state.fighters.map((fighter) => ({ ...fighter })),
  };
  launchSubjects(next);
  for (const fighter of next.fighters) {
    const input = inputs[fighter.id] ?? IDLE_INPUT;
    aim(fighter, input);
    shoot(next, fighter, input);
  }
  // Les leurres partis s'en vont ; les passages de la cible restent (la fin de partie les compte).
  next.subjects = next.subjects.filter(
    (subject) =>
      subject.role === 'target' || tick - subject.launchAt < steps(1) || isInSky(subject, tick),
  );
  return next;
}

/**
 * La partie finit un instant après que tout le monde a pris sa photo, ou après le dernier
 * passage de la cible (celui qui n'a rien pris n'a rien).
 */
function isOver(state: SkyPhotoState): boolean {
  if (state.practice) return false;
  const photos = state.fighters.map((fighter) => fighter.photo);
  if (photos.every((photo) => photo !== null)) {
    const last = Math.max(...photos.map((photo) => photo?.takenAt ?? 0));
    return state.tick >= last + steps(END_PAUSE);
  }
  if (state.passes < PHOTO_PASSES) return false;
  const lastPass = state.subjects.find(
    (subject) => subject.role === 'target' && subject.pass === PHOTO_PASSES - 1,
  );
  return lastPass !== undefined && state.tick >= flightEnd(lastPass) + steps(END_PAUSE);
}

const pointsOf = (state: SkyPhotoState, player: PlayerId) =>
  state.fighters.find((fighter) => fighter.id === player)?.photo?.points ?? 0;

/** Le classement aux points de la photo ; à égalité, ex aequo (les dés départagent). Zéro : tous derniers. */
function ranking(state: SkyPhotoState): PlayerId[][] {
  const byPoints = new Map<number, PlayerId[]>();
  for (const fighter of state.fighters) {
    const points = fighter.photo?.points ?? 0;
    byPoints.set(points, [...(byPoints.get(points) ?? []), fighter.id]);
  }
  return [...byPoints.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/** La graine reste chez l'hôte : avec elle, on saurait d'avance quand et où passe la cible. */
function viewFor(state: SkyPhotoState, _viewer: Viewer): SkyPhotoState {
  return { ...state, seed: 0 };
}

/**
 * Le bot cadre comme un joueur au stick : il repère la cible un temps après son départ, déplace
 * son cadre à une vitesse bornée vers elle, et déclenche quand il pense l'avoir au centre, à son
 * erreur près (tirée une fois par sujet). Il laisse parfois passer un passage pour attendre
 * mieux (jamais le dernier), et se fait parfois avoir par le sosie qui le précède.
 */
const REACTION: Record<BotLevel, number> = { easy: 0.45, normal: 0.3, expert: 0.2 };
const AIM_SPEED: Record<BotLevel, number> = { easy: 7, normal: 10, expert: 13 };
const AIM_ERROR: Record<BotLevel, number> = { easy: 0.8, normal: 0.55, expert: 0.38 };
const FOOLED: Record<BotLevel, number> = { easy: 0.2, normal: 0.08, expert: 0.02 };
const PATIENCE: Record<BotLevel, number> = { easy: 0.15, normal: 0.3, expert: 0.45 };
/** Il déclenche quand son cadre est à moins de ça du point voulu. */
const ON_TARGET = 0.15;
/** Il cherche où attendre le sujet jusqu'à tant de secondes plus loin sur son vol. */
const LOOK_AHEAD = 3;

function botInput(state: SkyPhotoState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me) return IDLE_INPUT;
  const stay = { ...IDLE_INPUT, point: { x: me.aimX, z: me.aimY } };
  if (me.photo || state.tick < steps(SHOWCASE_TIME)) return stay;
  const subject = botSubject(state, player, level);
  if (!subject) return stay;
  const key = `${state.seed}:${player}:${subject.id}`;
  const angle = hashUnit(`${key}:angle`) * Math.PI * 2;
  const miss = hashUnit(`${key}:miss`) * AIM_ERROR[level];
  const sighted = (tick: number) => {
    const at = subjectPosition(subject, tick);
    return { x: at.x + Math.cos(angle) * miss, y: at.y + Math.sin(angle) * miss };
  };
  const most = AIM_SPEED[level] * ARENA_STEP;
  // Le premier point de son vol que le cadre peut atteindre à temps (un jet va plus vite que lui).
  const bounds = photoAimBounds();
  let wanted = sighted(state.tick + 1);
  for (let ahead = 1; ahead <= steps(LOOK_AHEAD); ahead++) {
    const at = sighted(state.tick + ahead);
    const reachable =
      at.x >= bounds.minX && at.x <= bounds.maxX && at.y >= bounds.minY && at.y <= bounds.maxY;
    if (reachable && Math.hypot(at.x - me.aimX, at.y - me.aimY) <= most * ahead) {
      wanted = at;
      break;
    }
  }
  const gap = Math.hypot(wanted.x - me.aimX, wanted.y - me.aimY);
  const t = gap <= most ? 1 : most / gap;
  const point = { x: me.aimX + (wanted.x - me.aimX) * t, z: me.aimY + (wanted.y - me.aimY) * t };
  // La photo part au pas suivant, avec le cadre déjà au point envoyé.
  const next = sighted(state.tick + 1);
  const isCentered = Math.hypot(next.x - point.x, next.y - point.z) <= ON_TARGET;
  return { ...IDLE_INPUT, point, primary: !me.held && isCentered };
}

/** Le sujet que le bot veut photographier : la cible d'un passage qu'il ne laisse pas filer, ou le sosie qui l'a eu. */
function botSubject(state: SkyPhotoState, player: PlayerId, level: BotLevel): SkySubject | null {
  const reaction = steps(REACTION[level]);
  const twin = twinOf(state.target);
  const wanted = state.subjects.filter((subject) => {
    if (!isInSky(subject, state.tick + 1) || state.tick < subject.launchAt + reaction) return false;
    const key = `${state.seed}:${player}:${subject.id}`;
    if (subject.role === 'target') {
      const isLast = subject.pass >= PHOTO_PASSES - 1;
      return isLast || hashUnit(`${key}:skip`) >= PATIENCE[level];
    }
    return (
      subject.role === 'decoy' && subject.kind === twin && hashUnit(`${key}:fooled`) < FOOLED[level]
    );
  });
  return wanted[0] ?? null;
}

export const SKY_PHOTO: ArenaGame<SkyPhotoState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
  viewFor,
  // Proches : un cran de points d'écart ; écrasant : 30 points d'avance.
  reveal: { score: pointsOf, close: POINTS_GRAIN, crushing: 30 },
};
