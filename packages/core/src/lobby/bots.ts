import type { Rng } from '../random/rng';
import {
  type Appearance,
  CHARACTERS,
  type CharacterId,
  COAT_COUNT,
  GLASSES,
  HATS,
} from './players';

// Les bots d'une table (le salon solo, un salon du serveur) : ils prennent les animaux que les
// humains n'ont pas pris, portent leur nom, et s'habillent au hasard.

/** Le nom de chaque animal, que porte le bot qui le joue. */
export const CHARACTER_NAMES: Record<CharacterId, string> = {
  fox: 'Renard',
  cow: 'Vache',
  lizard: 'Lézard',
  lion: 'Lion',
  cat: 'Chat',
  dog: 'Chien',
  goat: 'Chèvre',
  wolf: 'Loup',
  duck: 'Canard',
};

/** Un bot sur deux porte un chapeau, un sur quatre des lunettes : assez pour varier la table. */
const BOT_HAT_CHANCE = 0.5;
const BOT_GLASSES_CHANCE = 0.25;

/** Une tenue au hasard pour le bot qui joue cet animal. */
export function botAppearance(character: CharacterId, rng: Rng): Appearance {
  return {
    character,
    coat: rng.int(0, COAT_COUNT - 1),
    hat: rng.chance(BOT_HAT_CHANCE) ? rng.pick(HATS.filter((hat) => hat !== 'none')) : 'none',
    glasses: rng.chance(BOT_GLASSES_CHANCE)
      ? rng.pick(GLASSES.filter((glasses) => glasses !== 'none'))
      : 'none',
  };
}

/**
 * Les animaux de `count` bots, tirés parmi ceux que les humains n'ont pas pris (s'il n'en reste
 * pas assez, des animaux déjà pris complètent).
 */
export function botCharacters(
  taken: readonly CharacterId[],
  count: number,
  rng: Rng,
): CharacterId[] {
  const free = rng.shuffle(CHARACTERS.filter((id) => !taken.includes(id)));
  if (free.length >= count) return free.slice(0, count);
  // (Le second tirage seulement s'il le faut : le hasard des tenues qui suit ne change pas.)
  const others = rng.shuffle(CHARACTERS.filter((id) => taken.includes(id)));
  return [...free, ...others].slice(0, count);
}
