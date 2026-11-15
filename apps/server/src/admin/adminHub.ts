import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type BotLevel,
  checkRoomName,
  GAME_VERSION,
  ROOM_PASSWORD_MAX,
  readRoomSettings,
} from '@board-trouble/core';
import type { GameServer, ServerBans } from '../gameServer';
import type { AdminInbound, AdminOutbound, AdminState, Preset } from './adminProtocol';
import type { DataStore } from './dataStore';
import type { LogBuffer } from './logBuffer';
import { StatsProbe } from './systemStats';

// Le tableau de bord du serveur, côté serveur (`/admin`) : qui y entre (depuis la machine du
// serveur, directement ; d'ailleurs, avec le mot de passe admin), ce qu'il voit (l'état du
// serveur toutes les deux secondes, le journal en direct) et ce qu'il fait (salons, joueurs,
// presets, arrêt). Tout ce qui arrive de la page est relu, comme d'un client de jeu.

export type AdminPeer = { send(text: string): void; close(): void };

type AdminConnection = { peer: AdminPeer; isAuthed: boolean; address: string };

export type AdminOptions = {
  game: GameServer;
  logs: LogBuffer;
  store: DataStore;
  bans: ServerBans;
  /** Le mot de passe admin (variable BT_ADMIN_PASSWORD, ou tiré au lancement). */
  password: string;
  serverInfo: () => { name: string; port: number; addresses: string[] };
  update: () => AdminState['server']['update'];
  log: (line: string) => void;
  onStop: () => void;
  onRestart: () => void;
};

/** L'état part toutes les tant de millisecondes. */
const STATE_EVERY = 2000;
/** Pas plus de tant de mots de passe ratés par minute et par adresse. */
const LOGIN_TRIES = 5;
const LOGIN_WINDOW = 60_000;
const BOT_LEVELS: readonly BotLevel[] = ['easy', 'normal', 'expert'];
const PRESETS_MAX = 20;

export class AdminHub {
  readonly #options: AdminOptions;
  readonly #connections = new Set<AdminConnection>();
  readonly #failures = new Map<string, number[]>();
  readonly #probe = new StatsProbe();
  readonly #startedAt = performance.now();
  #presets: Preset[];
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopLogs: () => void;

  constructor(options: AdminOptions) {
    this.#options = options;
    this.#presets = options.store.load('presets', readPresets);
    this.#stopLogs = options.logs.listen((line) =>
      this.#broadcast({ type: 'logs', lines: [line] }),
    );
    this.#timer = setInterval(() => this.#pushState(), STATE_EVERY);
  }

  /** `isLocal` : la page est ouverte sur la machine du serveur (pas de mot de passe). */
  connect(peer: AdminPeer, isLocal: boolean, address: string): AdminConnection {
    const connection = { peer, isAuthed: isLocal, address };
    this.#connections.add(connection);
    this.#send(connection, { type: 'auth', ok: isLocal, needsPassword: !isLocal });
    if (isLocal) this.#welcome(connection);
    return connection;
  }

  disconnect(connection: AdminConnection): void {
    this.#connections.delete(connection);
  }

  close(): void {
    clearInterval(this.#timer);
    this.#stopLogs();
  }

  receive(connection: AdminConnection, text: string): void {
    const message = parseAdmin(text);
    if (!message) return;
    if (message.type === 'login') {
      this.#login(connection, message.password);
      return;
    }
    if (!connection.isAuthed) return;
    this.#act(connection, message);
  }

  #login(connection: AdminConnection, password: string): void {
    if (connection.isAuthed) return;
    const recent = (this.#failures.get(connection.address) ?? []).filter(
      (at) => performance.now() - at < LOGIN_WINDOW,
    );
    if (recent.length >= LOGIN_TRIES) {
      this.#notice(connection, "Trop d'essais : attends une minute.", true);
      return;
    }
    if (!samePassword(password, this.#options.password)) {
      this.#failures.set(connection.address, [...recent, performance.now()]);
      this.#send(connection, { type: 'auth', ok: false, needsPassword: true });
      this.#notice(connection, 'Mauvais mot de passe.', true);
      return;
    }
    connection.isAuthed = true;
    this.#send(connection, { type: 'auth', ok: true, needsPassword: true });
    this.#welcome(connection);
  }

  #welcome(connection: AdminConnection): void {
    this.#send(connection, { type: 'logs', lines: [...this.#options.logs.lines] });
    this.#send(connection, { type: 'state', state: this.#state() });
  }

  #act(connection: AdminConnection, message: Exclude<AdminInbound, { type: 'login' }>): void {
    const { game, log } = this.#options;
    switch (message.type) {
      case 'createRoom': {
        const preset = this.#presets.find((one) => one.name === message.preset);
        const settings = preset?.settings ?? DEFAULT_PRESET.settings;
        const refused = game.adminCreateRoom(
          message.name,
          message.password,
          settings,
          preset?.botLevels ?? [],
        );
        this.#notice(
          connection,
          refused ? `Salon refusé (${refused}).` : `Salon "${message.name}" créé.`,
          refused !== null,
        );
        break;
      }
      case 'closeRoom':
        game.adminCloseRoom(message.roomId);
        break;
      case 'forceNext':
        game.adminForceNext(message.roomId);
        break;
      case 'expel':
        game.adminExpel(message.id, message.isBanned);
        break;
      case 'unban':
        game.adminUnban(message.id);
        log(`Débanni du serveur : ${message.id}`);
        break;
      case 'savePreset':
        this.#presets = [
          ...this.#presets.filter((one) => one.name !== message.preset.name),
          message.preset,
        ].slice(-PRESETS_MAX);
        this.#options.store.save('presets', this.#presets);
        this.#notice(connection, `Preset "${message.preset.name}" enregistré.`, false);
        break;
      case 'deletePreset':
        this.#presets = this.#presets.filter((one) => one.name !== message.name);
        this.#options.store.save('presets', this.#presets);
        break;
      case 'stop':
        log('Arrêt demandé depuis le tableau de bord');
        this.#options.onStop();
        return;
      case 'restart':
        log('Redémarrage demandé depuis le tableau de bord');
        this.#options.onRestart();
        return;
    }
    this.#pushState();
  }

  #state(): AdminState {
    const { game, bans, serverInfo, update } = this.#options;
    return {
      server: {
        ...serverInfo(),
        version: GAME_VERSION,
        uptime: performance.now() - this.#startedAt,
        stats: this.#probe.read(),
        update: update(),
      },
      rooms: game.adminRooms(),
      players: game.adminPlayers(),
      bans: bans.list(),
      presets: this.#presets,
    };
  }

  #pushState(): void {
    if (![...this.#connections].some((connection) => connection.isAuthed)) return;
    this.#broadcast({ type: 'state', state: this.#state() });
  }

  #broadcast(message: AdminOutbound): void {
    for (const connection of this.#connections) {
      if (connection.isAuthed) this.#send(connection, message);
    }
  }

  #notice(connection: AdminConnection, text: string, isError: boolean): void {
    this.#send(connection, { type: 'notice', text, isError });
  }

  #send(connection: AdminConnection, message: AdminOutbound): void {
    connection.peer.send(JSON.stringify(message));
  }
}

