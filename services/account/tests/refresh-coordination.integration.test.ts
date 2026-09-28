import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { accountFixture, freePort } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { createAccountApp } from '../src/app.ts';

type Tokens = { access_token: string; refresh_token: string };

test('G384: concurrent refreshes share a pair; withdrawal, revocation, disable and stale reuse stay fenced', async () => {
  const f = await accountFixture();
  let replica: ReturnType<typeof createAccountApp> | undefined;
  try {
    replica = createAccountApp(f.auth, f.pool).listen({ hostname: '127.0.0.1', port: await freePort() });
    const oauth = await oauthFixture(f);
    const member = await f.signup('refresh-coordination@example.test');
    const client = await oauth.createClient();
    const otherClient = await oauth.createClient();
    const endpoints = [f.baseURL, `http://127.0.0.1:${replica.server!.port}`];
    const refresh = (endpoint: string, token: string, clientId = client.client_id) =>
      fetch(`${endpoint}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
          refresh_token: token, resource: f.config.resource }) });
    const rotate = async (token: string) => {
      const response = await refresh(endpoints[0]!, token);
      expect(response.status).toBe(200);
      return response.json() as Promise<Tokens>;
    };
    const initial = await oauth.issue(client.client_id, member.cookie);
    const parallel = await Promise.all(endpoints.map(endpoint => refresh(endpoint, initial.refresh_token)));
    expect(parallel.map(response => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(parallel.map(response => response.json() as Promise<Tokens>));
    expect([second.access_token, second.refresh_token])
      .toEqual([first.access_token, first.refresh_token]);
    expect(await oauth.introspect(first.access_token)).toMatchObject({ active: true });
    const family = await f.pool.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM public."oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2`,
    [member.id, client.client_id]);
    expect(family.rows[0]?.count).toBe(2);
    const indexes = await f.pool.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'oauthRefreshToken'`);
    expect(indexes.rows.some(row => row.indexdef.includes('UNIQUE INDEX')
      && row.indexdef.includes('(token)'))).toBe(true);
    expect(indexes.rows.some(row => row.indexdef.includes('("userId", "clientId")'))).toBe(true);
    const survived = await rotate(first.refresh_token);
    expect(await oauth.introspect(survived.access_token)).toMatchObject({ active: true });

    const withdrawal = await oauth.issue(client.client_id, member.cookie);
    const withdrawalChild = await rotate(withdrawal.refresh_token);
    const consent = await f.pool.query<{ id: string }>(`SELECT id FROM public."oauthConsent"
      WHERE "userId" = $1 AND "clientId" = $2`, [member.id, client.client_id]);
    expect((await f.request('/api/auth/oauth2/delete-consent',
      { id: consent.rows[0]!.id }, member.cookie)).status).toBe(200);
    const window = await f.pool.query<{ open: boolean }>(`SELECT
      "rotationReplayExpiresAt" > clock_timestamp() AS open FROM public."oauthRefreshToken"
      WHERE token = $1`, [createHash('sha256').update(withdrawal.refresh_token).digest('base64url')]);
    expect(window.rows[0]?.open).toBe(true);
    const withdrawn = await refresh(endpoints[1]!, withdrawal.refresh_token);
    expect(withdrawn.status).toBe(400);
    expect(await withdrawn.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await oauth.introspect(withdrawalChild.access_token)).toEqual({ active: false });

    const revocable = await oauth.issue(client.client_id, member.cookie);
    const revocableChild = await rotate(revocable.refresh_token);
    const revoked = await fetch(`${f.baseURL}/api/auth/oauth2/revoke`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: revocableChild.refresh_token,
        token_type_hint: 'refresh_token', client_id: client.client_id }) });
    expect(revoked.ok).toBe(true);
    expect((await refresh(endpoints[1]!, revocable.refresh_token)).status).toBe(400);

    const disabled = await oauth.issue(client.client_id, member.cookie);
    await rotate(disabled.refresh_token);
    await f.pool.query(`UPDATE public.rezics_account_security
      SET suspended_at = now(), generation = generation + 1 WHERE user_id = $1`, [member.id]);
    expect((await refresh(endpoints[1]!, disabled.refresh_token)).status).toBe(400);
    await f.pool.query(`UPDATE public.rezics_account_security SET suspended_at = NULL
      WHERE user_id = $1`, [member.id]);

    const erasing = await oauth.issue(client.client_id, member.cookie);
    await rotate(erasing.refresh_token);
    await f.pool.query(`UPDATE public.rezics_account_security
      SET deletion_started_at = now(), generation = generation + 1 WHERE user_id = $1`, [member.id]);
    expect((await refresh(endpoints[1]!, erasing.refresh_token)).status).toBe(400);
    await f.pool.query(`UPDATE public.rezics_account_security SET deletion_started_at = NULL
      WHERE user_id = $1`, [member.id]);

    const stale = await oauth.issue(client.client_id, member.cookie);
    const staleChild = await rotate(stale.refresh_token);
    await f.pool.query(`UPDATE public."oauthRefreshToken"
      SET "rotationReplayExpiresAt" = now() - interval '1 second' WHERE token = $1`,
    [createHash('sha256').update(stale.refresh_token).digest('base64url')]);
    const reuse = await refresh(endpoints[1]!, stale.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(endpoints[0]!, staleChild.refresh_token)).status).toBe(400);

    // A rotated token sent under another registered client is family reuse,
    // even inside the cache window. Its child can no longer refresh.
    const swapped = await oauth.issue(client.client_id, member.cookie);
    const swappedChild = await rotate(swapped.refresh_token);
    expect((await refresh(endpoints[1]!, swapped.refresh_token, otherClient.client_id)).status).toBe(400);
    expect((await refresh(endpoints[0]!, swappedChild.refresh_token)).status).toBe(400);
    expect((await f.pool.query(`SELECT 1 FROM public."oauthRefreshToken"
      WHERE "userId" = $1 AND "clientId" = $2`, [member.id, client.client_id])).rowCount).toBe(0);
  } finally {
    await replica?.stop();
    await f.close();
  }
}, 120_000);
