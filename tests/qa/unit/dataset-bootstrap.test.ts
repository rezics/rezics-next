import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import {
  checkedLocalDatabase,
  DATASET_ADMIN_GRANTS,
  grantDatasetAdminAuthority,
  loadDatasetAdminCredentials,
  datasetStackMarker,
  completeDatasetAdminAudit,
} from '../../../scripts/datasets/bootstrap.ts';
import { FixtureAuthorityDenied } from '../../../services/main/src/modules/access/fixture-authority.ts';

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});
function ownerFixture(
  options: {
    closed?: boolean;
    policy?: boolean;
    prior?: boolean;
    controlled?: boolean;
    gateClosed?: boolean;
    dispatchClosed?: boolean;
  } = {},
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
      if (sql.includes('FROM access.recovery_fence')) return result([{ open: !options.closed }]);
      if (sql.includes('FROM access.principal'))
        return result([{ id: 'principal-dataset', active: true }]);
      if (sql.includes('FROM access.representation')) {
        const action = values[2];
        if (action === 'agent.control')
          return result(options.controlled === false ? [] : [{ id: 'existing-controller' }]);
        return result(options.prior ? [{ id: `representation-${String(action)}` }] : []);
      }
      if (sql.includes('FROM access.scope_gate'))
        return result([{ open: !options.gateClosed, dispatch_open: !options.dispatchClosed }]);
      if (sql.includes('FROM access.policy'))
        return result(options.policy ? [{ id: 'existing-policy' }] : []);
      if (sql.includes('FROM access.permission_grant'))
        return result(options.prior ? [{ id: 'existing-fixture-grant' }] : []);
      return result([]);
    },
  } as unknown as Pick<PoolClient, 'query'>;
  return { client, calls };
}
const grantInsert =
  "INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '7 days')";
const representationInsert =
  "INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,clock_timestamp() + interval '7 days')";
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000123';

