import { getSpace, type SpaceId, type SpaceKind } from '../board/board';
import {
  catchUpFactor,
  drawItem,
  INVENTORY_SIZE,
  ITEM_IDS,
  ITEMS,
  type ItemId,
} from '../items/catalog';
import { activePlayerId, type Context, type Flow, removeItem } from './context';
import type { ItemSource, PlayerState } from './types';

/** Assez pour revenir sur ses pas lors des plus grands reculs. */
const TRAIL_LENGTH = 64;
const FIRECRACKER_RECOIL = 5;
const CHEST_TRAP_RECOIL = 4;
const CHEST_TRAP_CHANCE = 0.5;

/**
 * Effet de la case d'arrivée (01-vision-et-plateau.md, section 8). Arrivée aux dés : la case
 * s'active. Arrivée par un effet : pile ou face, une seule fois par joueur et par tour.
 * Les cases à choix (coffre) ou à inventaire ne s'activent que pour le joueur dont c'est
 * le tour ; un joueur déplacé pendant le tour d'un autre n'y gagne rien.
 */
export function resolveArrival(ctx: Context, player: PlayerState, cause: 'dice' | 'effect'): Flow {
  if (player.atGate) return 'continue';
  const space = getSpace(ctx.board, player.position);

  const trap = ctx.state.traps[space.id];
  if (trap?.type === 'firecracker' && trap.owner !== player.id) {
    delete ctx.state.traps[space.id];
    ctx.events.push({
      type: 'trapTriggered',
      playerId: player.id,
      spaceId: space.id,
      trap: 'firecracker',
    });
    return applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, FIRECRACKER_RECOIL));
  }

  if (!hasEffect(space.kind, player, activePlayerId(ctx.state) === player.id)) return 'continue';

  if (cause === 'effect') {
    if (ctx.state.turn.coinFlipped.includes(player.id)) return 'continue';
    ctx.state.turn.coinFlipped.push(player.id);
    const heads = ctx.rng.chance(0.5);
    ctx.events.push({ type: 'coinFlipped', playerId: player.id, spaceId: space.id, heads });
    if (!heads) return 'continue';
  }

  ctx.events.push({ type: 'spaceTriggered', playerId: player.id, spaceId: space.id });
  switch (space.kind.type) {
    case 'bonus':
      return advanceByEffect(ctx, player, space.kind.amount);
    case 'malus': {
      const { amount } = space.kind;
      return applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, amount));
    }
    case 'item':
      return gainItem(
        ctx,
        player,
        drawItem(ctx.rng, catchUpFactor(ctx.board, ctx.state, player.id)),
        'itemSpace',
      );
    case 'chest':
      ctx.state.phase = {
        type: 'turn',
        playerId: player.id,
        step: { type: 'awaitChest', resume: ctx.resume },
      };
      return 'paused';
    case 'rest':
      return gainItem(
        ctx,
        player,
        ctx.rng.pick(ITEM_IDS.filter((item) => ITEMS[item].rarity === 'common')),
        'rest',
      );
    default:
      return 'continue';
  }
}

function hasEffect(kind: SpaceKind, player: PlayerState, isActive: boolean): boolean {
  switch (kind.type) {
    case 'bonus':
    case 'malus':
      return true;
    case 'item':
    case 'chest':
      return isActive;
    case 'rest':
      return isActive && player.inventory.length === 0;
    default:
      return false;
  }
}

/** Le joueur choisit un des deux coffres ; son contenu n'est tiré qu'après le choix. */
export function openChest(ctx: Context, player: PlayerState, chest: 0 | 1): Flow {
  const trapped = ctx.rng.chance(CHEST_TRAP_CHANCE);
  ctx.events.push({ type: 'chestOpened', playerId: player.id, chest, trapped });
  if (trapped)
    return applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, CHEST_TRAP_RECOIL));
  return gainItem(
    ctx,
    player,
    drawItem(ctx.rng, catchUpFactor(ctx.board, ctx.state, player.id), 'rare'),
    'chest',
  );
}

/**
 * Donne un objet. Inventaire plein : le joueur dont c'est le tour choisit quoi jeter ;
 * un autre joueur (hors de son tour) refuse automatiquement l'objet.
 */
