import { expect, test } from 'bun:test';
import { accountFixture, freePort } from './account-fixture.ts';
import { createAccountApp } from '../src/app.ts';
import { createAccountAuth } from '../src/auth.ts';
import { POLICY_VERSIONS } from '../src/policy-versions.ts';
import { accountEmailQueue } from '../src/email.ts';
import {
  accountMailReport,
  mailEventSignature,
  optionalMailSuppressed,
  readUnsubscribeToken,
  unsubscribeToken,
  UNSUBSCRIBE_SECONDS,
} from '../src/mail-suppression.ts';
import { policyAcceptanceRequired } from '../src/policy-acceptance.ts';
import { MARKET_POLICY_VERSION } from '../src/market-policy.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { accountRecoveryCoverage } from '../src/recovery-coverage.ts';

const acceptedPolicies = POLICY_VERSIONS.map(({ policyId, versionDigest }) => ({
  policyId,
  versionDigest,
}));
const signupBody = {
  name: 'Policy Member',
  password: 'a sufficiently long password',
  acceptedPolicies,
};
const month = (date: Date) => date.toISOString().slice(0, 7);

test('G-731 API: country minimum boundaries, missing birth, unavailable market and forged ingress', async () => {
  const f = await accountFixture();
  const proxy = createAccountApp(f.auth, f.pool, {
    trustedProxyPeers: new Set(['127.0.0.1']),
  }).listen({ hostname: '127.0.0.1', port: await freePort() });
  let sequence = 0;
  const signup = (
    country?: string,
    birthMonth?: string,
    port = proxy.server!.port!,
    headers = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        origin: f.baseURL,
        'content-type': 'application/json',
        ...(country ? { 'cf-ipcountry': country } : {}),
        ...headers,
      },
      body: JSON.stringify({ ...signupBody, email: `age-${sequence++}@example.test`, birthMonth }),
    });
  try {
    const now = new Date();
    for (const [country, minimumAge] of [
      ['KR', 14],
      ['DE', 16],
      ['US', 13],
    ] as const) {
      for (const offset of [-1, 0, 1]) {
        const birthMonth = month(
          new Date(Date.UTC(now.getUTCFullYear() - minimumAge, now.getUTCMonth() + offset, 1)),
        );
        const response = await signup(country, birthMonth);
        expect(response.status, await response.clone().text()).toBe(offset === -1 ? 200 : 400);
        if (offset !== -1)
          expect(await response.json()).toMatchObject({ reason: 'market_minimum_age', minimumAge });
      }
    }
    expect(await (await signup('US')).json()).toMatchObject({ reason: 'birth_month_required' });
    expect(await (await signup('CN', '1990-01')).json()).toMatchObject({
      reason: 'market_unavailable',
    });
    const young = month(new Date(Date.UTC(now.getUTCFullYear() - 14, now.getUTCMonth() - 1, 1)));
    expect(
      await (
        await signup('US', young, Number(new URL(f.baseURL).port), {
          'x-rezics-request-country': 'US',
        })
      ).json(),
    ).toMatchObject({ reason: 'market_minimum_age', minimumAge: 16 });
    for (const country of [undefined, 'XX', 'us', 'US,KR']) {
      expect(await (await signup(country, young)).json()).toMatchObject({
        reason: 'market_minimum_age',
        minimumAge: 16,
      });
    }
    const noAcceptance = await f.request('/api/auth/sign-up/email', {
      ...signupBody,
      email: 'no-acceptance@example.test',
      birthMonth: '1990-01',
      acceptedPolicies: [],
    });
    expect(await noAcceptance.json()).toMatchObject({ reason: 'policy_acceptance_required' });
    const { rows } = await f.pool.query(
      'SELECT registration_policy_version, signup_policies FROM "user"',
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          row.registration_policy_version === MARKET_POLICY_VERSION && row.signup_policies === null,
      ),
    ).toBe(true);
    expect(
      Number((await f.pool.query('SELECT count(*) FROM rezics_policy_acceptance')).rows[0].count),
    ).toBe(6);
    expect(
      (
        await f.pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'birth_month'`)
      ).rowCount,
    ).toBe(0);
  } finally {
    await proxy.stop();
    await f.close();
  }
}, 60_000);

test('G-731 API: durable receipts, material update, stale/denied acceptance, replay and private birth input', async () => {
  const f = await accountFixture();
  const changed = POLICY_VERSIONS.map((policy) =>
    policy.policyId === 'terms'
      ? { ...policy, versionDigest: 'a'.repeat(64), acceptanceDigests: ['a'.repeat(64)] }
      : policy,
  );
  const auth = createAccountAuth({
    ...f.config,
    policyVersions: changed,
    policyAcceptanceEnforced: true,
  });
  const app = createAccountApp(auth, f.pool).listen({
    hostname: '127.0.0.1',
    port: await freePort(),
  });
  const request = (path: string, body?: unknown, cookie?: string, origin = f.baseURL) =>
    fetch(`http://127.0.0.1:${app.server!.port!}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const user = await f.signup('policy@example.test');
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    const legacy = await f.signup('legacy-policy@example.test');
    await f.pool.query('DELETE FROM rezics_policy_acceptance WHERE user_id = $1', [legacy.id]);
    expect(await policyAcceptanceRequired(f.pool, legacy.id)).toBe(true);
    // With enforcement off by default, a pre-journal account can still finish
    // authorization while G-736 builds the re-acceptance page.
    expect(
      await oauth.introspect((await oauth.issue(client.client_id, legacy.cookie)).access_token),
    ).toMatchObject({ active: true });
    const tokens = await oauth.issue(client.client_id, user.cookie);
    const introspection = (await oauth.introspect(tokens.access_token)) as Record<string, unknown>;
    expect(introspection.active).toBe(true);
    expect(
      Object.keys(introspection).some((key) => /age.?band|adult|birth.?month/i.test(key)),
    ).toBe(false);
    const blockedAuthorization = await request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'https://notes.example.test/callback',
        scope: 'openid work:read',
        state: 'material-policy-update',
        resource: f.config.resource,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
      undefined,
      user.cookie,
    );
    expect(blockedAuthorization.status).toBe(403);
    expect(await blockedAuthorization.json()).toMatchObject({ code: 'policy_acceptance_required' });
    expect(await policyAcceptanceRequired(f.pool, user.id)).toBe(false);
    expect(await policyAcceptanceRequired(f.pool, user.id, changed)).toBe(true);
    const session = (await (
      await f.request('/api/auth/get-session', undefined, user.cookie)
    ).json()) as { user: Record<string, unknown> };
    expect(session.user.birthMonth).toBeUndefined();
    expect(session.user.registrationPolicyVersion).toBeUndefined();
    expect(session.user.signupPolicies).toBeUndefined();
    expect(session.user.ageBand).toBeUndefined();
    expect(session.user.adultAvailable).toBeUndefined();
    expect(
      await (await request('/api/account/policies', undefined, user.cookie)).json(),
    ).toMatchObject({ acceptanceRequired: true });
    const current = {
      acceptedPolicies: changed.map(({ policyId, versionDigest }) => ({ policyId, versionDigest })),
    };
    expect((await request('/api/account/policies/acceptance', current)).status).toBe(401);
    expect(
      (
        await request(
          '/api/account/policies/acceptance',
          current,
          user.cookie,
          'https://forged.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/account/policies/acceptance', { acceptedPolicies }, user.cookie)).status,
    ).toBe(409);
    const concurrent = await Promise.all(
      [1, 2].map(() => request('/api/account/policies/acceptance', current, user.cookie)),
    );
    expect(concurrent.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await (await request('/api/account/policies', undefined, user.cookie)).json(),
    ).toMatchObject({ acceptanceRequired: false });
    const receipts = (
      await f.pool.query(
        `SELECT policy_id, version_digest, accepted_at FROM rezics_policy_acceptance
      WHERE user_id = $1 ORDER BY policy_id, version_digest`,
        [user.id],
      )
    ).rows;
    expect(receipts).toHaveLength(3);
    expect(receipts.every((row) => row.accepted_at instanceof Date)).toBe(true);
    await request('/api/account/policies/acceptance', current, user.cookie);
    expect(
      (
        await f.pool.query(
          `SELECT policy_id, version_digest, accepted_at FROM rezics_policy_acceptance
      WHERE user_id = $1 ORDER BY policy_id, version_digest`,
          [user.id],
        )
      ).rows,
    ).toEqual(receipts);
    const editorial = changed.map((policy) => ({ ...policy, versionDigest: 'b'.repeat(64) }));
    expect(await policyAcceptanceRequired(f.pool, user.id, editorial)).toBe(false);
    // Retained versions must not turn the current-policy check into a journal
    // scan. Exercise the real owner index with a long history for this user.
    await f.pool.query(
      `INSERT INTO rezics_policy_acceptance (user_id, policy_id, version_digest)
      SELECT $1, 'terms', md5(n::text) || md5((n + 1000)::text) FROM generate_series(1, 1000) n`,
      [user.id],
    );
    await f.pool.query('ANALYZE rezics_policy_acceptance');
    expect(await policyAcceptanceRequired(f.pool, user.id, changed)).toBe(false);
    const plan = await f.pool.query(
      `EXPLAIN (FORMAT JSON) SELECT 1 FROM rezics_policy_acceptance
      WHERE user_id = $1 AND policy_id = 'terms' AND version_digest = $2`,
      [user.id, changed[0]!.versionDigest],
    );
    expect(JSON.stringify(plan.rows)).toContain('Index');
    // Policy receipt failure must roll back the user, rather than leave enrollment
    // half-complete and silently permit a person without their acknowledgement.
    await f.pool
      .query(`CREATE FUNCTION reject_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'receipt unavailable'; END $$; CREATE TRIGGER reject_policy_receipt
      BEFORE INSERT ON rezics_policy_acceptance FOR EACH ROW EXECUTE FUNCTION reject_policy_receipt()`);
    expect(
      (
        await f.request('/api/auth/sign-up/email', {
          email: 'rollback@example.test',
          ...signupBody,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await f.pool.query('SELECT 1 FROM "user" WHERE email = $1', ['rollback@example.test']))
        .rowCount,
    ).toBe(0);
  } finally {
    await app.stop();
    await f.close();
  }
}, 60_000);

