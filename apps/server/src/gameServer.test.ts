import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  GAME_VERSION,
  type NetHostMessage,
  naturalAppearance,
  PROTOCOL_VERSION,
} from '@board-trouble/core';
import { GameServer } from './gameServer';
import { MemorySaveSlots } from './saveSlots';

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
  server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, awayAfter: 20 });
  return server;
}

/** Ana crée un salon, Bob le rejoint ; Ana lance la partie. */
function twoInGame() {
  newServer();
  const ana = client(server, 'ana-000000000000001', 'Ana');
  const bob = client(server, 'bob-000000000000002', 'Bob');
  ana.hello();
  bob.hello();
  ana.send({ type: 'createRoom', name: 'Partie', password: null });
  bob.send({ type: 'joinRoom', roomId: ana.last('room')?.room?.id, password: null });
  ana.send({ type: 'startGame' });
  return { ana, bob };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  test('a player away too long is played by an easy bot, and takes the seat back on return', async () => {
    const { ana, bob } = twoInGame();
    server.disconnect(bob.connection);
    await wait(60);
    expect(ana.last('seats')?.seats.p2?.kind).toBe('bot');
    expect(ana.last('chat')?.lines.at(-1)?.text).toContain('Bob');
    const back = client(server, 'bob-000000000000002', 'Bob');
    back.hello();
    expect(back.last('snapshot')?.you).toBe('p2');
    expect(ana.last('seats')?.seats.p2?.kind).toBe('human');
  });

  test('chat lines reach everyone in the room, too many too fast are refused', () => {
    const { ana, bob } = twoInGame();
    ana.send({ type: 'chat', text: '  salut   tout le monde ' });
    expect(bob.last('chat')?.lines.at(-1)).toMatchObject({
      name: 'Ana',
      text: 'salut tout le monde',
    });
    for (let index = 0; index < 6; index++) ana.send({ type: 'chat', text: `spam ${index}` });
    expect(ana.last('refused')?.reason).toBe('chatTooFast');
  });

  test('the host kicks (who may come back) or bans (who may not)', () => {
    const { ana, bob } = twoInGame();
    ana.send({ type: 'ban', member: 'bob-000000000000002' });
    expect(bob.last('refused')?.reason).toBe('kicked');
    expect(bob.last('room')?.room).toBeNull();
    expect(ana.last('seats')?.seats.p2?.kind).toBe('bot');
    bob.send({ type: 'joinRoom', roomId: ana.last('room')?.room?.id, password: null });
    expect(bob.last('refused')?.reason).toBe('banned');
  });

  test('someone arriving mid-game watches, then the host gives them a bot seat', () => {
    const { ana } = twoInGame();
    const cleo = client(server, 'cleo-00000000000003', 'Cleo');
    cleo.hello();
    cleo.send({ type: 'joinRoom', roomId: ana.last('room')?.room?.id, password: null });
    expect(cleo.last('snapshot')?.you).toBeNull();
    ana.send({ type: 'assignSeat', member: 'cleo-00000000000003', seat: 2 });
    expect(cleo.last('snapshot')?.you).toBe('p3');
    expect(ana.last('seats')?.seats.p3?.kind).toBe('human');
    expect(cleo.last('snapshot')?.state.players[2]?.name).toBe('Cleo');
  });

  test('a game is saved as it goes; after a restart, its players resume it and find their seats', () => {
    const saves = new MemorySaveSlots(3);
    server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, saves });
    const ana = client(server, 'ana-000000000000001', 'Ana');
    const bob = client(server, 'bob-000000000000002', 'Bob');
    ana.hello();
    bob.hello();
    ana.send({ type: 'createRoom', name: 'Partie', password: null });
    bob.send({ type: 'joinRoom', roomId: ana.last('room')?.room?.id, password: null });
    ana.send({ type: 'startGame' });
    expect(saves.list()).toMatchObject([
      {
        slot: 1,
        roomName: 'Partie',
        players: ['Ana', 'Bob', expect.any(String), expect.any(String)],
      },
    ]);
    // Le serveur redémarre : un nouveau serveur, les mêmes sauvegardes.
    server.close();
    server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, saves });
    const back = client(server, 'ana-000000000000001', 'Ana');
    back.hello();
    back.send({ type: 'createRoom', name: 'Reprise', password: null });
    expect(back.last('saves')?.saves[0]?.slot).toBe(1);
    back.send({ type: 'resumeSave', slot: 1 });
    expect(back.last('snapshot')?.you).toBe('p1');
    expect(back.last('room')?.room?.seats[1]).toMatchObject({
      member: 'bob-000000000000002',
      isAway: true,
    });
    const bobBack = client(server, 'bob-000000000000002', 'Bob');
    bobBack.hello();
    bobBack.send({ type: 'joinRoom', roomId: back.last('room')?.room?.id, password: null });
    expect(bobBack.last('snapshot')?.you).toBe('p2');
  });

  test('from the dashboard, a saved game reopens and starts again with its first player', () => {
    const saves = new MemorySaveSlots(3);
    server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, saves });
    const ana = client(server, 'ana-000000000000001', 'Ana');
    ana.hello();
    ana.send({ type: 'createRoom', name: 'Soirée', password: null });
    ana.send({ type: 'startGame' });
    server.close();
    server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, saves });
    expect(server.adminResumeSave(1)).toBeNull();
    const room = server.adminRooms()[0]?.view;
    expect(room?.name).toBe('Soirée');
    const back = client(server, 'ana-000000000000001', 'Ana');
    back.hello();
    back.send({ type: 'joinRoom', roomId: room?.id, password: null });
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

