import { describe, expect, test } from 'bun:test';
import { type Point, prepareBoard, type Space, validateBoard } from '../board/board';
import { buildMontTrouble } from './montTrouble';

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
  test('is a valid board of five named floors, about 110 spaces from start to summit', () => {
    expect(validateBoard(definition)).toEqual([]);
    const board = prepareBoard(definition);
    const shortest = board.distanceToGoal.get('start') ?? 0;
    expect(shortest).toBeGreaterThan(105);
    expect(shortest).toBeLessThan(120);
    expect(Object.values(definition.floors ?? {}).map((floor) => floor.name)).toEqual([
      'Plage du départ',
      'Prairie des Pions',
      'Marais aux Dés',
      'Ateliers',
      'Glacier',
      'Crête des Nuages',
    ]);
  });

  test('has rings that shorten on the way up: 32, 28, 24, 20 and 16 spaces', () => {
    expect([1, 2, 3, 4, 5].map(longestPath)).toEqual([32, 28, 24, 20, 16]);
  });

  test('adds one mechanic per floor, with no dangerous edge on the first', () => {
    const kindsOn = (floor: number) => onFloor(floor).map((space) => space.kind.type);
    expect(onFloor(1).some((space) => space.fallsTo !== undefined)).toBe(false);
    expect(kindsOn(2)).toContain('giantDie');
    expect(kindsOn(3)).toEqual(expect.arrayContaining(['conveyor', 'drawbridge']));
    expect(kindsOn(4)).toContain('ice');
    expect(definition.floors?.[5]).toMatchObject({ muddy: true, windy: true });
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

  test('places every space in the scene, neither crammed nor too far from the next', () => {
    for (const space of spaces) {
      expect(space.position).toBeDefined();
      for (const next of space.next) {
        const gap = distance(space.position, definition.spaces[next]?.position);
        // Le pont-levis enjambe un vide : ses cases sont plus espacées.
        const isBridge = [space.id, next].some((id) => id.includes('bridge'));
        expect({ from: space.id, gap: gap >= 1.4 && gap <= (isBridge ? 5.5 : 4) }).toEqual({
          from: space.id,
          gap: true,
        });
      }
    }
    for (const [index, a] of spaces.entries()) {
      for (const b of spaces.slice(index + 1)) {
        expect({ pair: `${a.id}/${b.id}`, apart: distance(a.position, b.position) >= 1.4 }).toEqual(
          {
            pair: `${a.id}/${b.id}`,
            apart: true,
          },
        );
      }
    }
  });
});
