import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Le coeur des règles tourne aussi dans le navigateur (solo) : aucune API propre à Bun
// ou à Node dans le code de production. Les tests, eux, peuvent en utiliser.
test('core source files use no Bun or Node specific module', () => {
  const sources = readdirSync(import.meta.dir, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    const code = readFileSync(join(import.meta.dir, file), 'utf8');
    expect({ file, imports: code.match(/from ['"](bun|node:[^'"]+|fs|path)['"]/g) }).toEqual({
      file,
      imports: null,
    });
  }
});
