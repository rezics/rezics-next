import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { AccountApp } from '@rezics/account/app';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage } from '../src/recovery-coverage.ts';

test('G205 contract: typed Eden responses, OpenAPI, stable errors and complete new-table recovery coverage', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('contracts@example.test');
    const client = treaty<AccountApp>(f.baseURL);
    const methods = await client.api.account.methods.get({ headers: { cookie: member.cookie } });
    expect(methods.error).toBeNull();
    const password: boolean | undefined = methods.data?.password;
    expect(password).toBe(true);
    const doc = await (await f.request('/api/account/openapi.json')).json() as { openapi: string;
      paths: Record<string, { get?: { responses: Record<string, unknown> }; post?: { requestBody: unknown } }> };
    expect(doc.openapi).toBe('3.1.2');
    expect(doc.paths['/api/account/methods']!.get!.responses['200']).toBeTruthy();
    expect(doc.paths['/api/account/admin/users/{userId}/actions']!.post!.requestBody).toBeTruthy();
    const authDoc = await f.auth.api.generateOpenAPISchema();
    expect(authDoc.paths['/passkey/verify-authentication']).toBeTruthy();
    expect(authDoc.paths['/two-factor/enable']).toBeTruthy();
    const invalid = await f.request('/api/account/sessions?limit=999', undefined, member.cookie);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_request' });
    const manifest = await accountRecoveryCoverage(f.pool);
    await assertAccountRecoveryCoverage(f.pool, manifest);
    await f.pool.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1', [member.id]);
    await expect(assertAccountRecoveryCoverage(f.pool, manifest)).rejects.toThrow('Account rows differ');
  } finally { await f.close(); }
}, 60_000);

test('Account recovery coverage includes first-party clients and the session client column', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('recovery-client@example.test');
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    const beforeMarker = await accountRecoveryCoverage(f.pool);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)',
      [client.client_id]);
    const withMarker = await accountRecoveryCoverage(f.pool);
    expect(BigInt(withMarker.rowCount)).toBe(BigInt(beforeMarker.rowCount) + 1n);
    expect(withMarker.rowDigest).not.toBe(beforeMarker.rowDigest);
    await expect(assertAccountRecoveryCoverage(f.pool, beforeMarker))
      .rejects.toThrow('Account rows differ from retained recovery coverage');

    await f.pool.query(`UPDATE "session" SET rezics_client_id = $1 WHERE "userId" = $2`,
      [client.client_id, member.id]);
    const withSessionClient = await accountRecoveryCoverage(f.pool);
    expect(withSessionClient.rowCount).toBe(withMarker.rowCount);
    expect(withSessionClient.rowDigest).not.toBe(withMarker.rowDigest);
    await expect(assertAccountRecoveryCoverage(f.pool, withMarker))
      .rejects.toThrow('Account rows differ from retained recovery coverage');
  } finally { await f.close(); }
}, 60_000);

test('G205 pagination: no event lost across PostgreSQL microseconds or equal timestamps', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('page@example.test');
    await f.pool.query(`INSERT INTO rezics_account_security_event (user_id, action, occurred_at)
      SELECT $1, 'page_probe', '2026-01-01T00:00:00.123456Z'::timestamptz
      FROM generate_series(1, 12)`, [member.id]);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let probes = 0;
    do {
      const response = await f.request(`/api/account/security-activity?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, member.cookie);
      const page = await response.json() as { items: { id: string; action: string }[]; nextCursor: string | null };
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false); seen.add(item.id);
        if (item.action === 'page_probe') probes++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(probes).toBe(12);
  } finally { await f.close(); }
}, 60_000);
