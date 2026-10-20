import { distanceToGoal, getSpace, type Space, type SpaceId } from '../board/board';
import { rollDice } from '../dice/dice';
import type { ItemId } from '../items/catalog';
import { drawMinigame } from '../minigames/selection';
import { type Context, type Flow, removeItem } from './context';
import { applyHostile, isGate, recoil } from './effects';
import { fallFromEdge, isIce } from './floors';
import { moveWithDice } from './movement';
import type { PlayerState } from './types';

/** Une porte ne descend pas sous ce seuil, quel que soit le nombre d'échecs. */
const MIN_GATE_THRESHOLD = 2;
const TRAPPED_DOOR_RECOIL = 5;
const TRAPPED_DOOR_CHANCE = 0.5;
const SKILL_GATE_BONUS = 3;
const BOULDER_COURSE = 15;

export type GateOutcome = 'passed' | 'failed' | 'opened' | 'paused';

/**
 * Tente la porte devant laquelle se trouve le joueur. `remaining` : cases à parcourir après
 * la porte. `turnRoll` : total déjà lancé ce tour (tentative en début de tour), ou null
 * (arrivée pendant un déplacement : on lance si la porte le demande). Une Clé ouvre toute
 * porte sauf la porte finale.
 */
export function attemptGate(
  ctx: Context,
  player: PlayerState,
  remaining: number,
  turnRoll: number | null,
): GateOutcome {
  const space = getSpace(ctx.board, player.position);
  const { kind } = space;
  const pause = (step: Extract<Context['state']['phase'], { type: 'turn' }>['step']) => {
    ctx.state.phase = { type: 'turn', playerId: player.id, step };
    return 'paused' as const;
  };

  if (kind.type !== 'finalGate' && player.inventory.includes('key')) {
    removeItem(player, 'key');
    player.atGate = false;
    ctx.events.push({ type: 'keyUsed', playerId: player.id, spaceId: space.id });
    return 'passed';
  }

  switch (kind.type) {
    case 'twinGate':
      return pause({ type: 'awaitDoor', remaining });
    case 'skillGate':
      return pause({ type: 'awaitSkillGate', remaining, minigame: drawMinigame(ctx, 'solo', 1) });
    case 'tollGate':
      if (player.inventory.length > 0)
        return pause({ type: 'awaitToll', remaining, roll: turnRoll });
      return thresholdTest(ctx, player, space, turnRoll ?? gateRoll(ctx, player));
    case 'gate':
    case 'boulderGate':
    case 'finalGate':
      return thresholdTest(ctx, player, space, turnRoll ?? gateRoll(ctx, player));
    default:
      throw new Error(`Pas de porte sur ${space.id}`);
  }
}

/** Lancer de dés pour une porte atteinte pendant un déplacement. */
function gateRoll(ctx: Context, player: PlayerState): number {
  const roll = rollDice(ctx.rng, ctx.state.bonusDice[player.id] ?? null);
  ctx.events.push({ type: 'diceRolled', playerId: player.id, purpose: 'gate', roll });
  return roll.total;
}

/**
 * Test de seuil. Le seuil baisse de 1 par échec pour ce joueur (sauf la porte finale). Un
 * échec à la porte au rocher lâche le rocher.
 */
function thresholdTest(
  ctx: Context,
  player: PlayerState,
  space: Space,
  total: number,
): GateOutcome {
  const { kind } = space;
  if (!('threshold' in kind)) throw new Error(`Pas de seuil sur ${space.id}`);
  const failures = player.gateFailures[space.id] ?? 0;
  const threshold =
    kind.type === 'finalGate'
      ? kind.threshold
      : kind.threshold - Math.max(0, Math.min(failures, kind.threshold - MIN_GATE_THRESHOLD));
  const success = total >= threshold;
  ctx.events.push({
    type: 'gateTested',
    playerId: player.id,
    spaceId: space.id,
    threshold,
    total,
    success,
  });

  if (!success) {
    player.gateFailures[space.id] = failures + 1;
    if (kind.type === 'boulderGate') rollBoulder(ctx, player, space.id);
    return 'failed';
  }
  player.atGate = false;
  if (kind.type !== 'finalGate') return 'passed';
  ctx.state.finalGateOpenedBy.push(player.id);
  ctx.events.push({ type: 'finalGateOpened', playerId: player.id });
  return 'opened';
}

