import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GAME_VERSION } from '@board-trouble/core';
import { GameServer, type Peer } from './gameServer';

// Le serveur Board Trouble (01-architecture.md, sections 3 et 10) : il sert le jeu lui-même (la
// page et la connexion de jeu ont la même origine : en LAN, ni contenu mixte ni accès au réseau
// local à autoriser) et héberge les salons sur une WebSocket (`/ws`).
//
// Réglages (ligne de commande, sinon variables d'environnement) :
//   --port 7350        BT_PORT
//   --name "Mon serveur" BT_NAME
//   --client <dossier> BT_CLIENT   le jeu compilé (dist du client)

type Settings = { port: number; name: string; client: string };

function readSettings(): Settings {
  const args = process.argv.slice(2);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(option('--port') ?? process.env.BT_PORT ?? 7350);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7350,
    name: (option('--name') ?? process.env.BT_NAME ?? 'Serveur Board Trouble').slice(0, 40),
    // Par défaut, le client cloné à côté du serveur (01-architecture.md, section 2), compilé.
    client: resolve(
      option('--client') ??
        process.env.BT_CLIENT ??
        join(import.meta.dir, '../../../../client/dist'),
    ),
  };
}

function log(line: string): void {
  const time = new Date().toLocaleTimeString('fr-FR');
  console.log(`[${time}] ${line}`);
}

/** Les adresses où les autres joueurs du réseau local peuvent ouvrir le jeu. */
function lanAddresses(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry?.address}:${port}`);
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
const game = new GameServer({ name: settings.name, maxRooms: 8, log });

type SocketData = { connection: ReturnType<GameServer['connect']> | null };

const server = Bun.serve<SocketData>({
  port: settings.port,
  fetch(request, bun) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      return bun.upgrade(request, { data: { connection: null } })
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
    open(socket) {
      const peer: Peer = {
        send: (text) => socket.send(text),
        close: () => socket.close(),
      };
      socket.data.connection = game.connect(peer);
    },
    message(socket, message) {
      const { connection } = socket.data;
      if (connection) game.receive(connection, typeof message === 'string' ? message : '');
    },
    close(socket) {
      const { connection } = socket.data;
      if (connection) game.disconnect(connection);
    },
  },
});

// (Undefined seulement pour un serveur sur un socket Unix, pas ici.)
const port = server.port ?? settings.port;
log(`Board Trouble ${GAME_VERSION} : "${settings.name}" sur le port ${port}`);
log(`Sur cette machine : http://localhost:${port}`);
for (const address of lanAddresses(port)) log(`Sur le réseau local : ${address}`);
if (!hasClient)
  log(`Attention : pas de jeu compilé dans ${settings.client} (npm run build côté client)`);

process.on('SIGINT', () => {
  log('Arrêt du serveur');
  game.close();
  server.stop(true);
  process.exit(0);
});
