import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GAME_VERSION } from '@board-trouble/core';
import { AdminHub, type AdminPeer } from './admin/adminHub';
import { DataStore } from './admin/dataStore';
import { FileBans } from './admin/fileBans';
import adminPage from './admin/index.html';
import { LogBuffer } from './admin/logBuffer';
import { GameServer, type Peer } from './gameServer';
import { FileSaveSlots } from './saveSlots';
import { UpdateChecker } from './updates';

// Le serveur Board Trouble (01-architecture.md, sections 3 et 10) : il sert le jeu lui-même (la
// page et la connexion de jeu ont la même origine : en LAN, ni contenu mixte ni accès au réseau
// local à autoriser) et héberge les salons sur une WebSocket (`/ws`). Son tableau de bord est sur
// `/admin` (sa connexion sur `/admin/ws`).
//
// Réglages (ligne de commande, sinon variables d'environnement) :
//   --port 7350        BT_PORT
//   --name "Mon serveur" BT_NAME
//   --client <dossier> BT_CLIENT   le jeu compilé (dist du client)
//   --lag 80           BT_LAG      développement : simule un réseau lent (ms de latence, plus
//                                  des à-coups de la moitié), dans les deux sens
//   --data <dossier>   BT_DATA     où garder ses données (bannis, presets) : `data/` par défaut
//   BT_ADMIN_PASSWORD             le mot de passe du tableau de bord (sinon tiré au lancement)
//   BT_SAVE_SLOTS                 combien de parties gardées en même temps (3 par défaut)
//   BT_UPDATE_REPO                le repo GitHub dont suivre les Releases (le repo du serveur)
//   BT_NO_UPDATE_CHECK=1          ne pas chercher de mises à jour

type Settings = { port: number; name: string; client: string; lag: number; data: string };

function readSettings(): Settings {
  const args = process.argv.slice(2);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(option('--port') ?? process.env.BT_PORT ?? 7350);
  const lag = Number(option('--lag') ?? process.env.BT_LAG ?? 0);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7350,
    lag: Number.isFinite(lag) && lag > 0 ? Math.min(lag, 2000) : 0,
    name: (option('--name') ?? process.env.BT_NAME ?? 'Serveur Board Trouble').slice(0, 40),
    // Par défaut, le client cloné à côté du serveur (01-architecture.md, section 2), compilé.
    client: resolve(
      option('--client') ??
        process.env.BT_CLIENT ??
        join(import.meta.dir, '../../../../client/dist'),
    ),
    data: resolve(option('--data') ?? process.env.BT_DATA ?? 'data'),
  };
}

/** Le journal : la console, et la console du tableau de bord (les 500 dernières lignes). */
const logs = new LogBuffer(500);

function log(line: string): void {
  const time = new Date().toLocaleTimeString('fr-FR');
  const stamped = `[${time}] ${line}`;
  console.log(stamped);
  logs.push(stamped);
}

