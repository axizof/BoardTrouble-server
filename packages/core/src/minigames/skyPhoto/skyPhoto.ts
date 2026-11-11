import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Clic-clac ! (02-mini-jeux.md, fiche 53) : l'œil collé au viseur de son appareil, en haut du
// phare. Le viseur ne bouge pas : tout se joue au moment du déclic. On montre d'abord le sujet à
// photographier ; puis il ne se passe rien (le vent), et hop, quelque chose traverse le viseur,
// très vite : un leurre, son sosie (l'oiseau bleu quand il faut le rouge, l'avion à hélice quand
// il faut le jet), ou la cible, qui passe deux fois. UNE seule photo : le sujet le plus proche du
// centre est celui qu'elle montre ; la cible vaut ses points (plus elle est au centre, plus la
// photo est nette et en vaut), un leurre ou du ciel vide, zéro. Tout se joue dans le plan du
// ciel face à l'appareil : x à droite, y en haut, en mètres ; le centre du viseur est VIEW.center.
//
// Chaque trajectoire est décrite autour du moment où le sujet passe par son point de passage
// (`through`, à `crossAt` secondes de son départ). Pour la cible, ce point est le centre exact,
// à la même vitesse aux deux passages : chacun a la même photo parfaite à saisir (retour de test :
// un passage plus centré que l'autre avantageait celui qui avait attendu).

export type SubjectKind =
  | 'redBird'
  | 'blueBird'
  | 'jet'
  | 'propeller'
  | 'yellowCopter'
  | 'greenCopter'
  | 'rocket'
  | 'ufo';

/** Comment vole un sujet : en battant des ailes, en ligne droite, par bonds, en montant... */
type Flight = 'flap' | 'glide' | 'cruise' | 'hover' | 'climb' | 'hop';

/**
 * Chaque sujet : son vol, sa vitesse au passage (m/s, au hasard entre les deux ; la cible garde
 * la même aux deux passages), et son sosie. Vite : le viseur fait 8 m de large.
 */
const SUBJECTS: Record<
  SubjectKind,
  { flight: Flight; speed: [number, number]; twin: SubjectKind | null }
> = {
  redBird: { flight: 'flap', speed: [11, 12], twin: 'blueBird' },
  blueBird: { flight: 'flap', speed: [11, 12], twin: 'redBird' },
  jet: { flight: 'glide', speed: [18, 20], twin: 'propeller' },
  propeller: { flight: 'cruise', speed: [13, 14], twin: 'jet' },
  yellowCopter: { flight: 'hover', speed: [9.5, 10.5], twin: 'greenCopter' },
  greenCopter: { flight: 'hover', speed: [9.5, 10.5], twin: 'yellowCopter' },
  // La fusée traverse le viseur de bas en haut.
  rocket: { flight: 'climb', speed: [8.5, 9.5], twin: null },
  // La soucoupe file par bonds : sa vitesse est sa moyenne, pauses comprises ; elle passe le
  // centre au milieu d'un bond, à pleine vitesse.
  ufo: { flight: 'hop', speed: [5.5, 6], twin: null },
};
export const SUBJECT_KINDS = Object.keys(SUBJECTS) as SubjectKind[];

