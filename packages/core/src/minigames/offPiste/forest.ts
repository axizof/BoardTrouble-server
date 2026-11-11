// La forêt de Hors-piste ! (02-mini-jeux.md, fiche 50) : une large pente de neige vierge qui
// descend tout droit (vers -z), entre deux barres de rochers, semée de sapins fins, de plus en
// plus serrés en descendant. Pas de piste ni de chemin tracé : on se faufile entre les troncs.
// Elle est tirée de la graine de la partie (la même pour tous, chez l'hôte comme chez les
// joueurs, qui la dessinent) et se calcule par rangées à la demande : elle n'a pas de fin. Un
// passage reste toujours possible : un couloir invisible, sans tronc, ondule d'un bord à l'autre,
// assez doucement pour qu'on puisse le suivre à la plus grande vitesse (sa pente et sa courbure
// sont bornées, voir le test) ; jamais de mur de sapins. Distance `d` le long de la descente
// (mètres), écart `x` au milieu.

/** La forêt : de -FOREST_HALF à FOREST_HALF, entre les rochers (mètres). */
export const FOREST_HALF = 20;
/** Les sapins sont tirés par rangées de cette profondeur (mètres). */
export const TREE_ROW = 2.5;
/** Le haut de la pente, sans sapin : le départ et l'élan (mètres). */
const START_CLEAR = 15;
/** Un sapin arrête le skieur à cette distance de son tronc (mètres, le skieur compris). */
export const TREE_REACH = 0.6;
/** Le couloir : aucun tronc à moins de tant de son milieu (plus étroit en bas, mètres). */
const CORRIDOR_CLEAR: [number, number] = [1.5, 1.25];
/** Ses ondulations : des sinus (amplitude, longueur d'onde en mètres), d'un bord à l'autre. */
const CORRIDOR_WAVES = [
  { amplitude: 9, length: 40 },
  { amplitude: 4, length: 17 },
  { amplitude: 1, length: 11 },
] as const;
/** Il part du milieu et rejoint ses ondulations sur tant de mètres. */
const CORRIDOR_OPENING = 90;
/** Les sapins par mètre carré, en haut puis à partir de DENSE_AT (mètres). */
const DENSITY: [number, number] = [0.035, 0.07];
const DENSE_AT = 900;
/** Deux sapins d'une même rangée ne se touchent pas (mètres entre les troncs). */
const TREE_GAP = 1;

export type Tree = {
  /** Unique dans la forêt (rangée et rang). */
  key: number;
  x: number;
  d: number;
  /** Sa taille (1 : un sapin moyen), pour le dessin. */
  size: number;
};

/** Une valeur entre 0 et 1, toujours la même pour ces nombres. */
export function forestUnit(seed: number, a: number, b = 0): number {
  let hash = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x632be5ab, 0xc2b2ae35);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) ^ Math.imul(b + 0x27d4eb2f, 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 13), 0x297a2d39);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Plus bas, plus dur : de 0 en haut à 1 à partir de DENSE_AT. */
function depth(d: number): number {
  return Math.max(0, Math.min(1, (d - START_CLEAR) / (DENSE_AT - START_CLEAR)));
}

/**
 * Le milieu du couloir sans tronc, à cette distance. Il part du milieu (là où l'on part) et
 * s'en écarte peu à peu sur CORRIDOR_OPENING mètres.
 */
export function corridorX(seed: number, d: number): number {
  const waves = CORRIDOR_WAVES.reduce(
    (x, { amplitude, length }, wave) =>
      x + amplitude * Math.sin(d / length + forestUnit(seed, -1, wave) * Math.PI * 2),
    0,
  );
  const opening = Math.max(0, Math.min(1, d / CORRIDOR_OPENING));
  return waves * opening * opening * (3 - 2 * opening);
}

const cache = new Map<number, Map<number, Tree[]>>();
/** Les forêts gardées en mémoire (une par graine) : la partie en cours et le bac à sable. */
const KEPT_FORESTS = 4;

/** Les sapins de la rangée `row` (de row * TREE_ROW à la rangée suivante). */
export function treesInRow(seed: number, row: number): Tree[] {
  let forest = cache.get(seed);
  if (!forest) {
    forest = new Map();
    cache.set(seed, forest);
    if (cache.size > KEPT_FORESTS) cache.delete(cache.keys().next().value ?? seed);
  }
  const known = forest.get(row);
  if (known) return known;
  const trees = plantRow(seed, row);
  forest.set(row, trees);
  return trees;
}

function plantRow(seed: number, row: number): Tree[] {
  const top = row * TREE_ROW;
  if (row < 0 || top < START_CLEAR) return [];
  const share = depth(top);
  const expected = (DENSITY[0] + (DENSITY[1] - DENSITY[0]) * share) * FOREST_HALF * 2 * TREE_ROW;
  // Arrondi au hasard : 1,4 sapin attendu fait une ou deux rangées sur trois à 2.
  const count = Math.floor(expected + forestUnit(seed, row, 0));
  const clear = CORRIDOR_CLEAR[0] + (CORRIDOR_CLEAR[1] - CORRIDOR_CLEAR[0]) * share;
  const trees: Tree[] = [];
  // Quelques essais de plus que de sapins : ceux qui tombent dans le couloir sont refusés.
  for (let k = 0; k < count * 2 + 2 && trees.length < count; k++) {
    const x = (forestUnit(seed, row, 1 + k * 3) * 2 - 1) * (FOREST_HALF - 0.4);
    const d = top + forestUnit(seed, row, 2 + k * 3) * TREE_ROW;
    if (Math.abs(x - corridorX(seed, d)) < clear) continue;
    if (trees.some((other) => Math.hypot(other.x - x, other.d - d) < TREE_GAP)) continue;
    trees.push({ key: row * 64 + k, x, d, size: 0.8 + forestUnit(seed, row, 3 + k * 3) * 0.5 });
  }
  return trees;
}

/** Tous les sapins entre `from` et `to` (mètres le long de la descente). */
export function treesBetween(seed: number, from: number, to: number): Tree[] {
  const trees: Tree[] = [];
  for (let row = Math.floor(from / TREE_ROW); row * TREE_ROW <= to; row++) {
    for (const tree of treesInRow(seed, row)) if (tree.d >= from && tree.d <= to) trees.push(tree);
  }
  return trees;
}
