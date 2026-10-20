import { describe, expect, test } from 'bun:test';
import { type Point, prepareBoard, type Space, validateBoard } from '../board/board';
import { buildMontTrouble } from './montTrouble';
import { horizontalDistance } from './route';

const definition = buildMontTrouble();
const spaces = Object.values(definition.spaces);
const onFloor = (floor: number) => spaces.filter((space) => space.floor === floor);
const floorOf = (id: string) => definition.spaces[id]?.floor ?? Number.NaN;

/** Plus long chemin sur un étage, de sa première case à sa porte (l'étage est sans boucle). */
function longestPath(floor: number): number {
  const memo = new Map<string, number>();
  const longest = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const space = definition.spaces[id];
    const inside = (space?.next ?? []).filter((next) => floorOf(next) === floor);
    const length = 1 + Math.max(0, ...inside.map(longest));
    memo.set(id, length);
    return length;
  };
  return longest(`f${floor}-0`);
}

function distance(a: Point | undefined, b: Point | undefined): number {
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('the Mont Trouble', () => {
  test('is a valid board of five named floors, about 130 spaces from start to summit', () => {
    expect(validateBoard(definition)).toEqual([]);
    const board = prepareBoard(definition);
    const shortest = board.distanceToGoal.get('start') ?? 0;
    expect(shortest).toBeGreaterThan(120);
    expect(shortest).toBeLessThan(140);
    expect(Object.values(definition.floors ?? {}).map((floor) => floor.name)).toEqual([
      'Plage du départ',
      'Prairie des Pions',
      'Marais aux Dés',
      'Ateliers',
      'Glacier',
      'Crête des Nuages',
    ]);
  });

  test('has floors that shorten on the way up: 40, 34, 28, 20 and 16 spaces', () => {
    expect([1, 2, 3, 4, 5].map(longestPath)).toEqual([40, 34, 28, 20, 16]);
  });

  test('adds one mechanic per floor, with no dangerous edge on the first', () => {
    const kindsOn = (floor: number) => onFloor(floor).map((space) => space.kind.type);
    expect(onFloor(1).some((space) => space.fallsTo !== undefined)).toBe(false);
    expect(kindsOn(2)).toContain('giantDie');
    expect(kindsOn(3)).toEqual(expect.arrayContaining(['conveyor', 'drawbridge']));
    expect(kindsOn(4)).toContain('ice');
    expect(definition.floors?.[5]).toMatchObject({ muddy: true, windy: true });
  });

  test('lands falls and transports just below or above, on the next floor', () => {
    for (const space of spaces) {
      const to = space.fallsTo ?? ('to' in space.kind ? space.kind.to : undefined);
      if (!to || space.kind.type === 'teleporter') continue;
      const target = definition.spaces[to];
      const reach = horizontalDistance(space.position, target?.position);
      // Une chute ou un transport mène à la zone voisine, juste en contrebas ou au-dessus.
      expect({ id: space.id, close: reach <= 14 }).toEqual({ id: space.id, close: true });
    }
  });

  test('never stacks two floors: there is room for a cliff between them', () => {
    for (const [index, a] of spaces.entries()) {
      for (const b of spaces.slice(index + 1)) {
        if (a.floor === b.floor || a.next.includes(b.id) || b.next.includes(a.id)) continue;
        const gap = horizontalDistance(a.position, b.position);
        expect({ pair: `${a.id}/${b.id}`, apart: gap >= 3.3 }).toEqual({
          pair: `${a.id}/${b.id}`,
          apart: true,
        });
      }
    }
  });

  test('links floors vertically: elevators go one floor up, slides and falls one floor down', () => {
    const linked = (space: Space) => ('to' in space.kind ? space.kind.to : null);
    for (const space of spaces) {
      const to = linked(space);
      if (space.kind.type === 'elevator' || space.kind.type === 'freightLift') {
        expect({ id: space.id, floor: floorOf(to ?? '') }).toEqual({
          id: space.id,
          floor: space.floor + 1,
        });
      }
      if (space.kind.type === 'slide' || space.kind.type === 'teleporter') {
        const expected = space.kind.type === 'slide' ? space.floor - 1 : space.floor;
        expect({ id: space.id, floor: floorOf(to ?? '') }).toEqual({
          id: space.id,
          floor: expected,
        });
      }
    }
  });

  test('places every space in the scene, a few steps from the next', () => {
    for (const space of spaces) {
      expect(space.position).toBeDefined();
      for (const next of space.next) {
        const gap = horizontalDistance(space.position, definition.spaces[next]?.position);
        // Le pont-levis enjambe un vide, et le passage d'un étage au suivant monte la falaise
        // par un escalier : leurs cases sont plus espacées.
        const isBridge = [space.id, next].some((id) => id.includes('bridge'));
        const isClimb = floorOf(next) !== space.floor;
        const longest = isClimb ? 14 : isBridge ? 10.5 : 8.5;
        expect({ from: space.id, gap: gap >= 2 && gap <= longest }).toEqual({
          from: space.id,
          gap: true,
        });
      }
    }
    for (const [index, a] of spaces.entries()) {
      for (const b of spaces.slice(index + 1)) {
        expect({ pair: `${a.id}/${b.id}`, apart: distance(a.position, b.position) >= 2 }).toEqual({
          pair: `${a.id}/${b.id}`,
          apart: true,
        });
      }
    }
  });
});