/** Le viseur dans le plan du ciel (mètres) : son centre, et sa demi-largeur et demi-hauteur. */
export const VIEW = { center: { x: 0, y: 5.5 }, halfWidth: 4, halfHeight: 2.25 } as const;
/** Le pas des points : ce que l'œil distingue. */
const POINTS_GRAIN = 5;
export const MAX_PHOTO_POINTS = 100;
/** Les points baissent avec la distance au centre ; au-delà de celle-ci (mètres), le minimum. */
const SHARP_RANGE = 2.5;
/** On montre la cible pendant ce temps (secondes) ; on ne peut pas déclencher avant. */
export const SHOWCASE_TIME = 3;
/** Les passages de la cible. */
export const PHOTO_PASSES = 2;
/** Le silence entre deux sujets (secondes, au hasard entre les deux) ; plus court après un sosie. */
const QUIET: [number, number] = [0.8, 2.2];
const TRAP_QUIET: [number, number] = [0.2, 0.6];
/** Le premier sujet part ce temps après la présentation (secondes). */
const FIRST_QUIET = 1;
/** Le premier passage de la cible est le 3e ou le 4e sujet ; le second, 3 à 5 sujets plus loin. */
const FIRST_PASS: [number, number] = [2, 3];
const PASS_SPACING: [number, number] = [3, 5];
/** Au bac à sable, la cible repasse tous les tant de sujets. */
const PRACTICE_PASS_EVERY = 3;
/** Les leurres vont parfois moins vite (part de leur vitesse, au hasard entre les deux). */
const DECOY_PACE: [number, number] = [0.55, 1.05];
/** Où passent les leurres, autour du centre (mètres, au plus, de chaque côté de leur route). */
const DECOY_SPREAD = 1.6;
/** La pente d'une route en travers du viseur (radians, au plus) : à plat ou en diagonale. */
const SLANT = 0.5;
/** La fusée monte presque droit (radians d'écart à la verticale, au plus). */
const CLIMB_SLANT = 0.25;
/** La partie finit ce temps après la dernière photo, ou après le dernier passage (secondes). */
const END_PAUSE = 1.2;
/** Au bac à sable, on peut reprendre une photo au bout de ce temps (secondes). */
const PRACTICE_RETAKE = 1;
/** Un sujet qui vole depuis plus longtemps est parti (secondes). */
const LONGEST_FLIGHT = 10;
/** Les sujets partent et finissent à cette distance du bord du viseur (mètres). */
const EDGE_MARGIN = 1.5;

/**
 * Un sujet : quoi, son rôle (la cible, un leurre, ou la cible montrée au début, qui ne compte
 * pas), le passage de la cible qu'il est (0, 1 ; -1 sinon), et sa route : il passe par
 * `throughX, throughY` `crossAt` secondes après son départ, dans la direction `angle` (radians,
 * 0 : vers la droite), à `speed`.
 */
export type SkySubject = {
  id: number;
  kind: SubjectKind;
  role: 'target' | 'decoy' | 'showcase';
  pass: number;
  launchAt: number;
  crossAt: number;
  throughX: number;
  throughY: number;
  angle: number;
  speed: number;
};

/** Une photo : quand, le sujet qu'elle montre (ou null : du ciel), et sa distance au centre. */
export type SkyPhoto = {
  takenAt: number;
  kind: SubjectKind | null;
  /** La distance du sujet au centre (mètres), null sans sujet. */
  distance: number | null;
  points: number;
};

export type Photographer = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
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
  /** Les sujets déjà partis (après la présentation), les passages de la cible, le prochain départ. */
  launched: number;
  passes: number;
  nextLaunchAt: number;
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

export function twinOf(kind: SubjectKind): SubjectKind | null {
  return SUBJECTS[kind].twin;
}

/** La soucoupe : un bond toutes les HOP_TIME secondes (en HOP_DASH de ce temps), puis du surplace. */
const HOP_TIME = 0.5;
const HOP_DASH = 0.5;
/** Entre deux bonds, elle s'arrête d'un côté puis de l'autre de sa route (mètres). */
const HOP_ZIGZAG = 0.45;
const smooth = (u: number) => u * u * (3 - 2 * u);

/**
 * Le chemin parcouru le long de la route (mètres) et l'écart de côté, `time` secondes après le
 * point de passage (négatif : avant). Tous deux valent 0 au point de passage.
 */