describe('dedicated local dataset administrator bootstrap', () => {
  test('persists independently generated private credentials before setup and reuses them with mode0600', () => {
    const account = `http://127.0.0.1:${Math.floor(Math.random() * 10_000) + 30_000}`;
    const first = loadDatasetAdminCredentials(account);
    files.push(first.credentialsPath);
    const repeated = loadDatasetAdminCredentials(account);
    expect(first.credentials.email.endsWith('@example.test')).toBe(true);
    expect(first.credentials.password.length).toBeGreaterThanOrEqual(40);
    expect(first.credentials).toEqual(repeated.credentials);
    expect(statSync(first.credentialsPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.credentialsPath, 'utf8')).name).toBe(
      'Local dataset administrator',
    );
  });

  test('new stack epochs get separate credentials while sameepoch identities and historical files remain intact', () => {
    const account = `http://127.0.0.1:${Math.floor(Math.random() * 10_000) + 40_000}`;
    const old = datasetStackMarker('00000000-0000-4000-8000-000000000001', 'operator-one');
    const fresh = datasetStackMarker('00000000-0000-4000-8000-000000000002', 'operator-two');
    const first = loadDatasetAdminCredentials(account, old),
      next = loadDatasetAdminCredentials(account, fresh);
    files.push(first.credentialsPath, next.credentialsPath);
    expect(first.credentialsPath).not.toBe(next.credentialsPath);
    expect(first.credentials.email).not.toBe(next.credentials.email);
    expect(loadDatasetAdminCredentials(account, old).credentials).toEqual(first.credentials);
    expect(statSync(first.credentialsPath).mode & 0o777).toBe(0o600);
    expect(() => datasetStackMarker(undefined, 'operator')).toThrow('reset marker');
  });

  test('failed Account audits never leave a completed local bootstrap receipt', async () => {
    const setup = loadDatasetAdminCredentials(
      `http://127.0.0.1:${Math.floor(Math.random() * 10_000) + 50_000}`,
    );
    files.push(setup.credentialsPath);
    writeFileSync(setup.credentialsPath, JSON.stringify({ state: 'attempted' }));
    await expect(
      completeDatasetAdminAudit(setup.credentialsPath, { state: 'completed' }, async () => {
        throw new Error('audit unavailable');
      }),
    ).rejects.toThrow('audit unavailable');
    expect(JSON.parse(readFileSync(setup.credentialsPath, 'utf8')).state).toBe('attempted');
    let audited = false;
    await completeDatasetAdminAudit(setup.credentialsPath, { state: 'completed' }, async () => {
      audited = true;
    });
    expect(audited).toBe(true);
    expect(JSON.parse(readFileSync(setup.credentialsPath, 'utf8')).state).toBe('completed');
  });

  test('refuses remote and unported owner databases before setup', () => {
    expect(checkedLocalDatabase('postgres://user:password@127.0.0.1:5432/access')).toContain(
      '127.0.0.1',
    );
    expect(() =>
      checkedLocalDatabase('postgres://user:password@production.example:5432/access'),
    ).toThrow('loopback');
    expect(() => checkedLocalDatabase('postgres://localhost/access')).toThrow('loopback');
  });

  test('adds only dataset creation/semantic permissions to its existing controlled principal and preserves all other state', async () => {
    const fixture = ownerFixture();
    const result = await grantDatasetAdminAuthority(
      fixture.client,
      'http://127.0.0.1:3004/api/auth',
      'dataset-account',
      actor,
    );
    expect(result.granted.map(({ action, scope }) => ({ action, scope }))).toEqual(
      DATASET_ADMIN_GRANTS,
    );
    const grants = fixture.calls.filter((call) =>
      call.sql.startsWith('INSERT INTO access.permission_grant'),
    );
    expect(grants.map((call) => ({ sql: call.sql, actor: call.values[1], scope: call.values[2], action: call.values[3] }))).toEqual(
      DATASET_ADMIN_GRANTS.map(({ action, scope }) => ({ sql: grantInsert, actor, scope, action })),
    );
    const representations = fixture.calls.filter((call) =>
      call.sql.startsWith('INSERT INTO access.representation'),
    );
    expect(representations.map((call) => ({
      sql: call.sql, principal: call.values[1], actor: call.values[2], action: call.values[3],
    }))).toEqual(DATASET_ADMIN_GRANTS.map(({ action }) => ({
      sql: representationInsert, principal: 'principal-dataset', actor, action,
    })));
    expect(
      fixture.calls.some((call) => /^\s*(DELETE|UPDATE|TRUNCATE|DROP|ALTER)/.test(call.sql)),
    ).toBe(false);
    expect(fixture.calls.at(-1)?.sql).toBe('COMMIT');
    expect(fixture.calls.some((call) => call.sql.includes('INSERT INTO access.principal'))).toBe(
      false,
    );
    expect(fixture.calls.some((call) => call.sql.includes('platform_administrator'))).toBe(false);
  });

  test('reuses active fixture grants and refuses recovery holds, unrelated policies, or missing control', async () => {
    const reused = ownerFixture({ prior: true });
    const result = await grantDatasetAdminAuthority(
      reused.client,
      'http://127.0.0.1:3004/api/auth',
      'dataset-account',
      actor,
    );
    expect(result.granted.map((grant) => grant.id)).toEqual(
      DATASET_ADMIN_GRANTS.map(() => 'existing-fixture-grant'),
    );
    expect(
      reused.calls.some((call) => call.sql.startsWith('INSERT INTO access.permission_grant')),
    ).toBe(false);
    expect(
      reused.calls.some((call) => call.sql.startsWith('INSERT INTO access.representation')),
    ).toBe(false);
    const denied: Record<string, { kind: FixtureAuthorityDenied['kind']; message: string }> = {
      closed: { kind: 'recovery', message: 'Access recovery fence is closed' },
      policy: { kind: 'policy', message: 'fixture scope has a policy: work:create:root' },
      gateClosed: { kind: 'gate', message: 'fixture scope is closed: work:create:root' },
      dispatchClosed: { kind: 'gate', message: 'fixture scope is closed: work:create:root' },
    };
    for (const posture of [{ closed: true }, { policy: true }, { controlled: false }, { gateClosed: true }, { dispatchClosed: true }]) {
      const fixture = ownerFixture(posture);
      const key = Object.keys(posture)[0]!;
      const expectation = expect(
        grantDatasetAdminAuthority(
          fixture.client,
          'http://127.0.0.1:3004/api/auth',
          'dataset-account',
          actor,
        ),
      );
      if (denied[key]) await expectation.rejects.toMatchObject({ name: 'FixtureAuthorityDenied', ...denied[key] });
      else await expectation.rejects.toThrow('must already control its publicly provisioned Agent');
      expect(fixture.calls.at(-1)?.sql).toBe('ROLLBACK');
      expect(
        fixture.calls.some((call) => call.sql.startsWith('INSERT INTO access.permission_grant')
          || call.sql.startsWith('INSERT INTO access.representation')),
      ).toBe(false);
    }
  });
});
