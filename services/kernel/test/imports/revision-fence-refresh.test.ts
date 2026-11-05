import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

async function frozenSuite(kind: 'ledger' | 'native') {
  const suite = resolve(
    import.meta.dir,
    '../../../../specs/' + (kind === 'ledger' ? 'imports-ledger.test.ts' : 'imports-api.test.ts'),
  );
  const driver = resolve(
    import.meta.dir,
    kind === 'ledger' ? '../../../importer/tests/ledger-driver.ts' : 'api-driver.ts',
  );
  const names = [
    'changed records and converter revisions append proposals while community adoption survives',
    'takedown fences survive unchanged refresh payload changes restart and reconversion',
    'cover fences prevent reimport on unchanged and changed refresh and hide later disclosures',
  ];
  const args = [process.execPath, 'test', '--timeout', '300000'];
  if (kind === 'native') args.push('--test-name-pattern', names.join('|'));
  args.push(suite);
  const child = Bun.spawn(args, {
    env: { ...process.env, [kind === 'ledger' ? 'IMPORT_LEDGER_DRIVER' : 'IMPORT_API_DRIVER']: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  if (code !== 0) console.error(output);
  expect(code).toBe(0);
  expect(output).toMatch(new RegExp('^\\s*' + (kind === 'ledger' ? 28 : 3) + ' pass$', 'm'));
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
  if (kind === 'native') for (const name of names) expect(output).toContain('(pass) ' + name);
}
test(
  'all unchanged ledger cases retain converter-revision refresh and exact field fences',
  () => frozenSuite('ledger'),
  1_800_000,
);
test(
  'ordinary public API reconversion appends actual new-revision proposals and preserves adoption and current fences',
  () => frozenSuite('native'),
  1_800_000,
);