function travel(subject: SkySubject, time: number): { along: number; aside: number } {
  const { speed } = subject;
  switch (SUBJECTS[subject.kind].flight) {
    case 'flap':
      return { along: speed * time, aside: 0.22 * Math.sin(Math.PI * 3.2 * time) };
    case 'glide':
      return { along: speed * time, aside: 0 };
    case 'cruise':
      return { along: speed * time, aside: 0.08 * Math.sin(Math.PI * 1.4 * time) };
    case 'hover':
      return { along: speed * time, aside: 0.15 * Math.sin(Math.PI * 1.2 * time) };
    case 'climb':
      return { along: speed * time, aside: 0 };
    case 'hop': {
      // Le point de passage est au milieu d'un bond : on compte les bonds depuis le début de celui-là.
      const hopLength = speed * HOP_TIME;
      const since = time + (HOP_DASH * HOP_TIME) / 2;
      const hop = Math.floor(since / HOP_TIME);
      const u = (since - hop * HOP_TIME) / HOP_TIME;
      const ease = u < HOP_DASH ? smooth(u / HOP_DASH) : 1;
      // Il s'arrête d'un côté puis de l'autre : au milieu de chaque bond, il recroise sa route.
      const stop = (k: number) => (k % 2 === 0 ? -1 : 1) * HOP_ZIGZAG;
      return {
        along: hopLength * (hop + ease - 0.5),
        aside: stop(hop - 1) + (stop(hop) - stop(hop - 1)) * ease,
      };
    }
  }
}

/** Où est le sujet à ce pas (fraction comprise), dans le plan du ciel. */
export function subjectPosition(subject: SkySubject, tick: number): { x: number; y: number } {
  const t = Math.max(0, tick - subject.launchAt) * ARENA_STEP;
  if (subject.role === 'showcase') {
    // Il flotte au centre, puis file vers le haut à la fin de la présentation.
    const leaving = Math.max(0, t - SHOWCASE_TIME);
    return {
      x: subject.throughX + Math.cos(subject.angle) * 2 * leaving * leaving,
      y: subject.throughY + 0.15 * Math.sin(t * 2.4) + 9 * leaving * leaving,
    };
  }
  const { along, aside } = travel(subject, t - subject.crossAt);
  const cos = Math.cos(subject.angle);
  const sin = Math.sin(subject.angle);
  return {
    x: subject.throughX + cos * along - sin * aside,
    y: subject.throughY + sin * along + cos * aside,
  };
}

/** Le sujet vole : parti, et pas encore sorti du ciel autour du viseur après son passage. */
export function isInSky(subject: SkySubject, tick: number): boolean {
  if (tick < subject.launchAt || tick - subject.launchAt > steps(LONGEST_FLIGHT)) return false;
  const time = (tick - subject.launchAt) * ARENA_STEP;
  if (subject.role !== 'showcase' && time <= subject.crossAt) return true;
  const { x, y } = subjectPosition(subject, tick);
  const margin = EDGE_MARGIN + 0.5;
  return (
    Math.abs(x - VIEW.center.x) < VIEW.halfWidth + margin &&
    Math.abs(y - VIEW.center.y) < VIEW.halfHeight + margin + 0.5
  );
}

/** Le pas où le sujet a quitté le ciel. */
function flightEnd(subject: SkySubject): number {
  let tick = subject.launchAt;
  while (isInSky(subject, tick)) tick += 1;
  return tick;
}

/**
 * Un sujet qui part, hors du viseur : la cible droit sur le centre, à la vitesse de la partie ;
 * un leurre n'importe où autour, parfois moins vite. À plat ou en diagonale (la fusée de bas en
 * haut).
 */
