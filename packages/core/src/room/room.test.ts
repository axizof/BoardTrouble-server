import { describe, expect, test } from 'bun:test';
import { prepareBoard } from '../board/board';
import { buildMontTrouble } from '../boards/montTrouble';
import { naturalAppearance } from '../lobby/players';
import { DEFAULT_ROOM_SETTINGS, Room } from './room';
import { parseNetMessage } from './roomProtocol';

const board = prepareBoard(buildMontTrouble());
const ana = { id: 'ana-0000000000000001', name: 'Ana', appearance: naturalAppearance('fox') };
const bob = { id: 'bob-0000000000000002', name: 'Bob', appearance: naturalAppearance('cat') };

function lobby(): Room {
  const room = new Room('ROOM1', 'Les copains', false);
  room.join(ana);
  room.join(bob);
  return room;
}

describe('a room', () => {
  test('the first to arrive hosts; members take the free seats in order, bots fill the rest', () => {
    const room = lobby();
    const view = room.view();
    expect(view.hostId).toBe(ana.id);
    expect(view.seats.map((seat) => seat.member)).toEqual([ana.id, bob.id, null, null]);
  });

  test('two members cannot share a nickname (whatever the case)', () => {
    const room = lobby();
    const clash = { ...bob, id: 'bob-0000000000000003', name: 'ANA' };
    expect(room.join(clash)).toEqual({ ok: false, reason: 'nameTaken' });
  });

  test('only the host changes the settings, and the table never shrinks under seated humans', () => {
    const room = lobby();
    expect(room.setSettings(bob.id, { ...DEFAULT_ROOM_SETTINGS, tableSize: 6 }).ok).toBe(false);
    expect(room.setSettings(ana.id, { ...DEFAULT_ROOM_SETTINGS, tableSize: 6 }).ok).toBe(true);
    expect(room.view().seats).toHaveLength(6);
    for (let index = 0; index < 4; index++) {
      room.join({ ...bob, id: `guest-00000000000000${index}`, name: `Invite ${index}` });
    }
    expect(room.setSettings(ana.id, { ...DEFAULT_ROOM_SETTINGS, tableSize: 4 })).toEqual({
      ok: false,
      reason: 'tableTooSmall',
    });
  });

  test('the host leaving hands the room to the next member; in the lobby the seat frees up', () => {
    const room = lobby();
    room.leave(ana.id);
    expect(room.hostId).toBe(bob.id);
    expect(room.view().seats.map((seat) => seat.member)).toEqual([null, bob.id, null, null]);
  });

  test('starting seats the humans with their names and fills the table with leveled bots', () => {
    const room = lobby();
    room.setBotLevel(ana.id, 2, 'expert');
    const started = room.start(ana.id, board, 7, 0);
    expect(started.ok).toBe(true);
    const session = room.session;
    if (!session) throw new Error('no session');
    expect(session.seats.p1?.control).toBe('human');
    expect(session.seats.p2?.control).toBe('human');
    expect(session.seats.p3?.control).toBe('expert');
    expect(session.seats.p4?.control).toBe('normal');
    // Les bots prennent des animaux que les humains n'ont pas pris.
    expect(['fox', 'cat']).not.toContain(session.seats.p3?.appearance.character);
    expect(room.viewerOf(bob.id)).toEqual({ type: 'player', playerId: 'p2' });
  });

  test('during the game, a member who leaves keeps their seat, and someone new only watches', () => {
    const room = lobby();
    room.start(ana.id, board, 7, 0);
    room.leave(bob.id);
    expect(room.member(bob.id)?.isConnected).toBe(false);
    room.join(bob);
    expect(room.viewerOf(bob.id)).toEqual({ type: 'player', playerId: 'p2' });
    room.join({ ...bob, id: 'late-000000000000000', name: 'Tardif' });
    expect(room.viewerOf('late-000000000000000')).toEqual({ type: 'spectator' });
  });
});

describe('the network messages', () => {
  const identity = { id: 'abcdefghijklmnop', secret: 'a'.repeat(40) };
  const profile = { name: '  Ana  ', appearance: naturalAppearance('fox') };

  test('a hello is read field by field, the nickname cleaned up', () => {
    const message = parseNetMessage(
      JSON.stringify({ type: 'hello', protocol: 7, version: '0.5.0', identity, profile, extra: 1 }),
    );
    expect(message).toEqual({
      type: 'hello',
      protocol: 7,
      version: '0.5.0',
      identity,
      profile: { name: 'Ana', appearance: naturalAppearance('fox') },
    });
  });

  test('anything malformed, unknown or oversized is dropped', () => {
    expect(parseNetMessage('not json')).toBeNull();
    expect(parseNetMessage(JSON.stringify({ type: 'teleport' }))).toBeNull();
    expect(
      parseNetMessage(
        JSON.stringify({
          type: 'hello',
          protocol: 7,
          version: '1',
          identity,
          profile: { name: 'x' },
        }),
      ),
    ).toBeNull();
    expect(
      parseNetMessage(JSON.stringify({ type: 'createRoom', name: '<script>', password: null })),
    ).toBeNull();
    expect(parseNetMessage('x'.repeat(20_000))).toBeNull();
  });

  test('settings must be one of the offered values', () => {
    const settings = { ...DEFAULT_ROOM_SETTINGS, decisionTime: 5 };
    expect(parseNetMessage(JSON.stringify({ type: 'setSettings', settings }))).toBeNull();
    expect(
      parseNetMessage(JSON.stringify({ type: 'setSettings', settings: DEFAULT_ROOM_SETTINGS })),
    ).toEqual({ type: 'setSettings', settings: DEFAULT_ROOM_SETTINGS });
  });
});
