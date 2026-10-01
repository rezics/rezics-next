import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAuthorityRead, AUTHORITY_READ_COST } from '../../../services/main/src/modules/access/authority-read.ts';
import { policyHarness } from './access-policy-harness.ts';

test('G-903: manager preconditions and revocation sources are authorized, fresh and bounded', async () => {
  const h = await policyHarness();
  try {
    const manager = await h.fixture.agent();
    const recipient = await h.fixture.agent();
    const scope = await h.fixture.scope();
    await h.fixture.mandate(h.manager, manager, 'access.policy.manage');
    await h.fixture.mandate(h.manager, manager, 'access.revoke');
    const ceiling = await h.fixture.grant(manager, manager, scope, 'access.policy.manage');
    const target = await h.fixture.grant(manager, recipient, scope, 'work.read');
    const costs = { statements: 0, rows: 0 };
    const statements: string[] = [];
    const measured = { connect: async () => {
      const client = await h.pool.connect();
      return { query: async (sql: string, parameters?: unknown[]) => {
        costs.statements++; statements.push(sql);
        const result = await client.query(sql, parameters);
        costs.rows += result.rows.length;
        return result;
      }, release: () => client.release() };
    } } as unknown as Pool;
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
    const app = createMainApp(fuseki, { environment: { fuseki, objectDirectory: '.temp/g-903-authority-objects',
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } },
    account: h.account.verifier, access: h.registry, authorityRead: new AccessAuthorityRead(measured) });
    const read = async (path: string, token = h.managerToken) => {
      costs.statements = 0; costs.rows = 0; statements.length = 0;
      const response = await app.handle(new Request(`http://main.local${path}`,
        { headers: { authorization: `Bearer ${token}` } }));
      expect(costs.statements).toBeLessThanOrEqual(AUTHORITY_READ_COST.statements);
      expect(costs.rows).toBeLessThanOrEqual(AUTHORITY_READ_COST.selectedRows);
      expect(statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
      return { response, body: await response.json() as Record<string, any> };
    };
    const path = '/v1/access/authority-state?' + new URLSearchParams({ scopeId: scope,
      actingSubject: manager, action: 'access.policy.manage' });
    const initial = await read(path);
    expect(initial.response.status).toBe(200);
    expect(initial.response.headers.get('cache-control')).toBe('private, no-store');
    expect(initial.body).toMatchObject({ scopeId: scope, authorityEpoch: '0', grant: { id: ceiling, generation: '0' } });
    expect(JSON.stringify(initial.body)).not.toContain(h.manager);
    const denied = await read(path, h.readerToken);
    expect(denied.response.status, JSON.stringify(denied.body)).toBe(403);
    expect((await read('/v1/access/authority-state?' + new URLSearchParams({ scopeId: scope,
      actingSubject: manager, action: 'access.revoke' }))).response.status).toBe(400);
    expect((await read(path, h.account.noScope)).response.status).toBe(401);
    // Unrelated retained grant history cannot expand exact authority/source reads.
    await h.q(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT gen_random_uuid(), $1, $2, $3, 'work.read', now() + interval '1 hour'
      FROM generate_series(1, 512)`, [manager, recipient, scope]);
    expect((await read(path)).body).toEqual(initial.body);
    const published = await h.ok<{ authorityEpoch: string }>(h.call('POST', '/v1/access/policy-changes', h.managerToken, {
      profile: 'access-policy-change-v1', action: 'publish-revision', policyId: randomUUID(),
      issuerSubject: manager, scopeId: scope, expectedHeadRevision: '0',
      expectedAuthorityEpoch: initial.body.authorityEpoch, mandatory: [], ordered: [],
    }));
    const refreshed = await read(path);
    expect(refreshed.body.authorityEpoch).toBe(published.authorityEpoch);
    expect(refreshed.body.authorityEpoch).not.toBe(initial.body.authorityEpoch);
    const sourcePath = `/v1/access/revocation-sources/${target}?`
      + new URLSearchParams({ issuerSubject: manager });
    const source = await read(sourcePath);
    expect(source.response.status).toBe(200);
    expect(source.body).toMatchObject({ authorityEpoch: published.authorityEpoch,
      source: { id: target, generation: '0', action: 'work.read', recipientSubject: recipient, active: true } });
    expect((await read(sourcePath, h.readerToken)).response.status).toBe(403);
    const other = await h.fixture.agent();
    await h.fixture.mandate(h.manager, other, 'access.revoke');
    expect((await read(`/v1/access/revocation-sources/${target}?`
      + new URLSearchParams({ issuerSubject: other }))).response.status).toBe(403);
    const revokeBody = { profile: 'access-revocation-v1', revocationId: randomUUID(),
      issuerSubject: manager, scopeId: scope, mode: 'ordinary',
      expectedAuthorityEpoch: source.body.authorityEpoch,
      target: { kind: 'permission_grant', id: source.body.source.id,
        expectedGeneration: source.body.source.generation } };
    const key = randomUUID();
    const revoked = await h.ok(h.call('POST', '/v1/access/revocations', h.managerToken, revokeBody, key));
    const after = await read(sourcePath);
    expect(after.body.source).toMatchObject({ id: target, active: false, generation: '1' });
    expect(after.body.authorityEpoch).toBe(revoked.fenceAuthorityEpoch);
    expect((await h.call('POST', '/v1/access/revocations', h.managerToken, revokeBody, key)).body.replayed).toBe(true);
    await h.q('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await read(path)).response.status).toBe(503);
    await h.q('UPDATE access.recovery_fence SET open = true WHERE id');
    expect((await read(path)).response.status).toBe(200);
  } finally { await h.close(); }
}, 180_000);
