import type { BotLevel } from '../../bots/boardBot';
import type { PlayerId } from '../../game/types';
import type { Viewer } from '../../game/views';
import type { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaGame, type ArenaInput, IDLE_INPUT } from '../arena/arena';

// L'escalier des uniques (02-mini-jeux.md, fiche 44) : tout le monde au pied d'un escalier. À
// chaque manche, chacun choisit en secret un nombre de marches ; à la révélation, on ne monte que
// si l'on est seul à avoir choisi son nombre. Le premier en haut gagne (la partie s'arrête à la
// fin de la manche), sinon le plus haut au bout de STAIRS_ROUNDS manches. Tant qu'un choix n'est
// pas révélé, l'hôte ne l'envoie qu'à son joueur.

export const STAIRS_ROUNDS = 8;
/** Le temps pour choisir (secondes) : qui n'a rien choisi reste sur place. */
export const CHOICE_TIME = 10;
/** Les choix révélés (et la montée) restent ce temps-là avant la manche suivante. */
export const STAIRS_REVEAL_TIME = 3;
/** Un choix caché, dans ce qu'on envoie aux autres joueurs ; pas de choix. */
export const HIDDEN_CHOICE = -1;
export const NO_CHOICE = 0;
/** Les boutons visés à la souris (`target`) : un nombre (son indice), ou valider. */
export const STAIRS_CONFIRM = 9;
const DEAD_ZONE = 0.5;

/** Les nombres de marches proposés, et la hauteur du sommet, selon la taille de la table. */
export function stairsOptions(players: number): number[] {
  return players >= 5 ? [1, 3, 4, 5] : [1, 3, 5];
}

export function stairsTop(players: number): number {
  return players >= 5 ? 12 : 15;
}

export type StairsPhase = 'choosing' | 'reveal';

export type Climber = {
  id: PlayerId;
  /** Personne ne tombe ici : toujours null (le cadre des arènes le demande). */
  fellAt: null;
  /** Les marches montées (le sommet au plus). */
  height: number;
  /** Le nombre choisi (NO_CHOICE : rien ; HIDDEN_CHOICE pour les autres, avant la révélation). */
  choice: number;
  isLocked: boolean;
  /** Le choix révélé à la dernière manche (NO_CHOICE : il n'avait rien choisi), et s'il est monté. */
  lastChoice: number | null;
  climbed: boolean;
  /** Tous ses choix révélés, dans l'ordre (publics : un bot Expert y lit ses habitudes). */
  history: number[];
  heldDirection: number;
  held: boolean;
};

export type StairsState = {
  tick: number;
  practice: boolean;
  seed: number;
  options: number[];
  top: number;
  round: number;
  phase: StairsPhase;
  phaseAt: number;
  fighters: Climber[];
};

