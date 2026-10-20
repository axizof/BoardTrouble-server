import { type Board, distanceToGoal } from '../board/board';
import { getPlayer } from '../game/context';
import { progressRanking } from '../game/progress';
import type { GameState, Intent, PlayerId, PlayerState } from '../game/types';
import type { ItemId } from '../items/catalog';
import { itemUseError, validTargets } from '../items/useItem';
import type { Rng } from '../random/rng';

export type BotLevel = 'easy' | 'normal' | 'expert';

/** Part de choix faits au hasard : un bot Facile se trompe souvent, un Expert jamais. */
const RANDOM_CHOICE_RATE: Record<BotLevel, number> = { easy: 0.5, normal: 0.15, expert: 0 };
/** Part de tours où le bot oublie d'utiliser ses objets. */
const FORGET_ITEM_RATE: Record<BotLevel, number> = { easy: 0.6, normal: 0.2, expert: 0 };
/** Distance jusqu'à laquelle un piège posé a des chances d'être traversé par un adversaire. */
const TRAP_REACH = 8;

/** Valeur d'un objet pour le bot, quand il faut en jeter un. */
const ITEM_VALUE: Record<ItemId, number> = {
  firecracker: 2,
  turboDie: 3,
  rocket: 3,
  glue: 3,
  reroll: 3,
  pickpocket: 3,
  shield: 4,
  blower: 4,
  hourglass: 4,
  mirror: 5,
  grapple: 6,
  key: 6,
};

/** Ordre dans lequel le bot envisage ses objets : les plus décisifs d'abord. */
const ITEM_PRIORITY: ItemId[] = [
  'grapple',
  'hourglass',
  'blower',
  'pickpocket',
  'mirror',
  'rocket',
  'turboDie',
  'glue',
  'firecracker',
  'reroll',
];

/**
 * Décision d'un bot, ou null si ce n'est pas à lui de jouer. Le bot utilise son propre
 * générateur : ses choix ne consomment pas le hasard de la partie, et il ne voit que ce
 * qu'un joueur voit.
 */
export function chooseBoardIntent(
  board: Board,
  state: GameState,
  playerId: PlayerId,
  level: BotLevel,
  rng: Rng,
): Intent | null {
  const { phase } = state;
  if (phase.type !== 'turn' || phase.playerId !== playerId) return null;
  const me = getPlayer(state, playerId);
  const { step } = phase;

  switch (step.type) {
    case 'awaitRoll':
      return (
        (state.turn.itemUsed ? null : chooseItem(board, state, me, level, rng)) ?? { type: 'roll' }
      );
    case 'awaitRerollChoice': {
      const bonus = state.bonusDice[playerId];
      const expected = 3.5 + (bonus ? (bonus.faces + 1) / 2 : 0);
      return { type: step.roll.total < expected ? 'reroll' : 'keepRoll' };
    }
    case 'awaitBranch': {
      if (rng.chance(RANDOM_CHOICE_RATE[level])) {
        return { type: 'chooseBranch', spaceId: rng.pick(step.options) };
      }
      const [best] = [...step.options].sort(
        (a, b) => distanceToGoal(board, a) - distanceToGoal(board, b),
      );
      return best === undefined ? null : { type: 'chooseBranch', spaceId: best };
    }
    case 'awaitChest':
      return { type: 'chooseChest', chest: rng.chance(0.5) ? 0 : 1 };
    case 'awaitItemSwap': {
      const [worst] = [...me.inventory, step.offered].sort((a, b) => ITEM_VALUE[a] - ITEM_VALUE[b]);
      return worst === undefined ? null : { type: 'resolveItemSwap', discard: worst };
    }
  }
}

function chooseItem(
  board: Board,
  state: GameState,
  me: PlayerState,
  level: BotLevel,
  rng: Rng,
): Intent | null {
  if (me.inventory.length === 0 || rng.chance(FORGET_ITEM_RATE[level])) return null;
  const ranking = progressRanking(board, state);
  const myDistance = distanceToGoal(board, me.position);
  const distanceOf = (id: PlayerId) => distanceToGoal(board, getPlayer(state, id).position);

  for (const item of ITEM_PRIORITY) {
    if (!me.inventory.includes(item)) continue;
    const targets = validTargets(board, state, me.id, item);
    // Viser le mieux placé : c'est lui qu'il faut ralentir.
    const target = [...targets].sort((a, b) => ranking.indexOf(a) - ranking.indexOf(b))[0];
    const usable = itemUseError(board, state, me.id, item, target) === null;
    if (!usable || !worthUsing(item)) continue;
    return { type: 'useItem', item, ...(target === undefined ? {} : { target }) };
  }
  return null;

  function worthUsing(item: ItemId): boolean {
    switch (item) {
      case 'blower':
        return validTargets(board, state, me.id, item).some((id) => distanceOf(id) < myDistance);
      case 'mirror':
        return ranking.indexOf(me.id) < ranking.length / 2;
      case 'rocket': {
        const bonus = state.bonusDice[me.id];
        return !me.atGate && (bonus === null || bonus === undefined || bonus.faces <= 3);
      }
      case 'glue':
      case 'firecracker':
        return state.players.some(
          (other) =>
            other.id !== me.id &&
            distanceOf(other.id) > myDistance &&
            distanceOf(other.id) - myDistance <= TRAP_REACH,
        );
      default:
        return true;
    }
  }
}
