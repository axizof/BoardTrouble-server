export type SpaceId = string;

export type SpaceKind =
  | { type: 'start' }
  | { type: 'empty' }
  | { type: 'bonus'; amount: number }
  | { type: 'malus'; amount: number }
  /** Tire un objet, plus souvent rare pour les joueurs loin derrière. */
  | { type: 'item' }
  /** Deux coffres : un objet rare ou un piège. */
  | { type: 'chest' }
  /** Donne un objet commun à qui n'en a aucun. */
  | { type: 'rest' }
  /** Le Plateau se réveille tout de suite : un petit événement TROUBLE. */
  | { type: 'trouble' }
  // Interactions entre joueurs : elles ne s'activent que pendant le tour de celui qui arrive.
  /** Un dé désigne un adversaire, qui recule de 4 à 6 cases. */
  | { type: 'squall' }
  /** Un tirage désigne un adversaire : on échange nos places. */
  | { type: 'swap' }
  /** On attire un adversaire du même étage de 4 cases au plus vers soi. */
  | { type: 'magnet' }
  /** On vole un objet au hasard à un adversaire choisi. */
  | { type: 'steal' }
  /** Duel contre un adversaire choisi : +6 pour le gagnant, -6 pour l'autre. */
  | { type: 'duel' }
  /** Mini-jeu seul contre tous : +10 en cas de victoire. */
  | { type: 'oneVsAll' }
  /** Duel automatique contre le dernier joueur qui nous a fait reculer. */
  | { type: 'vendetta' }
  /** Bousculade : les adversaires à 2 cases ou moins sont poussés d'une case. */
  | { type: 'jostle' }
  /** Les Filous enlèvent le joueur et l'enferment dans leur Cachot. */
  | { type: 'filous' }
  // Déplacement et hasard.
  /** Projette loin devant. */
  | { type: 'springboard'; amount: number }
  /** Renvoie loin derrière (rare). */
  | { type: 'statue'; amount: number }
  /** Monte d'un étage jusqu'à `to`. Les destinations sont du level design. */
  | { type: 'elevator'; to: SpaceId }
  /** Comme l'ascenseur, mais ne marche qu'une manche sur deux (les manches paires). */
  | { type: 'freightLift'; to: SpaceId }
  /** Descend d'un étage jusqu'à `to`. */
  | { type: 'slide'; to: SpaceId }
  /** Envoie vers le téléporteur jumeau `to`. */
  | { type: 'teleporter'; to: SpaceId }
  /** Arriver sur un bout projette de 4 cases les joueurs posés sur l'autre bout (`partner`). */
  | { type: 'seesaw'; partner: SpaceId }
  /** Un dé géant à faces illustrées décide. */
  | { type: 'giantDie' }
  /** Donne un dé spécial au hasard (surtout au Marais aux Dés). */
  | { type: 'specialDie' }
  /** Une roue que le joueur arrête lui-même (test de timing) ; issues propres à la case. */
  | { type: 'wheel'; segments: WheelSegment[] }
  /** Parier de 1 à 5 cases sur le vainqueur du prochain mini-jeu. */
  | { type: 'bet' }
  // Mécaniques d'étage (01-vision-et-plateau.md, section 7).
  /** Case gelée : on n'y reste jamais, on glisse jusqu'à la prochaine case non gelée. */
  | { type: 'ice' }
  /** Tapis roulant : déplace de `amount` cases le pion posé dessus, en fin de manche. */
  | { type: 'conveyor'; direction: 'forward' | 'backward'; amount: number }
  /** Pont-levis : on ne peut s'y engager que les manches impaires. */
  | { type: 'drawbridge' }
  /** Porte à seuil : faire `threshold` ou plus aux dés, le seuil baisse à chaque échec. */
  | { type: 'gate'; threshold: number }
  /** Deux portes : choisir un passage ; l'un est piégé et repousse de 5 cases. */
  | { type: 'twinGate' }
  /** Porte d'adresse : un mini-défi solo de 10 s ; réussi, on passe avec 3 cases de plus. */
  | { type: 'skillGate' }
  /** Péage : payer un objet pour passer tout de suite, ou tenter le seuil aux dés. */
  | { type: 'tollGate'; threshold: number }
  /** Porte au rocher : en cas d'échec, un rocher dévale le chemin et pousse tout le monde. */
  | { type: 'boulderGate'; threshold: number }
  /** Porte finale au sommet : le seuil ne baisse pas. */
  | { type: 'finalGate'; threshold: number };

