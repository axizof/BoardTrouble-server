import type { GameEvent, GameState, PlayerId } from './types';

export type Viewer = { type: 'player'; playerId: PlayerId } | { type: 'spectator' };

/**
 * Ce qu'un client a le droit de savoir de l'état. Le serveur n'envoie jamais l'état brut :
 * ni le hasard, ni le Miroir activé d'un autre joueur.
 */
export function viewState(state: GameState, viewer: Viewer): GameState {
  const view = structuredClone(state);
  view.rngState = 0;
  for (const player of view.players) {
    if (!isSelf(viewer, player.id)) player.mirrorArmed = false;
  }
  return view;
}

/** Les événements qu'un client reçoit : les événements privés ne vont qu'à leur joueur. */
export function viewEvents(events: GameEvent[], viewer: Viewer): GameEvent[] {
  return events.filter((event) => {
    if (event.type === 'mirrorArmed' || event.type === 'mirrorExpired') {
      return isSelf(viewer, event.playerId);
    }
    return true;
  });
}

function isSelf(viewer: Viewer, playerId: PlayerId): boolean {
  return viewer.type === 'player' && viewer.playerId === playerId;
}
