import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

test('G438 admin mail uses the recipient language, and a Japanese operator can start a bulk job', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const german = await f.signup('de@example.test');
    const japanese = await f.signup('ja@example.test');
    const korean = await f.signup('ko@example.test');
    await f.pool.query(`UPDATE "user" SET locale = 'de', signup_locale = 'en' WHERE id = $1`, [german.id]);
    await f.pool.query(`UPDATE "user" SET locale = NULL, signup_locale = 'ja' WHERE id = $1`, [japanese.id]);
    await f.pool.query(`UPDATE "user" SET locale = NULL, signup_locale = 'ko', "emailVerified" = false WHERE id = $1`, [korean.id]);
    const bulk = { action: 'suspend', reasonCode: 'spam', reason: 'Posted spam', commandId: randomUUID(),
      userIds: [german.id, japanese.id], userMessage: 'Please write to support.' };
    const started = await f.request('/api/account/admin/bulk-actions', bulk, owner.cookie, { 'accept-language': 'ja' });
    expect(started.status).toBe(200);
    const { jobId } = await started.json() as { jobId: string };
    expect((await f.pool.query<{ locale: string }>('SELECT locale FROM rezics_account_operator_job WHERE id = $1', [jobId])).rows[0]?.locale)
      .toBe('ja');
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = await f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, owner.cookie);
      if ((await job.json() as { finishedAt: string | null }).finishedAt) break;
      await Bun.sleep(100);
      if (attempt === 199) throw new Error('Bulk job did not finish');
    }
    await f.email.drain();
    const notice = (address: string) => f.messages.find(message => message.to === address && message.subject.includes('REZICS'))!;
    const germanMail = notice(german.email);
    const japaneseMail = notice(japanese.email);
    expect(germanMail.html).toContain('lang="de"');
    expect(germanMail.subject).toBe('Eine Nachricht zu Ihrem REZICS-Konto');
    expect(japaneseMail.html).toContain('lang="ja"');
    expect(japaneseMail.subject).not.toBe(germanMail.subject);
    const resent = await f.request(`/api/account/admin/users/${korean.id}/actions`, {
      commandId: randomUUID(), action: 'resend-verification', reasonCode: 'support', reason: 'Asked for another link',
    }, owner.cookie, { 'accept-language': 'ja' });
    expect(resent.status).toBe(200);
    await f.email.drain();
    const verification = f.messages.find(message => message.to === korean.email && message.html.includes('lang="ko"'));
    expect(verification?.subject).toBe('이메일 주소 확인');
  } finally { await f.close(); }
}, 90_000);
