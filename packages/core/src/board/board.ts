export type SpaceId = string;

export type SpaceKind =
  | { type: 'start' }
  | { type: 'empty' }
  | { type: 'bonus'; amount: number }
  | { type: 'malus'; amount: number }
  /** Porte à seuil : faire `threshold` ou plus aux dés, le seuil baisse à chaque échec. */
  | { type: 'gate'; threshold: number }
  /** Porte finale au sommet : le seuil ne baisse pas. */
  | { type: 'finalGate'; threshold: number };

export type Space = {
  id: SpaceId;
  kind: SpaceKind;
  floor: number;
  /**
   * Cases suivantes. Plusieurs = embranchement, le joueur choisit. La première est la
   * voie principale, suivie par les déplacements d'effet (qui ne demandent pas de choix).
   */
  next: SpaceId[];
};

export type BoardDefinition = {
  id: string;
  name: string;
  start: SpaceId;
  spaces: Record<SpaceId, Space>;
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
    if (
      (space.kind.type === 'bonus' || space.kind.type === 'malus') &&
      (!Number.isInteger(space.kind.amount) || space.kind.amount < 1)
    ) {
      errors.push(`Montant invalide sur "${space.id}"`);
    }
    if (
      (space.kind.type === 'gate' || space.kind.type === 'finalGate') &&
      (!Number.isInteger(space.kind.threshold) || space.kind.threshold < 1)
    ) {
      errors.push(`Seuil invalide sur "${space.id}"`);
    }
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
