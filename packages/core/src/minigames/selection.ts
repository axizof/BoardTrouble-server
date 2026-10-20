import type { Context } from '../game/context';
import type { GameState, PlayerState } from '../game/types';
import type { Rng } from '../random/rng';
import { type MinigameId, type MinigameOccasion, minigameCandidates } from './catalog';

// Choix du mini-jeu (01-vision-et-plateau.md, section 5).
const CHOICE_OPTIONS = 3;

/**
 * Roue : tire le mini-jeu d'une occasion. `players` : nombre de joueurs du mini-jeu (il
 * compte pour une finale).
 */
export function drawMinigame(
  ctx: Context,
  occasion: MinigameOccasion,
  players: number,
): MinigameId {
  const [minigame] = weightedDraw(ctx.state, ctx.rng, minigameCandidates(occasion, players), 1);
  if (minigame === undefined) throw new Error(`Aucun mini-jeu pour ${occasion} à ${players}`);
  ctx.events.push({ type: 'minigameDrawn', occasion, minigame });
  notePlayed(ctx.state, minigame);
  return minigame;
}

/** Trois mini-jeux différents à proposer, tirés comme par la roue. */
export function drawMinigameOptions(
  ctx: Context,
  occasion: MinigameOccasion,
  players: number,
): MinigameId[] {
  const candidates = minigameCandidates(occasion, players);
  return weightedDraw(ctx.state, ctx.rng, candidates, CHOICE_OPTIONS);
}

/** Le joueur a choisi son mini-jeu parmi ceux proposés. */
export function chooseMinigame(ctx: Context, player: PlayerState, minigame: MinigameId): void {
  ctx.events.push({ type: 'minigameChosen', playerId: player.id, minigame });
  notePlayed(ctx.state, minigame);
}

/**
 * Mini-jeu de manche : le joueur qui en a gagné le droit (Joker, événement de manche) choisit
 * parmi 3 ; sinon, la roue tire.
 */
export function startRoundMinigame(ctx: Context): void {
  const { state } = ctx;
  const chooser = state.minigames.nextChooser;
  if (chooser === null) {
    state.phase = { type: 'minigame', minigame: drawMinigame(ctx, 'round', state.tableSize) };
    return;
  }
  state.minigames.nextChooser = null;
  const options = drawMinigameOptions(ctx, 'round', state.tableSize);
  state.phase = { type: 'minigameChoice', chooser, options };
  ctx.events.push({ type: 'minigameChoiceOffered', playerId: chooser, options });
}

/** Le joueur choisira le prochain mini-jeu de manche. Un seul joueur a ce droit à la fois. */
export function grantMinigameChoice(ctx: Context, player: PlayerState): void {
  ctx.state.minigames.nextChooser = player.id;
  ctx.events.push({ type: 'minigameChoiceGranted', playerId: player.id });
}

function notePlayed(state: GameState, minigame: MinigameId): void {
  state.minigames.played[minigame] = (state.minigames.played[minigame] ?? 0) + 1;
  state.minigames.last = minigame;
}

/**
 * Tirage sans remise de `count` mini-jeux. Le mini-jeu joué juste avant est évité tant qu'il
 * reste un autre choix, et les mini-jeux peu joués dans la partie sont favorisés. Ça reste du
 * hasard : un mini-jeu peut revenir.
 */
function weightedDraw(
  state: GameState,
  rng: Rng,
  candidates: MinigameId[],
  count: number,
): MinigameId[] {
  const pool = [...candidates];
  const drawn: MinigameId[] = [];
  while (drawn.length < count && pool.length > 0) {
    const weights = pool.map((id) =>
      id === state.minigames.last && pool.length > 1
        ? 0
        : 1 / (1 + (state.minigames.played[id] ?? 0)),
    );
    let roll = rng.next() * weights.reduce((sum, weight) => sum + weight, 0);
    const index = weights.findIndex((weight) => {
      roll -= weight;
      return roll < 0;
    });
    // Arrondi en bout de tirage : on prend le dernier candidat possible.
    const fallback = weights.reduce((last, weight, i) => (weight > 0 ? i : last), 0);
    const [picked] = pool.splice(index < 0 ? fallback : index, 1);
    if (picked !== undefined) drawn.push(picked);
  }
  return drawn;
}