function launch(
  state: Pick<SkyPhotoState, 'seed'>,
  base: Pick<SkySubject, 'id' | 'kind' | 'role' | 'pass' | 'launchAt'>,
  key: string,
): SkySubject {
  const { flight, speed } = SUBJECTS[base.kind];
  const isTarget = base.role === 'target';
  const pace = isTarget ? 1 : between(`${key}:pace`, DECOY_PACE);
  const passSpeed = between(isTarget ? `${state.seed}:target-speed` : `${key}:speed`, speed) * pace;
  const slant = between(
    `${key}:slant`,
    flight === 'climb' ? [-CLIMB_SLANT, CLIMB_SLANT] : [-SLANT, SLANT],
  );
  const isLeftward = hashUnit(`${key}:dir`) < 0.5;
  const angle = flight === 'climb' ? Math.PI / 2 + slant : (isLeftward ? Math.PI : 0) + slant;
  const offset = isTarget ? 0 : between(`${key}:offset`, [-DECOY_SPREAD, DECOY_SPREAD]);
  // De côté par rapport à la route : un leurre passe au-dessus, en dessous, ou pile au centre.
  const throughX = VIEW.center.x - Math.sin(angle) * offset;
  const throughY = VIEW.center.y + Math.cos(angle) * offset;
  const distance = Math.hypot(VIEW.halfWidth, VIEW.halfHeight) + EDGE_MARGIN;
  return {
    ...base,
    crossAt: distance / passSpeed,
    throughX,
    throughY,
    angle,
    speed: passSpeed,
  };
}

/** Le rang (parmi les sujets lancés) du passage `pass` de la cible. */
function passSlot(state: Pick<SkyPhotoState, 'seed' | 'practice'>, pass: number): number {
  if (state.practice) return PRACTICE_PASS_EVERY * (pass + 1) - 1;
  const first = Math.round(between(`${state.seed}:first-pass`, FIRST_PASS));
  if (pass === 0) return first;
  if (pass >= PHOTO_PASSES) return Number.POSITIVE_INFINITY;
  return first + Math.round(between(`${state.seed}:pass-spacing`, PASS_SPACING));
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
    crossAt: 0,
    throughX: VIEW.center.x,
    throughY: VIEW.center.y + 0.3,
    // Elle s'en va d'un côté ou de l'autre (le cosinus de l'angle).
    angle: hashUnit(`${seed}:showcase`) < 0.5 ? Math.PI : 0,
    speed: 0,
  };
  return {
    tick: 0,
    practice,
    seed,
    target,
    subjects: [showcase],
    launched: 0,
    passes: 0,
    nextLaunchAt: steps(SHOWCASE_TIME + FIRST_QUIET),
    fighters: players.map((id) => ({ id, fellAt: null, held: false, photo: null })),
  };
}

/**
 * Le sujet suivant part quand le précédent est sorti et que le silence est passé : la cible à son
 * passage, son sosie juste avant (ou un leurre au hasard si elle n'en a pas), sinon un leurre.
 */
function launchNext(state: SkyPhotoState): void {
  const { tick, seed, target } = state;
  if (tick < state.nextLaunchAt) return;
  if (!state.practice && state.passes >= PHOTO_PASSES) return;
  const slot = state.launched;
  const key = `${seed}:subject:${slot}`;
  const nextPass = passSlot(state, state.passes);
  const isPass = slot === nextPass;
  const isTrap = slot === nextPass - 1;
  const decoy = pick(
    `${key}:kind`,
    SUBJECT_KINDS.filter((kind) => kind !== target),
  );
  const kind = isPass ? target : isTrap ? (twinOf(target) ?? decoy) : decoy;
  const subject = launch(
    state,
    {
      id: slot + 1,
      kind,
      role: isPass ? 'target' : 'decoy',
      pass: isPass ? state.passes : -1,
      launchAt: tick,
    },
    key,
  );
  state.subjects.push(subject);
  state.launched += 1;
  if (isPass) state.passes += 1;
  const quiet = between(`${key}:quiet`, isTrap ? TRAP_QUIET : QUIET);
  state.nextLaunchAt = flightEnd(subject) + steps(quiet);
}

