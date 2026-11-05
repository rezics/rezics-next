import { expect, expectTypeOf, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import {
  bootstrapGovernance,
  bootstrapLocalShowcaseBoardCreation,
  BOOTSTRAP_GOVERNANCE_DEADLINE_MS,
  BootstrapGovernanceUnavailableError,
  PLATFORM_GOVERNANCE_ROLE,
  PLATFORM_RESOURCE,
  type BootstrapGovernanceResult,
} from '../../src/access/bootstrap-governance.ts';
import { parseBootstrapGovernanceArgs } from '../../scripts/bootstrap-governance.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const accountId = '00000000-0000-8000-8000-123400000001';
const root = new URL('../../../../', import.meta.url).pathname;
const script = 'services/kernel/scripts/bootstrap-governance.ts';

test('operator governance bootstrap contract exposes the fixed Global authority and no HTTP route', () => {
  expect(BOOTSTRAP_GOVERNANCE_DEADLINE_MS).toBe(10_000);
  expect(PLATFORM_GOVERNANCE_ROLE).toBe('platform.governance');
  expect(PLATFORM_RESOURCE).toEqual({ route: 0, id: GLOBAL_CONTEXT });
  expect(Object.isFrozen(PLATFORM_RESOURCE)).toBe(true);
  expectTypeOf<typeof PLATFORM_RESOURCE>().toEqualTypeOf<
    Readonly<{ route: 0; id: '00000000-0000-8000-8000-000000000000' }>
  >();
  expectTypeOf<typeof bootstrapGovernance>().toEqualTypeOf<
    (pool: Pool, accountId: string) => Promise<BootstrapGovernanceResult>
  >();
  expectTypeOf<BootstrapGovernanceResult>().toEqualTypeOf<{
    accountId: string;
    role: typeof PLATFORM_GOVERNANCE_ROLE;
    resource: typeof PLATFORM_RESOURCE;
    replayed: boolean;
  }>();
  const app = createKernel({ pool: {} as Pool, routeKey: new Uint8Array(32) });
  expect(JSON.stringify(openApiDocument(app))).not.toMatch(/bootstrap|showcase|platform\.governance/i);
  expect(app.routes.some((route) => /bootstrap|showcase/i.test(route.path))).toBe(false);
});

test('malformed bootstrap input fails closed before I/O', async () => {
  let touched = false;
  const pool = new Proxy({} as Pool, {
    get() {
      touched = true;
      throw new Error('Unavailable bootstrap must not touch storage');
    },
  });
  for (const helper of [bootstrapGovernance, bootstrapLocalShowcaseBoardCreation]) {
    for (const id of [
      '',
      'root',
      accountId.replace('-8000-', '-4000-'),
      `${accountId}\n`,
      accountId.toUpperCase().replace('00000000', 'ABCDEF00'),
    ]) {
      await expect(helper(pool, id)).rejects.toBeInstanceOf(BootstrapGovernanceUnavailableError);
    }
    expect(touched).toBe(false);
    // Both historical v8 and native v7 identifiers pass routeOf and reach storage.
    for (const id of [accountId, accountId.replace('-8000-', '-7000-')]) {
      touched = false;
      await expect(helper(pool, id)).rejects.toThrow();
      expect(touched).toBe(true);
    }
    touched = false;
  }
  expect(touched).toBe(false);
  expect(new BootstrapGovernanceUnavailableError().name).toBe('BootstrapGovernanceUnavailableError');
});

test('CLI accepts only one explicit account', () => {
  expect(parseBootstrapGovernanceArgs(['--account', accountId])).toEqual({ accountId });
  expect(parseBootstrapGovernanceArgs(['--account', accountId.replace('-8000-', '-7000-')]).accountId).toContain(
    '-7000-',
  );
  for (const argv of [
    [],
    ['--account'],
    [accountId],
    [`--account=${accountId}`],
    ['--account', accountId, '--account', accountId],
    ['--account', accountId, '--role', PLATFORM_GOVERNANCE_ROLE],
    ['--resource', GLOBAL_CONTEXT, '--account', accountId],
    ['--account', accountId, '--authority'],
    ['--account', accountId, '--actions', '*'],
    ['--account', accountId, 'extra'],
    ...[
      '',
      'root',
      '--account',
      accountId.toUpperCase().replace('00000000', 'ABCDEF00'),
      accountId.replace('-8000-', '-4000-'),
      accountId.replace('-8000-', '-c000-'),
      `${accountId}\n`,
      ` ${accountId}`,
      `${accountId} `,
    ].map((id) => ['--account', id]),
  ]) {
    expect(() => parseBootstrapGovernanceArgs(argv)).toThrow();
  }
});

test('repository-root CLI requires DATABASE_URL and reports unavailable without claiming success', () => {
  for (const [argv, databaseUrl, failure] of [
    [[], 'postgres://kernel.invalid/bootstrap', /--account/],
    [['--account', accountId], '', /DATABASE_URL/],
    [['--account', accountId], 'postgres://kernel.invalid/bootstrap', /BootstrapGovernanceUnavailableError/],
  ] as const) {
    const child = Bun.spawnSync(['bun', script, ...argv], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl, BOOTSTRAP_ACCOUNT: accountId },
      timeout: 10_000,
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe('');
    expect(child.stderr.toString()).toMatch(failure);
    expect(child.stderr.toString()).not.toMatch(/cannot find|SQL|connection refused/i);
  }
});

test('CLI closes its owned pool when deployment storage is unavailable', () => {
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(resolve(root, '.temp/bootstrap-governance-'));
  try {
    const preload = resolve(directory, 'observe-pool.ts');
    writeFileSync(
      preload,
      `import pg from ${JSON.stringify(import.meta.resolve('pg'))};
let closed = 0;
const end = pg.Pool.prototype.end;
pg.Pool.prototype.end = function (...args) { closed++; return end.apply(this, args); };
pg.Pool.prototype.query = pg.Pool.prototype.connect = () => { throw new Error('Storage touched'); };
process.on('exit', () => process.stderr.write('pools closed: ' + closed + '\\n'));
`,
    );
    const child = Bun.spawnSync(['bun', '--preload', preload, script, '--account', accountId], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: 'postgres://kernel.invalid/bootstrap' },
      timeout: 10_000,
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe('');
    expect(child.stderr.toString()).toContain('BootstrapGovernanceUnavailableError');
    expect(child.stderr.toString()).toContain('pools closed: 1');
    expect(child.stderr.toString()).not.toContain('Storage touched');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
