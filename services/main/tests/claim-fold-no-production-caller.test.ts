import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const entry = 'services/main/src/modules/verification/claim-fold.ts';

/** The Claim fold takes the dataset-wide restore hold and its completion and
 * release are denied until the original inventory is exhaustively reconciled,
 * so a caller on a live dataset would hide the catalogue with nothing to release
 * it. Until the closure exists, no production code may start a fold turn. */
test('no production code starts a Claim fold turn', () => {
  const callers: string[] = [];
  for (const dir of ['services', 'scripts', 'packages', 'apps']) {
    for (const item of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!item.isFile() || !/\.(ts|tsx)$/.test(item.name)) continue;
      const file = relative(root, join(item.parentPath, item.name));
      if (file === entry || file.includes('node_modules') || /(^|\/)(tests?|__tests__)\//.test(file)
        || /\.(test|spec)\.tsx?$/.test(file)) continue;
      if (/\b(convertEligibleClaimsTurn|convertEligibleClaims)\b/.test(readFileSync(join(root, file), 'utf8'))) callers.push(file);
    }
  }
  expect(callers).toEqual([]);
});
