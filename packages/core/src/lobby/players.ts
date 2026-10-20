// Ce qu'un joueur choisit dans le salon : son pseudo et son apparence. Tout ce qui vient d'un
// client est revérifié côté serveur (01-architecture.md, section 7).

/** Les 8 animaux jouables (STYLE.md section 5) : même gabarit, même hitbox. */
export const CHARACTERS = ['fox', 'cow', 'lizard', 'lion', 'cat', 'dog', 'goat', 'wolf'] as const;

export type CharacterId = (typeof CHARACTERS)[number];

export function isCharacter(value: unknown): value is CharacterId {
  return isOneOf(CHARACTERS, value);
}

/** Pelages de chaque animal : 0 est sa couleur naturelle. */
export const COAT_COUNT = 4;
export const HATS = ['none', 'cap', 'party', 'beanie', 'cowboy', 'top', 'crown'] as const;
export const GLASSES = ['none', 'round', 'shades', 'heart', 'monocle'] as const;

export type HatId = (typeof HATS)[number];
export type GlassesId = (typeof GLASSES)[number];

/** L'apparence choisie dans le salon (01-vision-et-plateau.md, section 20) : purement esthétique. */
export type Appearance = { character: CharacterId; coat: number; hat: HatId; glasses: GlassesId };

export function naturalAppearance(character: CharacterId): Appearance {
  return { character, coat: 0, hat: 'none', glasses: 'none' };
}

/**
 * Lit une apparence envoyée par un client : un nouvel objet avec seulement les champs connus,
 * pour ne jamais renvoyer aux autres joueurs ce qu'un client aurait ajouté. Null si invalide.
 */
export function readAppearance(value: unknown): Appearance | null {
  if (typeof value !== 'object' || value === null) return null;
  const { character, coat, hat, glasses } = value as Record<string, unknown>;
  if (!isCharacter(character)) return null;
  if (typeof coat !== 'number' || !Number.isInteger(coat) || coat < 0 || coat >= COAT_COUNT) {
    return null;
  }
  if (!isOneOf(HATS, hat) || !isOneOf(GLASSES, glasses)) return null;
  return { character, coat, hat, glasses };
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 16;
/** Lettres (accents compris), chiffres, espaces et quelques signes simples. */
const NICKNAME_CHARACTERS = /^[\p{L}\p{N} _'.-]+$/u;

export type NicknameCheck =
  | { ok: true; nickname: string }
  | { ok: false; reason: 'tooShort' | 'tooLong' | 'invalidCharacters' };

/**
 * Valide un pseudo : espaces en trop retirés, 3 à 16 caractères, pas de caractère de
 * contrôle ni de symbole exotique. La longueur se compte en caractères visibles.
 */
export function checkNickname(input: unknown): NicknameCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'invalidCharacters' };
  // Un texte démesuré n'est même pas découpé en caractères.
  if (input.length > NICKNAME_MAX * 8) return { ok: false, reason: 'tooLong' };
  const nickname = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...nickname].length;
  if (length < NICKNAME_MIN) return { ok: false, reason: 'tooShort' };
  if (length > NICKNAME_MAX) return { ok: false, reason: 'tooLong' };
  if (!NICKNAME_CHARACTERS.test(nickname)) return { ok: false, reason: 'invalidCharacters' };
  return { ok: true, nickname };
}
