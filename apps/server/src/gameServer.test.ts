import { afterEach, describe, expect, test } from 'bun:test';
import {
  GAME_VERSION,
  type NetHostMessage,
  naturalAppearance,
  PROTOCOL_VERSION,
} from '@board-trouble/core';
import { GameServer } from './gameServer';

/** Un faux client : ce qu'il a reçu, et s'il a été fermé. */
function client(server: GameServer, id: string, name: string, secret = 's'.repeat(40)) {
  const received: NetHostMessage[] = [];
  const state = { isClosed: false };
  const connection = server.connect({
    send: (text) => received.push(JSON.parse(text) as NetHostMessage),
    close: () => {
      state.isClosed = true;
    },
  });
  const send = (message: object) => server.receive(connection, JSON.stringify(message));
  const hello = (version = GAME_VERSION) =>
    send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      version,
      identity: { id, secret },
      profile: { name, appearance: naturalAppearance('fox') },
    });
  const last = <T extends NetHostMessage['type']>(type: T) =>
    received
      .filter((message): message is Extract<NetHostMessage, { type: T }> => message.type === type)
      .at(-1);
  return { connection, received, state, send, hello, last };
}

let server: GameServer;
afterEach(() => server?.close());

function newServer(): GameServer {
  server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {} });
  return server;
}

describe('the game server', () => {
  test('a client of another version is refused and told the server version', () => {
    const ana = client(newServer(), 'ana-000000000000001', 'Ana');
    ana.hello('0.0.1');
    expect(ana.last('refused')).toEqual({
      type: 'refused',
      reason: 'version',
      version: GAME_VERSION,
    });
    expect(ana.state.isClosed).toBe(true);
  });

  test('an identifier already seen cannot be taken with another secret', () => {
    newServer();
    client(server, 'ana-000000000000001', 'Ana').hello();
    const thief = client(server, 'ana-000000000000001', 'Voleur', 't'.repeat(40));
    thief.hello();
    expect(thief.last('refused')?.reason).toBe('identity');
  });

  test('a room with a password: a wrong one is refused, the right one lets in', () => {
    newServer();
    const ana = client(server, 'ana-000000000000001', 'Ana');
    const bob = client(server, 'bob-000000000000002', 'Bob');
    ana.hello();
    bob.hello();
    ana.send({ type: 'createRoom', name: 'Les copains', password: 'secret' });
    const roomId = ana.last('room')?.room?.id ?? '';
    expect(bob.last('rooms')?.rooms[0]).toMatchObject({ id: roomId, hasPassword: true, humans: 1 });
    bob.send({ type: 'joinRoom', roomId, password: 'nope' });
    expect(bob.last('refused')?.reason).toBe('badPassword');
    bob.send({ type: 'joinRoom', roomId, password: 'secret' });
    expect(ana.last('room')?.room?.members.map((member) => member.name)).toEqual(['Ana', 'Bob']);
  });

  test('too many wrong passwords in a row and the server stops checking for a while', () => {
    newServer();
    const ana = client(server, 'ana-000000000000001', 'Ana');
    const bob = client(server, 'bob-000000000000002', 'Bob');
    ana.hello();
    bob.hello();
    ana.send({ type: 'createRoom', name: 'Fermé', password: 'secret' });
    const roomId = ana.last('room')?.room?.id ?? '';
    for (let index = 0; index < 5; index++) bob.send({ type: 'joinRoom', roomId, password: 'x' });
    bob.send({ type: 'joinRoom', roomId, password: 'secret' });
    expect(bob.last('refused')?.reason).toBe('tooManyTries');
  });

  test('the host starts: each player gets the game from their own seat, the others are bots', () => {
    newServer();
    const ana = client(server, 'ana-000000000000001', 'Ana');
    const bob = client(server, 'bob-000000000000002', 'Bob');
    ana.hello();
    bob.hello();
    ana.send({ type: 'createRoom', name: 'Partie', password: null });
    bob.send({ type: 'joinRoom', roomId: ana.last('room')?.room?.id, password: null });
    bob.send({ type: 'startGame' });
    expect(bob.last('refused')?.reason).toBe('notHost');
    ana.send({ type: 'startGame' });
    const anaGame = ana.last('snapshot');
    const bobGame = bob.last('snapshot');
    expect(anaGame?.you).toBe('p1');
    expect(bobGame?.you).toBe('p2');
    expect(Object.values(anaGame?.seats ?? {}).map((seat) => seat.kind)).toEqual([
      'human',
      'human',
      'bot',
      'bot',
    ]);
    // Une intention passe : Ana passe la présentation du plateau.
    ana.send({ type: 'intent', intent: { type: 'skipIntro' } });
    expect(bob.last('events')).toBeDefined();
  });

  test('a player who drops out in the middle of the game finds their seat back', () => {
    newServer();
    const ana = client(server, 'ana-000000000000001', 'Ana');
    ana.hello();
    ana.send({ type: 'createRoom', name: 'Partie', password: null });
    ana.send({ type: 'startGame' });
    server.disconnect(ana.connection);
    const back = client(server, 'ana-000000000000001', 'Ana');
    back.hello();
    expect(back.last('room')?.room?.phase).toBe('playing');
    expect(back.last('snapshot')?.you).toBe('p1');
  });

  test('nothing is done before saying hello, and garbage is ignored', () => {
    const ana = client(newServer(), 'ana-000000000000001', 'Ana');
    ana.send({ type: 'createRoom', name: 'Avant', password: null });
    server.receive(ana.connection, '{oops');
    expect(ana.received).toEqual([]);
    expect(server.roomCount).toBe(0);
  });
});