export type WheelSegment =
  | { type: 'advance'; amount: number }
  | { type: 'recoil'; amount: number }
  | { type: 'item' }
  | { type: 'trouble' }
  | { type: 'nothing' };

/** Cases qui renvoient vers une autre case (destination ou partenaire). */
export function linkedSpace(kind: SpaceKind): SpaceId | null {
  switch (kind.type) {
    case 'elevator':
    case 'freightLift':
    case 'slide':
    case 'teleporter':
      return kind.to;
    case 'seesaw':
      return kind.partner;
    default:
      return null;
  }
}

/** Toutes les sortes de portes : elles arrêtent le déplacement. */
export function isGateKind(kind: SpaceKind): boolean {
  return ['gate', 'twinGate', 'skillGate', 'tollGate', 'boulderGate', 'finalGate'].includes(
    kind.type,
  );
}

export type Space = {
  id: SpaceId;
  kind: SpaceKind;
  floor: number;
  /**
   * Cases suivantes. Plusieurs = embranchement, le joueur choisit. La première est la
   * voie principale, suivie par les déplacements d'effet (qui ne demandent pas de choix).
   */
  next: SpaceId[];
  /**
   * Case de bord, sans garde-fou : un joueur poussé d'ici tombe sur cette case, à la
   * verticale sur l'étage du dessous.
   */
  fallsTo?: SpaceId;
  /** Position dans la scène 3D (1 unité = la taille d'un personnage), pour l'affichage. */
  position?: Point;
};

export type Point = { x: number; y: number; z: number };

/** Un étage entier : son nom affiché et ses mécaniques propres. */
export type FloorDefinition = {
  name?: string;
  /** Boue : toute poussée va 2 cases plus loin. */
  muddy?: boolean;
  /** Coups de vent occasionnels en fin de manche. */
  windy?: boolean;
};

export type BoardDefinition = {
  id: string;
  name: string;
  start: SpaceId;
  spaces: Record<SpaceId, Space>;
  /** Étages par numéro ; un étage absent n'a ni nom ni mécanique propre. */
  floors?: Record<number, FloorDefinition>;
};

/** Plateau validé, avec les données calculées une fois pour toutes. */
export type Board = {
  definition: BoardDefinition;
  finalGate: SpaceId;
  /** Nombre minimal de pas jusqu'à la porte finale : mesure la progression d'un joueur. */
  distanceToGoal: ReadonlyMap<SpaceId, number>;
  /** Cases précédentes, la voie principale en premier. Sert aux reculs. */
  predecessors: ReadonlyMap<SpaceId, readonly SpaceId[]>;
};

export function validateBoard(definition: BoardDefinition): string[] {
  const errors: string[] = [];
  const spaces = Object.values(definition.spaces);

  for (const [key, space] of Object.entries(definition.spaces)) {
    if (key !== space.id) errors.push(`La case "${key}" a l'identifiant "${space.id}"`);
    for (const next of space.next) {
      if (!definition.spaces[next])
        errors.push(`La case "${space.id}" mène à "${next}", introuvable`);
    }
    if (new Set(space.next).size !== space.next.length) {
      errors.push(`La case "${space.id}" mène deux fois à la même case`);
    }
    const isEnd = space.kind.type === 'finalGate';
    if (isEnd && space.next.length > 0) errors.push('La porte finale doit terminer le chemin');
    if (!isEnd && space.next.length === 0) errors.push(`Cul-de-sac sur "${space.id}"`);
    if ('amount' in space.kind && (!Number.isInteger(space.kind.amount) || space.kind.amount < 1)) {
      errors.push(`Montant invalide sur "${space.id}"`);
    }
    if (
      'threshold' in space.kind &&
      (!Number.isInteger(space.kind.threshold) || space.kind.threshold < 1)
    ) {
      errors.push(`Seuil invalide sur "${space.id}"`);
    }
    const linked = linkedSpace(space.kind);
    if (linked !== null && !definition.spaces[linked]) {
      errors.push(`La case "${space.id}" renvoie vers "${linked}", introuvable`);
    }
    if (space.kind.type === 'seesaw') {
      const partner = definition.spaces[space.kind.partner]?.kind;
      if (partner?.type !== 'seesaw' || partner.partner !== space.id) {
        errors.push(`La bascule "${space.id}" doit former une paire avec "${space.kind.partner}"`);
      }
    }
    if (space.kind.type === 'wheel' && space.kind.segments.length === 0) {
      errors.push(`La roue "${space.id}" n'a aucune issue`);
    }
    errors.push(...floorMechanicErrors(definition, space));
  }

  if (definition.spaces[definition.start]?.kind.type !== 'start') {
    errors.push('La case de départ doit exister et être de type "start"');
  }
  if (spaces.filter((space) => space.kind.type === 'start').length !== 1) {
    errors.push('Il faut exactement une case de départ');
  }
  const finals = spaces.filter((space) => space.kind.type === 'finalGate');
  if (finals.length !== 1) errors.push('Il faut exactement une porte finale');

  if (errors.length === 0) {
    const distances = computeDistances(definition, finals[0]?.id ?? '');
    for (const space of spaces) {
      if (!distances.has(space.id)) errors.push(`La case "${space.id}" ne mène pas au sommet`);
    }
  }
  return errors;
}

