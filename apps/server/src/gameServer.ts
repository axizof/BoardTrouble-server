import {
  type Board,
  buildMontTrouble,
  GAME_VERSION,
  type GameEvent,
  type MemberId,
  type NetClientMessage,
  type NetHostMessage,
  PROTOCOL_VERSION,
  type Profile,
  parseNetMessage,
  prepareBoard,
  Room,
  type RoomClientMessage,
  type ServerRefusal,
} from '@board-trouble/core';

// Le serveur de jeu, sans le réseau (01-architecture.md, sections 3, 5 et 7) : les connexions,
// les salons et les parties qu'ils hébergent. Bun (main.ts) lui passe chaque connexion et chaque
// message ; ici, on décide. Une partie se rythme comme l'hôte solo : la session dit quand elle
// veut se réveiller (bot, chrono, pas d'arène), un minuteur l'y réveille.

/** Le bout réseau d'une connexion : de quoi lui écrire et la fermer. */
export type Peer = { send(text: string): void; close(): void };

export type ServerOptions = {
  name: string;
  /** Combien de salons à la fois, au plus. */
  maxRooms: number;
  log: (line: string) => void;
};

type Connection = {
  peer: Peer;
  /** L'identifiant du joueur, une fois présenté (`hello`). */
  id: MemberId | null;
  profile: Profile | null;
  roomId: string | null;
  /** Les mots de passe ratés récemment (instants, ms) : au-delà, on attend. */
  failures: number[];
};

type HostedRoom = {
  room: Room;
  /** Le mot de passe haché, ou null. */
  password: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Le salon vide disparaît au bout d'un moment (on peut y revenir d'ici là). */
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  isRecapSent: boolean;
};

/** Pas plus de tant de mots de passe ratés par minute et par connexion. */
const PASSWORD_TRIES = 5;
const PASSWORD_WINDOW = 60_000;
/** Un salon sans personne de connecté ferme au bout de tant (ms). */
const EMPTY_ROOM_GRACE = 5 * 60_000;
/** Les codes de salon : sans lettres qu'on confond (O et 0, I et 1). */
const ROOM_CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

const now = () => performance.now();

export class GameServer {
  readonly #options: ServerOptions;
  readonly #board: Board = prepareBoard(buildMontTrouble());
  readonly #rooms = new Map<string, HostedRoom>();
  /** La connexion active de chaque joueur présenté. */
  readonly #byId = new Map<MemberId, Connection>();
  /** Le secret de chaque identifiant déjà vu : lui seul peut reprendre cet identifiant. */
  readonly #secrets = new Map<MemberId, string>();

  constructor(options: ServerOptions) {
    this.#options = options;
  }

  connect(peer: Peer): Connection {
    return { peer, id: null, profile: null, roomId: null, failures: [] };
  }

  receive(connection: Connection, text: string): void {
    const message = parseNetMessage(text);
    if (!message) return;
    if (message.type === 'hello') {
      this.#hello(connection, message);
      return;
    }
    // Rien avant de s'être présenté.
    if (connection.id === null || connection.profile === null) return;
    switch (message.type) {
      case 'listRooms':
        this.#send(connection, { type: 'rooms', rooms: this.#summaries() });
        return;
      case 'createRoom':
        this.#createRoom(connection, message.name, message.password);
        return;
      case 'joinRoom':
        this.#joinRoom(connection, message.roomId, message.password);
        return;
      case 'leaveRoom':
        this.#leaveRoom(connection);
        return;
      default:
        this.#inRoom(connection, message);
    }
  }

  /** La connexion est coupée : sa place l'attend (pendant une partie) ou se libère (au salon). */
  disconnect(connection: Connection): void {
    if (connection.id !== null && this.#byId.get(connection.id) === connection) {
      this.#byId.delete(connection.id);
      this.#options.log(`${connection.profile?.name ?? connection.id} s'est déconnecté`);
    }
    this.#leaveRoom(connection, false);
  }