/**
 * Le rocher dévale 15 cases depuis la porte : tous les joueurs sur sa trajectoire, celui qui
 * l'a lâché compris, sont poussés jusqu'au bas de sa course (pas au-delà, ni sur une case
 * gelée). C'est une poussée : un joueur sur une case de bord tombe. Le Bouclier protège ;
 * les joueurs intouchables (Cachot, porte finale ouverte) sont épargnés.
 */
function rollBoulder(ctx: Context, trigger: PlayerState, gateId: SpaceId): void {
  let bottom = gateId;
  for (let i = 0; i < BOULDER_COURSE || isIce(ctx.board, bottom); i++) {
    const previous = ctx.board.predecessors.get(bottom)?.[0];
    if (previous === undefined) break;
    bottom = previous;
  }
  const top = distanceToGoal(ctx.board, gateId);
  const floor = distanceToGoal(ctx.board, bottom);
  const pushed: string[] = [];
  for (const player of ctx.state.players) {
    if (player.jail || ctx.state.finalGateOpenedBy.includes(player.id)) continue;
    const distance = distanceToGoal(ctx.board, player.position);
    if (distance < top || distance >= floor) continue;
    applyHostile(ctx, player, null, (victim) => {
      if (fallFromEdge(ctx, victim)) return 'continue';
      victim.position = bottom;
      victim.trail = [];
      victim.atGate = isGate(getSpace(ctx.board, bottom).kind);
      pushed.push(victim.id);
      return 'continue';
    });
  }
  ctx.events.push({
    type: 'boulderRolled',
    playerId: trigger.id,
    spaceId: gateId,
    pushed,
    to: bottom,
  });
}

/** Le joueur a passé la porte : il finit son déplacement. */
function passGate(ctx: Context, player: PlayerState, remaining: number): Flow {
  player.atGate = false;
  return moveWithDice(ctx, player, remaining);
}

/** Deux portes : le passage piégé n'est tiré qu'après le choix. */
export function chooseDoor(
  ctx: Context,
  player: PlayerState,
  door: 0 | 1,
  remaining: number,
): Flow {
  const trapped = ctx.rng.chance(TRAPPED_DOOR_CHANCE);
  ctx.events.push({ type: 'doorOpened', playerId: player.id, door, trapped });
  if (!trapped) return passGate(ctx, player, remaining);
  applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, TRAPPED_DOOR_RECOIL));
  return 'continue';
}

/** Péage : payer un objet pour passer tout de suite, ou tenter le seuil (item null). */
export function payToll(
  ctx: Context,
  player: PlayerState,
  item: ItemId | null,
  remaining: number,
  turnRoll: number | null,
): Flow {
  if (item !== null) {
    removeItem(player, item);
    ctx.events.push({ type: 'tollPaid', playerId: player.id, item });
    return passGate(ctx, player, remaining);
  }
  const space = getSpace(ctx.board, player.position);
  const outcome = thresholdTest(ctx, player, space, turnRoll ?? gateRoll(ctx, player));
  return outcome === 'passed' ? passGate(ctx, player, remaining) : 'continue';
}

/** Porte d'adresse : réussi, on passe avec 3 cases de plus ; raté, on reste devant. */
export function resolveSkillGate(
  ctx: Context,
  player: PlayerState,
  success: boolean,
  remaining: number,
): Flow {
  ctx.events.push({ type: 'skillGateResult', playerId: player.id, success });
  return success ? passGate(ctx, player, remaining + SKILL_GATE_BONUS) : 'continue';
}