/** Une valeur entre 0 et 1, toujours la même pour un même texte. */
function hashUnit(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

const steps = (seconds: number) => Math.round(seconds / ARENA_STEP);

function freshClimber(id: PlayerId): Climber {
  return {
    id,
    fellAt: null,
    height: 0,
    choice: NO_CHOICE,
    isLocked: false,
    lastChoice: null,
    climbed: false,
    history: [],
    heldDirection: 0,
    held: false,
  };
}

function create(
  players: PlayerId[],
  { practice, seed }: { practice: boolean; seed: number },
): StairsState {
  // Au bac à sable, on est seul : les choix de la table de quatre.
  const count = practice ? 4 : players.length;
  return {
    tick: 0,
    practice,
    seed,
    options: stairsOptions(count),
    top: stairsTop(count),
    round: 0,
    phase: 'choosing',
    phaseAt: 0,
    fighters: players.map(freshClimber),
  };
}

/** Les secondes qui restent pour choisir, ou null hors des choix. */
export function choiceTimeLeft(state: StairsState): number | null {
  if (state.phase !== 'choosing') return null;
  return Math.max(0, CHOICE_TIME - (state.tick - state.phaseAt) * ARENA_STEP);
}

/** Le pas d'un joueur pendant les choix : il choisit un nombre (clic, flèches), puis valide. */
function choosing(climber: Climber, input: ArenaInput, options: number[]): Climber {
  const next = { ...climber };
  const isPress = input.primary && !climber.held;
  next.held = input.primary;
  const direction = Math.abs(input.move.x) > DEAD_ZONE ? Math.sign(input.move.x) : 0;
  const move = direction !== climber.heldDirection ? direction : 0;
  next.heldDirection = direction;
  if (next.isLocked) return next;
  const target = input.target;
  if (typeof target === 'number' && target < options.length) {
    next.choice = options[target] ?? NO_CHOICE;
  } else if (move !== 0) {
    const index = options.indexOf(next.choice);
    const from = index < 0 ? (move > 0 ? -1 : options.length) : index;
    next.choice = options[Math.min(options.length - 1, Math.max(0, from + move))] ?? NO_CHOICE;
  }
  const isConfirm = isPress || target === STAIRS_CONFIRM;
  if (isConfirm && next.choice !== NO_CHOICE) next.isLocked = true;
  return next;
}

/** La révélation : qui est seul sur son nombre monte d'autant (le sommet au plus). */
function reveal(state: StairsState, fighters: Climber[], tick: number): StairsState {
  const counts = new Map<number, number>();
  for (const { choice } of fighters) {
    if (choice !== NO_CHOICE) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }
  const revealed = fighters.map((climber) => {
    const isAlone = climber.choice !== NO_CHOICE && counts.get(climber.choice) === 1;
    return {
      ...climber,
      height: isAlone ? Math.min(state.top, climber.height + climber.choice) : climber.height,
      lastChoice: climber.choice,
      climbed: isAlone,
      history: [...climber.history, climber.choice],
      isLocked: true,
    };
  });
  return { ...state, tick, phase: 'reveal', phaseAt: tick, fighters: revealed };
}

/** La partie est jouée : quelqu'un est en haut, ou c'était la dernière manche. */
function isFinished(state: StairsState): boolean {
  return (
    state.round + 1 >= STAIRS_ROUNDS ||
    state.fighters.some((climber) => climber.height >= state.top)
  );
}

function nextRound(state: StairsState, tick: number): StairsState {
  // Au bac à sable, en haut (ou au bout des manches), on redescend.
  const isRestart = isFinished(state);
  const fighters = state.fighters.map((climber) => ({
    ...climber,
    height: isRestart ? 0 : climber.height,
    history: isRestart ? [] : climber.history,
    choice: NO_CHOICE,
    isLocked: false,
  }));
  return {
    ...state,
    tick,
    round: isRestart ? 0 : state.round + 1,
    phase: 'choosing',
    phaseAt: tick,
    fighters,
  };
}

function step(state: StairsState, inputs: Partial<Record<PlayerId, ArenaInput>>): StairsState {
  const tick = state.tick + 1;
  if (state.phase === 'reveal') {
    const isShown = tick - state.phaseAt >= steps(STAIRS_REVEAL_TIME);
    if (isShown && (state.practice || !isFinished(state))) return nextRound(state, tick);
    return { ...state, tick };
  }
  const fighters = state.fighters.map((climber) =>
    choosing(climber, inputs[climber.id] ?? IDLE_INPUT, state.options),
  );
  const isTimeUp = tick - state.phaseAt >= steps(CHOICE_TIME);
  if (isTimeUp || fighters.every((climber) => climber.isLocked)) {
    // Le temps écoulé, un nombre choisi mais pas validé compte quand même.
    return reveal(state, fighters, tick);
  }
  return { ...state, tick, fighters };
}

function isOver(state: StairsState): boolean {
  return (
    !state.practice &&
    state.phase === 'reveal' &&
    isFinished(state) &&
    state.tick - state.phaseAt >= steps(STAIRS_REVEAL_TIME)
  );
}

/** Le classement à la hauteur atteinte ; à hauteur égale, ex aequo (les dés). */
function ranking(state: StairsState): PlayerId[][] {
  const byHeight = new Map<number, PlayerId[]>();
  for (const climber of state.fighters) {
    byHeight.set(climber.height, [...(byHeight.get(climber.height) ?? []), climber.id]);
  }
  return [...byHeight.entries()].sort(([a], [b]) => b - a).map(([, ids]) => ids);
}

/** Pendant les choix, chacun ne voit que le sien (et qui a validé) ; à la révélation, tout. */
function viewFor(state: StairsState, viewer: Viewer): StairsState {
  if (state.phase !== 'choosing') return { ...state, seed: 0 };
  const fighters = state.fighters.map((climber) => {
    const isOwn = viewer.type === 'player' && viewer.playerId === climber.id;
    return isOwn ? climber : { ...climber, choice: HIDDEN_CHOICE };
  });
  return { ...state, seed: 0, fighters };
}

/**
 * Le bot réfléchit un moment (THINK), choisit son nombre, puis valide. Il ne voit que ce qui est
 * public : les hauteurs, et les choix révélés à la manche d'avant. Le Facile choisit au hasard.
 * Le Normal et l'Expert pèsent chaque nombre : ce qu'il fait monter, fois la chance que personne
 * d'autre ne le prenne, d'après ce qu'ils attendent des autres (expectedChoices). L'Expert sait
 * en plus qu'atteindre le sommet, c'est gagner. Un peu de hasard dans le tirage, pour ne
 * pas être lisible.
 */
const THINK: Record<BotLevel, [number, number]> = {
  easy: [1, 3],
  normal: [1.5, 4],
  expert: [2, 5],
};

/**
 * Ce qu'un bot attend d'un autre joueur : la chance qu'il prenne chaque nombre. Au départ, les gros
 * nombres attirent plus ; puis chaque choix révélé de ce joueur pèse autant que tout cet a priori
 * pour l'Expert (il lit vite les habitudes), dix fois moins pour le Normal. L'Expert voit aussi qui
 * peut atteindre le sommet. Réglé à la mesure (300 parties) : seul face à trois bots d'un niveau
 * plus faible, l'Expert gagne 29 à 35 % des parties, le Normal 29 % ; des bots qui raisonnent
 * pareil s'annulent, d'où un écart modeste.
 */
const PRIOR_WEIGHT: Record<BotLevel, number> = { easy: 0, normal: 10, expert: 1 };

function expectedChoices(state: StairsState, other: Climber, level: BotLevel): number[] {
  const prior = state.options.map((option) => option ** 0.7);
  const priorTotal = prior.reduce((sum, weight) => sum + weight, 0);
  const weights = state.options.map((option, index) => {
    const played = other.history.filter((choice) => choice === option).length;
    let weight = ((prior[index] ?? 0) / priorTotal) * PRIOR_WEIGHT[level] + played;
    if (level !== 'expert') return weight;
    if (other.height + option >= state.top) weight *= 2.5;
    return weight;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function chosenOption(state: StairsState, me: Climber, level: BotLevel): number {
  const luck = hashUnit(`${state.seed}:${me.id}:${state.round}:choice`);
  if (level === 'easy') return state.options[Math.floor(luck * state.options.length)] ?? 1;
  const others = state.fighters.filter((climber) => climber.id !== me.id);
  const expectations = others.map((other) => expectedChoices(state, other, level));
  const values = state.options.map((option, index) => {
    const alone = expectations.reduce((chance, odds) => chance * (1 - (odds[index] ?? 0)), 1);
    // Ce qu'il monte vraiment : pas au-delà du sommet ; l'Expert voit qu'y arriver, c'est gagner.
    const climb = Math.min(option, state.top - me.height);
    const reachesTop = me.height + option >= state.top;
    return climb * alone * (level === 'expert' && reachesTop ? 2 : 1);
  });
  // Un tirage pondéré par ces valeurs (au carré : le meilleur sort le plus souvent).
  const weights = values.map((value) => value ** 2 + 0.01);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = luck * total;
  for (const [index, weight] of weights.entries()) {
    pick -= weight;
    if (pick <= 0) return state.options[index] ?? 1;
  }
  return state.options.at(-1) ?? 1;
}

function botInput(state: StairsState, player: PlayerId, level: BotLevel, _rng: Rng): ArenaInput {
  const me = state.fighters.find((climber) => climber.id === player);
  if (!me || state.phase !== 'choosing' || me.isLocked) return IDLE_INPUT;
  const [least, most] = THINK[level];
  const think = least + (most - least) * hashUnit(`${state.seed}:${player}:${state.round}:think`);
  if ((state.tick - state.phaseAt) * ARENA_STEP < think) return IDLE_INPUT;
  const wanted = chosenOption(state, me, level);
  if (me.choice === wanted) return { ...IDLE_INPUT, target: STAIRS_CONFIRM };
  return { ...IDLE_INPUT, target: state.options.indexOf(wanted) };
}

export const UNIQUE_STAIRS: ArenaGame<StairsState> = {
  create,
  step,
  botInput,
  isOver,
  timeLeft: () => null,
  ranking,
  viewFor,
};
