import {
  type BoardDefinition,
  linkedSpace,
  Rng,
  type Space,
  type SpaceKind,
} from '@board-trouble/core';

// Plateau prototype pour mesurer l'équilibrage en attendant le vrai level design du
// Mont Trouble : 5 anneaux qui raccourcissent en montant (01-vision-et-plateau.md, section 7).
const RINGS = [32, 28, 24, 20, 16];
/** Une sorte de porte par passage d'étage. */
const GATES: SpaceKind[] = [
  { type: 'twinGate' },
  { type: 'skillGate' },
  { type: 'tollGate', threshold: 4 },
  { type: 'boulderGate', threshold: 5 },
];
const WHEEL: SpaceKind = {
  type: 'wheel',
  segments: [
    { type: 'advance', amount: 4 },
    { type: 'advance', amount: 2 },
    { type: 'item' },
    { type: 'recoil', amount: 3 },
    { type: 'trouble' },
    { type: 'nothing' },
  ],
};
const FINAL_THRESHOLD = 6;
const SHORT_LANE = 3;
const LONG_LANE = 5;
// Une mécanique en plus par étage (01-vision-et-plateau.md, section 7).
const WORKSHOP_FLOOR = 3;
const GLACIER_FLOOR = 4;
const CLOUD_FLOOR = 5;
const ICE_PATCHES = 3;
/** Raccourci du pont-levis : 2 cases au lieu de 4 sur le tronc. */
const BRIDGE_SKIP = 5;

/**
 * Chaque anneau : un tronc commun, un embranchement (voie courte et exposée, voie longue
 * avec plus de bonus), puis la porte vers l'étage suivant.
 */
export function buildSpiralPrototype(seed = 2026): BoardDefinition {
  const rng = new Rng(seed);
  const spaces: Record<string, Space> = {};
  const add = (id: string, kind: SpaceKind, floor: number) => {
    spaces[id] = { id, kind, floor, next: [] };
    return id;
  };
  const link = (from: string, to: string) => spaces[from]?.next.push(to);

  let previous = add('start', { type: 'start' }, 0);
  RINGS.forEach((length, ringIndex) => {
    const floor = ringIndex + 1;
    const { trunk, forkAt } = ringShape(length);

    for (let i = 0; i < trunk; i++) {
      const id = add(`f${floor}-${i}`, randomKind(rng, 'trunk'), floor);
      link(previous, id);
      previous = id;
      if (i !== forkAt) continue;

      const fork = id;
      const merge = `f${floor}-merge`;
      const shortLane = laneIds(floor, 'short', SHORT_LANE);
      const longLane = laneIds(floor, 'long', LONG_LANE);
      for (const [lane, flavour] of [
        [shortLane, 'short'],
        [longLane, 'long'],
      ] as const) {
        lane.forEach((laneId) => {
          add(laneId, randomKind(rng, flavour), floor);
        });
        link(fork, lane[0] ?? merge);
        lane.forEach((laneId, index) => {
          link(laneId, lane[index + 1] ?? merge);
        });
      }
      add(merge, { type: 'empty' }, floor);
      previous = merge;
    }

    const gateKind = GATES[ringIndex];
    const gate =
      gateKind === undefined
        ? add('summit', { type: 'finalGate', threshold: FINAL_THRESHOLD }, floor)
        : add(`f${floor}-gate`, gateKind, floor);
    link(previous, gate);
    previous = gate;
  });

  addLinkedSpaces(spaces, rng);
  // Hasard à part : le reste du plateau ne change pas quand on règle ces mécaniques.
  addFloorMechanics(spaces, new Rng(seed + 1));
  return {
    id: 'spiral-prototype',
    name: 'Spirale prototype',
    start: 'start',
    spaces,
    floors: { [CLOUD_FLOOR]: { muddy: true, windy: true } },
  };
}

function ringShape(length: number): { trunk: number; forkAt: number } {
  const trunk = length - LONG_LANE - 1;
  return { trunk, forkAt: Math.floor(trunk / 3) };
}

