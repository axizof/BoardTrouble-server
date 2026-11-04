import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// Tir à la corde rythmé (02-mini-jeux.md, fiche 24) : deux équipes tirées au hasard, chacune sur
// sa plateforme au-dessus du vide, une corde entre elles. Des flèches défilent, les mêmes pour
// tous : appuyer la bonne flèche au bon moment tire la corde (un coup parfait, plus fort), et
// quand toute l'équipe tape juste sur la même note, elle tire encore plus. Une touche à côté fait
// glisser son équipe : marteler ne sert à rien. Le repère de la corde passe la ligne d'une équipe
// (WIN_DISTANCE) : l'autre tombe dans les nuages. Sinon, au bout de TUG_TIME, la plus avancée
// gagne. Les notes viennent par passages (calme, normal, rafale), de plus en plus serrés, avec
// parfois deux notes coup sur coup : beaucoup de notes, pour que chaque raté compte.

export const TUG_TIME = 45;
/** La première note arrive après ce temps (secondes) : on voit les flèches venir. */
export const FIRST_NOTE = 2;
/** L'écart de base entre deux notes, du début à la fin de la partie (secondes). */
const BEAT_START = 0.55;
const BEAT_END = 0.32;
/** L'écart le plus serré (deux notes coup sur coup en fin de partie). */
const MIN_GAP = 0.22;
/** Chaque passage multiplie l'écart de base : plus calme, normal, ou en rafale. */
export const PACES = { calm: 1.35, steady: 1, rush: 0.7 } as const;
export type TugPace = keyof typeof PACES;
/** La part des notes suivies d'une autre deux fois plus près (hors passages calmes). */
const DOUBLE_CHANCE = 0.15;
/** Jusqu'où d'une note un appui compte (secondes, avant ou après) : parfait, bien. */
export const PERFECT_WINDOW = 0.055;
export const GOOD_WINDOW = 0.13;
/** Ce que tire un appui (la part de l'équipe : divisé par sa taille), et la synchro d'équipe. */
const PULL = { perfect: 1, good: 0.6, slip: -0.5 } as const;
const SYNC_BONUS = 0.5;
/** Les mètres de corde que vaut une unité de traction. */
const ROPE_PER_PULL = 0.13;
/** Le repère de la corde passe cette distance (mètres) du côté d'une équipe : elle gagne. */
export const WIN_DISTANCE = 3;
/** Le temps de la chute des perdants, avant la fin de la partie (secondes). */
export const FALL_TIME = 2.5;
const DEAD_ZONE = 0.5;

/** Les flèches : gauche, haut, droite, bas. */
export const DIRECTIONS = ['left', 'up', 'right', 'down'] as const;
export const NO_DIRECTION = -1;

export type TugNote = { at: number; direction: number };
/** Un passage de la musique : son début (secondes) et son allure. */
export type TugSection = { at: number; pace: TugPace };
export type TugJudge = 'perfect' | 'good' | 'miss' | 'slip';
export type TugTeam = 0 | 1;

export type Puller = {
  id: PlayerId;
  /** Le pas où il est tombé avec son équipe (les perdants), sinon null. */
  fellAt: number | null;
  team: TugTeam;
  /** La première note qu'il n'a pas encore jouée (ou laissée passer). */
  next: number;
  /** Son dernier jugement ("Parfait !", "Raté"...), au pas judgedAt. */
  judge: TugJudge | null;
  judgedAt: number;
  /** La dernière note qu'il a tapée juste (synchro d'équipe), -1 : aucune. */
  lastHit: number;
  perfect: number;
  good: number;
  misses: number;
  slips: number;
  heldDirection: number;
};

export type TugPhase = 'pulling' | 'won';

export type TugState = {
  tick: number;
  practice: boolean;
  seed: number;
  /** Les notes, les mêmes pour tous (publiques), en secondes depuis songAt. */
  notes: TugNote[];
  /** Les passages, pour annoncer une rafale ou un moment calme. */
  sections: TugSection[];
  /** Le pas où la musique a commencé (au bac à sable, elle reprend en boucle). */
  songAt: number;
  /** Le repère de la corde, en mètres : négatif du côté de l'équipe 0, positif de l'équipe 1. */
  rope: number;
  phase: TugPhase;
  phaseAt: number;
  /** L'équipe gagnante, ou null (pas encore, ou égalité parfaite au temps). */
  winner: TugTeam | null;
  /** Le pas de la dernière synchro de chaque équipe, -1 : aucune ; et sa note. */
  syncAt: [number, number];
  syncNote: [number, number];
  fighters: Puller[];
};

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

