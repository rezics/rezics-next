import { expect, test } from 'bun:test';
import { accountFixture, freePort } from './account-fixture.ts';
import { ageAt, readContentPreferences, writeContentPreferences } from '../src/content-preferences.ts';
import { createAccountApp } from '../src/app.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { exportAccountData } from '../src/data-export.ts';

test('first-party OAuth readers receive live derived content preferences without an Account session', async () => {
  const f = await accountFixture();
  try {
    const user = await f.signup('content-reader@example.test');
    const oauth = await oauthFixture(f), app = await oauth.createClient();
    f.displayPreferenceClientIds.add(app.client_id);
    const { access_token: token } = await oauth.issue(app.client_id, user.cookie);
    const read = (bearer?: string, cookie?: string) => fetch(`${f.baseURL}/api/account/content-preferences/viewer`, {
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    });
    expect((await read()).status).toBe(401);
    expect((await read('invalid', user.cookie)).status).toBe(401);
    // A bearer never opens the full private settings read or a settings write.
    expect((await f.request('/api/account/content-preferences', undefined, undefined,
      { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await f.request('/api/account/content-preferences', { expectedRevision: 0, nsfwDisplay: 'show' }, undefined,
      { authorization: `Bearer ${token}` })).status).toBe(401);
    const initial = await read(token);
    expect(initial.status).toBe(200);
    expect(initial.headers.get('cache-control')).toBe('no-store');
    expect(await initial.json()).toEqual({ age: 'unknown', accountEligible: true, adultAvailable: false,
      categories: { general: true, r15: false, r18: false, r18g: false }, nsfwDisplay: 'mask' });
    await writeContentPreferences(f.pool, user.id, { expectedRevision: 0, birthDate: '1990-01-01', country: 'US',
      birthdayPublic: true, categories: { r18: true }, nsfwDisplay: 'show' }, null);
    const current = await (await read(token)).json();
    expect(current).toEqual({ age: 'adult', accountEligible: true, adultAvailable: true,
      categories: { general: true, r15: true, r18: true, r18g: false }, nsfwDisplay: 'show' });
    expect(await (await read(undefined, user.cookie)).json()).toEqual(current);
    const otherApp = await oauth.createClient();
    const otherToken = (await oauth.issue(otherApp.client_id, user.cookie)).access_token;
    expect((await read(otherToken)).status).toBe(403);
    // An altered signed claim cannot impersonate the admitted client or another account.
    const pieces = token.split('.');
    const claims = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString());
    pieces[1] = Buffer.from(JSON.stringify({ ...claims, sub: oauth.owner.id })).toString('base64url');
    expect((await read(pieces.join('.'))).status).toBe(401);
    await f.pool.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1', [user.id]);
    expect((await read(token)).status).toBe(401);
  } finally { await f.close(); }
}, 90_000);

test('civil birthdays use exact days, UTC thresholds and March 1 for non-leap anniversaries', () => {
  expect(ageAt('2008-10-02', new Date('2026-10-01T23:59:59Z'))).toBe(17);
  expect(ageAt('2008-10-02', new Date('2026-10-02T00:00:00Z'))).toBe(18);
  expect(ageAt('2008-02-29', new Date('2026-02-28T23:59:59Z'))).toBe(17);
  expect(ageAt('2008-02-29', new Date('2026-03-01T00:00:00Z'))).toBe(18);
  expect(ageAt('2008-02-29', new Date('2024-02-29T00:00:00Z'))).toBe(16);
  for (const invalid of ['2026-02-29', '2000-02-30', '2000-13-01', '2000-00-01', '1990-1-01', '2027-01-01', '1899-01-01'])
    expect(() => ageAt(invalid, new Date('2026-10-01'))).toThrow('invalid_birth_date');
});

test('settings API preserves independent intent, privacy, defaults and concurrent revisions', async () => {
  const f = await accountFixture();
  try {
    const user = await f.signup('categories@example.test');
    const change = (body: Record<string, unknown>, cookie = user.cookie, headers = {}) =>
      f.request('/api/account/content-preferences', body, cookie, headers);
    expect(await readContentPreferences(f.pool, user.id)).toMatchObject({ birthDate: null, nsfwDisplay: 'mask',
      birthdayPublic: false, categories: { general: true, r15: false, r18: false, r18g: false } });
    expect((await f.request('/api/account/content-preferences')).status).toBe(401);
    expect((await change({ expectedRevision: 0, categories: { general: false } }, user.cookie,
      { origin: 'https://evil.example' })).status).toBe(403);
    expect((await change({ expectedRevision: 0, categories: { general: false } })).status).toBe(200);
    expect(await (await change({ expectedRevision: 1, categories: { r15: true } })).json())
      .toEqual({ error: 'birth_date_required' });
    expect((await change({ expectedRevision: 1, birthDate: '1990-02-31' })).status).toBe(400);
    const birthday = await change({ expectedRevision: 1, birthDate: '1990-02-28', country: 'US' });
    expect(birthday.status, await birthday.clone().text()).toBe(200);
    expect(await birthday.json()).toMatchObject({ revision: 2, birthDate: '1990-02-28', birthdayPublic: false,
      categories: { general: false, r15: true, r18: false, r18g: false } });
    expect((await change({ expectedRevision: 1, categories: { general: true } })).status).toBe(409);
    await change({ expectedRevision: 2, categories: { r15: false, r18: true } });
    const edited = await change({ expectedRevision: 3, birthDate: '1991-03-01' });
    expect(await edited.json()).toMatchObject({ categories: { general: false, r15: false, r18: true, r18g: false } });
    const published = await change({ expectedRevision: 4, birthdayPublic: true });
    const publicId = (await published.json()).publicId as string;
    const publicRead = await f.request(`/api/account/birthday/${publicId}`);
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toEqual({ birthDate: '1991-03-01' });
    expect(publicRead.headers.get('cache-control')).toBe('no-store');
    const session = await f.auth.api.getSession({ headers: { cookie: user.cookie } });
    const archive = await exportAccountData(f.pool, f.secret, user.id, session!.session.id);
    expect(archive.contentPreferences).toMatchObject({ birthDate: '1991-03-01', birthdayPublic: true });
    await change({ expectedRevision: 5, birthdayPublic: false });
    expect((await f.request(`/api/account/birthday/${publicId}`)).status).toBe(404);
    const republished = await change({ expectedRevision: 6, birthdayPublic: true });
    expect((await republished.json()).publicId).not.toBe(publicId);
    const cleared = await change({ expectedRevision: 7, birthDate: null });
    expect(await cleared.json()).toMatchObject({ birthDate: null, birthdayPublic: false, publicId: null,
      age: 'unknown', categories: { general: false, r15: false, r18: true, r18g: false } });
  } finally { await f.close(); }
}, 60_000);

test('NSFW display defaults to a mask, preserves omitted intent, and uses the same revision fence', async () => {
  const f = await accountFixture();
  try {
    const user = await f.signup('nsfw-display@example.test');
    const change = (body: Record<string, unknown>) =>
      f.request('/api/account/content-preferences', body, user.cookie);
    expect(await (await change({ expectedRevision: 0, nsfwDisplay: 'show' })).json())
      .toMatchObject({ revision: 1, nsfwDisplay: 'show', birthDate: null,
        categories: { general: true, r15: false, r18: false, r18g: false } });
    expect(await (await change({ expectedRevision: 1, categories: { general: false } })).json())
      .toMatchObject({ revision: 2, nsfwDisplay: 'show', categories: { general: false } });
    expect((await change({ expectedRevision: 1, nsfwDisplay: 'mask' })).status).toBe(409);
    expect((await change({ expectedRevision: 2, nsfwDisplay: 'allow' })).status).toBe(400);
    expect(await (await change({ expectedRevision: 2, nsfwDisplay: 'mask' })).json())
      .toMatchObject({ revision: 3, nsfwDisplay: 'mask', categories: { general: false, r18: false } });
    const session = await f.auth.api.getSession({ headers: { cookie: user.cookie } });
    expect((await exportAccountData(f.pool, f.secret, user.id, session!.session.id)).contentPreferences.nsfwDisplay)
      .toBe('mask');
  } finally { await f.close(); }
}, 60_000);

test('restricted categories use exact age and trusted ingress country; known underage revokes admission', async () => {
  const f = await accountFixture();
  const proxy = createAccountApp(f.auth, f.pool, { trustedProxyPeers: new Set(['127.0.0.1']) })
    .listen({ hostname: '127.0.0.1', port: await freePort() });
  try {
    const user = await f.signup('market-categories@example.test');
    const now = new Date('2026-10-01T00:00:00Z');
    await writeContentPreferences(f.pool, user.id, { expectedRevision: 0, birthDate: '2009-10-01', country: 'US' }, null, now);
    await expect(writeContentPreferences(f.pool, user.id, { expectedRevision: 1, categories: { r18: true } }, null, now))
      .rejects.toThrow('age_ineligible');
    await writeContentPreferences(f.pool, user.id, { expectedRevision: 1, birthDate: '1990-10-01' }, null, now);
    const changed = await fetch(`http://127.0.0.1:${proxy.server!.port!}/api/account/content-preferences`, {
      method: 'POST', headers: { cookie: user.cookie, origin: f.baseURL, 'content-type': 'application/json',
        'cf-ipcountry': 'KR' }, body: JSON.stringify({ expectedRevision: 2, country: 'US', categories: { r18: true } }) });
    expect(await changed.json()).toEqual({ error: 'market_restricted' });
    const forged = await f.request('/api/account/content-preferences', { expectedRevision: 2,
      country: 'KR', categories: { r18g: true } }, user.cookie, { 'cf-ipcountry': 'US', 'x-rezics-request-country': 'US' });
    expect(await forged.json()).toEqual({ error: 'market_restricted' });
    const held = await writeContentPreferences(f.pool, user.id, { expectedRevision: 2,
      birthDate: '2020-10-01', categories: { r18: true } }, null, now);
    expect(held.accountEligible).toBe(false);
    expect(held.categories.r18).toBe(false);
    expect(Number((await f.pool.query('SELECT count(*) FROM "session" WHERE "userId" = $1', [user.id])).rows[0].count)).toBe(0);
    expect((await f.pool.query('SELECT suspension_code FROM rezics_account_security WHERE user_id = $1', [user.id])).rows[0].suspension_code)
      .toBe('age_requirement');
  } finally { await proxy.stop(); await f.close(); }
}, 60_000);

test('the same OAuth token observes live settings without receiving the raw birthday', async () => {
  const f = await accountFixture();
  let main: ReturnType<typeof createAccountApp> | undefined;
  try {
    const user = await f.signup('live-age@example.test');
    const oauth = await oauthFixture(f), app = await oauth.createClient(true);
    const tokens = await oauth.issue(app.client_id, user.cookie);
    expect((await oauth.introspect(tokens.access_token)).rezics_content_evidence).toBeUndefined();
    main = createAccountApp(f.auth, f.pool, { contentEvidenceSecret: oauth.verifier.client_secret! })
      .listen({ hostname: '127.0.0.1', port: await freePort() });
    const inspect = async () => {
      const response = await fetch(`http://127.0.0.1:${main!.server!.port!}/api/auth/oauth2/introspect`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.access_token, client_id: oauth.verifier.client_id,
          client_secret: oauth.verifier.client_secret! }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    };
    expect((await inspect()).rezics_content_evidence)
      .toMatchObject({ age: 'unknown', nsfwDisplay: 'mask',
        categories: { general: true, r15: false, r18: false, r18g: false } });
    await writeContentPreferences(f.pool, user.id, { expectedRevision: 0, birthDate: '1990-01-01', country: 'US',
      categories: { r18g: true }, nsfwDisplay: 'show' }, null);
    const live = await inspect();
    expect(live.rezics_content_evidence).toMatchObject({ age: 'adult', adultAvailable: true, nsfwDisplay: 'show',
      categories: { general: true, r15: true, r18: false, r18g: true } });
    expect(JSON.stringify(live)).not.toContain('1990-01-01');
    expect(JSON.stringify(JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString())))
      .not.toMatch(/birth|content_evidence/);
    await writeContentPreferences(f.pool, user.id, { expectedRevision: 1, categories: { r15: false, r18g: false } }, null);
    expect((await inspect()).rezics_content_evidence)
      .toMatchObject({ nsfwDisplay: 'show', categories: { r15: false, r18g: false } });
  } finally { await main?.stop(); await f.close(); }
}, 60_000);