/**
 * On ne s'arrête jamais sur une case gelée : une chute ou un transport n'y mène pas, et une
 * glissade ne rencontre pas d'embranchement. Un pont-levis fermé ne bloque jamais la voie
 * principale, que suivent les déplacements sans choix.
 */
function floorMechanicErrors(definition: BoardDefinition, space: Space): string[] {
  const errors: string[] = [];
  const kindOf = (id: SpaceId) => definition.spaces[id]?.kind;
  const landing = [space.fallsTo, linkedSpace(space.kind)].filter((id) => id != null);
  if (landing.some((id) => kindOf(id)?.type === 'ice')) {
    errors.push(`La case "${space.id}" mène sur une case gelée`);
  }
  if (space.kind.type === 'ice' && space.next.length !== 1) {
    errors.push(`La case gelée "${space.id}" ne doit avoir qu'une case suivante`);
  }
  const [main] = space.next;
  if (main !== undefined && kindOf(main)?.type === 'drawbridge') {
    errors.push(`Le pont-levis "${main}" ne doit pas être la voie principale de "${space.id}"`);
  }
  if (space.fallsTo !== undefined) {
    const below = definition.spaces[space.fallsTo];
    if (!below) errors.push(`La case "${space.id}" tombe sur "${space.fallsTo}", introuvable`);
    else if (below.floor !== space.floor - 1) {
      errors.push(`La case "${space.id}" doit tomber sur l'étage juste en dessous`);
    }
    if (isGateKind(space.kind) || (below && isGateKind(below.kind))) {
      errors.push(
        `La case de bord "${space.id}" ne peut ni être une porte, ni tomber sur une porte`,
      );
    }
  }
  return errors;
}

export function prepareBoard(definition: BoardDefinition): Board {
  const errors = validateBoard(definition);
  if (errors.length > 0)
    throw new Error(`Plateau "${definition.id}" invalide :\n${errors.join('\n')}`);

  const finalGate = Object.values(definition.spaces).find(
    (space) => space.kind.type === 'finalGate',
  )?.id;
  if (finalGate === undefined) throw new Error('Porte finale introuvable');

  return {
    definition,
    finalGate,
    distanceToGoal: computeDistances(definition, finalGate),
    predecessors: computePredecessors(definition),
  };
}

export function getSpace(board: Board, id: SpaceId): Space {
  const space = board.definition.spaces[id];
  if (!space) throw new Error(`Case inconnue : ${id}`);
  return space;
}

export function getFloor(board: Board, floor: number): FloorDefinition {
  return board.definition.floors?.[floor] ?? {};
}

export function distanceToGoal(board: Board, id: SpaceId): number {
  return board.distanceToGoal.get(id) ?? Number.POSITIVE_INFINITY;
}

/** Parcours en largeur à rebours depuis la porte finale. */
function computeDistances(definition: BoardDefinition, goal: SpaceId): Map<SpaceId, number> {
  const predecessors = computePredecessors(definition);
  const distances = new Map<SpaceId, number>([[goal, 0]]);
  const queue = [goal];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const distance = distances.get(current) ?? 0;
    for (const previous of predecessors.get(current) ?? []) {
      if (distances.has(previous)) continue;
      distances.set(previous, distance + 1);
      queue.push(previous);
    }
  }
  return distances;
}

function computePredecessors(definition: BoardDefinition): Map<SpaceId, SpaceId[]> {
  const predecessors = new Map<SpaceId, SpaceId[]>();
  // Deux passes : les liens de voie principale (premier `next`) d'abord, pour qu'ils
  // soient le premier prédécesseur de chaque case.
  for (const mainOnly of [true, false]) {
    for (const space of Object.values(definition.spaces)) {
      space.next.forEach((next, index) => {
        if ((index === 0) !== mainOnly) return;
        const list = predecessors.get(next) ?? [];
        list.push(space.id);
        predecessors.set(next, list);
      });
    }
  }
  return predecessors;
}
