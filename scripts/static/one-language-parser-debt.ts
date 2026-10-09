import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rulePath = 'scripts/static/ast-grep/rules/one-language-parser.yml';
const debtPath = 'scripts/static/ast-grep/one-language-parser-debt.json';

export interface LanguageMatch { file: string; text: string }

/** The committed rule without its frozen node-text exclusions, so the debt can be remeasured. */
export function languageParserProbe(committed: string): string {
  return committed.split('\n---\n').map(document => {
    const at = document.indexOf('\n    - not:\n');
    return at < 0 ? document : `${document.slice(0, at)}\n`;
  }).join('\n---\n');
}

/** Drop path filters so a fixture file is visible to the committed rule. */
export function languageParserUnrestricted(committed: string): string {
  return committed.split('\n---\n').map(document => document
    .replace(/\nfiles:\n(?:  - .*\n)*/g, '\n')
    .replace(/\nignores:\n(?:  .*\n)*/g, '\n')).join('\n---\n');
}

export function languageParserIgnores(committed: string): string[][] {
  return committed.split('\n---\n').map(document => {
    const body = document.split('\nignores:\n')[1]?.split(/\nrule:/)[0] ?? '';
    return [...body.matchAll(/^  - (.+)$/gm)].map(match => match[1]!);
  });
}

export function scanLanguageRule(rule: string, paths: string[]): LanguageMatch[] {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'language-probe-'));
  const file = join(directory, 'rule.yml');
  try {
    writeFileSync(file, rule);
    const result = spawnSync(join(root, 'node_modules/.bin/ast-grep'),
      ['scan', '--rule', file, '--json=stream', ...paths],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr || `ast-grep exited ${result.status}`);
    }
    return result.stdout.split('\n').filter(Boolean).map(line => {
      const match = JSON.parse(line) as { file: string; text: string };
      return { file: match.file, text: match.text };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readLanguageDebt(path = join(root, debtPath)): LanguageMatch[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { matches: LanguageMatch[] };
  return parsed.matches;
}

export { rulePath, debtPath };
