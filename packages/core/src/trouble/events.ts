import { type Board, distanceToGoal, getSpace, type SpaceId } from '../board/board';
import { type Context, type Flow, getPlayer, removeItem } from '../game/context';
import { advanceByEffect, gainItem, recoil, stepForward, swapPlaces } from '../game/effects';
import { progressRanking } from '../game/progress';
import type { GameState, PlayerId, PlayerState } from '../game/types';
import { catchUpFactor, drawItem, ITEM_VALUE } from '../items/catalog';
import type { Rng } from '../random/rng';
import { isSpecial } from './overlays';

export type TroubleEventId =
  | 'grandExchange'
  | 'inversion'
  | 'eruption'
  | 'rotation'
  | 'expressElevator'
  | 'itemRain'
  | 'fog'
  | 'bonusMinigame'
  | 'tax'
  // Petits TROUBLE, réservés à la case TROUBLE :
  | 'shake'
  | 'gust';

export type TroubleCategory = 'mild' | 'medium' | 'violent' | 'small';

// Le Séisme (violent) arrive avec les cases de bord et les chutes.
export const TROUBLE_CATEGORY: Record<TroubleEventId, TroubleCategory> = {
  grandExchange: 'violent',
  inversion: 'medium',
  eruption: 'medium',
  rotation: 'medium',
  expressElevator: 'medium',
  itemRain: 'mild',
  fog: 'mild',
  bonusMinigame: 'mild',
  tax: 'mild',
  shake: 'small',
  gust: 'small',
};

const EVENTS = Object.keys(TROUBLE_CATEGORY) as TroubleEventId[];
/** Événements possibles sur une case TROUBLE : petits et sans pause de jeu. */
const SPACE_EVENTS: TroubleEventId[] = ['shake', 'gust', 'tax', 'fog'];
/** L'option violente n'est proposée qu'une fois sur cinq : le Grand Échange reste rare. */
const VIOLENT_OPTION_CHANCE = 0.2;
const OVERLAY_ROUNDS = 2;
const BONUS_MINIGAME_REWARD = 8;
const GUST_RANGE = 4;
const GUST_PUSH = 2;

/**
 * Un événement n'est jamais proposé ni tiré s'il n'a aucun effet
 * (01-vision-et-plateau.md, section 8).
 */
export function isApplicable(board: Board, state: GameState, event: TroubleEventId): boolean {
  const ranking = troubleRanking(board, state);
  const first = ranking[0];
  const last = ranking.at(-1);
  switch (event) {
    case 'grandExchange':
      return first !== undefined && last !== undefined && first !== last;
    case 'expressElevator':
      return last !== undefined && nextFloorPath(board, getPlayer(state, last).position) !== null;
    case 'tax':
      return first !== undefined && getPlayer(state, first).inventory.length > 0;
    case 'inversion':
      return state.overlays.inversionUntil === null;
    case 'eruption':
      return state.overlays.eruptionUntil === null;
    case 'fog':
      return state.overlays.fog === null;
    default:
      return true;
  }
}

/** Trois options au plus, chacune d'une violence différente (douce, moyenne, violente). */
export function drawTroubleOptions(board: Board, state: GameState, rng: Rng): TroubleEventId[] {
  const categories: TroubleCategory[] = ['mild', 'medium'];
  if (rng.chance(VIOLENT_OPTION_CHANCE)) categories.push('violent');
  return categories.flatMap((category) => {
    const candidates = EVENTS.filter(
      (event) => TROUBLE_CATEGORY[event] === category && isApplicable(board, state, event),
    );
    return candidates.length > 0 ? [rng.pick(candidates)] : [];
  });
}

/** Petit événement d'une case TROUBLE, tiré au hasard par le Plateau. */
export function drawSpaceEvent(board: Board, state: GameState, rng: Rng): TroubleEventId | null {
  const candidates = SPACE_EVENTS.filter((event) => isApplicable(board, state, event));
  return candidates.length > 0 ? rng.pick(candidates) : null;
}

/**
 * Le dernier et le premier selon le TROUBLE : classement du plateau, sans les intouchables
 * (porte finale ouverte, Cachot des Filous).
 */
export function troubleRanking(board: Board, state: GameState): PlayerId[] {
  return progressRanking(board, state).filter(
    (id) => !state.finalGateOpenedBy.includes(id) && getPlayer(state, id).jail === null,
  );
}

/**
 * Applique un événement. `subject` est le joueur qui a déclenché une case TROUBLE (null
 * pour un réveil de fin de manche). Le Bouclier ne protège pas : le Plateau est au-dessus
 * des règles.
 */
