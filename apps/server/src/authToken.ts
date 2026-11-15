import { createPublicKey, type KeyObject, verify } from 'node:crypto';

// La connexion Discord (01-architecture.md, section 7) : l'API centrale de Board Trouble passe le
// joueur par Discord et lui rend un jeton signé (Ed25519). Le serveur le vérifie lui-même, avec la
// clé publique de l'API : il ne l'appelle jamais pendant une partie, et une API en panne n'empêche
// que les nouvelles connexions Discord. Format : `base64url(charge JSON).base64url(signature)`.

/** Ce que le jeton dit du joueur, une fois vérifié. */
export type DiscordUser = { id: string; name: string; avatar: string | null };

/** La version de la charge que ce serveur sait lire. */
const TOKEN_VERSION = 1;
const DISCORD_ID = /^\d{5,25}$/;

/** La clé publique de l'API (32 octets en base64url, comme `/public-key`), ou null si invalide. */
export function authPublicKey(text: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: text }, format: 'jwk' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    // Une clé mal recopiée : on le dit au lancement (main.ts), le serveur marche sans Discord.
    return null;
  }
}

/**
 * Le joueur Discord d'un jeton, s'il est signé par l'API, pas expiré, et lié à cet identifiant
 * de navigateur (`identity`) ; sinon null.
 */
export function verifyAuthToken(
  token: string,
  key: KeyObject,
  identity: string,
  nowSeconds: number,
): DiscordUser | null {
  const [body, signature, ...rest] = token.split('.');
  if (body === undefined || signature === undefined || rest.length > 0) return null;
  if (!verify(null, Buffer.from(body), key, Buffer.from(signature, 'base64url'))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    // Signé mais illisible : une version de l'API que ce serveur ne connaît pas.
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { v, sub, name, avatar, idn, exp } = payload as Record<string, unknown>;
  if (
    v !== TOKEN_VERSION ||
    typeof sub !== 'string' ||
    !DISCORD_ID.test(sub) ||
    typeof name !== 'string' ||
    idn !== identity ||
    typeof exp !== 'number' ||
    exp < nowSeconds
  ) {
    return null;
  }
  return { id: sub, name, avatar: typeof avatar === 'string' ? avatar : null };
}
