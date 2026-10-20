import { type BoardDefinition, Rng, type Space, type SpaceKind } from '@board-trouble/core';

// Plateau prototype pour mesurer l'équilibrage en attendant le vrai level design du
// Mont Trouble : 5 anneaux qui raccourcissent en montant (01-vision-et-plateau.md, section 7).
const RINGS = [32, 28, 24, 20, 16];
const GATE_THRESHOLDS = [3, 4, 4, 5];
const FINAL_THRESHOLD = 6;
const SHORT_LANE = 3;
const LONG_LANE = 5;

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
    const trunk = length - LONG_LANE - 1;
    const forkAt = Math.floor(trunk / 3);

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

    const threshold = GATE_THRESHOLDS[ringIndex];
    const gate =
      threshold === undefined
        ? add('summit', { type: 'finalGate', threshold: FINAL_THRESHOLD }, floor)
        : add(`f${floor}-gate`, { type: 'gate', threshold }, floor);
    link(previous, gate);
    previous = gate;
  });

  return { id: 'spiral-prototype', name: 'Spirale prototype', start: 'start', spaces };
}

function laneIds(floor: number, lane: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `f${floor}-${lane}-${index}`);
}

function randomKind(rng: Rng, flavour: 'trunk' | 'short' | 'long'): SpaceKind {
  // Voie courte : plus d'objets et de coffres, mais plus de malus. Voie longue : plus de bonus.
  const rates = {
    trunk: { bonus: 0.15, malus: 0.12, item: 0.12, chest: 0.02, rest: 0.03 },
    short: { bonus: 0.1, malus: 0.22, item: 0.25, chest: 0.1, rest: 0 },
    long: { bonus: 0.35, malus: 0.1, item: 0.08, chest: 0, rest: 0.05 },
  }[flavour];
  let roll = rng.next();
  for (const [type, rate] of Object.entries(rates)) {
    roll -= rate;
    if (roll >= 0) continue;
    if (type === 'bonus' || type === 'malus') {
      return { type, amount: rng.chance(0.75) ? 3 : 5 };
    }
    return { type: type as 'item' | 'chest' | 'rest' };
  }
  return { type: 'empty' };
}
