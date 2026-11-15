import type { BotLevel } from '../bots/boardBot';
import type { Intent } from '../game/types';
import { type Appearance, checkNickname, readAppearance } from '../lobby/players';
import { sanitizeInput } from '../minigames/arena/arena';
import type { ClientMessage, HostMessage } from '../session/protocol';
import {
  CHAT_MAX,
  type ChatLine,
  DECISION_TIMES,
  type MemberId,
  type RoomRefusal,
  type RoomSettings,
  type RoomSummary,
  type RoomTextSpeed,
  type RoomView,
} from './room';

// Les messages d'un client avec un serveur de jeu (01-architecture.md, section 5) : se
// présenter, voir et rejoindre les salons, régler le sien ; puis, en partie, ceux du protocole
// de jeu (le même qu'en solo). Tout ce qui arrive d'un client est relu ici, champ par champ :
// un message inconnu, mal formé ou trop grand est ignoré.

/** Ce que le client garde dans son navigateur pour être reconnu (01-architecture.md, section 7). */
export type Identity = { id: string; secret: string };

export type Profile = { name: string; appearance: Appearance };

/** Une partie sauvegardée sur le serveur, telle que l'hôte la voit au salon pour la reprendre. */
export type SaveSummary = {
  slot: number;
  roomName: string;
  /** Date de la sauvegarde (ISO). */
  savedAt: string;
  round: number;
  players: string[];
};

export type RoomClientMessage =
  /** `auth` : le jeton de la connexion Discord (l'API centrale), s'il y en a une. */
  | {
      type: 'hello';
      protocol: number;
      version: string;
      identity: Identity;
      profile: Profile;
      auth?: string;
    }
  | { type: 'listRooms' }
  | { type: 'createRoom'; name: string; password: string | null }
  | { type: 'joinRoom'; roomId: string; password: string | null }
  | { type: 'leaveRoom' }
  | { type: 'setProfile'; profile: Profile }
  | { type: 'setSettings'; settings: RoomSettings }
  | { type: 'setBotLevel'; seat: number; level: BotLevel }
  | { type: 'startGame' }
  | { type: 'chat'; text: string }
  /** Revenir à sa place, que jouait un bot pendant son absence. */
  | { type: 'reclaimSeat' }
  /** L'hôte : placer un membre sur la place d'un bot, le sortir du salon, le bannir, le débannir. */
  | { type: 'assignSeat'; member: string; seat: number }
  | { type: 'kick'; member: string }
  | { type: 'ban'; member: string }
  | { type: 'unban'; member: string }
  /** L'hôte, au salon : reprendre la partie sauvegardée de cet emplacement. */
  | { type: 'resumeSave'; slot: number }
  /** L'hôte, au salon : supprime une partie sauvegardée (libère son emplacement). */
  | { type: 'deleteSave'; slot: number }
  /** L'hôte, en partie : l'arrête pour tout le monde, sauvegardée. */
  | { type: 'stopGame' }
  /** La réponse au `ping` du serveur (il mesure ainsi la latence de chacun). */
  | { type: 'pong'; id: number };

/** Pourquoi le serveur refuse : la connexion, ou une demande dans le salon. */
export type ServerRefusal =
  | RoomRefusal
  | 'version'
  | 'identity'
  | 'badName'
  | 'badPassword'
  | 'tooManyTries'
  | 'noRoom'
  | 'tooManyRooms'
  | 'notReady'
  | 'chatTooFast'
  /** La sauvegarde à reprendre n'existe plus, ou elle est illisible. */
  | 'noSave'
  /** Arrêter la partie : aucun emplacement de sauvegarde libre pour la garder. */
  | 'noSaveSlot'
  /** On t'a sorti du salon (ou banni). */
  | 'kicked';

