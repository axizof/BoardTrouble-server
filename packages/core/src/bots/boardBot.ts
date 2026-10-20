import { type Board, distanceToGoal, getSpace } from '../board/board';
import type { SpecialDieKind } from '../dice/dice';
import { getPlayer } from '../game/context';
import { progressRanking } from '../game/progress';
import type { GameState, Intent, PlayerId, PlayerState, TargetedInteraction } from '../game/types';
import { ITEM_VALUE, type ItemId } from '../items/catalog';
import { itemUseError, validTargets } from '../items/useItem';
import type { Rng } from '../random/rng';
import type { TroubleEventId } from '../trouble/events';

export type BotLevel = 'easy' | 'normal' | 'expert';

/** Part de choix faits au hasard : un bot Facile se trompe souvent, un Expert jamais. */
const RANDOM_CHOICE_RATE: Record<BotLevel, number> = { easy: 0.5, normal: 0.15, expert: 0 };
/** Part de tours où le bot oublie d'utiliser ses objets. */
const FORGET_ITEM_RATE: Record<BotLevel, number> = { easy: 0.6, normal: 0.2, expert: 0 };
/** Distance jusqu'à laquelle un piège posé a des chances d'être traversé par un adversaire. */
const TRAP_REACH = 8;

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
  const me = getPlayer(state, playerId);
  if (phase.type === 'trouble') {
    return phase.chooser === playerId
      ? { type: 'chooseTrouble', event: chooseTrouble(phase.options) }
      : null;
  }
  if (phase.type === 'itemChoices') {
    const [next] = phase.queue;
    if (next?.playerId !== playerId) return null;
    return { type: 'resolveItemSwap', discard: leastValuable([...me.inventory, next.offered]) };
  }
  if (phase.type !== 'turn' || phase.playerId !== playerId) return null;
  const { step } = phase;

  switch (step.type) {
    case 'awaitRoll':
      return (
        (state.turn.itemUsed ? null : chooseItem(board, state, me, level, rng)) ??
        chooseRoll(board, state, me, level)
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
    case 'awaitItemSwap':
      return { type: 'resolveItemSwap', discard: leastValuable([...me.inventory, step.offered]) };
    case 'awaitTarget':
      return {
        type: 'chooseTarget',
        playerId: chooseInteractionTarget(board, state, step.interaction, step.options),
      };
    case 'awaitJailChoice':
      // Avancer sort en deux tours environ ; la roue ne vaut le coup qu'avec un Porte-bonheur.
      return {
        type: 'chooseJailAction',
        action: me.inventory.includes('luckyCharm') ? 'wheel' : 'advance',
      };
    case 'awaitTrapdoor':
      return { type: 'chooseTrapdoor', trapdoor: rng.pick([0, 1, 2] as const) };
    case 'awaitDoor':
      return { type: 'chooseDoor', door: rng.pick([0, 1] as const) };
    case 'awaitToll':
      // Payer avec son objet le moins utile plutôt que risquer de rester bloqué.
      return {
        type: 'payToll',
        item: me.inventory.length > 0 ? leastValuable(me.inventory) : null,
      };
    case 'awaitSpecialDieSwap': {
      const [worst] = [...me.specialDice, step.offered].sort(
        (a, b) => SPECIAL_DIE_VALUE[a] - SPECIAL_DIE_VALUE[b],
      );
      return { type: 'resolveSpecialDieSwap', discard: worst ?? step.offered };
    }
    case 'awaitBet':
      // Le bot parie sur lui-même : il connaît mal les autres.
      return { type: 'placeBet', on: me.id, stake: level === 'expert' ? 3 : 2 };
    case 'awaitDuelResult':
    case 'awaitOneVsAllResult':
    case 'awaitSkillGate':
    case 'awaitWheel':
      // Le résultat vient du mini-jeu, pas d'une décision du bot.
      return null;
  }
}

/**
 * Le bot qui choisit le TROUBLE est le dernier : il prend ce qui le rapproche le plus vite
 * du premier.
 */
const TROUBLE_PREFERENCE: TroubleEventId[] = [
  'grandExchange',
  'expressElevator',
  'tax',
  'itemRain',
  'bonusMinigame',
  'earthquake',
  'rotation',
  'inversion',
  'eruption',
  'fog',
];

function chooseTrouble(options: TroubleEventId[]): TroubleEventId {
  const ranked = [...options].sort(
    (a, b) => TROUBLE_PREFERENCE.indexOf(a) - TROUBLE_PREFERENCE.indexOf(b),
  );
  const [best] = ranked;
  if (best === undefined) throw new Error('Aucun TROUBLE proposé');
  return best;
}

/**
 * Cible d'une interaction : le mieux placé (c'est lui qu'il faut ralentir ou affronter), et
 * pour un Vol, celui qui a le meilleur objet.
 */
function chooseInteractionTarget(
  board: Board,
  state: GameState,
  interaction: TargetedInteraction,
  options: PlayerId[],
): PlayerId {
  const ranking = progressRanking(board, state);
  const bestItem = (id: PlayerId) =>
    Math.max(0, ...getPlayer(state, id).inventory.map((item) => ITEM_VALUE[item]));
  const [target] = [...options].sort((a, b) =>
    interaction === 'steal' ? bestItem(b) - bestItem(a) : ranking.indexOf(a) - ranking.indexOf(b),
  );
  if (target === undefined) throw new Error('Aucune cible proposée');
  return target;
}

const SPECIAL_DIE_VALUE: Record<SpecialDieKind, number> = {
  stable: 1,
  allOrNothing: 2,
  trapped: 3,
};

/** Cases qu'un bot aime viser avec un Dé Piégé. */
const GOOD_TARGETS = ['elevator', 'springboard', 'bonus', 'item', 'chest', 'specialDie'];

/**
 * Lancer, avec ou sans dé spécial. Dé Piégé : annoncer la distance d'une bonne case visible
 * devant soi. Tout ou rien : quand on est dans la moitié de derrière (il faut prendre des
 * risques). Un bot Facile ne pense pas à ses dés spéciaux.
 */
function chooseRoll(board: Board, state: GameState, me: PlayerState, level: BotLevel): Intent {
  if (level === 'easy' || me.atGate || me.specialDice.length === 0) return { type: 'roll' };
  if (me.specialDice.includes('trapped')) {
    let position = me.position;
    for (let distance = 1; distance <= 6; distance++) {
      const next = getSpace(board, position).next[0];
      if (next === undefined) break;
      position = next;
      if (GOOD_TARGETS.includes(getSpace(board, position).kind.type)) {
        return { type: 'roll', specialDie: 'trapped', call: distance };
      }
    }
  }
  const ranking = progressRanking(board, state);
  if (me.specialDice.includes('allOrNothing') && ranking.indexOf(me.id) >= ranking.length / 2) {
    return { type: 'roll', specialDie: 'allOrNothing' };
  }
  return { type: 'roll' };
}

function leastValuable(items: ItemId[]): ItemId {
  const [worst] = [...items].sort((a, b) => ITEM_VALUE[a] - ITEM_VALUE[b]);
  if (worst === undefined) throw new Error('Aucun objet à comparer');
  return worst;
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
