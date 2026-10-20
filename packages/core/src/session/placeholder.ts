import type { GameState, Intent, PlayerId } from '../game/types';
import type { Rng } from '../random/rng';

// En attendant les vrais mini-jeux (étape 6 de la feuille de route), l'hôte tire leurs
// résultats au hasard : la partie se joue de bout en bout. Le client montre un écran
// provisoire avec le nom du mini-jeu tiré.
const ONE_VS_ALL_SOLO_WIN = 1 / 3;
const SKILL_GATE_SUCCESS = 0.6;

/** Résultat provisoire de ce que le serveur attend, ou null s'il n'attend rien. */
export function placeholderSystemIntent(state: GameState, rng: Rng): Intent | null {
  const { phase } = state;
  const shuffledRanking = (ids: PlayerId[]) => rng.shuffle(ids).map((id) => [id]);
  switch (phase.type) {
    case 'minigame':
      return {
        type: 'submitMinigameResult',
        ranking: shuffledRanking(state.players.map((p) => p.id)),
      };
    case 'bonusMinigame':
      return {
        type: 'submitBonusMinigameResult',
        ranking: shuffledRanking(state.players.map((p) => p.id)),
      };
    case 'finale':
      return { type: 'submitFinaleResult', ranking: shuffledRanking(phase.contenders) };
    case 'turn':
      break;
    default:
      return null;
  }
  const { step } = phase;
  switch (step.type) {
    case 'awaitDuelResult':
      return { type: 'submitDuelResult', winner: rng.pick([phase.playerId, step.opponent]) };
    case 'awaitOneVsAllResult':
      return { type: 'submitOneVsAllResult', soloWon: rng.chance(ONE_VS_ALL_SOLO_WIN) };
    case 'awaitSkillGate':
      return { type: 'submitSkillGateResult', success: rng.chance(SKILL_GATE_SUCCESS) };
    case 'awaitWheel':
      return { type: 'submitWheelResult', segment: rng.int(0, step.segments.length - 1) };
    default:
      return null;
  }
}