test('G-731 API: signed one-click, GET confirmation, expired/tampered/replayed tokens, queue suppression and reset mail', async () => {
  const f = await accountFixture();
  const app = createAccountApp(f.auth, f.pool, {
    notificationDigest: { accountSecret: f.secret, mainSecret: 'main' },
  }).listen({ hostname: '127.0.0.1', port: await freePort() });
  const sent: { to: string; headers?: Record<string, string> }[] = [];
  const queue = accountEmailQueue(
    f.pool,
    f.secret,
    async (mail) => {
      sent.push(mail);
    },
    f.baseURL,
  );
  try {
    const user = await f.signup('unsubscribe@example.test');
    const digest = {
      userId: user.id,
      to: user.email,
      purpose: 'digest' as const,
      locale: 'en' as const,
      url: f.baseURL,
      message: 'One mention',
    };
    await queue.enqueue(digest);
    await queue.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = sent[0]!.headers!['List-Unsubscribe']!.slice(1, -1);
    const token = new URL(link).searchParams.get('token')!;
    expect(Buffer.from(token.split('.')[0]!, 'base64url').toString()).not.toContain(user.email);
    expect(readUnsubscribeToken(f.secret, token)).toMatchObject({
      userId: user.id,
      purpose: 'digest',
    });
    expect((await fetch(link)).status).toBe(200);
    expect(await optionalMailSuppressed(f.pool, user.email)).toBe(false);
    await queue.enqueue(digest); // Already queued when unsubscribe arrives.
    const unsubscribe = (value: string) =>
      fetch(`${f.baseURL}/api/account/mail/unsubscribe?token=${value}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
    expect((await unsubscribe(token + 'x')).status).toBe(400);
    const badForm = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=Wrong',
    });
    expect(badForm.status).toBe(400);
    expect(await optionalMailSuppressed(f.pool, user.email)).toBe(false);
    expect(
      (
        await unsubscribe(
          unsubscribeToken(
            f.secret,
            user.id,
            user.email,
            Math.floor(Date.now() / 1_000) - UNSUBSCRIBE_SECONDS,
          ),
        )
      ).status,
    ).toBe(400);
    const beforeSuppression = await accountRecoveryCoverage(f.pool);
    const concurrent = await Promise.all([unsubscribe(token), unsubscribe(token)]);
    expect(concurrent.map((r) => r.status)).toEqual([204, 204]);
    expect(await optionalMailSuppressed(f.pool, user.email.toUpperCase())).toBe(true);
    const afterSuppression = await accountRecoveryCoverage(f.pool);
    expect(BigInt(afterSuppression.rowCount)).toBe(BigInt(beforeSuppression.rowCount) + 1n);
    expect(afterSuppression.rowDigest).not.toBe(beforeSuppression.rowDigest);
    await queue.drain();
    await queue.enqueue(digest);
    await queue.drain();
    expect(sent).toHaveLength(1);
    const intake = await fetch(
      `http://127.0.0.1:${app.server!.port!}/api/internal/notification-digest`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer main', 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          day: '2026-01-01',
          counts: [{ topic: 'mention', count: 1 }],
          more: false,
        }),
      },
    );
    expect(intake.status).toBe(204);
    expect(
      (await f.request('/api/auth/request-password-reset', { email: user.email })).status,
    ).toBe(200);
    await queue.drain();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers).toBeUndefined();
    for (const purpose of ['verify', 'change-email', 'notice'] as const) {
      await queue.enqueue({ ...digest, purpose });
    }
    await queue.drain();
    expect(sent).toHaveLength(5);
    expect(sent.slice(1).every((mail) => !mail.headers)).toBe(true);
    await f.pool.query('UPDATE "user" SET email = $2 WHERE id = $1', [
      user.id,
      'replacement@example.test',
    ]);
    await unsubscribe(token);
    expect(await optionalMailSuppressed(f.pool, 'replacement@example.test')).toBe(false);
    await queue.enqueue({ ...digest, purpose: 'reset', to: 'replacement@example.test' });
    await f.pool
      .query(`UPDATE rezics_account_email SET state = 'sending', started_at = now() - interval '3 minutes'
      WHERE state = 'queued'`);
    await queue.drain();
    expect(await accountMailReport(f.pool)).toEqual({
      uncertain: '1',
      suppressed: [{ reason: 'unsubscribe', count: '1' }],
    });
    await queue.drain();
    expect(sent).toHaveLength(5);
    // An already-started SMTP call may finish, but it must not delay an
    // unsubscribe acknowledgement by holding a mailbox/database lock.
    const smtpStarted = Promise.withResolvers<void>();
    const resumeSmtp = Promise.withResolvers<void>();
    const stalledQueue = accountEmailQueue(
      f.pool,
      f.secret,
      async () => {
        smtpStarted.resolve();
        await resumeSmtp.promise;
      },
      f.baseURL,
    );
    await stalledQueue.enqueue({ ...digest, to: 'replacement@example.test' });
    const draining = stalledQueue.drain();
    try {
      await smtpStarted.promise;
      const replacementToken = unsubscribeToken(f.secret, user.id, 'replacement@example.test');
      const response = await fetch(
        `${f.baseURL}/api/account/mail/unsubscribe?token=${replacementToken}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          signal: AbortSignal.timeout(5_000),
        },
      );
      expect(response.status).toBe(204);
      expect(await optionalMailSuppressed(f.pool, 'replacement@example.test')).toBe(true);
    } finally {
      resumeSmtp.resolve();
      await draining;
    }
  } finally {
    await app.stop();
    await f.close();
  }
}, 60_000);

test('G-731 API: authenticated hard bounce/complaint, forged/stale events, idempotent suppression and disabled intake', async () => {
  const f = await accountFixture();
  const secret = 'mail-events-secret-at-least-32-characters';
  const app = createAccountApp(f.auth, f.pool, { mailEventsSecret: secret }).listen({
    hostname: '127.0.0.1',
    port: await freePort(),
  });
  const event = {
    source: 'smtp-adapter',
    eventId: 'bounce-1',
    type: 'hard_bounce',
    address: ' BOUNCE@example.test ',
  };
  const raw = JSON.stringify(event);
  const send = (body = raw, key = secret, timestamp = String(Math.floor(Date.now() / 1_000))) =>
    fetch(`http://127.0.0.1:${app.server!.port!}/api/internal/mail-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rezics-mail-timestamp': timestamp,
        'x-rezics-mail-signature': mailEventSignature(key, timestamp, body),
      },
      body,
    });
  try {
    expect((await f.request('/api/internal/mail-events', event)).status).toBe(404);
    expect((await send(raw, 'forged')).status).toBe(403);
    expect((await send(raw, secret, String(Math.floor(Date.now() / 1_000) - 301))).status).toBe(
      403,
    );
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const forgedBody = await fetch(
      `http://127.0.0.1:${app.server!.port!}/api/internal/mail-events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rezics-mail-timestamp': timestamp,
          'x-rezics-mail-signature': mailEventSignature(secret, timestamp, raw),
        },
        body: raw.replace('bounce-1', 'tampered'),
      },
    );
    expect(forgedBody.status).toBe(403);
    expect((await send(JSON.stringify({ ...event, type: 'soft_bounce' }))).status).toBe(400);
    expect(await optionalMailSuppressed(f.pool, 'bounce@example.test')).toBe(false);
    expect((await Promise.all([send(), send()])).map((r) => r.status)).toEqual([204, 204]);
    expect(await optionalMailSuppressed(f.pool, 'bounce@example.test')).toBe(true);
    expect(
      (await f.pool.query(`SELECT to_regclass('public.rezics_mail_event') AS name`)).rows[0].name,
    ).toBeNull();
    expect(
      (
        await f.pool.query(
          `SELECT source, suppressed_at FROM rezics_mail_suppression WHERE address = 'bounce@example.test'`,
        )
      ).rows[0].source,
    ).toBe('smtp-adapter:bounce-1');
    expect(
      (
        await send(
          JSON.stringify({
            ...event,
            eventId: 'complaint-1',
            type: 'complaint',
            address: 'complaint@example.test',
          }),
        )
      ).status,
    ).toBe(204);
    expect(await accountMailReport(f.pool)).toEqual({
      uncertain: '0',
      suppressed: [
        { reason: 'complaint', count: '1' },
        { reason: 'hard_bounce', count: '1' },
      ],
    });
  } finally {
    await app.stop();
    await f.close();
  }
}, 60_000);
