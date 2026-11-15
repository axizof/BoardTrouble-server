import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomSettings } from '@board-trouble/core';
import { GameServer } from '../gameServer';
import { AdminHub } from './adminHub';
import type { AdminOutbound } from './adminProtocol';
import { DataStore } from './dataStore';
import { FileBans } from './fileBans';
import { LogBuffer } from './logBuffer';

let hub: AdminHub;
afterEach(() => hub?.close());

function setup() {
  const store = new DataStore(mkdtempSync(join(tmpdir(), 'bt-admin-')), () => {});
  const bans = new FileBans(store);
  const game = new GameServer({ name: 'Test', maxRooms: 4, log: () => {}, bans });
  hub = new AdminHub({
    game,
    logs: new LogBuffer(10),
    store,
    bans,
    password: 'secret-admin',
    serverInfo: () => ({ name: 'Test', port: 7350, addresses: [] }),
    update: () => null,
    log: () => {},
    onStop: () => {},
    onRestart: () => {},
  });
  const page = (isLocal: boolean, address = '10.0.0.2') => {
    const received: AdminOutbound[] = [];
    const connection = hub.connect(
      { send: (text) => received.push(JSON.parse(text) as AdminOutbound), close: () => {} },
      isLocal,
      address,
    );
    const send = (message: object) => hub.receive(connection, JSON.stringify(message));
    const last = <T extends AdminOutbound['type']>(type: T) =>
      received
        .filter((one): one is Extract<AdminOutbound, { type: T }> => one.type === type)
        .at(-1);
    return { send, last };
  };
  return { game, page, bans, store };
}

describe('the dashboard', () => {
  test('on the server machine it opens at once; elsewhere it asks the admin password', () => {
    const { page } = setup();
    expect(page(true).last('state')).toBeDefined();
    const remote = page(false);
    expect(remote.last('auth')).toEqual({ type: 'auth', ok: false, needsPassword: true });
    remote.send({ type: 'createRoom', name: 'Avant', password: null, preset: null });
    expect(remote.last('state')).toBeUndefined();
    remote.send({ type: 'login', password: 'secret-admin' });
    expect(remote.last('state')).toBeDefined();
  });

  test('too many wrong passwords from an address and it stops checking for a while', () => {
    const { page } = setup();
    const remote = page(false);
    for (let index = 0; index < 5; index++) remote.send({ type: 'login', password: 'nope' });
    remote.send({ type: 'login', password: 'secret-admin' });
    expect(remote.last('state')).toBeUndefined();
    expect(remote.last('notice')?.isError).toBe(true);
  });

  test('a room created from a preset takes its settings; bans are kept on disk', () => {
    const { game, page, store } = setup();
    const admin = page(true);
    const settings: RoomSettings = {
      tableSize: 6,
      chaos: 'calm',
      decisionTime: 120_000,
      textSpeed: 'fast',
      tips: false,
    };
    admin.send({ type: 'savePreset', preset: { name: 'Soirée', settings, botLevels: ['expert'] } });
    admin.send({ type: 'createRoom', name: 'Les copains', password: null, preset: 'Soirée' });
    const room = game.adminRooms()[0]?.view;
    expect(room?.settings).toEqual(settings);
    expect(room?.seats[0]?.botLevel).toBe('expert');
    game.adminExpel('abcdefghijklmnop', true);
    expect(new FileBans(store).has('abcdefghijklmnop')).toBe(true);
  });
});
