import {
  type ArenaStage,
  type Board,
  type BotLevel,
  buildMontTrouble,
  GAME_VERSION,
  type GameEvent,
  type MemberId,
  MINIGAME_NAMES,
  type NetClientMessage,
  type NetHostMessage,
  type PlayerId,
  PROTOCOL_VERSION,
  type Profile,
  parseNetMessage,
  prepareBoard,
  Room,
  type RoomClientMessage,
  type RoomRefusal,
  type RoomSettings,
  type RoomView,
  type SaveSummary,
  type ServerRefusal,
  seatPlayerId,
  whoMustAct,
} from '@board-trouble/core';
import { SAVE_FILE_VERSION, type SaveSlots } from './saveSlots';

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
  /** Déconnecté en partie depuis tant (ms), un bot prend sa place (AWAY_AFTER par défaut). */
  awayAfter?: number;
  /** Les bannis du serveur (le tableau de bord), gardés sur disque par main.ts. */
  bans?: ServerBans;
  /** Les parties sauvegardées (data/saves) ; absent : rien n'est sauvegardé. */
  saves?: SaveSlots;
};

/** Les bannis de tout le serveur : leur identifiant et leur pseudo. */
export type ServerBans = {
  has(id: MemberId): boolean;
  add(id: MemberId, name: string): void;
  remove(id: MemberId): void;
  list(): { id: MemberId; name: string }[];
};

/** Ce que le tableau de bord voit d'un joueur connecté. */
export type AdminPlayer = {
  id: MemberId;
  name: string;
  roomId: string | null;
  address: string;
  /** Aller-retour mesuré avec le client (ms), ou null pas encore mesuré. */
  ping: number | null;
};

/** Ce que le tableau de bord voit d'un salon : sa vue, et où en est sa partie. */
export type AdminRoom = { view: RoomView; step: string | null };

/** Une sauvegarde vue du tableau de bord : `inUse`, un salon la joue en ce moment. */
export type AdminSave = SaveSummary & { inUse: boolean };

type Connection = {
  peer: Peer;
  /** L'identifiant du joueur, une fois présenté (`hello`). */
  id: MemberId | null;
  profile: Profile | null;
  roomId: string | null;
  /** Les mots de passe ratés récemment (instants, ms) : au-delà, on attend. */
  failures: number[];
  /** Ses dernières lignes de tchat (instants, ms) : au-delà d'un rythme, refusées. */
  chats: number[];
  /** Son adresse IP (le tableau de bord), et la latence mesurée (ms). */
  address: string;
  ping: number | null;
  /** Le dernier `ping` envoyé : son numéro et son heure. */
  pingSent: { id: number; at: number } | null;
};

type HostedRoom = {
  room: Room;
  /** Le mot de passe haché, ou null. */
  password: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Le salon vide disparaît au bout d'un moment (on peut y revenir d'ici là). */
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  isRecapSent: boolean;
  /** Combien de fois de suite chaque joueur a été joué d'office (son chrono écoulé). */
  autoPlays: Map<PlayerId, number>;
  /** Les membres déconnectés en partie : un bot les remplace au bout de AWAY_AFTER. */
  awayTimers: Map<MemberId, ReturnType<typeof setTimeout>>;
  /** Ceux qui reviennent pendant un mini-jeu : ils reprennent leur place à sa fin. */
  pendingReturns: Set<MemberId>;
  /** L'emplacement de sauvegarde de sa partie, ou null (pas de partie, ou aucun de libre). */
  slot: number | null;
  /**
   * Une partie à reprendre dès que le premier de ses joueurs arrive (reprise depuis le tableau
   * de bord : sans personne, les bots joueraient seuls), ou null.
   */
  pendingSave: number | null;
};

