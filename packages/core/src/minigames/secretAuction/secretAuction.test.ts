import { describe, expect, test } from 'bun:test';
import type { BotLevel } from '../../bots/boardBot';
import { Rng } from '../../random/rng';
import { ARENA_STEP, type ArenaInput, IDLE_INPUT } from '../arena/arena';
import {
  AUCTION_TOKENS,
  type AuctionState,
  BID_CONFIRM,
  BID_LESS,
  BID_MORE,
  BID_TIME,
  HIDDEN_BID,
  REVEAL_TIME,
  SECRET_AUCTION,
} from './secretAuction';

const PLAYERS = ['a', 'b', 'c'];
const bidder = (state: AuctionState, id: string) => {
  const found = state.fighters.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Joueur attendu : ${id}`);
  return found;
};
const aim = (target: number): ArenaInput => ({ ...IDLE_INPUT, target });

/** Chacun met sa mise (au bouton plus) puis valide, un pas par bouton. */
function bidAll(state: AuctionState, bids: Record<string, number>): AuctionState {
  let current = state;
  const most = Math.max(...Object.values(bids));
  for (let i = 0; i <= most; i++) {
    const inputs = Object.fromEntries(
      Object.entries(bids).map(([id, amount]) => [id, aim(i < amount ? BID_MORE : BID_CONFIRM)]),
    );
    current = SECRET_AUCTION.step(current, inputs);
  }
  return current;
}

describe('secret auction', () => {
  test('the highest bid wins the lot, and everyone pays what they bid', () => {
    const state = SECRET_AUCTION.create(PLAYERS, { practice: false, seed: 1 });
    const value = state.lots[0] ?? 0;
    const revealed = bidAll(state, { a: 4, b: 6, c: 2 });
    expect(revealed.phase).toBe('reveal');
    expect(revealed.winner).toBe('b');
    expect(revealed.wins).toEqual(['b']);
    expect(bidder(revealed, 'b').points).toBe(value);
    expect(PLAYERS.map((id) => bidder(revealed, id).tokens)).toEqual([
      AUCTION_TOKENS - 4,
      AUCTION_TOKENS - 6,
      AUCTION_TOKENS - 2,
    ]);
  });

  test('two highest bids tied: nobody gets the lot, but they still pay', () => {
    const state = SECRET_AUCTION.create(PLAYERS, { practice: false, seed: 1 });
    const revealed = bidAll(state, { a: 5, b: 5, c: 1 });
    expect(revealed.winner).toBeNull();
    expect(PLAYERS.map((id) => bidder(revealed, id).points)).toEqual([0, 0, 0]);
    expect(bidder(revealed, 'a').tokens).toBe(AUCTION_TOKENS - 5);
  });

  test('a bid moves by one or five, never beyond the tokens left, and can go down', () => {
    let state = SECRET_AUCTION.create(['a'], { practice: false, seed: 1 });
    const up = { ...IDLE_INPUT, move: { x: 0, z: -1 } };
    const right = { ...IDLE_INPUT, move: { x: 1, z: 0 } };
    state = [up, IDLE_INPUT, up, IDLE_INPUT, up, IDLE_INPUT, up, right].reduce(
      (current, input) => SECRET_AUCTION.step(current, { a: input }),
      state,
    );
    expect(bidder(state, 'a').bid).toBe(AUCTION_TOKENS);
    state = SECRET_AUCTION.step(state, { a: aim(BID_LESS) });
    expect(bidder(state, 'a').bid).toBe(AUCTION_TOKENS - 1);
  });

  test('the bids stay hidden from the others until they are revealed', () => {
    let state = SECRET_AUCTION.create(PLAYERS, { practice: false, seed: 1 });
    state = SECRET_AUCTION.step(state, { a: aim(BID_MORE), b: aim(BID_MORE) });
    state = SECRET_AUCTION.step(state, { a: aim(BID_CONFIRM) });
    const forB = SECRET_AUCTION.viewFor?.(state, { type: 'player', playerId: 'b' });
    const forWatcher = SECRET_AUCTION.viewFor?.(state, { type: 'spectator' });
    if (!forB || !forWatcher) throw new Error('Vue attendue');
    expect(bidder(forB, 'a').bid).toBe(HIDDEN_BID);
    expect(bidder(forB, 'a').isLocked).toBe(true);
    expect(bidder(forB, 'b').bid).toBe(1);
    expect(bidder(forWatcher, 'b').bid).toBe(HIDDEN_BID);
    const revealed = bidAll(state, { b: 1, c: 0 });
    expect(
      bidder(SECRET_AUCTION.viewFor?.(revealed, { type: 'spectator' }) ?? revealed, 'a').bid,
    ).toBe(1);
  });

  test('time up: the bid shown counts; then the next lot, and after the fifth, the end', () => {
    let state = SECRET_AUCTION.create(['a', 'b'], { practice: false, seed: 1 });
    state = SECRET_AUCTION.step(state, { a: aim(BID_MORE) });
    const wait = (current: AuctionState, seconds: number) => {
      let next = current;
      for (let i = 0; i < Math.round(seconds / ARENA_STEP); i++)
        next = SECRET_AUCTION.step(next, {});
      return next;
    };
    state = wait(state, BID_TIME);
    expect(state.phase).toBe('reveal');
    expect(state.winner).toBe('a');
    state = wait(state, REVEAL_TIME);
    expect(state.phase).toBe('bidding');
    expect(state.lot).toBe(1);
    for (let lot = 1; lot < 5; lot++) state = wait(state, BID_TIME + REVEAL_TIME + 0.1);
    expect(SECRET_AUCTION.isOver(state)).toBe(true);
  });

  test('ranked by points, then by tokens left', () => {
    const state = SECRET_AUCTION.create(PLAYERS, { practice: false, seed: 1 });
    const ended = {
      ...state,
      fighters: [
        { ...bidder(state, 'a'), points: 5, tokens: 2 },
        { ...bidder(state, 'b'), points: 5, tokens: 4 },
        { ...bidder(state, 'c'), points: 3, tokens: 9 },
      ],
    };
    expect(SECRET_AUCTION.ranking(ended)).toEqual([['b'], ['a'], ['c']]);
  });

  test('plays whole matches between bots, the expert ahead of the easy one', () => {
    const players = ['a', 'b', 'c', 'd'];
    const levels: BotLevel[] = ['easy', 'normal', 'expert', 'normal'];
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      let state = SECRET_AUCTION.create(players, { practice: false, seed });
      while (!SECRET_AUCTION.isOver(state)) {
        const inputs = Object.fromEntries(
          players.map((id, index) => [
            id,
            SECRET_AUCTION.botInput(state, id, levels[index] ?? 'normal', rng),
          ]),
        );
        state = SECRET_AUCTION.step(state, inputs);
      }
      const ranking = SECRET_AUCTION.ranking(state);
      expect(ranking.flat().sort()).toEqual([...players].sort());
      const first = ranking[0] ?? [];
      const winner = first.length === 1 ? (first[0] ?? '') : 'tie';
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
    expect(wins.c ?? 0).toBeGreaterThan(wins.a ?? 0);
  });
});