/** Les adresses où les autres joueurs du réseau local peuvent ouvrir le jeu. */
function lanAddresses(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry?.address}:${port}`);
}

/**
 * Un retard de réseau simulé (`--lag`) : chaque message part après la latence, plus ou moins
 * des à-coups, mais toujours dans l'ordre (comme sur une vraie connexion).
 */
function delayed(lag: number): (deliver: () => void) => void {
  if (lag === 0) return (deliver) => deliver();
  let last = 0;
  return (deliver) => {
    const at = Math.max(last, performance.now() + lag * (0.75 + Math.random() * 0.5));
    last = at;
    setTimeout(deliver, at - performance.now());
  };
}

/** Un fichier du jeu compilé, jamais en dehors de son dossier ; sinon la page du jeu. */
function clientFile(root: string, pathname: string): Response {
  const path = normalize(join(root, decodeURIComponent(pathname)));
  const isInside = path === root || path.startsWith(root + sep);
  const file = isInside && pathname !== '/' ? Bun.file(path) : null;
  if (file && existsSync(path) && !path.endsWith(sep)) return new Response(file);
  return new Response(Bun.file(join(root, 'index.html')));
}

const settings = readSettings();
const hasClient = existsSync(join(settings.client, 'index.html'));
const store = new DataStore(settings.data, log);
const bans = new FileBans(store);
/** Les emplacements de sauvegarde des parties (BT_SAVE_SLOTS, 3 par défaut). */
const saveSlots = Math.max(1, Math.min(20, Number(process.env.BT_SAVE_SLOTS) || 3));
const saves = new FileSaveSlots(join(settings.data, 'saves'), saveSlots, log);
const game = new GameServer({ name: settings.name, maxRooms: 8, log, bans, saves });
/** Le mot de passe du tableau de bord (hors de cette machine), affiché au lancement s'il est tiré. */
const adminPassword = process.env.BT_ADMIN_PASSWORD || randomBytes(6).toString('base64url');

/** Les adresses de la machine elle-même : le tableau de bord y entre sans mot de passe. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

type SocketData = {
  /** Une connexion de jeu, ou du tableau de bord. */
  kind: 'game' | 'admin';
  connection: ReturnType<GameServer['connect']> | null;
  admin: ReturnType<AdminHub['connect']> | null;
  address: string;
  /** Le retard simulé, dans chaque sens (`--lag`). */
  outbound: (deliver: () => void) => void;
  inbound: (deliver: () => void) => void;
};

const server = Bun.serve<SocketData>({
  port: settings.port,
  routes: { '/admin': adminPage },
  fetch(request, bun) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname === '/admin/ws') {
      const isAdmin = url.pathname === '/admin/ws';
      const data: SocketData = {
        kind: isAdmin ? 'admin' : 'game',
        connection: null,
        admin: null,
        address: bun.requestIP(request)?.address ?? '',
        outbound: delayed(isAdmin ? 0 : settings.lag),
        inbound: delayed(isAdmin ? 0 : settings.lag),
      };
      return bun.upgrade(request, { data })
        ? undefined
        : new Response('WebSocket attendue', { status: 400 });
    }
    if (!hasClient) {
      return new Response(
        `Board Trouble ${GAME_VERSION} : le jeu n'est pas compilé à côté du serveur (${settings.client}).`,
        { status: 503 },
      );
    }
    return clientFile(settings.client, url.pathname);
  },
  websocket: {
    // Le JSON se compresse très bien : un état d'arène envoyé 30 fois par seconde pèse bien
    // moins une fois compressé (jusqu'à 280 Ko/s par joueur sans, pour la Plateforme fondante).
    perMessageDeflate: true,
    // Une connexion muette (pas même la réponse aux pings que Bun envoie, à laquelle un navigateur
    // vivant répond tout seul) depuis tant de secondes est coupée : un PC en veille, un Wi-Fi
    // tombé, sinon vus au bout de 2 minutes. Un joueur inactif mais présent n'est pas coupé.
    idleTimeout: 30,
    open(socket) {
      const peer: Peer & AdminPeer = {
        send: (text) => socket.data.outbound(() => socket.send(text)),
        close: () => socket.data.outbound(() => socket.close()),
      };
      const { address } = socket.data;
      if (socket.data.kind === 'admin') {
        socket.data.admin = admin.connect(peer, LOOPBACK.has(address), address);
      } else {
        socket.data.connection = game.connect(peer, address);
      }
    },
    message(socket, message) {
      const { connection, admin: adminConnection } = socket.data;
      const text = typeof message === 'string' ? message : '';
      if (adminConnection) admin.receive(adminConnection, text);
      if (connection) socket.data.inbound(() => game.receive(connection, text));
    },
    close(socket) {
      const { connection, admin: adminConnection } = socket.data;
      if (adminConnection) admin.disconnect(adminConnection);
      if (connection) game.disconnect(connection);
    },
  },
});

// (Undefined seulement pour un serveur sur un socket Unix, pas ici.)
const port = server.port ?? settings.port;

/** Arrête tout ; `restart` : relance le même serveur (mêmes réglages) une fois le port libéré. */
function shutdown(restart: boolean): void {
  log(restart ? 'Redémarrage du serveur' : 'Arrêt du serveur');
  clearInterval(pinging);
  updates.stop();
  admin.close();
  game.close();
  server.stop(true);
  if (restart) {
    // La même commande (bun et ce script, ou l'exécutable), qui hérite de cette console.
    Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
  }
  process.exit(0);
}

/** Les mises à jour (BT_NO_UPDATE_CHECK=1 pour ne pas regarder). */
const updates = new UpdateChecker(log);

const admin = new AdminHub({
  game,
  logs,
  store,
  bans,
  password: adminPassword,
  serverInfo: () => ({ name: settings.name, port, addresses: lanAddresses(port) }),
  update: () => updates.available,
  log,
  onStop: () => shutdown(false),
  onRestart: () => shutdown(true),
  saveSlots,
  onUpdate: async () => {
    if (game.adminRooms().some((room) => room.view.phase === 'playing')) {
      return 'Une partie est en cours : la mise à jour attendra sa fin.';
    }
    const error = await updates.apply();
    if (!error) shutdown(true);
    return error;
  },
});
/** La latence de chacun, mesurée toutes les 5 s (le tableau de bord l'affiche). */
const pinging = setInterval(() => game.pingAll(), 5000);
log(`Board Trouble ${GAME_VERSION} : "${settings.name}" sur le port ${port}`);
log(`Sur cette machine : http://localhost:${port}`);
for (const address of lanAddresses(port)) log(`Sur le réseau local : ${address}`);
if (settings.lag > 0) log(`Réseau lent simulé : ${settings.lag} ms de latence (développement)`);
if (!hasClient)
  log(`Attention : pas de jeu compilé dans ${settings.client} (npm run build côté client)`);
log(`Tableau de bord : http://localhost:${port}/admin`);
if (!process.env.BT_ADMIN_PASSWORD) {
  log(
    `  depuis une autre machine, mot de passe : ${adminPassword} (ou fixe-le : BT_ADMIN_PASSWORD)`,
  );
}

process.on('SIGINT', () => shutdown(false));
