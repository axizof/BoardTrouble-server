import { describe, expect, test } from 'bun:test';
import { forkBoard, linearBoard } from '../testing/fixtures';
import { type BoardDefinition, distanceToGoal, prepareBoard, validateBoard } from './board';

describe('validateBoard', () => {
  test('accepts well-formed boards', () => {
    expect(validateBoard(linearBoard([{ type: 'empty' }]))).toEqual([]);
    expect(validateBoard(forkBoard())).toEqual([]);
  });

  test('reports a link to a missing space', () => {
    const board = linearBoard([{ type: 'empty' }]);
    board.spaces.s1 = { id: 's1', kind: { type: 'empty' }, floor: 0, next: ['nowhere'] };
    expect(validateBoard(board).join()).toContain('nowhere');
  });

  test('reports a dead end', () => {
    const board: BoardDefinition = linearBoard([{ type: 'empty' }]);
    board.spaces.lost = { id: 'lost', kind: { type: 'empty' }, floor: 0, next: [] };
    const errors = validateBoard(board).join('\n');
    expect(errors).toContain('Cul-de-sac sur "lost"');
  });

  test('requires exactly one final gate that ends the path', () => {
    const board = linearBoard([{ type: 'empty' }]);
    board.spaces.s1 = {
      id: 's1',
      kind: { type: 'finalGate', threshold: 6 },
      floor: 0,
      next: ['goal'],
    };
    expect(validateBoard(board).length).toBeGreaterThan(0);
  });
});

describe('prepareBoard', () => {
  test('computes the shortest distance to the summit, through the short lane', () => {
    const board = prepareBoard(forkBoard());
    expect(distanceToGoal(board, 'goal')).toBe(0);
    expect(distanceToGoal(board, 'merge')).toBe(11);
    expect(distanceToGoal(board, 'fork')).toBe(13);
    expect(distanceToGoal(board, 'b1')).toBe(13);
  });

  test('throws on an invalid board', () => {
    const board = linearBoard([]);
    board.start = 'missing';
    expect(() => prepareBoard(board)).toThrow();
  });
});