export type RoomHostMessage =
  /**
   * La réponse au `hello` : le serveur, sa version, ses salons ; `memberId` : qui l'on est ici
   * (l'identifiant du navigateur, ou `discord-...` si le serveur a reconnu le jeton Discord) ;
   * `roomId` : le salon où l'on revient (une partie en cours qui garde sa place), ou null (après
   * un redémarrage du serveur, la partie affichée n'existe plus).
   */
  | {
      type: 'welcome';
      serverName: string;
      version: string;
      rooms: RoomSummary[];
      memberId: MemberId;
      roomId: string | null;
    }
  | { type: 'rooms'; rooms: RoomSummary[] }
  /** Le salon où l'on est (à chaque changement), ou null quand on en sort. */
  | { type: 'room'; room: RoomView | null }
  | { type: 'refused'; reason: ServerRefusal; version?: string }
  /** Des lignes du tchat : les dernières en arrivant, puis chaque nouvelle. */
  | { type: 'chat'; lines: ChatLine[] }
  /** Le serveur mesure la latence : le client répond `pong` avec le même numéro. */
  | { type: 'ping'; id: number }
  /** Au salon : les parties sauvegardées du serveur (l'hôte peut en reprendre une). */
  | { type: 'saves'; saves: SaveSummary[]; slots: number }
  /** L'hôte a arrêté la partie (sauvegardée) : chacun revient au salon. */
  | { type: 'gameStopped' };

/** Tout ce qu'un client peut envoyer à un serveur, et tout ce qu'il peut en recevoir. */
export type NetClientMessage = RoomClientMessage | ClientMessage;
export type NetHostMessage = RoomHostMessage | HostMessage;

/** Un message plus long que ça (caractères JSON) est refusé sans être lu. */
export const NET_MESSAGE_MAX = 16_000;
export const ROOM_NAME_MAX = 24;
export const ROOM_PASSWORD_MAX = 64;
const IDENTITY_ID = /^[A-Za-z0-9_-]{16,64}$/;
const IDENTITY_SECRET = /^[A-Za-z0-9_-]{32,128}$/;
/** Un jeton Discord : deux morceaux en base64url (sa charge est courte). */
const AUTH_TOKEN = /^[A-Za-z0-9_-]{1,1500}\.[A-Za-z0-9_-]{86}$/;
/**
 * L'identifiant d'un joueur connecté avec Discord, le même dans tous ses navigateurs. Un
 * navigateur ne peut pas se présenter sous un identifiant qui commence ainsi (le serveur le
 * refuse sans jeton valable) : `isDiscordMember` suffit à dire qui est passé par Discord.
 */
export const DISCORD_MEMBER_PREFIX = 'discord-';

export function isDiscordMember(id: MemberId): boolean {
  return id.startsWith(DISCORD_MEMBER_PREFIX);
}
const ROOM_ID = /^[A-Za-z0-9]{4,16}$/;
const TEXT_SPEEDS: readonly RoomTextSpeed[] = ['slow', 'normal', 'fast', 'instant'];
const BOT_LEVELS: readonly BotLevel[] = ['easy', 'normal', 'expert'];

/**
 * Le nom d'un salon : comme un pseudo (lettres, chiffres, espaces, quelques signes), jusqu'à
 * ROOM_NAME_MAX caractères.
 */
export function checkRoomName(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > ROOM_NAME_MAX * 8) return null;
  const name = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  if (length < 3 || length > ROOM_NAME_MAX) return null;
  return /^[\p{L}\p{N} _'.!-]+$/u.test(name) ? name : null;
}

