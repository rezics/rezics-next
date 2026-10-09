import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mechanismWriterViolations } from './mechanism-writers.ts';

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
