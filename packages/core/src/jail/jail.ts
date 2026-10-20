import { getSpace } from '../board/board';
import type { DiceRoll } from '../dice/dice';
import { type Context, type Flow, removeItem } from '../game/context';
import { isGate, stepForward } from '../game/effects';
import type { PlayerState } from '../game/types';

// Le Cachot des Filous (01-vision-et-plateau.md, section 10).
export const JAIL_LENGTH = 8;
export const WHEEL_CHANCE = 0.3;
export const LUCKY_WHEEL_CHANCE = 0.6;
/** Au 3e tour au Cachot, la sortie est automatique : on ne reste jamais coincé. */
export const AUTOMATIC_EXIT_TURN = 3;
/** Destinations des trappes, par rapport à l'endroit de l'enlèvement. */
const TRAPDOOR_OFFSETS = [-5, 0, 5];

/** Les Filous enlèvent le joueur : il quitte le plateau, son pion reste noté à cet endroit. */
export function kidnap(ctx: Context, player: PlayerState): Flow {
  player.jail = { turns: 0, progress: 0 };
  player.atGate = false;
  ctx.events.push({ type: 'kidnapped', playerId: player.id, spaceId: player.position });
  return 'continue';
}

/** Début d'un tour au Cachot : choisir quoi faire, ou sortie automatique au 3e tour. */
export function startJailTurn(ctx: Context, player: PlayerState): void {
  const jail = player.jail;
  if (!jail) throw new Error(`${player.id} n'est pas au Cachot`);
  jail.turns++;
  const automaticExit = jail.turns >= AUTOMATIC_EXIT_TURN;
  ctx.events.push({ type: 'jailTurn', playerId: player.id, turn: jail.turns, automaticExit });
  ctx.state.phase = {
    type: 'turn',
    playerId: player.id,
    step: { type: automaticExit ? 'awaitTrapdoor' : 'awaitJailChoice' },
  };
}

/**
 * Avancer sur le chemin intérieur avec ses dés. Au bout du chemin, les trappes ; sinon le
 * tour s'arrête. Renvoie `paused` quand le joueur doit choisir une trappe.
 */
export function advanceInJail(ctx: Context, player: PlayerState, dice: DiceRoll): Flow {
  const jail = player.jail;
  if (!jail) throw new Error(`${player.id} n'est pas au Cachot`);
  jail.progress = Math.min(JAIL_LENGTH, jail.progress + dice.total);
  ctx.events.push({
    type: 'jailAdvanced',
    playerId: player.id,
    progress: jail.progress,
    length: JAIL_LENGTH,
  });
  return jail.progress >= JAIL_LENGTH ? awaitTrapdoor(ctx, player) : 'continue';
}

/** Tenter la roue gravée sur le mur : 30 %, ou 60 % avec un Porte-bonheur (consommé). */
export function spinWheel(ctx: Context, player: PlayerState): Flow {
  const lucky = player.inventory.includes('luckyCharm');
  if (lucky) removeItem(player, 'luckyCharm');
  const chance = lucky ? LUCKY_WHEEL_CHANCE : WHEEL_CHANCE;
  const success = ctx.rng.chance(chance);
  ctx.events.push({ type: 'jailWheel', playerId: player.id, chance, success });
  return success ? awaitTrapdoor(ctx, player) : 'continue';
}

function awaitTrapdoor(ctx: Context, player: PlayerState): Flow {
  ctx.state.phase = { type: 'turn', playerId: player.id, step: { type: 'awaitTrapdoor' } };
  return 'paused';
}

/**
 * Le joueur choisit une trappe ; les destinations ne sont tirées qu'après le choix. Il
 * revient sur le plateau un peu derrière, au même endroit ou un peu devant l'endroit de
 * l'enlèvement, sans déclencher la case d'arrivée (comme un échange). Vers l'avant, il
 * s'arrête devant une porte.
 */
export function openTrapdoor(ctx: Context, player: PlayerState, trapdoor: 0 | 1 | 2): void {
  const offset = ctx.rng.shuffle(TRAPDOOR_OFFSETS)[trapdoor] ?? 0;
  ctx.events.push({ type: 'trapdoorOpened', playerId: player.id, trapdoor, offset });
  player.jail = null;

  for (let i = 0; i < Math.abs(offset); i++) {
    if (offset > 0) {
      if (player.atGate) break;
      const next = getSpace(ctx.board, player.position).next[0];
      if (next === undefined) break;
      stepForward(player, next);
      player.atGate = isGate(getSpace(ctx.board, next).kind);
    } else {
      const previous = player.trail.pop() ?? ctx.board.predecessors.get(player.position)?.[0];
      if (previous === undefined) break;
      player.position = previous;
      player.atGate = isGate(getSpace(ctx.board, previous).kind);
    }
  }
  ctx.events.push({ type: 'released', playerId: player.id, spaceId: player.position });
}
