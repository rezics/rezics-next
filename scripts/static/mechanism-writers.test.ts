import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessAuthorityDebt, accessAuthorityWriters, mechanismWriterViolations } from './mechanism-writers.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = (name: string, path: string) => ({
  path,
  source: readFileSync(resolve(import.meta.dir, 'fixtures/mechanism-writers', name), 'utf8'),
});

test('only Rights and Governance write assessment, obligation and enforcement state', async () => {
  const violations: string[] = [];
  for await (const path of new Bun.Glob('services/**/src/**/*.ts').scan({ cwd: root })) {
    violations.push(...mechanismWriterViolations([{ path, source: readFileSync(resolve(root, path), 'utf8') }]));
  }
  expect(violations.sort()).toEqual([]);
});

test('Access authority writes stay in Access, the frozen debt, or neither scripts nor other modules', async () => {
  const serviceWriters: string[] = [];
  for await (const path of new Bun.Glob('services/**/src/**/*.ts').scan({ cwd: root })) {
    serviceWriters.push(...accessAuthorityWriters([{ path, source: readFileSync(resolve(root, path), 'utf8') }]));
  }
  expect(serviceWriters.sort()).toEqual([...accessAuthorityDebt].sort());
  const scriptViolations: string[] = [];
  for await (const path of new Bun.Glob('scripts/**/*.ts').scan({ cwd: root })) {
    // Guard fixtures are the negative cases. The load corpus still grants by its own SQL.
    if (path.startsWith('scripts/static/fixtures/') || path.startsWith('scripts/load/')) continue;
    scriptViolations.push(...mechanismWriterViolations([{ path, source: readFileSync(resolve(root, path), 'utf8') }]));
  }
  expect(scriptViolations.sort()).toEqual([]);
  expect(mechanismWriterViolations(accessAuthorityDebt.map(path => ({
    path, source: readFileSync(resolve(root, path), 'utf8'),
  })))).toEqual([]);
});

test('a fixture script that inserts a permission grant fails; an Access module write passes', () => {
  const grant = fixture('permission-grant.ts', 'scripts/dev/seed/unauthorized-grant.ts');
  const owner = fixture('permission-grant.ts', 'services/main/src/modules/access/fixture-authority.ts');
  expect(mechanismWriterViolations([grant]).join('\n')).toContain('writes access authority state');
  expect(mechanismWriterViolations([owner])).toEqual([]);
  expect(accessAuthorityWriters([grant])).toEqual(['scripts/dev/seed/unauthorized-grant.ts']);
});

test('an adaptation policy and a separate cover fence fail; a mapping, a projection and an owner change pass', () => {
  const adaptation = fixture('adaptation-policy.ts', 'services/main/src/modules/work/metadata-command.ts');
  const cover = fixture('cover-fence.ts', 'services/main/src/modules/media/cover-fence.ts');
  const mapping = fixture('licence-mapping.ts', 'services/main/src/modules/source/licence-mapping.ts');
  const projection = fixture('assessment-projection.ts', 'services/main/src/modules/work/assessment-read.ts');
  const rights = fixture('owner-rights.ts', 'services/main/src/modules/rights/obligation-write.ts');
  const governance = fixture('owner-governance.ts', 'services/main/src/modules/governance/fence-write.ts');
  expect(mechanismWriterViolations([adaptation]).join('\n')).toContain('decides a derivative obligation from a licence');
  expect(mechanismWriterViolations([cover]).join('\n')).toContain('writes a separate cover fence');
  expect(mechanismWriterViolations([mapping, projection, rights, governance])).toEqual([]);
});