/**
 * Glace sur le Glacier, tapis roulants et pont-levis aux Ateliers, et cases de bord sur les
 * voies courtes à partir de l'étage 2 (la Prairie n'a pas de bord dangereux).
 */
function addFloorMechanics(spaces: Record<string, Space>, rng: Rng): void {
  const targets = new Set(Object.values(spaces).flatMap((space) => linkedSpace(space.kind) ?? []));
  const trunkId = (floor: number, index: number) => `f${floor}-${index}`;
  const isFree = (id: string) => spaces[id]?.kind.type === 'empty' && !targets.has(id);
  const setKind = (id: string, kind: SpaceKind) => {
    const space = spaces[id];
    if (space) space.kind = kind;
  };

  const glacier = ringShape(RINGS[GLACIER_FLOOR - 1] ?? 0);
  const iceStarts = Array.from({ length: glacier.trunk - 1 }, (_, index) => index).filter(
    (index) =>
      index !== glacier.forkAt &&
      index + 1 !== glacier.forkAt &&
      isFree(trunkId(GLACIER_FLOOR, index)) &&
      isFree(trunkId(GLACIER_FLOOR, index + 1)),
  );
  for (let patch = 0; patch < ICE_PATCHES && iceStarts.length > 0; patch++) {
    const start = rng.pick(iceStarts);
    for (const index of [start, start + 1]) setKind(trunkId(GLACIER_FLOOR, index), { type: 'ice' });
    iceStarts.splice(0, iceStarts.length, ...iceStarts.filter((i) => Math.abs(i - start) > 2));
  }

  const workshop = ringShape(RINGS[WORKSHOP_FLOOR - 1] ?? 0);
  const belts = Array.from({ length: workshop.trunk }, (_, index) =>
    trunkId(WORKSHOP_FLOOR, index),
  ).filter(isFree);
  const conveyors: SpaceKind[] = [
    { type: 'conveyor', direction: 'forward', amount: 3 },
    { type: 'conveyor', direction: 'forward', amount: 3 },
    { type: 'conveyor', direction: 'backward', amount: 2 },
  ];
  for (const kind of conveyors) {
    const id = rng.pick(belts);
    belts.splice(belts.indexOf(id), 1);
    setKind(id, kind);
  }
  const bridgeFrom = workshop.forkAt + 4;
  const bridgeTo = trunkId(WORKSHOP_FLOOR, bridgeFrom + BRIDGE_SKIP);
  spaces[`f${WORKSHOP_FLOOR}-bridge`] = {
    id: `f${WORKSHOP_FLOOR}-bridge`,
    kind: { type: 'drawbridge' },
    floor: WORKSHOP_FLOOR,
    next: [`f${WORKSHOP_FLOOR}-bridge-end`],
  };
  spaces[`f${WORKSHOP_FLOOR}-bridge-end`] = {
    id: `f${WORKSHOP_FLOOR}-bridge-end`,
    kind: { type: 'empty' },
    floor: WORKSHOP_FLOOR,
    next: [bridgeTo],
  };
  spaces[trunkId(WORKSHOP_FLOOR, bridgeFrom)]?.next.push(`f${WORKSHOP_FLOOR}-bridge`);

  RINGS.forEach((length, ringIndex) => {
    const floor = ringIndex + 1;
    if (floor === 1) return;
    const { forkAt } = ringShape(length);
    const below = ringShape(RINGS[ringIndex - 1] ?? 0);
    const landings = Array.from({ length: below.trunk }, (_, index) =>
      trunkId(floor - 1, index),
    ).filter((id) => spaces[id]?.kind.type !== 'ice');
    laneIds(floor, 'short', SHORT_LANE).forEach((id, index) => {
      // À la verticale : même proportion du tour de l'anneau, sur l'anneau du dessous.
      const turn = (forkAt + 1 + index) / length;
      const space = spaces[id];
      const landing = landings[Math.round(turn * (landings.length - 1))];
      if (space && landing) space.fallsTo = landing;
    });
  });
}

