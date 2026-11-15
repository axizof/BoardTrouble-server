import type { Board } from '../board/board';
import type { BotLevel } from '../bots/boardBot';
import type { TableSize } from '../dice/dice';
import type { ChaosLevel, GameEvent, PlayerId } from '../game/types';
import type { Viewer } from '../game/views';
import { botAppearance, botCharacters, CHARACTER_NAMES } from '../lobby/bots';
import type { Appearance } from '../lobby/players';
import { Rng } from '../random/rng';
import { GameSession, type Seat, type SessionSave } from '../session/session';

// Un salon du serveur (01-architecture.md, section 7) : ses membres, sa table (une place par
// joueur : un humain ou un bot), son hôte et ses réglages, puis la partie qu'il lance. Pur et sans
// horloge, comme la session : le serveur s'occupe du réseau, des mots de passe et des minuteurs.

/** L'identifiant public d'un joueur (gardé dans son navigateur avec un secret). */
export type MemberId = string;

export type RoomTextSpeed = 'slow' | 'normal' | 'fast' | 'instant';

/**
 * Les réglages de l'hôte. La vitesse du texte et les conseils du Plateau sont ceux du salon
 * pour tout le monde (en multi, ceux des options de chacun ne comptent pas).
 */
export type RoomSettings = {
  tableSize: TableSize;
  chaos: ChaosLevel;
  /** Temps pour décider (ms) : large, chacun doit avoir le temps de lire. */
  decisionTime: number;
  textSpeed: RoomTextSpeed;
  tips: boolean;
};

/** En multi, la présentation d'un mini-jeu se lance seule au bout de tant (ms). */
export const ROOM_ARENA_INTRO = 60_000;

/** Les temps pour décider proposés à l'hôte (ms). */
export const DECISION_TIMES = [60_000, 90_000, 120_000, 180_000] as const;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  tableSize: 4,
  chaos: 'normal',
  decisionTime: 90_000,
  textSpeed: 'normal',
  tips: true,
};

/**
 * Une place de la table : le membre qui la joue, sinon un bot de ce niveau. `isAway` : en
 * partie, son membre est absent et un bot Facile joue pour lui (il seul peut la reprendre).
 */
export type RoomSeat = { member: MemberId | null; botLevel: BotLevel; isAway: boolean };

/** Un absent est remplacé par un bot de ce niveau : plus fort, il jouerait mieux que lui. */
export const AWAY_BOT: BotLevel = 'easy';

/** Une ligne du tchat : d'un membre, ou du système (`from` null : un absent remplacé...). */
export type ChatLine = { id: number; from: MemberId | null; name: string; text: string };

/** Le tchat garde tant de lignes (ce que voit qui arrive). */
const CHAT_KEPT = 50;
/** Une ligne de tchat fait au plus tant de caractères. */
export const CHAT_MAX = 200;

export type RoomMember = {
  id: MemberId;
  name: string;
  appearance: Appearance;
  isConnected: boolean;
};

export type RoomPhase = 'lobby' | 'playing';

/** Ce que chaque membre voit du salon. */
export type RoomView = {
  id: string;
  name: string;
  hasPassword: boolean;
  hostId: MemberId | null;
  phase: RoomPhase;
  settings: RoomSettings;
  seats: RoomSeat[];
  members: RoomMember[];
  /** Les bannis du salon (l'hôte peut les débannir). */
  banned: { id: MemberId; name: string }[];
};

/** Ce que la liste des salons d'un serveur en montre. */
export type RoomSummary = {
  id: string;
  name: string;
  hasPassword: boolean;
  humans: number;
  tableSize: TableSize;
  phase: RoomPhase;
};

/** Version du format de sauvegarde d'un salon : une autre version n'est pas chargée. */
export const ROOM_SAVE_VERSION = 1;

/**
 * La partie d'un salon, sauvegardée (01-architecture.md, section 9) : ses réglages, sa table
 * (qui est à quelle place), ses joueurs (pour leur réserver leur place à la reprise) et la partie.
 */
export type RoomSave = {
  version: typeof ROOM_SAVE_VERSION;
  settings: RoomSettings;
  seats: RoomSeat[];
  members: { id: MemberId; name: string; appearance: Appearance }[];
  session: SessionSave;
};

