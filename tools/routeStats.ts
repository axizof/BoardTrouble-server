// Réglage du tracé du Mont Trouble : écarts entre cases, cases trop proches, étages
// superposés, et effet de chaque chute ou transport. Exporte le plateau en JSON si on donne
// un fichier : bun run tools/routeStats.ts [plateau.json]
import { writeFileSync } from 'node:fs';
import { horizontalDistance } from '../packages/core/src/boards/route';
import { buildMontTrouble, prepareBoard } from '../packages/core/src/index';

const definition = buildMontTrouble();
const board = prepareBoard(definition);
const spaces = Object.values(definition.spaces);

for (const floor of [1, 2, 3, 4, 5]) {
  const gaps: [number, string][] = [];
  for (const space of spaces.filter((s) => s.floor === floor)) {
    for (const next of space.next) {
      const other = definition.spaces[next];
      if (other?.floor === floor && space.position && other.position)
        gaps.push([horizontalDistance(space.position, other.position), `${space.id}>${next}`]);
    }
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const [low, high] = [gaps[0], gaps.at(-1)];
  const mean = gaps.reduce((sum, [g]) => sum + g, 0) / gaps.length;
  console.log(
    `étage ${floor}: écart ${low?.[0].toFixed(2)} (${low?.[1]}) à ${high?.[0].toFixed(2)} (${high?.[1]}), moyenne ${mean.toFixed(2)}`,
  );
}

const linked = (a: string, b: string) =>
  definition.spaces[a]?.next.includes(b) || definition.spaces[b]?.next.includes(a);
const close: string[] = [];
for (const [i, a] of spaces.entries()) {
  for (const b of spaces.slice(i + 1)) {
    if (!a.position || !b.position || linked(a.id, b.id)) continue;
    const h = horizontalDistance(a.position, b.position);
    const dy = Math.abs(a.position.y - b.position.y);
    if (dy < 3.5 && h < 3.2) close.push(`${a.id}/${b.id} h=${h.toFixed(1)} dy=${dy.toFixed(1)}`);
  }
}
console.log('trop proches:', close.length ? close.join(', ') : 'aucune');
// Le terrain n'a qu'une hauteur par point : deux étages ne se superposent jamais, il faut la
// place d'une falaise entre eux.
const stacked: string[] = [];
for (const [i, a] of spaces.entries()) {
  for (const b of spaces.slice(i + 1)) {
    if (!a.position || !b.position || a.floor === b.floor || linked(a.id, b.id)) continue;
    const h = horizontalDistance(a.position, b.position);
    if (h < 4) stacked.push(`${a.id}/${b.id} h=${h.toFixed(1)}`);
  }
}
console.log('étages superposés:', stacked.length ? stacked.join(', ') : 'aucun');

const dist = (id: string) => board.distanceToGoal.get(id) ?? Number.NaN;
for (const space of spaces) {
  const to =
    space.fallsTo ??
    ('to' in space.kind && space.kind.type !== 'teleporter' ? space.kind.to : undefined);
  if (!to || !space.position) continue;
  const target = definition.spaces[to];
  if (!target?.position) continue;
  const label = space.fallsTo ? 'chute' : space.kind.type;
  console.log(
    `${label} ${space.id} -> ${to}: h=${horizontalDistance(space.position, target.position).toFixed(1)} dy=${(target.position.y - space.position.y).toFixed(1)} gain=${dist(space.id) - dist(to)}`,
  );
}
console.log('chemin le plus court:', dist('start'));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(definition));