/** Ce que montre une photo prise à ce pas : le sujet du viseur le plus proche du centre. */
export function developPhoto(state: SkyPhotoState, tick: number): SkyPhoto {
  let shown: { subject: SkySubject; distance: number } | null = null;
  for (const subject of state.subjects) {
    if (subject.role === 'showcase' || !isInSky(subject, tick)) continue;
    const at = subjectPosition(subject, tick);
    const dx = Math.abs(at.x - VIEW.center.x);
    const dy = Math.abs(at.y - VIEW.center.y);
    if (dx > VIEW.halfWidth || dy > VIEW.halfHeight) continue;
    const distance = Math.hypot(dx, dy);
    if (!shown || distance < shown.distance) shown = { subject, distance };
  }
  if (!shown) return { takenAt: tick, kind: null, distance: null, points: 0 };
  const isTarget = shown.subject.role === 'target';
  return {
    takenAt: tick,
    kind: shown.subject.kind,
    distance: shown.distance,
    points: isTarget ? photoPoints(shown.distance) : 0,
  };
}

/** Les points d'une photo de la cible : 100 au centre, par crans de 5, au moins 5 dans le viseur. */
export function photoPoints(distance: number): number {
  const share = Math.max(0, 1 - distance / SHARP_RANGE);
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
  fighter.photo = developPhoto(state, state.tick);
}

function step(state: SkyPhotoState, inputs: Partial<Record<PlayerId, ArenaInput>>): SkyPhotoState {
  const tick = state.tick + 1;
  const next: SkyPhotoState = {
    ...state,
    tick,
    subjects: [...state.subjects],
    fighters: state.fighters.map((fighter) => ({ ...fighter })),
  };
  launchNext(next);
  for (const fighter of next.fighters) shoot(next, fighter, inputs[fighter.id] ?? IDLE_INPUT);
  // Les leurres partis s'en vont ; les passages de la cible restent (la fin de partie les compte).
  next.subjects = next.subjects.filter(
    (subject) => subject.role === 'target' || isInSky(subject, tick),
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

/** La graine reste chez l'hôte : avec elle, on saurait d'avance quand passe la cible. */
function viewFor(state: SkyPhotoState, _viewer: Viewer): SkyPhotoState {
  return { ...state, seed: 0 };
}

/**
 * Le bot guette : il reconnaît la cible un temps après son départ, puis déclenche quand elle
 * passe au point qu'il vise, le centre à son erreur de timing près (tirée une fois par sujet, en
 * secondes : en mètres, d'autant plus que le sujet va vite). Il laisse parfois passer le premier
 * passage, et se fait parfois avoir par le sosie qui précède la cible.
 */
const REACTION: Record<BotLevel, number> = { easy: 0.3, normal: 0.2, expert: 0.12 };
const TIMING_ERROR: Record<BotLevel, number> = { easy: 0.09, normal: 0.055, expert: 0.03 };
const FOOLED: Record<BotLevel, number> = { easy: 0.3, normal: 0.15, expert: 0.05 };
const PATIENCE: Record<BotLevel, number> = { easy: 0.1, normal: 0.25, expert: 0.4 };

function botInput(state: SkyPhotoState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((fighter) => fighter.id === player);
  if (!me || me.photo || state.tick < steps(SHOWCASE_TIME)) return IDLE_INPUT;
  const subject = botSubject(state, player, level);
  if (!subject) return IDLE_INPUT;
  const key = `${state.seed}:${player}:${subject.id}`;
  const error = (hashUnit(`${key}:error`) * 2 - 1) * TIMING_ERROR[level] * subject.speed;
  // La photo part au pas suivant : il déclenche quand le sujet y passera son point.
  const along = (tick: number) => {
    const at = subjectPosition(subject, tick);
    return (
      (at.x - VIEW.center.x) * Math.cos(subject.angle) +
      (at.y - VIEW.center.y) * Math.sin(subject.angle)
    );
  };
  const isCrossing = along(state.tick) < error && along(state.tick + 1) >= error;
  return { ...IDLE_INPUT, primary: !me.held && isCrossing };
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
