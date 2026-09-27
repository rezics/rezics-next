import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

test('G311 display preferences: defaults, whole-value CAS, bearer and session identity', async () => {
  const f = await accountFixture();
  try {
    await f.pool.query(await Bun.file(new URL('../migrations/053_display_preferences.sql', import.meta.url)).text());
    const first = await f.signup('display-first@example.test');
    const second = await f.signup('display-second@example.test');
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient();
    f.displayPreferenceClientIds.add(client.client_id);
    const token = (await oauth.issue(client.client_id, first.cookie)).access_token;
    const otherClient = await oauth.createClient();
    const otherToken = (await oauth.issue(otherClient.client_id, first.cookie)).access_token;
    const request = (method: 'GET' | 'PUT', body?: unknown, cookie?: string, bearer?: string, origin = f.baseURL) =>
      fetch(`${f.baseURL}/api/account/display-preferences`, { method, headers: { origin,
        ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const initial = { revision: 0, displayMode: 'system', showZoneThemes: true };
    expect(await (await request('GET', undefined, first.cookie)).json()).toEqual(initial);
    expect(await (await request('GET', undefined, undefined, token)).json()).toEqual(initial);
    expect((await request('GET')).status).toBe(401);
    expect((await request('GET', undefined, undefined, 'invalid')).status).toBe(401);
    expect((await request('GET', undefined, undefined, otherToken)).status).toBe(403);
    expect((await request('PUT', { expectedRevision: 0, displayMode: 'dark', showZoneThemes: false },
      undefined, otherToken)).status).toBe(403);
    const update = { expectedRevision: 0, displayMode: 'dark', showZoneThemes: false };
    expect((await request('PUT', update, first.cookie, undefined, 'https://evil.test')).status).toBe(403);
    expect((await request('PUT', { ...update, displayMode: 'blue' }, first.cookie)).status).toBe(400);
    const raced = await Promise.all([request('PUT', update, first.cookie),
      request('PUT', { ...update, displayMode: 'light' }, undefined, token)]);
    expect(raced.map(item => item.status).sort()).toEqual([200, 409]);
    const current = await (await request('GET', undefined, first.cookie)).json() as typeof initial;
    expect(current.revision).toBe(1);
    expect(current.showZoneThemes).toBe(false);
    expect((await request('PUT', update, first.cookie)).status).toBe(409);
    expect(await (await request('GET', undefined, second.cookie)).json()).toEqual(initial);
    const saved = await request('PUT', { expectedRevision: 1, displayMode: 'light', showZoneThemes: true },
      undefined, token);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 2, displayMode: 'light', showZoneThemes: true });
    await f.pool.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1',
      [first.id]);
    expect((await request('GET', undefined, undefined, token)).status).toBe(401);
  } finally { await f.close(); }
}, 90_000);
