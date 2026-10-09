import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  languageParserIgnores, languageParserProbe, languageParserUnrestricted, readLanguageDebt, rulePath,
  scanLanguageRule,
} from './one-language-parser-debt.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sort = (matches: { file: string; text: string }[]) =>
  [...matches].sort((left, right) => left.file.localeCompare(right.file) || left.text.localeCompare(right.text));

test('language-tag parsing outside display-language stays at the frozen violations', () => {
  const committed = readFileSync(join(root, rulePath), 'utf8');
  const debt = readLanguageDebt();
  expect(debt.length).toBeGreaterThan(0);
  const found = scanLanguageRule(languageParserProbe(committed), ['.']);
  expect(sort(found)).toEqual(sort(debt));
  for (const ignores of languageParserIgnores(committed)) {
    expect(ignores).toEqual([
      'services/main/src/modules/display-language/**',
      'packages/model/src/generated/**',
    ]);
  }
}, 60_000);

test('a new language parser fails and a frozen violation does not', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'language-fixture-'));
  try {
    const fresh = join(directory, 'fresh.ts');
    const frozen = join(directory, 'frozen.ts');
    writeFileSync(fresh, 'const languageTag = /^[a-z]{2,5}(?:-[A-Za-z0-9]{3,8})*$/;\n');
    writeFileSync(frozen, 'const tag = Intl.getCanonicalLocales(value)[0];\n');
    const rule = languageParserUnrestricted(readFileSync(join(root, rulePath), 'utf8'));
    expect(scanLanguageRule(rule, [fresh]).map(match => match.text))
      .toEqual(['/^[a-z]{2,5}(?:-[A-Za-z0-9]{3,8})*$/']);
    expect(scanLanguageRule(rule, [frozen])).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