/**
 * Cases reliées à une autre, placées sur des cases vides du tronc : un ascenseur vers
 * l'étage du dessus, un toboggan vers celui du dessous, une paire de téléporteurs, une
 * bascule et un monte-charge à certains étages.
 */
function addLinkedSpaces(spaces: Record<string, Space>, rng: Rng): void {
  const emptyTrunk = (floor: number) =>
    Object.values(spaces)
      .filter(
        (space) =>
          space.floor === floor && /^f\d+-\d+$/.test(space.id) && space.kind.type === 'empty',
      )
      .map((space) => space.id);
  const take = (ids: string[]) => {
    const id = rng.pick(ids);
    ids.splice(ids.indexOf(id), 1);
    return id;
  };
  const setKind = (id: string, kind: SpaceKind) => {
    const space = spaces[id];
    if (space) space.kind = kind;
  };

  RINGS.forEach((_, ringIndex) => {
    const floor = ringIndex + 1;
    const here = emptyTrunk(floor);
    if (here.length < 6) return;
    const above = emptyTrunk(floor + 1);
    const below = emptyTrunk(floor - 1);
    if (above.length > 0) setKind(take(here), { type: 'elevator', to: rng.pick(above) });
    if (below.length > 0) setKind(take(here), { type: 'slide', to: rng.pick(below) });
    const [a, b] = [take(here), take(here)];
    setKind(a, { type: 'teleporter', to: b });
    setKind(b, { type: 'teleporter', to: a });
    if (floor % 2 === 0) {
      const [left, right] = [take(here), take(here)];
      setKind(left, { type: 'seesaw', partner: right });
      setKind(right, { type: 'seesaw', partner: left });
      if (above.length > 0) setKind(take(here), { type: 'freightLift', to: rng.pick(above) });
    }
  });
}

/** Chaque case d'interaction avec la même fréquence `rate`. */
function interactions(rate: number) {
  return {
    squall: rate,
    swap: rate,
    magnet: rate,
    steal: rate,
    jostle: rate,
    duel: rate,
    oneVsAll: rate,
    vendetta: rate,
  };
}

function laneIds(floor: number, lane: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `f${floor}-${lane}-${index}`);
}

function randomKind(rng: Rng, flavour: 'trunk' | 'short' | 'long'): SpaceKind {
  // Voie courte : plus d'objets et de coffres, mais plus de malus. Voie longue : plus de bonus.
  const rates = {
    trunk: {
      bonus: 0.13,
      malus: 0.1,
      item: 0.1,
      chest: 0.02,
      rest: 0.03,
      trouble: 0.04,
      filous: 0.015,
      springboard: 0.015,
      statue: 0.005,
      giantDie: 0.015,
      specialDie: 0.02,
      wheel: 0.01,
      bet: 0.01,
      ...interactions(0.012),
    },
    short: {
      bonus: 0.08,
      malus: 0.16,
      item: 0.18,
      chest: 0.08,
      rest: 0,
      trouble: 0.08,
      filous: 0.04,
      ...interactions(0.03),
    },
    long: {
      bonus: 0.3,
      springboard: 0.03,
      malus: 0.08,
      item: 0.08,
      chest: 0,
      rest: 0.05,
      trouble: 0,
      ...interactions(0.005),
    },
  }[flavour];
  let roll = rng.next();
  for (const [type, rate] of Object.entries(rates)) {
    roll -= rate;
    if (roll >= 0) continue;
    if (type === 'bonus' || type === 'malus') {
      return { type, amount: rng.chance(0.75) ? 3 : 5 };
    }
    if (type === 'springboard') return { type, amount: rng.int(8, 12) };
    if (type === 'statue') return { type, amount: rng.int(10, 14) };
    if (type === 'wheel') return WHEEL;
    return { type } as SpaceKind;
  }
  return { type: 'empty' };
}