export function gainItem(
  ctx: Context,
  player: PlayerState,
  item: ItemId,
  source: ItemSource,
): Flow {
  if (player.inventory.length < INVENTORY_SIZE) {
    player.inventory.push(item);
    ctx.events.push({ type: 'itemGained', playerId: player.id, item, source });
    return 'continue';
  }
  if (activePlayerId(ctx.state) === player.id) {
    ctx.state.phase = {
      type: 'turn',
      playerId: player.id,
      step: { type: 'awaitItemSwap', offered: item, source, resume: ctx.resume },
    };
    return 'paused';
  }
  ctx.events.push({ type: 'itemRefused', playerId: player.id, item });
  return 'continue';
}

export type HostileSource = { player: PlayerState; item: ItemId };

/**
 * Applique un effet négatif. Un effet ciblé venant d'un joueur est d'abord renvoyé par un
 * Miroir activé (une seule fois, pas de renvoi en chaîne) ; puis le Bouclier de la victime,
 * s'il y en a un, l'annule. `effect` reçoit la victime finale.
 */
export function applyHostile(
  ctx: Context,
  target: PlayerState,
  source: HostileSource | null,
  effect: (victim: PlayerState) => Flow,
): Flow {
  let victim = target;
  if (source && target.mirrorArmed) {
    removeItem(target, 'mirror');
    ctx.events.push({
      type: 'mirrorReflected',
      playerId: target.id,
      attacker: source.player.id,
      item: source.item,
    });
    victim = source.player;
  }
  if (victim.inventory.includes('shield')) {
    removeItem(victim, 'shield');
    ctx.events.push({ type: 'shieldBlocked', playerId: victim.id });
    return 'continue';
  }
  return effect(victim);
}

/** Recul de `amount` cases par le chemin réellement suivi, puis effet de la case d'arrivée. */
export function recoil(ctx: Context, player: PlayerState, amount: number): Flow {
  const path: SpaceId[] = [];
  for (let i = 0; i < amount; i++) {
    const previous = player.trail.pop() ?? ctx.board.predecessors.get(player.position)?.[0];
    if (previous === undefined) break;
    player.position = previous;
    player.atGate = isGate(getSpace(ctx.board, previous).kind);
    path.push(previous);
  }
  if (path.length > 0)
    ctx.events.push({ type: 'moved', playerId: player.id, path, cause: 'effect' });
  return resolveArrival(ctx, player, 'effect');
}

/**
 * Avancée par un effet (case bonus, Fusée...), puis effet de la case d'arrivée. Elle ne
 * franchit jamais une porte : elle s'arrête devant. À un embranchement, le joueur dont c'est
 * le tour choisit sa voie ; un joueur déplacé pendant le tour d'un autre ne peut pas répondre
 * à ce moment-là et suit la voie principale. `firstStep` est la voie choisie.
 */
export function advanceByEffect(
  ctx: Context,
  player: PlayerState,
  steps: number,
  firstStep?: SpaceId,
): Flow {
  const path: SpaceId[] = [];
  const flush = () => {
    if (path.length > 0)
      ctx.events.push({ type: 'moved', playerId: player.id, path: [...path], cause: 'effect' });
    path.length = 0;
  };
  let forced = firstStep;
  for (let remaining = steps; remaining > 0 && !player.atGate; remaining--) {
    const { next } = getSpace(ctx.board, player.position);
    if (forced === undefined && next.length > 1 && activePlayerId(ctx.state) === player.id) {
      flush();
      ctx.events.push({ type: 'branchReached', playerId: player.id, options: [...next] });
      ctx.state.phase = {
        type: 'turn',
        playerId: player.id,
        step: {
          type: 'awaitBranch',
          remaining,
          options: [...next],
          mode: 'effect',
          resume: ctx.resume,
        },
      };
      return 'paused';
    }
    const step = forced ?? next[0];
    forced = undefined;
    if (step === undefined) break;
    stepForward(player, step);
    player.atGate = isGate(getSpace(ctx.board, step).kind);
    path.push(step);
  }
  flush();
  return resolveArrival(ctx, player, 'effect');
}

export function stepForward(player: PlayerState, next: SpaceId): void {
  player.trail.push(player.position);
  if (player.trail.length > TRAIL_LENGTH) player.trail.shift();
  player.position = next;
  player.atGate = false;
}

export function isGate(kind: SpaceKind): boolean {
  return kind.type === 'gate' || kind.type === 'finalGate';
}
