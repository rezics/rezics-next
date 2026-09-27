import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

test('Verified signup creates a usable Account session without another sign-in', async () => {
  const f = await accountFixture();
  try {
    const email = 'verified-handoff@example.test';
    const created = await f.request('/api/auth/sign-up/email', {
      email, name: 'Verified Person', password: 'correct horse battery staple',
      callbackURL: '/verify-email?next=%2Fpersonal-info',
    });
    expect(created.status).toBe(200);
    await f.email.drain();
    const mail = f.messages.find(message => message.to === email)!;
    const url = /https?:\/\/\S+/.exec(mail.text)![0];
    const verified = await f.request(url);
    expect(verified.status).toBe(302);
    const cookie = verified.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const session = await (await f.request('/api/auth/get-session', undefined, cookie!)).json() as {
      user?: { email: string } };
    expect(session.user?.email).toBe(email);
    const activity = await (await f.request('/api/account/security-activity', undefined, cookie!)).json() as {
      items: { action: string; detail: { method?: string } }[] };
    expect(activity.items.some(item => item.action === 'sign_in' && item.detail.method === 'verified-email')).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test('Account sessions group by client and user agent and revoke every session in one group', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('grouped-sessions@example.test');
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    const browser = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0';
    const signIn = () => f.request('/api/auth/sign-in/email',
      { email: member.email, password: member.password }, undefined, { 'user-agent': browser });
    const first = await signIn();
    const second = await signIn();
    const firstCookie = first.headers.get('set-cookie')!;
    const secondCookie = second.headers.get('set-cookie')!;
    const sessions = await (await f.request('/api/account/sessions?limit=100', undefined, member.cookie)).json() as {
      items: { id: string; groupKey: string; clientName: string | null; thisDevice: boolean;
        device: { browser: string; platform: string | null } }[] };
    const chrome = sessions.items.filter(item => item.device.browser === 'Chrome');
    expect(chrome).toHaveLength(2);
    expect(chrome[0]!.groupKey).toBe(chrome[1]!.groupKey);
    expect(chrome[0]!.device.platform).toBe('Linux');
    expect(chrome.every(item => !item.thisDevice)).toBe(true);
    const revoked = await f.request('/api/account/sessions/revoke',
      { sessionIds: chrome.map(item => item.id) }, member.cookie);
    expect(await revoked.json()).toEqual({ revoked: 2 });
    expect(await (await f.request('/api/auth/get-session', undefined, firstCookie)).json()).toBeNull();
    expect(await (await f.request('/api/auth/get-session', undefined, secondCookie)).json()).toBeNull();
    expect((await f.request('/api/auth/get-session', undefined, member.cookie)).status).toBe(200);

    await oauth.code(client.client_id, member.cookie);
    const withClient = await (await f.request('/api/account/sessions?limit=100', undefined, member.cookie)).json() as {
      items: { thisDevice: boolean; clientName: string | null; groupKey: string }[] };
    expect(withClient.items.find(item => item.thisDevice)?.clientName).toBe('Trusted app');
  } finally { await f.close(); }
}, 60_000);