/** L'allure d'un passage : le premier est normal, jamais deux rafales de suite. */
function paceOf(seed: number, index: number, previous: TugPace | undefined): TugPace {
  if (previous === undefined) return 'steady';
  const roll = hashUnit(`${seed}:pace:${index}`);
  if (roll < 0.4 && previous !== 'rush') return 'rush';
  return roll < 0.7 ? 'steady' : 'calm';
}

/**
 * Les notes d'une partie, par passages de 4 à 8 notes : l'écart de base se resserre au fil de la
 * partie, chaque passage l'étire ou le serre. Jamais trois fois la même flèche de suite.
 */
function chartOf(seed: number): { notes: TugNote[]; sections: TugSection[] } {
  const notes: TugNote[] = [];
  const sections: TugSection[] = [];
  let at = FIRST_NOTE;
  while (at < TUG_TIME - 0.5) {
    const pace = paceOf(seed, sections.length, sections.at(-1)?.pace);
    sections.push({ at, pace });
    const length = 4 + Math.floor(hashUnit(`${seed}:length:${sections.length}`) * 5);
    for (let n = 0; n < length && at < TUG_TIME - 0.5; n++) {
      const index = notes.length;
      let direction = Math.floor(hashUnit(`${seed}:note:${index}`) * DIRECTIONS.length);
      const [before, last] = [notes[index - 2]?.direction, notes[index - 1]?.direction];
      if (before === direction && last === direction) {
        direction = (direction + 1) % DIRECTIONS.length;
      }
      notes.push({ at, direction });
      const base = BEAT_START + (BEAT_END - BEAT_START) * (at / TUG_TIME);
      const isDouble = pace !== 'calm' && hashUnit(`${seed}:double:${index}`) < DOUBLE_CHANCE;
      at += Math.max(MIN_GAP, base * PACES[pace] * (isDouble ? 0.5 : 1));
    }
  }
  return { notes, sections };
}

/** Les équipes : les joueurs mélangés (selon la partie), puis coupés en deux. */
function teamsOf(players: PlayerId[], seed: number): Map<PlayerId, TugTeam> {
  const shuffled = [...players].sort(
    (a, b) => hashUnit(`${seed}:team:${a}`) - hashUnit(`${seed}:team:${b}`),
  );
  const half = Math.ceil(shuffled.length / 2);
  return new Map(shuffled.map((id, index) => [id, index < half ? 0 : 1]));
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): TugState {
  const teams = teamsOf(players, seed);
  const { notes, sections } = chartOf(seed);
  return {
    tick: 0,
    practice,
    seed,
    notes,
    sections,
    songAt: 0,
    rope: 0,
    phase: 'pulling',
    phaseAt: 0,
    winner: null,
    syncAt: [-1, -1],
    syncNote: [-1, -1],
    fighters: players.map((id) => ({
      id,
      fellAt: null,
      team: teams.get(id) ?? 0,
      next: 0,
      judge: null,
      judgedAt: 0,
      lastHit: -1,
      perfect: 0,
      good: 0,
      misses: 0,
      slips: 0,
      heldDirection: NO_DIRECTION,
    })),
  };
}

/** Le temps de la musique (secondes). */
export function songTime(state: TugState): number {
  return (state.tick - state.songAt) * ARENA_STEP;
}

/**
 * La flèche tenue. Deux flèches à la fois (on appuie la suivante avant de lâcher la première,
 * quand ça va vite) : c'est la nouvelle qui compte, celle qui n'était pas déjà tenue.
 */
function directionOf(move: ArenaInput['move'], held: number): number {
  const isX = Math.abs(move.x) > DEAD_ZONE;
  const isZ = Math.abs(move.z) > DEAD_ZONE;
  const x = move.x < 0 ? 0 : 2;
  const z = move.z < 0 ? 1 : 3;
  if (isX && isZ) return held === x ? z : held === z ? x : NO_DIRECTION;
  if (isX) return x;
  return isZ ? z : NO_DIRECTION;
}