export function applyTrouble(
  ctx: Context,
  event: TroubleEventId,
  chooser: PlayerId | null,
  subject: PlayerState | null,
): Flow {
  const { board, state, rng } = ctx;
  ctx.events.push({ type: 'troubleApplied', event, chooser });
  const ranking = troubleRanking(board, state);
  const [firstId] = ranking;
  const lastId = ranking.at(-1);
  const first = firstId === undefined ? null : getPlayer(state, firstId);
  const last = lastId === undefined ? null : getPlayer(state, lastId);
  const until = state.round + OVERLAY_ROUNDS;

  switch (event) {
    case 'grandExchange':
      if (first && last) swapPlaces(ctx, first, last);
      return 'continue';
    case 'inversion':
      state.overlays.inversionUntil = until;
      return 'continue';
    case 'eruption':
      state.overlays.eruptionUntil = until;
      return 'continue';
    case 'fog': {
      const specials = Object.values(board.definition.spaces).filter((space) =>
        isSpecial(space.kind),
      );
      const kinds = rng.shuffle(specials.map((space) => space.kind));
      state.overlays.fog = {
        until,
        kinds: Object.fromEntries(
          specials.map((space, index) => [space.id, kinds[index] ?? space.kind]),
        ),
      };
      return 'continue';
    }
    case 'rotation':
      for (const id of ranking) {
        const player = getPlayer(state, id);
        const steps = rng.int(1, 6);
        if (rng.chance(0.5)) advanceByEffect(ctx, player, steps);
        else recoil(ctx, player, steps);
      }
      return 'continue';
    case 'expressElevator': {
      const path = last ? nextFloorPath(board, last.position) : null;
      if (!last || !path) return 'continue';
      for (const space of path) stepForward(last, space);
      ctx.events.push({ type: 'moved', playerId: last.id, path, cause: 'effect' });
      return 'continue';
    }
    case 'itemRain':
      // Événement sans position : les joueurs au Cachot reçoivent aussi leur objet.
      for (const id of [...ranking].reverse().concat(jailedPlayers(state))) {
        const player = getPlayer(state, id);
        gainItem(ctx, player, drawItem(rng, catchUpFactor(board, state, id)), 'trouble');
      }
      return 'continue';
    case 'bonusMinigame':
      state.phase = { type: 'bonusMinigame' };
      ctx.events.push({ type: 'bonusMinigameStarted' });
      return 'continue';
    case 'tax': {
      if (!first || !last || first.inventory.length === 0) return 'continue';
      const [best] = [...first.inventory].sort((a, b) => ITEM_VALUE[b] - ITEM_VALUE[a]);
      if (best === undefined) return 'continue';
      removeItem(first, best);
      return first === last ? 'continue' : gainItem(ctx, last, best, 'trouble');
    }
    case 'shake': {
      if (!subject) return 'continue';
      const steps = rng.int(1, 3);
      return rng.chance(0.5) ? advanceByEffect(ctx, subject, steps) : recoil(ctx, subject, steps);
    }
    case 'gust': {
      if (!subject) return 'continue';
      const origin = distanceToGoal(board, subject.position);
      for (const other of state.players) {
        if (other === subject || other.jail || state.finalGateOpenedBy.includes(other.id)) continue;
        if (Math.abs(distanceToGoal(board, other.position) - origin) <= GUST_RANGE) {
          recoil(ctx, other, GUST_PUSH);
        }
      }
      return 'continue';
    }
  }
}

function jailedPlayers(state: GameState): PlayerId[] {
  return state.players.filter((player) => player.jail !== null).map((player) => player.id);
}

/** Vainqueur du Mini-jeu bonus : il avance. */
export function rewardBonusMinigame(ctx: Context, winner: PlayerState): void {
  advanceByEffect(ctx, winner, BONUS_MINIGAME_REWARD);
}

/**
 * Chemin par la voie principale jusqu'à la première case de l'étage suivant (Ascenseur
 * express), ou null s'il n'y a pas d'étage au-dessus.
 */
export function nextFloorPath(board: Board, from: SpaceId): SpaceId[] | null {
  const floor = getSpace(board, from).floor;
  const path: SpaceId[] = [];
  let current = getSpace(board, from);
  for (let guard = 0; guard < 10_000; guard++) {
    const next = current.next[0];
    if (next === undefined) return null;
    current = getSpace(board, next);
    path.push(next);
    if (current.floor > floor) return path;
  }
  return null;
}