/** Le preset par défaut, pour un salon créé sans preset. */
const DEFAULT_PRESET: Preset = {
  name: 'Par défaut',
  settings: {
    tableSize: 4,
    chaos: 'normal',
    decisionTime: 90_000,
    textSpeed: 'normal',
    tips: true,
  },
  botLevels: [],
};

/** Compare deux mots de passe en temps constant (pas d'indice sur la longueur juste). */
function samePassword(given: string, expected: string): boolean {
  const hash = (text: string) => createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

function readPresets(raw: unknown): Preset[] {
  return Array.isArray(raw)
    ? raw.flatMap((one) => readPreset(one) ?? []).slice(0, PRESETS_MAX)
    : [];
}

function readPreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const name = checkRoomName(data.name);
  const settings = readRoomSettings(data.settings);
  const levels = Array.isArray(data.botLevels) ? data.botLevels : [];
  if (!name || !settings) return null;
  return {
    name,
    settings,
    botLevels: levels.flatMap((level) => BOT_LEVELS.find((one) => one === level) ?? []).slice(0, 6),
  };
}

/** Relit un message de la page ; null s'il est invalide. */
function parseAdmin(text: string): AdminInbound | null {
  if (text.length > 8000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Pas du JSON : ignoré, comme tout message invalide.
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const textOf = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  switch (data.type) {
    case 'login': {
      const password = textOf(data.password, 200);
      return password ? { type: 'login', password } : null;
    }
    case 'createRoom': {
      const name = checkRoomName(data.name);
      const password = data.password === null ? null : textOf(data.password, ROOM_PASSWORD_MAX);
      const preset = data.preset === null ? null : textOf(data.preset, 40);
      // Un mot de passe (ou un preset) donné mais invalide : refusé, pas pris pour "aucun".
      if (!name || (data.password !== null && password === null)) return null;
      if (data.preset !== null && preset === null) return null;
      return { type: 'createRoom', name, password, preset };
    }
    case 'closeRoom':
    case 'forceNext': {
      const roomId = textOf(data.roomId, 16);
      return roomId ? { type: data.type, roomId } : null;
    }
    case 'expel': {
      const id = textOf(data.id, 64);
      return id ? { type: 'expel', id, isBanned: data.isBanned === true } : null;
    }
    case 'unban': {
      const id = textOf(data.id, 64);
      return id ? { type: 'unban', id } : null;
    }
    case 'savePreset': {
      const preset = readPreset(data.preset);
      return preset ? { type: 'savePreset', preset } : null;
    }
    case 'deletePreset': {
      const name = textOf(data.name, 40);
      return name ? { type: 'deletePreset', name } : null;
    }
    case 'stop':
    case 'restart':
      return { type: data.type };
    default:
      return null;
  }
}