/** Le pas d'un joueur : les notes qu'il a laissées passer, puis son appui. Et ce qu'il tire. */
function play(
  puller: Puller,
  input: ArenaInput,
  notes: TugNote[],
  time: number,
  tick: number,
): { puller: Puller; pull: number } {
  const next = { ...puller };
  while ((notes[next.next]?.at ?? Number.POSITIVE_INFINITY) + GOOD_WINDOW < time) {
    next.next++;
    next.misses++;
    next.judge = 'miss';
    next.judgedAt = tick;
  }
  const direction = directionOf(input.move, puller.heldDirection);
  const isPress = direction !== NO_DIRECTION && direction !== puller.heldDirection;
  next.heldDirection = direction;
  if (!isPress) return { puller: next, pull: 0 };
  next.judgedAt = tick;
  // Les notes serrées se chevauchent : l'appui va à la première note proche de sa flèche, et
  // celles d'avant, sautées, sont ratées.
  const isReachable = (index: number) =>
    Math.abs((notes[index]?.at ?? Number.POSITIVE_INFINITY) - time) <= GOOD_WINDOW;
  let hit = next.next;
  while (isReachable(hit) && notes[hit]?.direction !== direction) hit++;
  if (!isReachable(hit)) {
    // Une flèche à côté de la note la gâche ; un appui loin de toute note ne gâche rien.
    if (isReachable(next.next)) next.next++;
    next.slips++;
    next.judge = 'slip';
    return { puller: next, pull: PULL.slip };
  }
  next.misses += hit - next.next;
  const offset = Math.abs((notes[hit]?.at ?? 0) - time);
  const judge = offset <= PERFECT_WINDOW ? 'perfect' : 'good';
  next[judge]++;
  next.judge = judge;
  next.lastHit = hit;
  next.next = hit + 1;
  return { puller: next, pull: PULL[judge] };
}

function step(state: TugState, inputs: Partial<Record<PlayerId, ArenaInput>>): TugState {
  const tick = state.tick + 1;
  if (state.phase === 'won') return { ...state, tick };
  const time = (tick - state.songAt) * ARENA_STEP;
  const sizes = [0, 1].map((team) => state.fighters.filter((one) => one.team === team).length);
  const pulls = [0, 0];
  const fighters = state.fighters.map((puller) => {
    const played = play(puller, inputs[puller.id] ?? IDLE_INPUT, state.notes, time, tick);
    pulls[puller.team] = (pulls[puller.team] ?? 0) + played.pull / (sizes[puller.team] ?? 1);
    return played.puller;
  });
  // La synchro : toute l'équipe (à deux au moins) a tapé juste la même note ; une fois par note.
  const syncAt: [number, number] = [...state.syncAt];
  const syncNote: [number, number] = [...state.syncNote];
  for (const team of [0, 1] as const) {
    const members = fighters.filter((one) => one.team === team);
    const note = members[0]?.lastHit ?? -1;
    const isSync =
      members.length >= 2 &&
      note >= 0 &&
      note !== syncNote[team] &&
      members.every((one) => one.lastHit === note);
    if (!isSync) continue;
    syncAt[team] = tick;
    syncNote[team] = note;
    pulls[team] = (pulls[team] ?? 0) + SYNC_BONUS;
  }
  let rope = state.rope + ((pulls[1] ?? 0) - (pulls[0] ?? 0)) * ROPE_PER_PULL;
  let next: TugState = { ...state, tick, rope, syncAt, syncNote, fighters };
  if (state.practice) {
    // Au bac à sable : la corde repart du milieu à la ligne, et la musique reprend.
    if (Math.abs(rope) >= WIN_DISTANCE) rope = 0;
    const last = state.notes[state.notes.length - 1]?.at ?? 0;
    if (time > last + 1.5) {
      return {
        ...next,
        rope,
        songAt: tick,
        fighters: fighters.map((one) => ({ ...one, next: 0, lastHit: -1 })),
        syncNote: [-1, -1],
      };
    }
    return { ...next, rope };
  }
  const isPulledIn = Math.abs(rope) >= WIN_DISTANCE;
  if (isPulledIn || time >= TUG_TIME) {
    const winner: TugTeam | null = rope < 0 ? 0 : rope > 0 ? 1 : null;
    rope = isPulledIn ? Math.sign(rope) * WIN_DISTANCE : rope;
    next = {
      ...next,
      rope,
      phase: 'won',
      phaseAt: tick,
      winner,
      fighters: fighters.map((one) =>
        winner !== null && one.team !== winner ? { ...one, fellAt: tick } : one,
      ),
    };
  }
  return next;
}