/** Déconnecté en partie depuis tant (ms) : un bot Facile prend sa place, qu'il retrouvera. */
const AWAY_AFTER = 30_000;
/** Joué d'office tant de fois de suite (connecté mais inactif) : un bot prend sa place. */
const AUTO_PLAYS_BEFORE_AWAY = 2;
/** Le tchat : pas plus de tant de lignes par fenêtre de tant (ms), par connexion. */
const CHAT_BURST = 5;
const CHAT_WINDOW = 5000;

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

  connect(peer: Peer, address = ''): Connection {
    return {
      peer,
      id: null,
      profile: null,
      roomId: null,
      failures: [],
      chats: [],
      address,
      ping: null,
      pingSent: null,
    };
  }

  /** Mesure la latence de chacun (main.ts l'appelle toutes les quelques secondes). */
  pingAll(): void {
    for (const connection of this.#byId.values()) {
      const id = (connection.pingSent?.id ?? 0) + 1;
      connection.pingSent = { id, at: now() };
      this.#send(connection, { type: 'ping', id });
    }
  }

  // Le tableau de bord (admin/adminHub.ts) : voir, et agir sans être hôte.

  adminPlayers(): AdminPlayer[] {
    return [...this.#byId.values()].flatMap((connection) =>
      connection.id === null || connection.profile === null
        ? []
        : [
            {
              id: connection.id,
              name: connection.profile.name,
              roomId: connection.roomId,
              address: connection.address,
              ping: connection.ping,
            },
          ],
    );
  }

  adminRooms(): AdminRoom[] {
    return [...this.#rooms.values()].map(({ room }) => ({
      view: room.view(),
      step: stepOf(room),
    }));
  }

  /** Un salon créé depuis le tableau de bord, avec ses réglages : le premier arrivé en est l'hôte. */
  adminCreateRoom(
    name: string,
    password: string | null,
    settings: RoomSettings,
    botLevels: BotLevel[],
  ): RoomRefusal | ServerRefusal | null {
    if (this.#rooms.size >= this.#options.maxRooms) return 'tooManyRooms';
    let code = roomCode();
    while (this.#rooms.has(code)) code = roomCode();
    const hosted = this.#host(new Room(code, name, password !== null), password);
    const configured = hosted.room.configure(settings, botLevels);
    if (!configured.ok) return configured.reason;
    this.#rooms.set(code, hosted);
    this.#options.log(`Le tableau de bord a créé le salon "${name}" (${code})`);
    this.#broadcastRooms();
    return null;
  }

  /** Ferme un salon : ses membres reviennent à la liste des salons. */
  adminCloseRoom(roomId: string): void {
    const hosted = this.#rooms.get(roomId);
    if (!hosted) return;
    for (const member of this.#members(hosted)) {
      member.roomId = null;
      this.#refuse(member, 'kicked');
      this.#send(member, { type: 'room', room: null });
    }
    clearTimeout(hosted.timer);
    clearTimeout(hosted.closeTimer);
    for (const timer of hosted.awayTimers.values()) clearTimeout(timer);
    this.#rooms.delete(roomId);
    this.#options.log(`Le tableau de bord a fermé le salon "${hosted.room.name}" (${roomId})`);
    this.#broadcastRooms();
  }

  /** Sort un joueur de son salon ; `isBanned` : banni de tout le serveur (il est déconnecté). */
  adminExpel(id: MemberId, isBanned: boolean): void {
    const connection = this.#byId.get(id);
    const hosted = connection?.roomId ? this.#rooms.get(connection.roomId) : undefined;
    const name = connection?.profile?.name ?? hosted?.room.member(id)?.name ?? id;
    if (hosted?.room.expel(id, false).ok) {
      this.#announce(hosted, `${name} a été sorti du salon par le serveur`);
      this.#broadcastRoom(hosted);
      this.#broadcastSeats(hosted);
      this.#schedule(hosted);
    }
    if (connection) {
      connection.roomId = null;
      this.#refuse(connection, isBanned ? 'banned' : 'kicked');
      this.#send(connection, { type: 'room', room: null });
    }
    if (isBanned) {
      this.#options.bans?.add(id, name);
      this.#options.log(`${name} est banni du serveur`);
      connection?.peer.close();
    }
    this.#broadcastRooms();
  }

  adminSaves(): AdminSave[] {
    return (this.#options.saves?.list() ?? []).map((save) => ({
      ...save,
      inUse: this.#slotInUse(save.slot),
    }));
  }

  /**
   * Reprend une sauvegarde depuis le tableau de bord : un salon à son nom (et son mot de passe),
   * qui la relance dès que le premier de ses joueurs arrive.
   */
  adminResumeSave(slot: number): ServerRefusal | null {
    const game = this.#options.saves?.read(slot);
    if (!game) return 'noSave';
    if (this.#slotInUse(slot)) return 'alreadyPlaying';
    if (this.#rooms.size >= this.#options.maxRooms) return 'tooManyRooms';
    let code = roomCode();
    while (this.#rooms.has(code)) code = roomCode();
    const hosted = this.#host(
      new Room(code, game.roomName, game.password !== null),
      game.password,
      true,
    );
    hosted.pendingSave = slot;
    this.#rooms.set(code, hosted);
    this.#options.log(
      `Le tableau de bord a rouvert "${game.roomName}" (${code}) pour reprendre sa partie`,
    );
    this.#broadcastRooms();
    return null;
  }

  adminDeleteSave(slot: number): void {
    if (this.#slotInUse(slot)) return;
    this.#options.saves?.remove(slot);
    this.#broadcastSaves();
  }

  adminUnban(id: MemberId): void {
    this.#options.bans?.remove(id);
  }

  /** Force l'étape suivante d'une partie bloquée (le choix par défaut, tout de suite). */
  adminForceNext(roomId: string): void {
    const hosted = this.#rooms.get(roomId);
    const session = hosted?.room.session;
    if (!hosted || !session) return;
    const wasPlaying = session.isPlayingArena;
    const events = session.forceNext(now());
    this.#options.log(`Étape forcée dans le salon "${hosted.room.name}" (${roomId})`);
    if (wasPlaying || session.isPlayingArena) this.#broadcastArena(hosted);
    if (events && events.length > 0) this.#broadcastEvents(hosted, events);
    if (hosted.room.session === session) this.#schedule(hosted);
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
      case 'pong':
        if (connection.pingSent?.id === message.id) {
          connection.ping = Math.round(now() - connection.pingSent.at);
        }
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
      for (const timer of hosted.awayTimers.values()) clearTimeout(timer);
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
    if (this.#options.bans?.has(id)) {
      this.#send(connection, { type: 'refused', reason: 'banned' });
      connection.peer.close();
      return;
    }
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
    const hosted = this.#host(new Room(code, name, password !== null), password);
    this.#rooms.set(code, hosted);
    this.#options.log(`${connection.profile?.name} a créé le salon "${name}" (${code})`);
    this.#enter(connection, hosted);
    this.#broadcastRooms();
  }

  /** Un salon à héberger, son mot de passe haché. */
  /** Un salon à héberger ; `password` : en clair, ou déjà haché (`isHashed`, une sauvegarde). */
  #host(room: Room, password: string | null, isHashed = false): HostedRoom {
    return {
      room,
      password:
        password === null || isHashed ? password : Bun.password.hashSync(password, 'bcrypt'),
      slot: null,
      pendingSave: null,
      timer: undefined,
      closeTimer: undefined,
      isRecapSent: false,
      autoPlays: new Map(),
      awayTimers: new Map(),
      pendingReturns: new Set(),
    };
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
    this.#send(connection, { type: 'chat', lines: [...room.chat] });
    const saves = this.#options.saves;
    if (saves && room.phase === 'lobby') {
      this.#send(connection, { type: 'saves', saves: saves.list(), slots: saves.count });
    }
    // Une partie reprise depuis le tableau de bord démarre avec le premier de ses joueurs.
    if (hosted.pendingSave !== null && room.hostId === connection.id) {
      const refused = this.#resume(hosted, connection.id, hosted.pendingSave);
      if (refused) this.#refuse(connection, refused);
    }
    // Revenu à temps : pas de bot ; revenu après : il reprend sa place (à la fin d'un mini-jeu).
    clearTimeout(hosted.awayTimers.get(connection.id));
    hosted.awayTimers.delete(connection.id);
    if (room.isAway(connection.id)) this.#giveBack(hosted, connection.id);
    this.#broadcastRoom(hosted);
    const session = room.session;
    if (session) {
      const viewer = room.viewerOf(connection.id);
      this.#send(connection, session.snapshot(viewer, now()));
      if (session.isPlayingArena) this.#send(connection, session.arenaMessage(viewer, now()));
    }
    this.#broadcastRooms();
  }

  /** Un membre reprend sa place (que jouait un bot) ; pendant un mini-jeu, à sa fin. */
  #giveBack(hosted: HostedRoom, id: MemberId): void {
    const { room } = hosted;
    if (room.session?.isPlayingArena) {
      hosted.pendingReturns.add(id);
      return;
    }
    hosted.pendingReturns.delete(id);
    if (!room.reclaim(id).ok) return;
    hosted.autoPlays.delete(seatPlayerId(room.seatOf(id)));
    this.#announce(hosted, `${room.member(id)?.name} a repris sa place`);
    this.#broadcastSeats(hosted);
  }

  /** Un membre est absent : un bot Facile joue pour lui, jusqu'à son retour. */
  #replaceAway(hosted: HostedRoom, id: MemberId, why: string): void {
    const { room } = hosted;
    if (room.replaceAway(id) === null) return;
    this.#announce(hosted, `${room.member(id)?.name} ${why} : un bot Facile joue à sa place`);
    this.#broadcastRoom(hosted);
    this.#broadcastSeats(hosted);
    this.#schedule(hosted);
  }

  /** Une ligne du système dans le tchat du salon. */
  #announce(hosted: HostedRoom, text: string): void {
    const line = hosted.room.say(null, text);
    this.#options.log(`[${hosted.room.name}] ${text}`);
    if (!line) return;
    for (const member of this.#members(hosted)) this.#send(member, { type: 'chat', lines: [line] });
  }

  /** Qui joue chaque place, à tout le salon (après un remplacement, un retour, un déplacement). */
  #broadcastSeats(hosted: HostedRoom): void {
    const session = hosted.room.session;
    if (!session) return;
    const seats = session.seatViews();
    for (const member of this.#members(hosted)) this.#send(member, { type: 'seats', seats });
  }

  /**
   * Sort du salon où l'on est. `isLeaving` : il part pour de bon (sinon, il est seulement
   * déconnecté, et retrouvera sa place en pleine partie).
   */
  #leaveRoom(connection: Connection, isLeaving = true): void {
    const hosted = connection.roomId === null ? undefined : this.#rooms.get(connection.roomId);
    connection.roomId = null;
    if (!hosted || connection.id === null) return;
    const id = connection.id;
    hosted.room.leave(id);
    if (isLeaving) this.#send(connection, { type: 'room', room: null });
    if (hosted.room.phase === 'playing' && hosted.room.seatOf(id) >= 0) {
      clearTimeout(hosted.awayTimers.get(id));
      hosted.awayTimers.set(
        id,
        setTimeout(() => {
          hosted.awayTimers.delete(id);
          if (hosted.room.member(id)?.isConnected === false) {
            this.#replaceAway(hosted, id, "s'est déconnecté");
          }
        }, this.#options.awayAfter ?? AWAY_AFTER),
      );
    }
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
      case 'chat': {
        const recent = connection.chats.filter((at) => now() - at < CHAT_WINDOW);
        connection.chats = recent;
        if (recent.length >= CHAT_BURST) {
          this.#refuse(connection, 'chatTooFast');
          return;
        }
        connection.chats.push(now());
        const line = room.say(id, message.text);
        if (!line) return;
        for (const member of this.#members(hosted)) {
          this.#send(member, { type: 'chat', lines: [line] });
        }
        return;
      }
      case 'resumeSave': {
        if (room.hostId !== id) {
          this.#refuse(connection, 'notHost');
          return;
        }
        const refused = this.#resume(hosted, id, message.slot);
        if (refused) this.#refuse(connection, refused);
        return;
      }
      case 'reclaimSeat':
        if (room.isAway(id)) this.#giveBack(hosted, id);
        return;
      case 'assignSeat': {
        const result = room.assignSeat(id, message.member, message.seat);
        if (!result.ok) {
          this.#refuse(connection, result.reason);
          return;
        }
        this.#announce(
          hosted,
          `${room.member(message.member)?.name} joue la place ${message.seat + 1}`,
        );
        this.#broadcastRoom(hosted);
        this.#broadcastSeats(hosted);
        // Sa vue de la partie change (une autre place) : il la reçoit en entier.
        const moved = this.#byId.get(message.member);
        const session = room.session;
        if (moved && session) {
          this.#send(moved, session.snapshot(room.viewerOf(message.member), now()));
        }
        this.#schedule(hosted);
        return;
      }
      case 'kick':
      case 'ban': {
        const name = room.member(message.member)?.name;
        const result = room.remove(id, message.member, message.type === 'ban');
        if (!result.ok) {
          this.#refuse(connection, result.reason);
          return;
        }
        const target = this.#byId.get(message.member);
        if (target && target.roomId === room.id) {
          target.roomId = null;
          this.#refuse(target, 'kicked');
          this.#send(target, { type: 'room', room: null });
        }
        this.#announce(
          hosted,
          `${name} ${message.type === 'ban' ? 'a été banni du salon' : 'a été sorti du salon'}`,
        );
        this.#broadcastRoom(hosted);
        this.#broadcastSeats(hosted);
        this.#broadcastRooms();
        this.#schedule(hosted);
        return;
      }
      case 'unban': {
        const result = room.unban(id, message.member);
        if (!result.ok) this.#refuse(connection, result.reason);
        else this.#broadcastRoom(hosted);
        return;
      }
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
    hosted.slot = this.#freeSlot();
    if (this.#options.saves && hosted.slot === null) {
      this.#announce(
        hosted,
        "Plus d'emplacement de sauvegarde libre : cette partie ne sera pas sauvegardée",
      );
    }
    this.#broadcastRoom(hosted);
    const session = room.session;
    if (!session) return;
    for (const member of this.#members(hosted)) {
      if (member.id === null) continue;
      const viewer = room.viewerOf(member.id);
      this.#send(member, session.snapshot(viewer, now()));
      this.#send(member, session.update(viewer, started.events, now()));
    }
    this.#persist(hosted);
    this.#schedule(hosted);
    this.#broadcastRooms();
  }

  /** Reprend une partie sauvegardée dans ce salon (l'hôte, ou le premier arrivé). */
  #resume(hosted: HostedRoom, by: MemberId, slot: number): ServerRefusal | null {
    const { room } = hosted;
    const game = this.#options.saves?.read(slot);
    if (!game) return 'noSave';
    if (this.#slotInUse(slot)) return 'alreadyPlaying';
    let result: ReturnType<Room['resume']>;
    try {
      result = room.resume(by, game.room, this.#board, now());
    } catch (error) {
      this.#options.log(`Sauvegarde ${slot} impossible à reprendre : ${String(error)}`);
      return 'noSave';
    }
    if (!result.ok) return result.reason;
    hosted.slot = slot;
    hosted.pendingSave = null;
    hosted.isRecapSent = false;
    this.#announce(hosted, `Partie reprise : manche ${game.room.session.state.round}`);
    this.#broadcastRoom(hosted);
    const session = room.session;
    if (session) {
      for (const member of this.#members(hosted)) {
        if (member.id !== null)
          this.#send(member, session.snapshot(room.viewerOf(member.id), now()));
      }
    }
    this.#schedule(hosted);
    this.#broadcastRooms();
    this.#broadcastSaves();
    return null;
  }

  /** Un emplacement libre (ni sauvegardé, ni pris par un salon en partie), ou null. */
  #freeSlot(): number | null {
    const saves = this.#options.saves;
    if (!saves) return null;
    const taken = new Set(saves.list().map((save) => save.slot));
    for (let slot = 1; slot <= saves.count; slot++) {
      if (!taken.has(slot) && !this.#slotInUse(slot)) return slot;
    }
    return null;
  }

  #slotInUse(slot: number): boolean {
    return [...this.#rooms.values()].some(
      (hosted) => hosted.slot === slot && hosted.room.phase === 'playing',
    );
  }

  /** Sauvegarde la partie du salon (après une étape résolue ; jamais en plein mini-jeu). */
  #persist(hosted: HostedRoom): void {
    const saves = this.#options.saves;
    const save = hosted.room.toSave();
    if (!saves || hosted.slot === null || !save) return;
    try {
      saves.write(hosted.slot, {
        version: SAVE_FILE_VERSION,
        savedAt: new Date().toISOString(),
        roomName: hosted.room.name,
        password: hosted.password,
        room: save,
      });
    } catch (error) {
      // Une sauvegarde ratée n'arrête pas la partie : on le note, la suivante réessaiera.
      this.#options.log(`Sauvegarde ratée (salon ${hosted.room.id}) : ${String(error)}`);
    }
  }

  /** Les parties sauvegardées, à ceux qui sont au salon (l'hôte peut en reprendre une). */
  #broadcastSaves(): void {
    const saves = this.#options.saves;
    if (!saves) return;
    const message = { type: 'saves', saves: saves.list(), slots: saves.count } as const;
    for (const hosted of this.#rooms.values()) {
      if (hosted.room.phase !== 'lobby') continue;
      for (const member of this.#members(hosted)) this.#send(member, message);
    }
  }

  #play(
    connection: Connection,
    hosted: HostedRoom,
    message: Extract<NetClientMessage, { type: 'intent' | 'arenaReady' | 'arenaInput' }>,
  ): void {
    const session = hosted.room.session;
    if (!session || connection.id === null) return;
    const viewer = hosted.room.viewerOf(connection.id);
    // Un spectateur ne joue pas ; un absent non plus (un bot joue sa place, il la reprend
    // d'abord).
    if (viewer.type !== 'player' || hosted.room.isAway(connection.id)) return;
    if (message.type === 'arenaInput') {
      session.arenaInput(viewer.playerId, message.input, message.seq);
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
    hosted.autoPlays.delete(viewer.playerId);
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
        if (hosted.room.session !== session) return;
        this.#watchPresence(hosted);
        this.#schedule(hosted);
      },
      Math.max(0, wake - now()),
    );
  }

  /**
   * Après une action automatique : un joueur joué d'office trop souvent de suite est remplacé par
   * un bot ; ceux revenus pendant un mini-jeu reprennent leur place s'il est fini.
   */
  #watchPresence(hosted: HostedRoom): void {
    const { room } = hosted;
    const session = room.session;
    if (!session) return;
    for (const player of session.takeAutoPlayed()) {
      const count = (hosted.autoPlays.get(player) ?? 0) + 1;
      hosted.autoPlays.set(player, count);
      const seats = room.view().seats;
      const member = seats.find((_, index) => seatPlayerId(index) === player)?.member;
      if (count >= AUTO_PLAYS_BEFORE_AWAY && member) {
        hosted.autoPlays.delete(player);
        this.#replaceAway(hosted, member, 'ne joue plus');
      }
    }
    if (!session.isPlayingArena) {
      for (const id of [...hosted.pendingReturns]) this.#giveBack(hosted, id);
    }
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
    this.#persist(hosted);
    if (session.isPlayingArena || hosted.isRecapSent) return;
    const recap = session.recapMessage();
    if (recap?.type !== 'recap') return;
    hosted.isRecapSent = true;
    for (const member of this.#members(hosted)) this.#send(member, recap);
    clearTimeout(hosted.timer);
    room.finishGame();
    // Finie : son emplacement de sauvegarde se libère.
    if (hosted.slot !== null) this.#options.saves?.remove(hosted.slot);
    hosted.slot = null;
    this.#options.log(`Partie finie dans le salon "${room.name}" (${room.id})`);
    this.#broadcastRoom(hosted);
    this.#broadcastRooms();
    this.#broadcastSaves();
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

/** Où en est la partie d'un salon, pour le tableau de bord ; null au salon. */
function stepOf(room: Room): string | null {
  const session = room.session;
  if (!session) return null;
  const arena = session.arenaMessage({ type: 'spectator' }, now());
  if (arena.type === 'arena' && arena.run) {
    return `${MINIGAME_NAMES[arena.run.minigame]} (${STAGE_NAMES[arena.run.stage]})`;
  }
  const snapshot = session.snapshot({ type: 'spectator' }, now());
  if (snapshot.type !== 'snapshot') return null;
  const actor = whoMustAct(snapshot.state);
  const name =
    actor?.type === 'player'
      ? snapshot.state.players.find((player) => player.id === actor.playerId)?.name
      : null;
  return name ? `Au tour de ${name}` : `Plateau (${snapshot.state.phase.type})`;
}

const STAGE_NAMES: Record<ArenaStage, string> = {
  intro: 'présentation',
  countdown: 'décompte',
  play: 'en jeu',
  reveal: 'révélation',
  result: 'résultat',
};

function roomCode(): string {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
    code += ROOM_CODE_LETTERS[Math.floor(Math.random() * ROOM_CODE_LETTERS.length)];
  }
  return code;
}
