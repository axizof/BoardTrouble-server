// Ce qu'un joueur choisit dans le salon : son pseudo et son personnage. Tout ce qui vient d'un
// client est revérifié côté serveur (01-architecture.md, section 7).

/** Les 8 animaux jouables (STYLE.md section 5) : même gabarit, même hitbox. */
export const CHARACTERS = ['fox', 'cow', 'lizard', 'lion', 'cat', 'dog', 'goat', 'wolf'] as const;

export type CharacterId = (typeof CHARACTERS)[number];

export function isCharacter(value: unknown): value is CharacterId {
  return typeof value === 'string' && (CHARACTERS as readonly string[]).includes(value);
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
