import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const testRoot = resolve(import.meta.dir, '..');
const guardFile = resolve(testRoot, 'content/setup-single-request.test.ts');
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

function testSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return testSources(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

function retries503DuringSetup(source: string): boolean {
  const branchesOn503 = /\bstatus\s*(?:===|!==|==|!=)\s*503\b/i.test(source);
  const hasSetupContext = /\b(?:setup\w*|fixtureSetup|bootstrap\w*)\b/i.test(source);
  const hasRetryControl = /\b(?:attempt|retryAfter|Retry-After|retryable|retry)\b/i.test(source);
  const repeats =
    /\b(?:for|while)\s*\(/.test(source) || (source.match(/\b(?:handle|fetch|request)\s*\(/g)?.length ?? 0) > 1;
  return branchesOn503 && hasSetupContext && hasRetryControl && repeats;
}

test('kernel test setup sends each request once', () => {
  const helperPath = 'setup' + '-retry';
  const helperName = ['setup', 'Request'].join('');
  const helperNamePattern = new RegExp(`\\b${helperName}\\b`);
  const helperIdentifierPattern = new RegExp(
    `\\b(?:setup\\w{0,24}retr(?:y|ies)\\w*|retr(?:y|ies)\\w{0,24}setup\\w*)\\b`,
    'i',
  );
  const retryImportPattern = /(?:^|[/._-])(?:setup.{0,24}retr|retr.{0,24}setup)(?:$|[./_-])/i;
  const violations: string[] = [];

  for (const file of testSources(testRoot)) {
    if (file === guardFile) continue;
    const source = readFileSync(file, 'utf8');
    const importsRetryHelper = transpiler
      .scanImports(source)
      .some(({ path }) => path.split('/').some((part) => retryImportPattern.test(part)) || path.includes(helperPath));
    if (importsRetryHelper || helperNamePattern.test(source) || helperIdentifierPattern.test(source))
      violations.push(`${relative(testRoot, file)} imports or uses a setup retry helper`);
    if (retries503DuringSetup(source)) {
      violations.push(`${relative(testRoot, file)} retries a 503 in setup`);
    }
  }

  expect(violations).toEqual([]);
});
