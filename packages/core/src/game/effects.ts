import { getSpace, type SpaceId, type SpaceKind } from '../board/board';
import { startInteraction } from '../interactions/interactions';
import {
  catchUpFactor,
  drawItem,
  INVENTORY_SIZE,
  ITEM_IDS,
  ITEMS,
  type ItemId,
} from '../items/catalog';
import { kidnap } from '../jail/jail';
import { applyTrouble, drawSpaceEvent } from '../trouble/events';
import { effectiveKind } from '../trouble/overlays';
import { activePlayerId, type Context, type Flow, removeItem } from './context';
import type { HostileVia, ItemSource, PlayerId, PlayerState } from './types';

/** Assez pour revenir sur ses pas lors des plus grands reculs. */
const TRAIL_LENGTH = 64;
const FIRECRACKER_RECOIL = 5;
const CHEST_TRAP_RECOIL = 4;
const CHEST_TRAP_CHANCE = 0.5;
const MAX_ERUPTION_CHAIN = 3;

/**
 * Effet de la case d'arrivée (01-vision-et-plateau.md, section 8). Arrivée aux dés : la case
 * s'active. Arrivée par un effet : pile ou face, une seule fois par joueur et par tour.
 * Les cases à choix (coffre) ou à inventaire ne s'activent que pour le joueur dont c'est
 * le tour ; un joueur déplacé pendant le tour d'un autre n'y gagne rien.
 */
export function resolveArrival(ctx: Context, player: PlayerState, cause: 'dice' | 'effect'): Flow {
  if (player.atGate || player.jail) return 'continue';
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

  const kind = effectiveKind(ctx.board, ctx.state, space.id);
  if (!hasEffect(kind, player, activePlayerId(ctx.state) === player.id)) return 'continue';

  // Pendant l'Éruption, les cases -3 s'enchaînent sans pile ou face, 3 fois au plus.
  const erupting = ctx.state.overlays.eruptionUntil !== null && kind.type === 'malus';
  if (cause === 'effect' && erupting) {
    if (ctx.eruptionChain >= MAX_ERUPTION_CHAIN) return 'continue';
    ctx.eruptionChain++;
  } else if (cause === 'effect') {
    if (ctx.state.turn.coinFlipped.includes(player.id)) return 'continue';
    ctx.state.turn.coinFlipped.push(player.id);
    const heads = ctx.rng.chance(0.5);
    ctx.events.push({ type: 'coinFlipped', playerId: player.id, spaceId: space.id, heads });
    if (!heads) return 'continue';
  }

  ctx.events.push({ type: 'spaceTriggered', playerId: player.id, spaceId: space.id });
  switch (kind.type) {
    case 'bonus':
      return advanceByEffect(ctx, player, kind.amount);
    case 'malus': {
      const { amount } = kind;
      // L'Éruption vient du Plateau : le Bouclier n'y peut rien.
      if (erupting) return recoil(ctx, player, amount);
      return applyHostile(ctx, player, null, (victim) => recoil(ctx, victim, amount));
    }
    case 'trouble': {
      const event = drawSpaceEvent(ctx.board, ctx.state, ctx.rng);
      return event === null ? 'continue' : applyTrouble(ctx, event, null, player);
    }
    case 'squall':
    case 'swap':
    case 'magnet':
    case 'steal':
    case 'duel':
    case 'oneVsAll':
    case 'vendetta':
      return startInteraction(ctx, player, kind.type);
    case 'filous':
      return applyHostile(ctx, player, null, (victim) => kidnap(ctx, victim));
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
    case 'trouble':
    case 'filous':
      return true;
    case 'item':
    case 'chest':
      return isActive;
    case 'rest':
      return isActive && player.inventory.length === 0;
    case 'vendetta':
      return isActive && player.lastAttack !== null;
    case 'squall':
    case 'swap':
    case 'magnet':
    case 'steal':
    case 'duel':
    case 'oneVsAll':
      return isActive;
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
 * Donne un objet. Inventaire plein : le joueur dont c'est le tour choisit quoi jeter ; entre
 * deux tours (fin de manche), chacun choisira à son tour ; un joueur touché pendant le tour
 * d'un autre refuse automatiquement l'objet (pas de choix pendant le tour d'un autre).
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
  const active = activePlayerId(ctx.state);
  if (active === null) {
    ctx.pendingItemChoices.push({ playerId: player.id, offered: item });
    return 'continue';
  }
  if (active === player.id) {
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

export type HostileSource = { player: PlayerState; via: HostileVia };

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
      via: source.via,
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

/**
 * Recul de `amount` cases par le chemin réellement suivi, puis effet de la case d'arrivée.
 * `attacker` : l'adversaire responsable du recul, retenu pour la Vendetta.
 */
export function recoil(
  ctx: Context,
  player: PlayerState,
  amount: number,
  attacker?: PlayerId,
): Flow {
  const path: SpaceId[] = [];
  for (let i = 0; i < amount; i++) {
    const previous = player.trail.pop() ?? ctx.board.predecessors.get(player.position)?.[0];
    if (previous === undefined) break;
    player.position = previous;
    player.atGate = isGate(getSpace(ctx.board, previous).kind);
    path.push(previous);
  }
  if (path.length > 0) {
    ctx.events.push({ type: 'moved', playerId: player.id, path, cause: 'effect' });
    if (attacker !== undefined) player.lastAttack = { by: attacker, spaces: path.length };
  }
  return resolveArrival(ctx, player, 'effect');
}

/**
 * L'autre joueur d'une attaque : après un renvoi par le Miroir, la victime est l'attaquant,
 * et l'effet profite alors à la cible d'origine.
 */
export function opponentOf(
  victim: PlayerState,
  attacker: PlayerState,
  target: PlayerState,
): PlayerState {
  return victim === target ? attacker : target;
}

/** Vole un objet au hasard (Pickpocket, case Vol). Une victime sans objet ne perd rien. */
export function stealRandomItem(ctx: Context, victim: PlayerState, thief: PlayerState): Flow {
  if (victim.inventory.length === 0) return 'continue';
  const stolen = ctx.rng.pick(victim.inventory);
  removeItem(victim, stolen);
  ctx.events.push({ type: 'itemStolen', playerId: thief.id, victim: victim.id, item: stolen });
  if (thief.inventory.length < INVENTORY_SIZE) thief.inventory.push(stolen);
  else ctx.events.push({ type: 'itemRefused', playerId: thief.id, item: stolen });
  return 'continue';
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

/** Échange de places : aucune case ne s'active (01-vision-et-plateau.md, section 8). */
export function swapPlaces(ctx: Context, a: PlayerState, b: PlayerState): void {
  [a.position, b.position] = [b.position, a.position];
  [a.atGate, b.atGate] = [b.atGate, a.atGate];
  [a.trail, b.trail] = [b.trail, a.trail];
  ctx.events.push({ type: 'swapped', playerId: a.id, with: b.id });
}
