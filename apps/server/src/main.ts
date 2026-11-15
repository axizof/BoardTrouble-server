import { type KeyObject, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GAME_VERSION } from '@board-trouble/core';
import { AdminHub, type AdminPeer } from './admin/adminHub';
import { DataStore } from './admin/dataStore';
import { FileBans } from './admin/fileBans';
import adminPage from './admin/index.html';
import { LogBuffer } from './admin/logBuffer';
import { authPublicKey } from './authToken';
import { GameServer, type Peer } from './gameServer';
import { FileSaveSlots } from './saveSlots';
import { loadCertificate } from './tls';
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
//   --https-port 7351  BT_HTTPS_PORT  le même jeu en HTTPS (la manette, en LAN) ; le port
//                                  suivant par défaut. --no-https (BT_NO_HTTPS=1) : sans HTTPS
//   BT_ADMIN_PASSWORD             le mot de passe du tableau de bord (sinon tiré au lancement)
//   BT_SAVE_SLOTS                 combien de parties gardées en même temps (3 par défaut)
//   BT_UPDATE_REPO                le repo GitHub dont suivre les Releases (le repo du serveur)
//   BT_NO_UPDATE_CHECK=1          ne pas chercher de mises à jour
//   BT_AUTH_URL                   l'API centrale (connexion Discord) : sa clé publique est lue au
//                                 lancement. Ou BT_AUTH_PUBLIC_KEY : la clé recopiée directement

type Settings = {
  port: number;
  /** Le port du HTTPS (la manette en LAN), ou null sans HTTPS. */
  securePort: number | null;
  name: string;
  client: string;
  lag: number;
  data: string;
};

function readSettings(): Settings {
  const args = process.argv.slice(2);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(option('--port') ?? process.env.BT_PORT ?? 7350);
  const lag = Number(option('--lag') ?? process.env.BT_LAG ?? 0);
  const validPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 7350;
  const securePort = Number(option('--https-port') ?? process.env.BT_HTTPS_PORT ?? validPort + 1);
  const isSecureOff = args.includes('--no-https') || process.env.BT_NO_HTTPS === '1';
  return {
    port: validPort,
    securePort:
      isSecureOff || !Number.isInteger(securePort) || securePort <= 0 || securePort >= 65536
        ? null
        : securePort,
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

/** Les adresses IPv4 de la machine sur ses réseaux (pas la boucle locale). */
function lanIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) =>
      entry && entry.family === 'IPv4' && !entry.internal ? [entry.address] : [],
    );
}

/** Les adresses où les autres joueurs du réseau local peuvent ouvrir le jeu (HTTP, puis HTTPS). */
function lanAddresses(port: number, securePort: number | null): string[] {
  return lanIps().flatMap((ip) => [
    `http://${ip}:${port}`,
    ...(securePort === null ? [] : [`https://${ip}:${securePort}`]),
  ]);
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
/** Le temps laissé à l'API centrale pour donner sa clé, au lancement (ms). */
const AUTH_KEY_TIMEOUT = 5000;

/**
 * La clé publique de l'API centrale (connexion Discord) : recopiée (BT_AUTH_PUBLIC_KEY), ou lue
 * sur l'API (BT_AUTH_URL). Rien de réglé, ou l'API injoignable : le serveur marche sans Discord.
 */
async function loadAuthKey(): Promise<KeyObject | null> {
  const written = process.env.BT_AUTH_PUBLIC_KEY;
  const url = process.env.BT_AUTH_URL;
  let text = written;
  if (!text && url) {
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/public-key`, {
        signal: AbortSignal.timeout(AUTH_KEY_TIMEOUT),
      });
      const body = (await response.json()) as { key?: unknown };
      text = typeof body.key === 'string' ? body.key : undefined;
    } catch (error) {
      log(`Connexion Discord désactivée : l'API ne répond pas (${String(error)})`);
      return null;
    }
  }
  if (!text) return null;
  const key = authPublicKey(text);
  log(
    key
      ? 'Connexion Discord activée'
      : "Connexion Discord désactivée : la clé publique de l'API est invalide",
  );
  return key;
}

const game = new GameServer({
  name: settings.name,
  maxRooms: 8,
  log,
  bans,
  saves,
  authKey: await loadAuthKey(),
});
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

/** Ce que sert le serveur, en HTTP comme en HTTPS : le jeu, le tableau de bord, les connexions. */
const serving = {
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
} satisfies Omit<Bun.Serve.Options<SocketData>, 'port'>;

const server = Bun.serve<SocketData>({ port: settings.port, ...serving });
// (Undefined seulement pour un serveur sur un socket Unix, pas ici.)
const port = server.port ?? settings.port;

/**
 * Le même jeu en HTTPS, sur un second port (la manette en LAN, 01-architecture.md section 6) :
 * un certificat que ce serveur fabrique lui-même (data/tls). Un port pris ou un certificat
 * impossible n'empêche pas de jouer : on le dit, et le HTTP reste.
 */
function serveSecure(): ReturnType<typeof Bun.serve<SocketData>> | null {
  if (settings.securePort === null) return null;
  try {
    const tls = loadCertificate(join(settings.data, 'tls'), lanIps(), log);
    return Bun.serve<SocketData>({ port: settings.securePort, tls, ...serving });
  } catch (error) {
    log(
      `HTTPS indisponible (${String(error)}) : la manette ne marchera qu'en local ou par un tunnel`,
    );
    return null;
  }
}

const secureServer = serveSecure();
const securePort = secureServer?.port ?? null;

/** Arrête tout ; `restart` : relance le même serveur (mêmes réglages) une fois le port libéré. */
function shutdown(restart: boolean): void {
  log(restart ? 'Redémarrage du serveur' : 'Arrêt du serveur');
  clearInterval(pinging);
  updates.stop();
  admin.close();
  game.close();
  server.stop(true);
  secureServer?.stop(true);
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
  serverInfo: () => ({ name: settings.name, port, addresses: lanAddresses(port, securePort) }),
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
for (const ip of lanIps()) log(`Sur le réseau local : http://${ip}:${port}`);
if (securePort !== null) {
  for (const ip of lanIps()) {
    log(
      `Avec une manette : https://${ip}:${securePort} (accepter une fois l'avertissement du navigateur)`,
    );
  }
}
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