function isOver(state: TugState): boolean {
  return !state.practice && state.phase === 'won' && state.tick - state.phaseAt >= steps(FALL_TIME);
}

function timeLeft(state: TugState): number | null {
  if (state.practice || state.phase !== 'pulling') return null;
  return Math.max(0, TUG_TIME - songTime(state));
}

/** La précision d'un joueur : un parfait vaut 2, un bien 1, une glissade coûte 1. */
export function precisionOf(puller: Puller): number {
  return puller.perfect * 2 + puller.good - puller.slips;
}

/** Ses joueurs, des plus précis aux moins précis ; à précision égale, ex aequo (les dés). */
function byPrecision(pullers: Puller[]): PlayerId[][] {
  const groups = new Map<number, PlayerId[]>();
  for (const puller of pullers) {
    const score = precisionOf(puller);
    groups.set(score, [...(groups.get(score) ?? []), puller.id]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/** L'équipe gagnante devant ; dans chaque équipe, la précision. Sans gagnant, la précision. */
function ranking(state: TugState): PlayerId[][] {
  if (state.winner === null) return byPrecision(state.fighters);
  const winners = state.fighters.filter((one) => one.team === state.winner);
  const losers = state.fighters.filter((one) => one.team !== state.winner);
  return [...byPrecision(winners), ...byPrecision(losers)];
}

/**
 * Le bot décide pour chaque note s'il la joue, avec quel écart au bon moment, et s'il se trompe
 * de flèche (toujours pareil pour une même partie). Le Facile rate et décale plus, l'Expert tape
 * presque toujours juste.
 */
const BOT_SKILL: Record<BotLevel, { play: number; spread: number; wrong: number; fast: number }> = {
  easy: { play: 0.8, spread: 0.16, wrong: 0.07, fast: 0.25 },
  normal: { play: 0.9, spread: 0.11, wrong: 0.03, fast: 0.12 },
  expert: { play: 0.95, spread: 0.08, wrong: 0.02, fast: 0.05 },
};
/** Une note à moins de ce temps de la précédente est "serrée" : le bot la joue moins souvent. */
const FAST_GAP = 0.35;

function botInput(state: TugState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((one) => one.id === player);
  if (!me || state.phase !== 'pulling') return IDLE_INPUT;
  const note = state.notes[me.next];
  if (!note) return IDLE_INPUT;
  const key = `${state.seed}:${state.songAt}:${player}:${me.next}`;
  const skill = BOT_SKILL[level];
  const gap = note.at - (state.notes[me.next - 1]?.at ?? Number.NEGATIVE_INFINITY);
  const chance = skill.play - (gap < FAST_GAP ? skill.fast : 0);
  if (hashUnit(`${key}:play`) >= chance) return IDLE_INPUT;
  // Deux tirages moyennés : l'écart tombe plus souvent près du bon moment qu'au bord.
  const spread = (hashUnit(`${key}:early`) + hashUnit(`${key}:late`) - 1) * skill.spread;
  if (songTime(state) + ARENA_STEP < note.at + spread) return IDLE_INPUT;
  const isWrong = hashUnit(`${key}:wrong`) < skill.wrong;
  const direction = isWrong ? (note.direction + 1) % DIRECTIONS.length : note.direction;
  const move = [
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 0 },
    { x: 0, z: 1 },
  ][direction] ?? { x: 0, z: 0 };
  return { ...IDLE_INPUT, move };
}

export const RHYTHM_TUG: ArenaGame<TugState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft,
  ranking,
};
