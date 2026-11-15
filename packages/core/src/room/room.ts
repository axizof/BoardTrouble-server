import type { Board } from '../board/board';
import type { BotLevel } from '../bots/boardBot';
import type { TableSize } from '../dice/dice';
import type { ChaosLevel, GameEvent, PlayerId } from '../game/types';
import type { Viewer } from '../game/views';
import { botAppearance, botCharacters, CHARACTER_NAMES } from '../lobby/bots';
import type { Appearance } from '../lobby/players';
import { Rng } from '../random/rng';
import { GameSession, type Seat } from '../session/session';

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

/** Les temps pour décider proposés à l'hôte (ms). */
export const DECISION_TIMES = [60_000, 90_000, 120_000, 180_000] as const;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  tableSize: 4,
  chaos: 'normal',
  decisionTime: 90_000,
  textSpeed: 'normal',
  tips: true,
};

/** Une place de la table : le membre qui la joue, sinon un bot de ce niveau. */
export type RoomSeat = { member: MemberId | null; botLevel: BotLevel };

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

/** Un salon accueille au plus tant de monde (joueurs et spectateurs). */
export const ROOM_MEMBERS_MAX = 12;

export type RoomRefusal =
  | 'notHost'
  | 'notInRoom'
  | 'roomFull'
  | 'nameTaken'
  | 'alreadyPlaying'
  | 'notInLobby'
  | 'tableTooSmall'
  | 'noHuman'
  | 'badSeat';

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
  #session: GameSession | null = null;

  constructor(id: string, name: string, hasPassword: boolean) {
    this.id = id;
    this.name = name;
    this.hasPassword = hasPassword;
    this.#seats = Array.from({ length: this.#settings.tableSize }, () => ({
      member: null,
      botLevel: 'normal',
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
    if (this.#phase !== 'lobby') return refuse('notInLobby');
    const humans = this.#seats.filter((seat) => seat.member !== null);
    if (humans.length > settings.tableSize) return refuse('tableTooSmall');
    // Les humains se tassent au début de la table, les bots gardent leur niveau.
    const kept = [...humans, ...this.#seats.filter((seat) => seat.member === null)];
    this.#seats = Array.from(
      { length: settings.tableSize },
      (_, index) => kept[index] ?? { member: null, botLevel: 'normal' },
    );
    this.#settings = { ...settings };
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
      { decisionTime: this.#settings.decisionTime },
      now,
    );
    this.#session = created.session;
    this.#phase = 'playing';
    return { ok: true, events: created.events };
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