  /** Arrête toutes les parties (le serveur s'éteint). */
  close(): void {
    for (const hosted of this.#rooms.values()) {
      clearTimeout(hosted.timer);
      clearTimeout(hosted.closeTimer);
    }
    this.#rooms.clear();
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  #hello(connection: Connection, message: Extract<RoomClientMessage, { type: 'hello' }>): void {
    if (connection.id !== null) return;
    if (message.protocol !== PROTOCOL_VERSION || message.version !== GAME_VERSION) {
      this.#send(connection, { type: 'refused', reason: 'version', version: GAME_VERSION });
      connection.peer.close();
      return;
    }
    const { id, secret } = message.identity;
    const known = this.#secrets.get(id);
    if (known !== undefined && known !== secret) {
      this.#send(connection, { type: 'refused', reason: 'identity' });
      connection.peer.close();
      return;
    }
    this.#secrets.set(id, secret);
    // Le même joueur dans un autre onglet (ou une connexion morte pas encore vue) : la nouvelle
    // connexion prend la relève.
    const previous = this.#byId.get(id);
    if (previous) {
      this.#byId.delete(id);
      previous.peer.close();
    }
    connection.id = id;
    connection.profile = message.profile;
    this.#byId.set(id, connection);
    this.#options.log(`${message.profile.name} est arrivé`);
    this.#send(connection, {
      type: 'welcome',
      serverName: this.#options.name,
      version: GAME_VERSION,
      rooms: this.#summaries(),
    });
    // Revenu en pleine partie : il reprend sa place.
    const back = [...this.#rooms.values()].find(
      (hosted) => hosted.room.phase === 'playing' && hosted.room.member(id) !== undefined,
    );
    if (back) this.#enter(connection, back);
  }

  #createRoom(connection: Connection, name: string, password: string | null): void {
    if (this.#rooms.size >= this.#options.maxRooms) {
      this.#refuse(connection, 'tooManyRooms');
      return;
    }
    this.#leaveRoom(connection);
    let code = roomCode();
    while (this.#rooms.has(code)) code = roomCode();
    const hosted: HostedRoom = {
      room: new Room(code, name, password !== null),
      password: password === null ? null : Bun.password.hashSync(password, 'bcrypt'),
      timer: undefined,
      closeTimer: undefined,
      isRecapSent: false,
    };
    this.#rooms.set(code, hosted);
    this.#options.log(`${connection.profile?.name} a créé le salon "${name}" (${code})`);
    this.#enter(connection, hosted);
    this.#broadcastRooms();
  }

  #joinRoom(connection: Connection, roomId: string, password: string | null): void {
    const hosted = this.#rooms.get(roomId);
    if (!hosted) {
      this.#refuse(connection, 'noRoom');
      return;
    }
    if (connection.roomId === roomId) return;
    const isMember = connection.id !== null && hosted.room.member(connection.id) !== undefined;
    if (hosted.password !== null && !isMember) {
      const recent = connection.failures.filter((at) => now() - at < PASSWORD_WINDOW);
      connection.failures = recent;
      if (recent.length >= PASSWORD_TRIES) {
        this.#refuse(connection, 'tooManyTries');
        return;
      }
      if (password === null || !Bun.password.verifySync(password, hosted.password)) {
        connection.failures.push(now());
        this.#refuse(connection, 'badPassword');
        return;
      }
    }
    this.#leaveRoom(connection);
    this.#enter(connection, hosted);
  }

  /** Entre dans le salon (ou y revient) ; en pleine partie, reçoit de quoi l'afficher. */
  #enter(connection: Connection, hosted: HostedRoom): void {
    const { room } = hosted;
    if (connection.id === null || connection.profile === null) return;
    const joined = room.join({ id: connection.id, ...connection.profile });
    if (!joined.ok) {
      this.#refuse(connection, joined.reason);
      return;
    }
    clearTimeout(hosted.closeTimer);
    hosted.closeTimer = undefined;
    connection.roomId = room.id;
    this.#broadcastRoom(hosted);
    const session = room.session;
    if (session) {
      const viewer = room.viewerOf(connection.id);
      this.#send(connection, session.snapshot(viewer, now()));
      if (session.isPlayingArena) this.#send(connection, session.arenaMessage(viewer, now()));
    }
    this.#broadcastRooms();
  }

  /**
   * Sort du salon où l'on est. `isLeaving` : il part pour de bon (sinon, il est seulement
   * déconnecté, et retrouvera sa place en pleine partie).
   */
  #leaveRoom(connection: Connection, isLeaving = true): void {
    const hosted = connection.roomId === null ? undefined : this.#rooms.get(connection.roomId);
    connection.roomId = null;
    if (!hosted || connection.id === null) return;
    hosted.room.leave(connection.id);
    if (isLeaving) this.#send(connection, { type: 'room', room: null });
    this.#broadcastRoom(hosted);
    if (hosted.room.connected.length === 0) this.#closeLater(hosted);
    this.#broadcastRooms();
  }

  /** Un salon où plus personne n'est connecté ferme après un délai (on peut encore y revenir). */
  #closeLater(hosted: HostedRoom): void {
    clearTimeout(hosted.closeTimer);
    const close = () => {
      if (hosted.room.connected.length > 0) return;
      clearTimeout(hosted.timer);
      this.#rooms.delete(hosted.room.id);
      this.#options.log(`Le salon "${hosted.room.name}" (${hosted.room.id}) est fermé`);
      this.#broadcastRooms();
    };
    // Au salon, personne n'a de place à retrouver : il ferme tout de suite.
    if (hosted.room.phase === 'lobby') close();
    else hosted.closeTimer = setTimeout(close, EMPTY_ROOM_GRACE);
  }

  /** Les messages qui se jouent dans le salon : ses réglages, puis la partie. */
  #inRoom(connection: Connection, message: NetClientMessage): void {
    const hosted = connection.roomId === null ? undefined : this.#rooms.get(connection.roomId);
    const id = connection.id;
    if (!hosted || id === null) {
      this.#refuse(connection, 'notInRoom');
      return;
    }
    const { room } = hosted;
    switch (message.type) {
      case 'setProfile': {
        const result = room.setProfile(id, message.profile.name, message.profile.appearance);
        if (!result.ok) this.#refuse(connection, result.reason);
        else {
          connection.profile = message.profile;
          this.#broadcastRoom(hosted);
        }
        return;
      }
      case 'setSettings': {
        const result = room.setSettings(id, message.settings);
        if (!result.ok) this.#refuse(connection, result.reason);
        else this.#broadcastRoom(hosted);
        return;
      }
      case 'setBotLevel': {
        const result = room.setBotLevel(id, message.seat, message.level);
        if (!result.ok) this.#refuse(connection, result.reason);
        else this.#broadcastRoom(hosted);
        return;
      }
      case 'startGame':
        this.#startGame(connection, hosted);
        return;
      case 'intent':
      case 'arenaReady':
      case 'arenaInput':
        this.#play(connection, hosted, message);
        return;
      default:
        return;
    }
  }

  #startGame(connection: Connection, hosted: HostedRoom): void {
    const { room } = hosted;
    if (connection.id === null) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const started = room.start(connection.id, this.#board, seed, now());
    if (!started.ok) {
      this.#refuse(connection, started.reason);
      return;
    }
    hosted.isRecapSent = false;
    this.#options.log(`Partie lancée dans le salon "${room.name}" (${room.id})`);
    this.#broadcastRoom(hosted);
    const session = room.session;
    if (!session) return;
    for (const member of this.#members(hosted)) {
      if (member.id === null) continue;
      const viewer = room.viewerOf(member.id);
      this.#send(member, session.snapshot(viewer, now()));
      this.#send(member, session.update(viewer, started.events, now()));
    }
    this.#schedule(hosted);
    this.#broadcastRooms();
  }

  #play(
    connection: Connection,
    hosted: HostedRoom,
    message: Extract<NetClientMessage, { type: 'intent' | 'arenaReady' | 'arenaInput' }>,
  ): void {
    const session = hosted.room.session;
    if (!session || connection.id === null) return;
    const viewer = hosted.room.viewerOf(connection.id);
    // Un spectateur ne joue pas.
    if (viewer.type !== 'player') return;
    if (message.type === 'arenaInput') {
      session.arenaInput(viewer.playerId, message.input);
      return;
    }
    if (message.type === 'arenaReady') {
      session.arenaReady(viewer.playerId, now());
      this.#broadcastArena(hosted);
      this.#schedule(hosted);
      return;
    }
    const result = session.submit(viewer, message.intent, now());
    if (!result.ok) {
      this.#send(connection, { type: 'rejected', error: result.error });
      return;
    }
    this.#broadcastEvents(hosted, result.events);
    this.#schedule(hosted);
  }

  /** Réveille la partie à l'heure de sa prochaine action automatique (bot, chrono, arène). */
  #schedule(hosted: HostedRoom): void {
    clearTimeout(hosted.timer);
    const session = hosted.room.session;
    const wake = session?.nextWakeAt();
    if (!session || wake === null || wake === undefined) return;
    hosted.timer = setTimeout(
      () => {
        const wasPlaying = session.isPlayingArena;
        const events = session.tick(now());
        // L'arène, à chaque pas (et une dernière fois, vide, quand elle se termine).
        if (wasPlaying || session.isPlayingArena) this.#broadcastArena(hosted);
        if (events && events.length > 0) this.#broadcastEvents(hosted, events);
        if (hosted.room.session === session) this.#schedule(hosted);
      },
      Math.max(0, wake - now()),
    );
  }

  /** Les événements, à chacun selon ce qu'il a le droit de voir ; puis, à la fin, le récap. */
  #broadcastEvents(hosted: HostedRoom, events: GameEvent[]): void {
    const { room } = hosted;
    const session = room.session;
    if (!session) return;
    for (const member of this.#members(hosted)) {
      if (member.id === null) continue;
      this.#send(member, session.update(room.viewerOf(member.id), events, now()));
    }
    if (session.isPlayingArena || hosted.isRecapSent) return;
    const recap = session.recapMessage();
    if (recap?.type !== 'recap') return;
    hosted.isRecapSent = true;
    for (const member of this.#members(hosted)) this.#send(member, recap);
    clearTimeout(hosted.timer);
    room.finishGame();
    this.#options.log(`Partie finie dans le salon "${room.name}" (${room.id})`);
    this.#broadcastRoom(hosted);
    this.#broadcastRooms();
  }

  #broadcastArena(hosted: HostedRoom): void {
    const { room } = hosted;
    const session = room.session;
    if (!session) return;
    for (const member of this.#members(hosted)) {
      if (member.id === null) continue;
      this.#send(member, session.arenaMessage(room.viewerOf(member.id), now()));
    }
  }

  #broadcastRoom(hosted: HostedRoom): void {
    const view = hosted.room.view();
    for (const member of this.#members(hosted)) this.#send(member, { type: 'room', room: view });
  }

  /** La liste des salons, à ceux qui la regardent (présentés, pas dans un salon). */
  #broadcastRooms(): void {
    const rooms = this.#summaries();
    for (const connection of this.#byId.values()) {
      if (connection.roomId === null) this.#send(connection, { type: 'rooms', rooms });
    }
  }

  /** Les connexions des membres connectés du salon. */
  #members(hosted: HostedRoom): Connection[] {
    return hosted.room.connected.flatMap((member) => {
      const connection = this.#byId.get(member.id);
      return connection && connection.roomId === hosted.room.id ? [connection] : [];
    });
  }

  #summaries() {
    return [...this.#rooms.values()].map((hosted) => hosted.room.summary());
  }

  #refuse(connection: Connection, reason: ServerRefusal): void {
    this.#send(connection, { type: 'refused', reason });
  }

  #send(connection: Connection, message: NetHostMessage): void {
    connection.peer.send(JSON.stringify(message));
  }
}

function roomCode(): string {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
    code += ROOM_CODE_LETTERS[Math.floor(Math.random() * ROOM_CODE_LETTERS.length)];
  }
  return code;
}
