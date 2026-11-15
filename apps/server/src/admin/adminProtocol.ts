import type { BotLevel, RoomSettings } from '@board-trouble/core';
import type { AdminPlayer, AdminRoom, AdminSave } from '../gameServer';
import type { AvailableUpdate } from '../updates';
import type { SystemStats } from './systemStats';

// Les messages entre la page du tableau de bord et le serveur (`/admin/ws`). Partagés par les
// deux côtés : ni le serveur ni la page ne peuvent diverger.

/** Des réglages de salon tout prêts, pour en créer un d'un clic. */
export type Preset = { name: string; settings: RoomSettings; botLevels: BotLevel[] };

export type AdminState = {
  server: {
    name: string;
    version: string;
    port: number;
    addresses: string[];
    /** Depuis quand il tourne (horloge du serveur, ms). */
    uptime: number;
    stats: SystemStats;
    /** Une version plus récente publiée, ou null ; `canApply` : un clic l'installe. */
    update: AvailableUpdate | null;
  };
  rooms: AdminRoom[];
  players: AdminPlayer[];
  bans: { id: string; name: string }[];
  presets: Preset[];
  /** Les parties sauvegardées, et le nombre d'emplacements. */
  saves: AdminSave[];
  saveSlots: number;
};

export type AdminInbound =
  | { type: 'login'; password: string }
  | { type: 'createRoom'; name: string; password: string | null; preset: string | null }
  | { type: 'closeRoom'; roomId: string }
  | { type: 'forceNext'; roomId: string }
  | { type: 'expel'; id: string; isBanned: boolean }
  | { type: 'unban'; id: string }
  | { type: 'savePreset'; preset: Preset }
  | { type: 'deletePreset'; name: string }
  | { type: 'stop' }
  | { type: 'restart' }
  | { type: 'applyUpdate' }
  | { type: 'resumeSave'; slot: number }
  | { type: 'deleteSave'; slot: number };

export type AdminOutbound =
  /** `needsPassword` : la page doit donner le mot de passe admin (hors de la machine du serveur). */
  | { type: 'auth'; ok: boolean; needsPassword: boolean }
  | { type: 'state'; state: AdminState }
  | { type: 'logs'; lines: string[] }
  /** Le résultat d'une action, à afficher (une erreur, ou ce qui a été fait). */
  | { type: 'notice'; text: string; isError: boolean };