describe('the Discord login', () => {
  const keys = generateKeyPairSync('ed25519');
  const discordServer = (authKey: KeyObject | null = null) => {
    server = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, authKey });
    return server;
  };
  /** Un jeton comme ceux de l'API centrale, pour ce navigateur. */
  const token = (identity: string, privateKey = keys.privateKey) => {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        sub: '123456789012345678',
        name: 'Ana',
        avatar: null,
        idn: identity,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
  };
  const helloWith = (player: ReturnType<typeof client>, id: string, auth: string) =>
    player.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      version: GAME_VERSION,
      identity: { id, secret: 's'.repeat(40) },
      profile: { name: 'Ana', appearance: naturalAppearance('fox') },
      auth,
    });

  test('a valid token makes the player the same member in every browser', () => {
    discordServer(keys.publicKey);
    const laptop = client(server, 'ana-000000000000001', 'Ana');
    helloWith(laptop, 'ana-000000000000001', token('ana-000000000000001'));
    expect(laptop.last('welcome')?.memberId).toBe('discord-123456789012345678');
    laptop.send({ type: 'createRoom', name: 'Partie', password: null });
    const bob = client(server, 'bob-000000000000002', 'Bob');
    bob.hello();
    bob.send({ type: 'joinRoom', roomId: laptop.last('room')?.room?.id, password: null });
    laptop.send({ type: 'startGame' });
    // Le même compte depuis un autre navigateur : il reprend sa place dans la partie.
    const phone = client(server, 'ana-phone-0000000001', 'Ana');
    helloWith(phone, 'ana-phone-0000000001', token('ana-phone-0000000001'));
    expect(phone.last('welcome')?.roomId).toBe(laptop.last('room')?.room?.id ?? 'none');
    expect(laptop.state.isClosed).toBe(true);
  });

  test('a token that does not check out lets the player in under the browser id', () => {
    discordServer(keys.publicKey);
    const other = generateKeyPairSync('ed25519');
    const forged = client(server, 'ana-000000000000001', 'Ana');
    helloWith(forged, 'ana-000000000000001', token('ana-000000000000001', other.privateKey));
    expect(forged.last('welcome')?.memberId).toBe('ana-000000000000001');
    // Le jeton d'un autre navigateur : pareil.
    const borrowed = client(server, 'bob-000000000000002', 'Bob');
    helloWith(borrowed, 'bob-000000000000002', token('ana-000000000000001'));
    expect(borrowed.last('welcome')?.memberId).toBe('bob-000000000000002');
  });

  test('without the API key, the server ignores tokens', () => {
    discordServer();
    const ana = client(server, 'ana-000000000000001', 'Ana');
    helloWith(ana, 'ana-000000000000001', token('ana-000000000000001'));
    expect(ana.last('welcome')?.memberId).toBe('ana-000000000000001');
  });

  test('a browser cannot pose as a Discord member', () => {
    discordServer(keys.publicKey);
    const thief = client(server, 'discord-123456789012345678', 'Voleur');
    thief.hello();
    expect(thief.last('refused')?.reason).toBe('identity');
    expect(thief.state.isClosed).toBe(true);
  });
});