/** Relit un message reçu d'un client ; null s'il est invalide. */
export function parseNetMessage(text: string): NetClientMessage | null {
  if (text.length > NET_MESSAGE_MAX) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Pas du JSON : le message est ignoré comme tout message invalide (null).
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  switch (data.type) {
    case 'hello':
      return readHello(data);
    case 'listRooms':
    case 'leaveRoom':
    case 'startGame':
    case 'stopGame':
    case 'arenaReady':
    case 'reclaimSeat':
      return { type: data.type };
    case 'chat': {
      const text = readChat(data.text);
      return text === null ? null : { type: 'chat', text };
    }
    case 'assignSeat':
      return isMemberId(data.member) && Number.isInteger(data.seat)
        ? { type: 'assignSeat', member: data.member, seat: data.seat as number }
        : null;
    case 'resumeSave':
    case 'deleteSave':
      return Number.isInteger(data.slot) ? { type: data.type, slot: data.slot as number } : null;

    case 'pong':
      return Number.isSafeInteger(data.id) ? { type: 'pong', id: data.id as number } : null;
    case 'kick':
    case 'ban':
    case 'unban':
      return isMemberId(data.member) ? { type: data.type, member: data.member } : null;
    case 'createRoom': {
      const name = checkRoomName(data.name);
      const password = readPassword(data.password);
      return name === null || password === undefined
        ? null
        : { type: 'createRoom', name, password };
    }
    case 'joinRoom': {
      const password = readPassword(data.password);
      if (typeof data.roomId !== 'string' || !ROOM_ID.test(data.roomId)) return null;
      return password === undefined ? null : { type: 'joinRoom', roomId: data.roomId, password };
    }
    case 'setProfile': {
      const profile = readProfile(data.profile);
      return profile ? { type: 'setProfile', profile } : null;
    }
    case 'setSettings': {
      const settings = readRoomSettings(data.settings);
      return settings ? { type: 'setSettings', settings } : null;
    }
    case 'setBotLevel': {
      const level = BOT_LEVELS.find((one) => one === data.level);
      if (!level || !Number.isInteger(data.seat)) return null;
      return { type: 'setBotLevel', seat: data.seat as number, level };
    }
    case 'arenaInput':
      return Number.isSafeInteger(data.seq) && (data.seq as number) >= 0
        ? { type: 'arenaInput', input: sanitizeInput(data.input), seq: data.seq as number }
        : null;
    case 'intent':
      // L'intention est validée par le moteur (droit d'agir, choix possibles) ; ici, sa forme.
      return typeof data.intent === 'object' &&
        data.intent !== null &&
        typeof (data.intent as Record<string, unknown>).type === 'string'
        ? { type: 'intent', intent: data.intent as Intent }
        : null;
    default:
      return null;
  }
}

function readHello(data: Record<string, unknown>): NetClientMessage | null {
  const identity = data.identity as Record<string, unknown> | null | undefined;
  const profile = readProfile(data.profile);
  if (
    typeof data.protocol !== 'number' ||
    typeof data.version !== 'string' ||
    data.version.length > 32 ||
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity.id !== 'string' ||
    typeof identity.secret !== 'string' ||
    !IDENTITY_ID.test(identity.id) ||
    !IDENTITY_SECRET.test(identity.secret) ||
    !profile ||
    (data.auth !== undefined && (typeof data.auth !== 'string' || !AUTH_TOKEN.test(data.auth)))
  ) {
    return null;
  }
  return {
    type: 'hello',
    protocol: data.protocol,
    version: data.version,
    identity: { id: identity.id, secret: identity.secret },
    profile,
    ...(data.auth === undefined ? {} : { auth: data.auth }),
  };
}

function isMemberId(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_ID.test(value);
}

/** Une ligne de tchat : sans caractère de contrôle ni espace en trop, 1 à CHAT_MAX caractères. */
function readChat(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CHAT_MAX * 4) return null;
  const text = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
  const length = [...text].length;
  return length === 0 || length > CHAT_MAX ? null : text;
}

function readProfile(value: unknown): Profile | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  const name = checkNickname(data.name);
  const appearance = readAppearance(data.appearance);
  return name.ok && appearance ? { name: name.nickname, appearance } : null;
}

/** Un mot de passe (texte non vide), ou null pour aucun ; undefined s'il est invalide. */
function readPassword(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > ROOM_PASSWORD_MAX) return undefined;
  return value;
}

/** Relit des réglages de salon (un client, un preset du tableau de bord) ; null s'ils sont invalides. */
export function readRoomSettings(value: unknown): RoomSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  const tableSize = data.tableSize === 4 || data.tableSize === 6 ? data.tableSize : null;
  const chaos =
    data.chaos === 'calm' || data.chaos === 'normal' || data.chaos === 'trouble'
      ? data.chaos
      : null;
  const decisionTime = DECISION_TIMES.find((time) => time === data.decisionTime);
  const textSpeed = TEXT_SPEEDS.find((speed) => speed === data.textSpeed);
  if (!tableSize || !chaos || !decisionTime || !textSpeed || typeof data.tips !== 'boolean') {
    return null;
  }
  return { tableSize, chaos, decisionTime, textSpeed, tips: data.tips };
}
