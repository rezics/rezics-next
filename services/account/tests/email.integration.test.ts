import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { accountFixture } from './account-fixture.ts';
import { accountEmailQueue, renderAccountEmail, smtpSender } from '../src/email.ts';

test('G205 email: verification, localized delivery, reset replay/concurrency and enumeration', async () => {
  const f = await accountFixture();
  try {
    const body = { email: 'member@example.test', name: '<Member>', password: 'a sufficiently long password' };
    const first = await f.request('/api/auth/sign-up/email', body, undefined, { 'accept-language': 'zh-CN' });
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toBeNull();
    expect(await first.json()).toEqual({ status: true });
    expect(await (await f.request('/api/auth/sign-up/email', body)).json()).toEqual({ status: true });
    expect((await f.request('/api/auth/sign-in/email', body)).status).toBe(403);
    await f.email.drain();
    const mail = f.messages[0]!;
    expect(mail.subject).toBe('验证邮箱地址');
    expect(mail.html).toContain('lang="zh-Hans"');
    expect((await f.pool.query('SELECT payload FROM rezics_account_email')).rows.every(row => row.payload === null)).toBe(true);
    const verify = /https?:\/\/\S+/.exec(mail.text)![0];
    expect((await f.request(verify)).status).toBe(302);
    const signIn = await f.request('/api/auth/sign-in/email', body);
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!;
    const existing = await f.request('/api/auth/request-password-reset', { email: body.email,
      redirectTo: `${f.baseURL}/reset-password` });
    const absent = await f.request('/api/auth/request-password-reset', { email: 'missing@example.test',
      redirectTo: `${f.baseURL}/reset-password` });
    expect(existing.status).toBe(absent.status);
    expect(await existing.json()).toEqual(await absent.json());
    await f.email.drain();
    const reset = [...f.messages].reverse().find(message => message.subject === '重置密码')!;
    const link = /https?:\/\/\S+/.exec(reset.text)![0];
    const callback = await f.request(link);
    const token = new URL(callback.headers.get('location')!).searchParams.get('token');
    const attempts = await Promise.all([1, 2].map(() => f.request('/api/auth/reset-password',
      { token, newPassword: 'a different long password' })));
    expect(attempts.map(response => response.status).sort()).toEqual([200, 400]);
    expect(await (await f.request('/api/auth/get-session', undefined, cookie)).json()).toBeNull();
    expect((await f.request('/api/auth/sign-in/email', body)).status).toBe(401);
    expect((await f.request('/api/auth/sign-in/email', { ...body, password: 'a different long password' })).status).toBe(200);
    const limits = await Promise.all(Array.from({ length: 4 }, () => f.request('/api/auth/send-verification-email',
      { email: 'never-existed@example.test' })));
    expect(limits.map(response => response.status).sort()).toEqual([200, 200, 200, 429]);
    const stale = await f.request('/api/auth/reset-password', { token: 'stale', newPassword: body.password });
    expect(stale.status).toBe(400);
  } finally { await f.close(); }
}, 60_000);

test('G205 email: SMTP sends both text and HTML without external network delivery', async () => {
  const messages: string[] = [];
  const server = createServer(socket => {
    socket.write('220 localhost SMTP ready\r\n');
    let buffer = '';
    let data = false;
    let message = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data && line !== '.') { message += `${line}\r\n`; continue; }
        if (data) { messages.push(message); data = false; socket.write('250 accepted\r\n'); }
        else if (line.startsWith('DATA')) { data = true; socket.write('354 send message\r\n'); }
        else if (line.startsWith('QUIT')) socket.end('221 goodbye\r\n');
        else socket.write('250 localhost\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP port unavailable');
  try {
    const send = smtpSender({ host: '127.0.0.1', port: address.port, secure: false,
      requireTLS: false, user: '', password: '', from: 'REZICS <accounts@example.test>' });
    await send({ id: 'smtp-test', to: 'recipient@example.test',
      ...renderAccountEmail('verify', 'en', 'https://accounts.example.test/verify') });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Content-Type: multipart/alternative');
    expect(messages[0]).toContain('Content-Type: text/plain');
    expect(messages[0]).toContain('Content-Type: text/html');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('G205 email: changing an address confirms the old mailbox before verifying the new one', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('old@example.test');
    const changed = await f.request('/api/auth/change-email', { newEmail: 'new@example.test', callbackURL: '/' }, member.cookie);
    expect(changed.status).toBe(200);
    await f.email.drain();
    const old = f.messages.at(-1)!;
    expect(old.to).toBe(member.email);
    expect(old.subject).toBe('Confirm your email change');
    expect((await f.pool.query('SELECT email FROM "user" WHERE id = $1', [member.id])).rows[0].email).toBe(member.email);
    await f.request(/https?:\/\/\S+/.exec(old.text)![0], undefined, member.cookie);
    await f.email.drain();
    const next = f.messages.at(-1)!;
    expect(next.to).toBe('new@example.test');
    await f.request(/https?:\/\/\S+/.exec(next.text)![0], undefined, member.cookie);
    expect((await f.pool.query('SELECT email, "emailVerified" FROM "user" WHERE id = $1', [member.id])).rows[0])
      .toEqual({ email: 'new@example.test', emailVerified: true });
  } finally { await f.close(); }
}, 60_000);

test('G205 email: sender failure is private; concurrent delivery claims once and expires obsolete links', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('delivery@example.test');
    let attempts = 0;
    const queue = accountEmailQueue(f.pool, f.secret, async () => { attempts++; throw new Error('uncertain DATA'); });
    await queue.enqueue({ userId: member.id, to: member.email, url: `${f.baseURL}/reset-password`, purpose: 'reset', locale: 'en' });
    await Promise.all([queue.drain(), queue.drain()]);
    expect(attempts).toBe(1);
    expect((await f.pool.query(`SELECT payload FROM rezics_account_email WHERE state = 'uncertain'`)).rows).toEqual([{ payload: null }]);
    await queue.drain();
    expect(attempts).toBe(1);
    await queue.enqueue({ userId: member.id, to: 'old@example.test', url: f.baseURL, purpose: 'reset', locale: 'en' });
    await queue.drain();
    expect(attempts).toBe(1);
    expect(renderAccountEmail('verify', 'en', `${f.baseURL}/?q="<x>`).html).not.toContain('"<x>');
    await queue.enqueue({ userId: 'signup-not-committed-yet', to: 'new@example.test', url: f.baseURL, purpose: 'verify', locale: 'en' });
    await queue.enqueue({ userId: member.id, to: member.email, url: f.baseURL, purpose: 'reset', locale: 'en' });
    await queue.drain();
    expect(attempts).toBe(2); // An uncommitted signup must not starve ready mail.
    await f.pool.query(`CREATE FUNCTION reject_email_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'queue unavailable probe'; END $$;
      CREATE TRIGGER reject_email_probe BEFORE INSERT ON rezics_account_email
      FOR EACH ROW EXECUTE FUNCTION reject_email_probe()`);
    const known = await f.request('/api/auth/request-password-reset', { email: member.email });
    const unknown = await f.request('/api/auth/request-password-reset', { email: 'unknown@example.test' });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  } finally { await f.close(); }
}, 60_000);