/** Un salon accueille au plus tant de monde (joueurs et spectateurs). */
export const ROOM_MEMBERS_MAX = 12;

export type RoomRefusal =
  | 'notHost'
  | 'notInRoom'
  | 'roomFull'
  | 'nameTaken'
  | 'alreadyPlaying'
  | 'notPlaying'
  | 'notInLobby'
  | 'tableTooSmall'
  | 'noHuman'
  | 'badSeat'
  | 'banned'
  | 'notAway'
  | 'seatTaken';

export type RoomResult = { ok: true } | { ok: false; reason: RoomRefusal };

const OK: RoomResult = { ok: true };
const refuse = (reason: RoomRefusal): RoomResult => ({ ok: false, reason });

export class Room {
  readonly id: string;
  readonly name: string;
  readonly hasPassword: boolean;
  #hostId: MemberId | null = null;
  #phase: RoomPhase = 'lobby';
  #settings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS };
  #seats: RoomSeat[];
  readonly #members = new Map<MemberId, RoomMember>();
  readonly #banned = new Map<MemberId, string>();
  #chat: ChatLine[] = [];
  #chatId = 0;
  #session: GameSession | null = null;

  constructor(id: string, name: string, hasPassword: boolean) {
    this.id = id;
    this.name = name;
    this.hasPassword = hasPassword;
    this.#seats = Array.from({ length: this.#settings.tableSize }, () => ({
      member: null,
      botLevel: 'normal',
      isAway: false,
    }));
  }

  get hostId(): MemberId | null {
    return this.#hostId;
  }

  get phase(): RoomPhase {
    return this.#phase;
  }

  get settings(): RoomSettings {
    return this.#settings;
  }

  get session(): GameSession | null {
    return this.#session;
  }

  get isEmpty(): boolean {
    return this.#members.size === 0;
  }

  /** Les membres connectés en ce moment. */
  get connected(): RoomMember[] {
    return [...this.#members.values()].filter((member) => member.isConnected);
  }

  member(id: MemberId): RoomMember | undefined {
    return this.#members.get(id);
  }

  /**
   * Un membre arrive : il prend la première place libre de la table (pendant le salon), sinon
   * il regarde. Le premier arrivé est l'hôte. Un membre déjà là (reconnexion) reprend sa place.
   */
  join(member: Omit<RoomMember, 'isConnected'>): RoomResult {
    const known = this.#members.get(member.id);
    if (known) {
      known.isConnected = true;
      if (this.#hostId === null) this.#hostId = member.id;
      return OK;
    }
    if (this.#banned.has(member.id)) return refuse('banned');
    if (this.#members.size >= ROOM_MEMBERS_MAX) return refuse('roomFull');
    if (this.#isNameTaken(member.name, member.id)) return refuse('nameTaken');
    this.#members.set(member.id, { ...member, isConnected: true });
    if (this.#hostId === null) this.#hostId = member.id;
    if (this.#phase === 'lobby') {
      const free = this.#seats.find((seat) => seat.member === null);
      if (free) free.member = member.id;
    }
    return OK;
  }

  /**
   * Un membre s'en va. Pendant le salon, il libère sa place et le salon l'oublie ; pendant la
   * partie, il reste (déconnecté) : sa place l'attend. Parti, l'hôte passe au membre connecté
   * suivant.
   */
  leave(id: MemberId): void {
    const member = this.#members.get(id);
    if (!member) return;
    if (this.#phase === 'lobby') {
      this.#members.delete(id);
      for (const seat of this.#seats) if (seat.member === id) seat.member = null;
    } else {
      member.isConnected = false;
    }
    if (this.#hostId === id) this.#hostId = this.connected[0]?.id ?? null;
  }

  /** Un membre change son pseudo ou son apparence (pendant le salon). */
  setProfile(id: MemberId, name: string, appearance: Appearance): RoomResult {
    const member = this.#members.get(id);
    if (!member) return refuse('notInRoom');
    if (this.#phase !== 'lobby') return refuse('notInLobby');
    if (this.#isNameTaken(name, id)) return refuse('nameTaken');
    member.name = name;
    member.appearance = appearance;
    return OK;
  }

  /** L'hôte change les réglages ; la table ne rétrécit pas sous les humains assis. */
  setSettings(by: MemberId, settings: RoomSettings): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    return this.configure(settings);
  }

  /**
   * Règle le salon (les réglages, et le niveau des bots s'il est donné) : l'hôte, ou le tableau
   * de bord du serveur pour un salon qu'il crée. Pendant le salon seulement.
   */
  configure(settings: RoomSettings, botLevels?: readonly BotLevel[]): RoomResult {
    if (this.#phase !== 'lobby') return refuse('notInLobby');
    const humans = this.#seats.filter((seat) => seat.member !== null);
    if (humans.length > settings.tableSize) return refuse('tableTooSmall');
    // Les humains se tassent au début de la table, les bots gardent leur niveau.
    const kept = [...humans, ...this.#seats.filter((seat) => seat.member === null)];
    this.#seats = Array.from(
      { length: settings.tableSize },
      (_, index) => kept[index] ?? { member: null, botLevel: 'normal', isAway: false },
    );
    this.#settings = { ...settings };
    if (botLevels) {
      this.#seats.forEach((seat, index) => {
        seat.botLevel = botLevels[index] ?? seat.botLevel;
      });
    }
    return OK;
  }

  /** L'hôte règle le niveau du bot d'une place libre. */
  setBotLevel(by: MemberId, seatIndex: number, level: BotLevel): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    if (this.#phase !== 'lobby') return refuse('notInLobby');
    const seat = this.#seats[seatIndex];
    if (!seat) return refuse('badSeat');
    seat.botLevel = level;
    return OK;
  }

  /**
   * L'hôte lance la partie : une place par joueur (`p1`, `p2`...), les humains avec leur
   * pseudo et leur apparence, les bots avec un animal libre, son nom et une tenue au hasard.
   */
  start(
    by: MemberId,
    board: Board,
    seed: number,
    now: number,
  ): { ok: true; events: GameEvent[] } | { ok: false; reason: RoomRefusal } {
    if (by !== this.#hostId) return { ok: false, reason: 'notHost' };
    if (this.#phase !== 'lobby') return { ok: false, reason: 'alreadyPlaying' };
    const humans = this.#seats.flatMap((seat) => (seat.member ? [seat.member] : []));
    if (humans.length === 0) return { ok: false, reason: 'noHuman' };
    const rng = new Rng(seed);
    const taken = humans.flatMap((id) => {
      const member = this.#members.get(id);
      return member ? [member.appearance.character] : [];
    });
    const botCount = this.#seats.length - humans.length;
    const characters = botCharacters(taken, botCount, rng);
    const players: { id: PlayerId; name: string }[] = [];
    const seats: Record<PlayerId, Seat> = {};
    let nextBot = 0;
    this.#seats.forEach((seat, index) => {
      const id = seatPlayerId(index);
      const member = seat.member ? this.#members.get(seat.member) : undefined;
      if (member) {
        players.push({ id, name: member.name });
        seats[id] = { control: 'human', appearance: member.appearance };
        return;
      }
      const character = characters[nextBot++] ?? 'fox';
      players.push({ id, name: CHARACTER_NAMES[character] });
      seats[id] = { control: seat.botLevel, appearance: botAppearance(character, rng) };
    });
    const created = GameSession.create(
      board,
      { players, tableSize: this.#settings.tableSize, seed, chaos: this.#settings.chaos },
      seats,
      { decisionTime: this.#settings.decisionTime, arenaIntroTime: ROOM_ARENA_INTRO },
      now,
    );
    this.#session = created.session;
    this.#phase = 'playing';
    return { ok: true, events: created.events };
  }

  /**
   * La partie est finie : retour au salon pour la suivante, avec les mêmes réglages. Ceux qui
   * sont partis pendant la partie quittent le salon et leur place redevient un bot.
   */
  finishGame(): void {
    if (this.#phase !== 'playing') return;
    this.#phase = 'lobby';
    this.#session = null;
    for (const seat of this.#seats) seat.isAway = false;
    for (const member of [...this.#members.values()]) {
      if (!member.isConnected) this.leave(member.id);
    }
  }

  /**
   * L'hôte arrête la partie pour tout le monde : retour au salon. Le serveur la garde (sa
   * dernière sauvegarde), à reprendre plus tard.
   */
  stopGame(by: MemberId): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    if (this.#phase !== 'playing') return refuse('notPlaying');
    this.finishGame();
    return OK;
  }

  /** La partie en cours, à sauvegarder (pas en plein mini-jeu : null), ou null sans partie. */
  toSave(): RoomSave | null {
    const session = this.#session;
    if (!session || session.isPlayingArena || session.isFinished) return null;
    const seated = new Set(this.#seats.flatMap((seat) => (seat.member ? [seat.member] : [])));
    return {
      version: ROOM_SAVE_VERSION,
      settings: { ...this.#settings },
      seats: this.#seats.map((seat) => ({ ...seat })),
      members: [...this.#members.values()]
        .filter((member) => seated.has(member.id))
        .map(({ id, name, appearance }) => ({ id, name, appearance })),
      session: session.toSave(),
    };
  }

  /**
   * L'hôte reprend une partie sauvegardée (au salon) : ses réglages, sa table, sa partie. Chaque
   * place reste à son joueur d'origine (reconnu à son identifiant) : présent, il la joue ;
   * absent, un bot Facile la joue jusqu'à son arrivée. Les membres présents sans place regardent
   * (l'hôte peut leur donner celle d'un bot). Lève une erreur si la sauvegarde est illisible.
   */
  resume(by: MemberId, save: RoomSave, board: Board, now: number): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    if (this.#phase !== 'lobby') return refuse('alreadyPlaying');
    if (save.version !== ROOM_SAVE_VERSION)
      throw new Error(`Salon d'une autre version (${save.version})`);
    const session = GameSession.restore(board, save.session, now);
    for (const member of save.members) {
      if (!this.#members.has(member.id))
        this.#members.set(member.id, { ...member, isConnected: false });
    }
    this.#settings = { ...save.settings };
    this.#seats = save.seats.map((seat) => ({ ...seat, isAway: false }));
    this.#seats.forEach((seat, index) => {
      const owner = seat.member ? this.#members.get(seat.member) : undefined;
      if (seat.member && !owner?.isConnected) {
        seat.isAway = true;
        session.setControl(seatPlayerId(index), AWAY_BOT);
      } else if (owner) {
        session.setControl(seatPlayerId(index), 'human');
      }
    });
    this.#session = session;
    this.#phase = 'playing';
    return OK;
  }

  /** L'index de la place de ce membre, ou -1. */
  seatOf(id: MemberId): number {
    return this.#seats.findIndex((seat) => seat.member === id);
  }

  /** Ce membre a une place, et un bot la joue pour lui (absent). */
  isAway(id: MemberId): boolean {
    return this.#seats[this.seatOf(id)]?.isAway === true;
  }

  /**
   * Le membre est absent (déconnecté trop longtemps, ou joué d'office deux fois de suite) : un
   * bot Facile prend sa place, qu'il reprendra en revenant. Rend sa place dans la partie.
   */
  replaceAway(id: MemberId): PlayerId | null {
    const index = this.seatOf(id);
    const seat = this.#seats[index];
    if (!seat || seat.isAway || !this.#session) return null;
    seat.isAway = true;
    this.#session.setControl(seatPlayerId(index), AWAY_BOT);
    return seatPlayerId(index);
  }

  /** Le membre revient : il reprend sa place (la sienne seulement), que jouait un bot. */
  reclaim(id: MemberId): RoomResult {
    const index = this.seatOf(id);
    const seat = this.#seats[index];
    if (!seat || !this.#session) return refuse('notInRoom');
    if (!seat.isAway) return refuse('notAway');
    seat.isAway = false;
    this.#session.setControl(seatPlayerId(index), 'human');
    return OK;
  }

  /**
   * L'hôte place un membre (un spectateur arrivé en cours de partie, un joueur qu'il déplace) sur
   * la place d'un bot. En partie, la place prend son pseudo ; sa place d'avant redevient un bot.
   */
  assignSeat(by: MemberId, id: MemberId, seatIndex: number): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    const member = this.#members.get(id);
    const target = this.#seats[seatIndex];
    if (!member) return refuse('notInRoom');
    if (!target) return refuse('badSeat');
    if (target.member !== null) return refuse('seatTaken');
    const before = this.seatOf(id);
    const left = this.#seats[before];
    if (left) {
      Object.assign(left, { member: null, isAway: false, botLevel: AWAY_BOT });
      this.#session?.setControl(seatPlayerId(before), AWAY_BOT);
    }
    Object.assign(target, { member: id, isAway: false });
    if (this.#session) {
      this.#session.setControl(seatPlayerId(seatIndex), 'human');
      this.#session.renamePlayer(seatPlayerId(seatIndex), member.name);
    }
    return OK;
  }

  /**
   * L'hôte sort un membre du salon (il peut revenir) ; `isBanned` : il ne peut plus revenir. En
   * partie, sa place devient un bot.
   */
  remove(by: MemberId, id: MemberId, isBanned: boolean): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    if (id === by) return refuse('notInRoom');
    return this.expel(id, isBanned);
  }

  /**
   * Sort un membre du salon (l'hôte, ou le tableau de bord du serveur) ; en partie, sa place
   * devient un bot. Parti, l'hôte passe au membre connecté suivant.
   */
  expel(id: MemberId, isBanned: boolean): RoomResult {
    const member = this.#members.get(id);
    if (!member) return refuse('notInRoom');
    if (isBanned) this.#banned.set(id, member.name);
    const index = this.seatOf(id);
    const seat = this.#seats[index];
    if (seat) {
      Object.assign(seat, { member: null, isAway: false });
      if (this.#session) {
        seat.botLevel = AWAY_BOT;
        this.#session.setControl(seatPlayerId(index), AWAY_BOT);
      }
    }
    this.#members.delete(id);
    if (this.#hostId === id) this.#hostId = this.connected[0]?.id ?? null;
    return OK;
  }

  unban(by: MemberId, id: MemberId): RoomResult {
    if (by !== this.#hostId) return refuse('notHost');
    this.#banned.delete(id);
    return OK;
  }

  /** Une ligne du tchat : d'un membre (`from`), ou du système (null). Rend la ligne. */
  say(from: MemberId | null, text: string): ChatLine | null {
    const name = from === null ? '' : this.#members.get(from)?.name;
    if (name === undefined) return null;
    const line = { id: ++this.#chatId, from, name, text: text.slice(0, CHAT_MAX) };
    this.#chat = [...this.#chat.slice(1 - CHAT_KEPT), line];
    return line;
  }

  /** Les dernières lignes du tchat (pour qui arrive). */
  get chat(): readonly ChatLine[] {
    return this.#chat;
  }

  /** Ce que la partie montre à ce membre : sa place s'il en a une, sinon la vue spectateur. */
  viewerOf(id: MemberId): Viewer {
    const index = this.#seats.findIndex((seat) => seat.member === id);
    return index < 0 || this.#phase !== 'playing'
      ? { type: 'spectator' }
      : { type: 'player', playerId: seatPlayerId(index) };
  }

  view(): RoomView {
    return {
      id: this.id,
      name: this.name,
      hasPassword: this.hasPassword,
      hostId: this.#hostId,
      phase: this.#phase,
      settings: { ...this.#settings },
      seats: this.#seats.map((seat) => ({ ...seat })),
      members: [...this.#members.values()].map((member) => ({ ...member })),
      banned: [...this.#banned].map(([id, name]) => ({ id, name })),
    };
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      hasPassword: this.hasPassword,
      humans: this.#seats.filter((seat) => seat.member !== null).length,
      tableSize: this.#settings.tableSize,
      phase: this.#phase,
    };
  }

  #isNameTaken(name: string, except: MemberId): boolean {
    const wanted = name.toLocaleLowerCase('fr');
    return [...this.#members.values()].some(
      (member) => member.id !== except && member.name.toLocaleLowerCase('fr') === wanted,
    );
  }
}

/** La place `index` de la table, comme joueur de la partie. */
export function seatPlayerId(index: number): PlayerId {
  return `p${index + 1}`;
}
