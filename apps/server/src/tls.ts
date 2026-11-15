import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Le HTTPS du réseau local (01-architecture.md, section 6) : un navigateur ne donne la manette
// qu'à une page sécurisée. Chaque serveur fabrique son propre certificat (auto-signé) au premier
// lancement, gardé dans `data/tls/`, et le refait si les adresses de la machine changent ou s'il
// approche de sa fin. Chaque joueur accepte une fois l'avertissement du navigateur ("connexion
// non privée", continuer) : la page est alors en HTTPS, et la manette marche.
//
// Ni Bun ni Node ne savent créer un certificat : on l'écrit ici (X.509, en DER), avec le module
// `crypto` standard. Rien à installer, la même chose sous Windows, macOS et Linux.

export type Certificate = { cert: string; key: string };

/** Un certificat dure un an ; on le refait un mois avant sa fin. */
const VALIDITY_DAYS = 365;
const RENEW_BEFORE_DAYS = 30;
const DAY = 24 * 60 * 60_000;

/** Le certificat de ce serveur pour ces adresses (fabriqué, ou relu s'il convient encore). */
export function loadCertificate(
  dir: string,
  ips: string[],
  log: (line: string) => void,
): Certificate {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf-8');
    const key = readFileSync(keyPath, 'utf-8');
    if (isStillGood(cert, ips)) return { cert, key };
  }
  const made = makeCertificate(ips, new Date());
  mkdirSync(dir, { recursive: true });
  writeFileSync(certPath, made.cert);
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  log(`Certificat HTTPS créé pour ${['localhost', ...ips].join(', ')} (data/tls)`);
  return made;
}

/** Encore valable plus d'un mois, et pour toutes ces adresses. */
function isStillGood(pem: string, ips: string[]): boolean {
  try {
    const certificate = new X509Certificate(pem);
    const isFresh = new Date(certificate.validTo).getTime() - Date.now() > RENEW_BEFORE_DAYS * DAY;
    const names = certificate.subjectAltName ?? '';
    return isFresh && ips.every((ip) => names.includes(`IP Address:${ip}`));
  } catch {
    // Illisible : on en refait un (rien n'est perdu, il n'a rien de secret à garder).
    return false;
  }
}

/** Un certificat auto-signé (clé EC P-256, ECDSA SHA-256) pour localhost et ces adresses IPv4. */
export function makeCertificate(ips: string[], now: Date): Certificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8('Board Trouble (serveur local)'))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(
      time(new Date(now.getTime() - DAY)),
      time(new Date(now.getTime() + VALIDITY_DAYS * DAY)),
    ),
    name,
    Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    explicit(
      3,
      sequence(
        extension('2.5.29.19', true, sequence()),
        // Signature numérique seulement (le bit 0) : un certificat de serveur.
        extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
        extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
        extension(
          '2.5.29.17',
          false,
          sequence(
            tlv(0x82, Buffer.from('localhost')),
            ...['127.0.0.1', ...ips].map((ip) =>
              tlv(0x87, Buffer.from(ip.split('.').map((part) => Number(part)))),
            ),
          ),
        ),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// --- DER : juste ce qu'il faut pour un certificat -------------------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  let header: number[];
  if (length < 0x80) header = [tag, length];
  else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    header = [tag, 0x80 | bytes.length, ...bytes];
  }
  return Buffer.concat([Buffer.from(header), content]);
}

function sequence(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

function explicit(tag: number, content: Buffer): Buffer {
  return tlv(0xa0 | tag, content);
}

function integer(value: Buffer): Buffer {
  // Un entier positif dont le premier bit est à 1 prend un zéro devant.
  const bytes = (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return tlv(0x02, bytes);
}

function utf8(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf-8'));
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** Une date en UTCTime (AAMMJJhhmmssZ), valable jusqu'en 2049. */
function time(date: Date): Buffer {
  const two = (value: number) => String(value).padStart(2, '0');
  const text =
    two(date.getUTCFullYear() % 100) +
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(text));
}

function extension(id: string, isCritical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(isCritical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  );
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
