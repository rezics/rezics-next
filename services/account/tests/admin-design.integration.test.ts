import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

type Fixture = Awaited<ReturnType<typeof accountFixture>>;
type Person = Awaited<ReturnType<Fixture['signup']>>;
interface Page<T> { items: T[]; nextCursor: string | null }
interface Signal { key: string; kind: string; severity: string; subject: { kind: string; id: string; email: string | null };
  evidence: Record<string, unknown> }
interface Signals { items: Signal[]; counts: Record<string, { count: number; capped: boolean }>; reviewedLastDay: number }
interface Line { id: string; source: string; action: string; detail: Record<string, unknown>; occurredAt: string;
  staff: { actorEmail: string | null; reason: string; reasonCode: string | null; userMessage: string | null } | null;
  note: { body: string; authorEmail: string | null } | null }
interface Job { id: string; startsAt: string; finishedAt: string | null; cancelledAt: string | null; pending: number;
  succeeded: number; cancelled: number; items: { userId: string; state: string }[] }
interface Entry { action: string; targetId: string; reason: string; reasonCode: string | null; requestId: string;
  after: Record<string, unknown> | null }

const json = async <T>(response: Response | Promise<Response>) => {
  const resolved = await response;
  if (!resolved.ok) throw new Error(`${resolved.status} ${await resolved.clone().text()}`);
  return await resolved.json() as T;
};
const act = (f: Fixture, userId: string, body: Record<string, unknown>, cookie: string) =>
  json<{ requestId: string }>(f.request(`/api/account/admin/users/${userId}/actions`, { commandId: randomUUID(), ...body }, cookie));
/** Moves a sign-in outside the five-minute step-up window. */
const age = (f: Fixture, person: Person) => f.pool.query(`UPDATE "session" SET "createdAt" = now() - interval '1 hour'
  WHERE "userId" = $1`, [person.id]);
const fail = (f: Fixture, person: Person, times: number) => Promise.all(Array.from({ length: times }, () =>
  f.request('/api/auth/sign-in/email', { email: person.email, password: 'not the password at all' })));
const event = (f: Fixture, userId: string, action: string, ago: string, detail: object = {}) => f.pool.query(`INSERT INTO
  rezics_account_security_event (user_id, action, detail, occurred_at) VALUES ($1, $2, $3, now() - $4::interval)`,
[userId, action, JSON.stringify(detail), ago]);

interface PlanNode { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] }
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
/** Rows a scan node looked at, over all its loops: those it returned and those its filters threw away. */
const examined = (node: PlanNode) => (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
  + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'];
/** Runs `work` and returns the executed plan of every read it sent through
 * the service's pool, for work checks against seeded history. */
async function observe(f: Fixture, work: () => Promise<unknown>) {
  const reads: { text: string; values: unknown[] }[] = [];
  const query = f.pool.query.bind(f.pool);
  f.pool.query = ((text: unknown, values?: unknown[]) => {
    if (typeof text === 'string' && /^\s*(WITH|SELECT)\b/i.test(text)) reads.push({ text, values: values ?? [] });
    return query(text as string, values);
  }) as typeof f.pool.query;
  try { await work(); } finally { f.pool.query = query; }
  return Promise.all(reads.map(async read => ({ text: read.text,
    plan: (await query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${read.text}`, read.values))
      .rows[0]!['QUERY PLAN'][0]!.Plan })));
}
const history = ['rezics_account_security_event', 'rezics_account_operator_audit', 'rezics_account_operator_note'];

test('G356 admin signals: failure bursts, email after a password change, new passkeys and App consent surges, each reviewed', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const { owner } = oauth;
    const support = await f.signup('support@example.test');
    const stuffed = await f.signup('stuffed@example.test');
    const changed = await f.signup('changed@example.test');
    const veteran = await f.signup('veteran@example.test');
    const newcomer = await f.signup('newcomer@example.test');
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie));
    const signals = (cookie = owner.cookie) => json<Signals>(f.request('/api/account/admin/signals', undefined, cookie));
    const find = (list: Signals, key: string) => list.items.find(signal => signal.key === key);
    const review = (key: string, cookie: string, extra: Record<string, unknown> = {}) =>
      f.request('/api/account/admin/signals/review', { key, commandId: randomUUID(), ...extra }, cookie);

    // Five failures in a day are a burst; a success after them makes it severe.
    const burst = `failed-sign-ins:${stuffed.id}`;
    await fail(f, stuffed, 4);
    expect(find(await signals(), burst)).toBeUndefined();
    await fail(f, stuffed, 1);
    expect(find(await signals(), burst)).toMatchObject({ kind: 'failed-sign-ins', severity: 'medium',
      subject: { kind: 'user', id: stuffed.id, email: stuffed.email }, evidence: { failures: 5, signedInAfter: false } });
    expect((await f.request('/api/auth/sign-in/email', { email: stuffed.email, password: stuffed.password })).ok).toBe(true);
    expect(find(await signals(), burst)).toMatchObject({ severity: 'high', evidence: { signedInAfter: true } });

    // A password change and an email change within a day, either order.
    await f.pool.query(`UPDATE account SET password = 'rotated:' || password WHERE "userId" = $1 AND "providerId" = 'credential'`, [changed.id]);
    await f.pool.query('UPDATE "user" SET email = $2 WHERE id = $1', [changed.id, 'changed-attacker@example.test']);
    await f.pool.query('UPDATE "user" SET email = $2 WHERE id = $1', [newcomer.id, 'newcomer-2@example.test']);
    const emailSignal = (await signals()).items.find(signal => signal.kind === 'email-after-password');
    expect(emailSignal).toMatchObject({ severity: 'high', subject: { id: changed.id, email: 'changed-attacker@example.test' } });
    expect((await signals()).items.filter(signal => signal.kind === 'email-after-password')).toHaveLength(1);
    const evidence = emailSignal!.evidence as { passwordChangedAt: string; emailChangedAt: string };
    expect(evidence.passwordChangedAt < evidence.emailChangedAt).toBe(true);

    // A passkey stands out only on an account that is at least 30 days old.
    await f.pool.query(`UPDATE "user" SET "createdAt" = now() - interval '60 days' WHERE id = $1`, [veteran.id]);
    await event(f, veteran.id, 'passkey_added', '2 hours');
    await event(f, newcomer.id, 'passkey_added', '2 hours');
    await event(f, veteran.id, 'passkey_added', '9 days');
    expect((await signals()).items.filter(signal => signal.kind === 'new-passkey').map(signal => signal.subject.id)).toEqual([veteran.id]);

    // An App that many accounts newly allow, against its quiet week before.
    const notes = await oauth.createClient();
    const trusted = await oauth.createClient(true);
    await oauth.code(notes.client_id, veteran.cookie);
    for (let n = 0; n < 9; n++) await event(f, `consent-${n}`, 'consent_granted', `${n + 1} minutes`, { clientId: notes.client_id });
    for (let n = 0; n < 7; n++) await event(f, `earlier-${n}`, 'consent_granted', `${n + 1} days 1 hour`, { clientId: notes.client_id });
    for (let n = 0; n < 12; n++) await event(f, `trusted-${n}`, 'consent_granted', `${n + 1} minutes`, { clientId: trusted.client_id });
    const surge = `mass-consent:${notes.client_id}`;
    expect(find(await signals(), surge)).toMatchObject({ severity: 'high', subject: { kind: 'client', id: notes.client_id, email: null },
      evidence: { accounts: 10, dailyAverage: 1 } });
    expect((await signals()).items.some(signal => signal.key === `mass-consent:${trusted.client_id}`)).toBe(false);
    // Support staff don't manage Apps: they aren't shown App signals.
    const supportView = await signals(support.cookie);
    expect(supportView.counts['mass-consent']).toEqual({ count: 0, capped: false });
    expect(find(supportView, burst)).toBeTruthy();

    const overview = await json<{ signals: Signals; failedSignIns?: unknown }>(f.request('/api/account/admin/overview', undefined, owner.cookie));
    expect(overview.failedSignIns).toBeUndefined();
    expect(overview.signals.items[0]!.severity).toBe('high');
    expect(overview.signals.counts).toMatchObject({ 'failed-sign-ins': { count: 1 }, 'email-after-password': { count: 1 },
      'new-passkey': { count: 1 }, 'mass-consent': { count: 1 } });
    const detail = await json<{ signals: Signal[] }>(f.request(`/api/account/admin/users/${changed.id}`, undefined, support.cookie));
    expect(detail.signals.map(signal => signal.kind)).toEqual(['email-after-password']);

    // Reviewing: annotated like a note, recorded on the subject, replayable.
    const commandId = randomUUID();
    const reviewed = await json<{ requestId: string }>(review(burst, support.cookie, { commandId, note: 'Owner confirmed the sign-in' }));
    expect(await json<object>(review(burst, support.cookie, { commandId, note: 'Owner confirmed the sign-in' }))).toEqual({ status: true, ...reviewed });
    expect((await review(burst, support.cookie, { commandId, note: 'Something else' })).status).toBe(409);
    expect((await review(surge, support.cookie)).status).toBe(403);
    expect((await review('bogus:thing', owner.cookie)).status).toBe(400);
    expect((await review('new-passkey:not-an-event', owner.cookie)).status).toBe(404);
    expect((await review(`new-passkey:${randomUUID()}`, owner.cookie)).status).toBe(404);
    expect((await review('failed-sign-ins:nobody', owner.cookie)).status).toBe(404);
    await json(review(surge, owner.cookie));
    await json(review(emailSignal!.key, owner.cookie));
    const open = await signals();
    expect(find(open, burst)).toBeUndefined();
    expect(find(open, surge)).toBeUndefined();
    expect(open.items.some(signal => signal.kind === 'email-after-password')).toBe(false);
    expect(open.reviewedLastDay).toBe(3);
    const audit = await json<Page<Entry>>(f.request(`/api/account/admin/audit?action=signal_reviewed&targetId=${stuffed.id}`,
      undefined, owner.cookie));
    expect(audit.items).toEqual([expect.objectContaining({ reason: 'Owner confirmed the sign-in', after: { key: burst, kind: 'failed-sign-ins' } })]);
    // A counting signal counts again from its review: a new burst reopens it.
    await fail(f, stuffed, 5);
    expect(find(await signals(), burst)).toMatchObject({ severity: 'medium', evidence: { failures: 5, signedInAfter: false } });
    await age(f, support);
    const stale = await review(burst, support.cookie);
    expect([stale.status, await stale.json()]).toEqual([403, { error: 'step_up_required' }]);
  } finally { await f.close(); }
}, 120_000);

test('G356 admin timeline: an account’s security log, staff actions and notes in one seek-paged story', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const support = await f.signup('support@example.test');
    const member = await f.signup('member@example.test');
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie));
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [member.id]);
    await fail(f, member, 1);
    await act(f, member.id, { action: 'suspend', reasonCode: 'spam', reason: 'Link spam in Realms', userMessage: 'You were suspended for spam.' }, owner.cookie);
    await act(f, member.id, { action: 'add-note', reason: 'Call', note: 'Called them back' }, support.cookie);
    await act(f, member.id, { action: 'resend-verification', reason: 'Asked for a link' }, support.cookie);
    await act(f, member.id, { action: 'unsuspend', reasonCode: 'appeal', reason: 'Appeal accepted' }, owner.cookie);
    const story = (query: string, cookie = owner.cookie) =>
      json<Page<Line>>(f.request(`/api/account/admin/users/${member.id}/timeline?${query}`, undefined, cookie));

    // Newest first; every staff action once, with who and why; notes as notes.
    const all = await story('limit=50');
    const shape = all.items.map(line => `${line.source}:${line.action}`);
    expect(shape.filter(line => line !== 'security:session_revoked').slice(0, 5)).toEqual(['staff:unsuspend',
      'staff:resend-verification', 'note:note', 'staff:suspend', 'security:sign_in_failed']);
    // Suspending signed them out first, inside the same change.
    expect(shape.indexOf('security:session_revoked')).toBe(shape.indexOf('staff:suspend') + 1);
    expect(shape).not.toContain('security:admin_action');
    expect(shape).not.toContain('staff:add-note');
    expect(all.items.every((line, index) => index === 0 || all.items[index - 1]!.occurredAt >= line.occurredAt)).toBe(true);
    expect(all.items.find(line => line.action === 'suspend')!.staff).toMatchObject({ actorEmail: owner.email, reasonCode: 'spam',
      reason: 'Link spam in Realms', userMessage: 'You were suspended for spam.' });
    expect(all.items.find(line => line.source === 'note')!.note).toEqual({ body: 'Called them back', authorId: support.id,
      authorName: 'Account Test', authorEmail: support.email });

    // Without the audit log: sanctions in full, other staff actions as the user's own log line.
    const limited = (await story('limit=50', support.cookie)).items.map(line => `${line.source}:${line.action}`);
    expect(limited.slice(0, 3)).toEqual(['staff:unsuspend', 'security:admin_action', 'note:note']);
    expect(limited).toContain('staff:suspend');
    expect((await story('limit=50', support.cookie)).items[1]!.detail).toMatchObject({ action: 'resend-verification' });

    expect((await story('category=sign-ins&limit=50')).items.map(line => line.action).every(action =>
      ['sign_in', 'sign_in_failed', 'sign_out', 'session_revoked'].includes(action))).toBe(true);
    expect((await story('category=staff&limit=50')).items.map(line => line.source)).toEqual(['staff', 'staff', 'note', 'staff']);
    expect((await story('category=apps')).items).toEqual([]);

    // Seek pages: no overlap, no gap, bound to their category.
    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Line> = await story(`limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      pages.push(...page.items.map(line => line.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual(all.items.map(line => line.id));
    const first = await story('limit=2');
    expect((await f.request(`/api/account/admin/users/${member.id}/timeline?category=staff&cursor=${encodeURIComponent(first.nextCursor!)}`,
      undefined, owner.cookie)).status).toBe(400);
    const bystander = await f.signup('bystander@example.test');
    expect((await f.request(`/api/account/admin/users/${member.id}/timeline`, undefined, bystander.cookie)).status).toBe(403);
    const detail = await json<{ timeline: Page<Line>; sessions: Page<unknown> }>(f.request(`/api/account/admin/users/${member.id}`,
      undefined, owner.cookie));
    expect(detail.timeline.items.map(line => line.id)).toEqual(all.items.slice(0, 20).map(line => line.id));
  } finally { await f.close(); }
}, 90_000);

test('G356 admin work: signals and the timeline read bounded index ranges amid long histories', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const heavy = await f.signup('heavy@example.test');
    // Long history: failures, grants, passkeys and email changes across 500
    // accounts, filling every signal window past its cap (a window smaller
    // than its cap may be read whole, which the planner finds cheaper), and
    // one account with thousands of events, staff actions and notes.
    await f.pool.query(`INSERT INTO rezics_account_security_event (user_id, action, detail, occurred_at)
      SELECT 'history-' || (n % 500), (ARRAY['sign_in_failed', 'consent_granted', 'passkey_added', 'email_changed', 'sign_in'])[1 + n % 5],
        jsonb_build_object('clientId', 'history-client'), now() - n * interval '5 seconds'
      FROM generate_series(1, 150000) AS n`);
    await f.pool.query(`INSERT INTO rezics_account_security_event (user_id, action, occurred_at)
      SELECT $1, (ARRAY['sign_in', 'sign_out', 'passkey_added'])[1 + n % 3], now() - n * interval '1 minute'
      FROM generate_series(1, 6000) AS n`, [heavy.id]);
    await f.pool.query(`INSERT INTO rezics_account_operator_audit (actor_id, action, target_id, reason, request_id, outcome, occurred_at)
      SELECT $2, 'revoke-sessions', $1, 'History', gen_random_uuid(), 'succeeded', now() - n * interval '1 minute' - interval '30 seconds'
      FROM generate_series(1, 3000) AS n`, [heavy.id, owner.id]);
    await f.pool.query(`INSERT INTO rezics_account_operator_note (user_id, author_id, body, created_at)
      SELECT $1, $2, 'History ' || n, now() - n * interval '1 minute' - interval '15 seconds' FROM generate_series(1, 3000) AS n`,
    [heavy.id, owner.id]);
    for (const table of history) await f.pool.query(`ANALYZE ${table}`);
    const indexes = new Set((await f.pool.query<{ name: string }>(`SELECT indexname AS name FROM pg_indexes
      WHERE tablename = ANY($1::text[])`, [history])).rows.map(row => row.name));

    // Every scan of the history tables is an index range, and no scan node
    // looks at more rows than the operation's bound (LIMITs, not history).
    const checked = async (label: string, work: () => Promise<unknown>, bound: number) => {
      const reads = await observe(f, work);
      let scans = 0;
      for (const { text, plan } of reads) {
        for (const node of nodes(plan).filter(item => (item['Relation Name'] && history.includes(item['Relation Name']))
          || (item['Index Name'] && indexes.has(item['Index Name'])))) {
          scans++;
          if (node['Node Type'] === 'Seq Scan') throw new Error(`${label}: sequential scan of ${node['Relation Name']} in ${text}`);
          if (examined(node) > bound) throw new Error(`${label}: ${node['Node Type']} ${node['Index Name'] ?? node['Relation Name']}`
            + ` examined ${examined(node)} rows (bound ${bound}) in ${text}`);
        }
      }
      expect(scans).toBeGreaterThan(0);
    };
    await checked('signals', () => json(f.request('/api/account/admin/signals', undefined, owner.cookie)), 5001);
    await checked('timeline', () => json(f.request(`/api/account/admin/users/${heavy.id}/timeline?limit=25`, undefined, owner.cookie)), 26);
    await checked('staff timeline', () => json(f.request(`/api/account/admin/users/${heavy.id}/timeline?category=staff&limit=25`,
      undefined, owner.cookie)), 26);
    // The user page's per-account signals probe that account's action index only.
    await checked('user signals', () => json(f.request(`/api/account/admin/users/${heavy.id}`, undefined, owner.cookie)), 2001);
  } finally { await f.close(); }
}, 120_000);

test('G356 admin bulk: an undo window before the first item, and stopping what is left', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const admin = await f.signup('admin@example.test');
    const [first, second] = [await f.signup('one@example.test'), await f.signup('two@example.test')];
    await json(f.request(`/api/account/admin/operators/${admin.id}`, { role: 'admin', reason: 'Moderation team' }, owner.cookie));
    const bulk = (extra: Record<string, unknown>, cookie = admin.cookie) => f.request('/api/account/admin/bulk-actions', { action: 'suspend',
      reasonCode: 'spam', reason: 'Spam wave', commandId: randomUUID(), userIds: [first.id, second.id], ...extra }, cookie);
    const job = (jobId: string, cookie = admin.cookie) => json<Job>(f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, cookie));
    const cancel = (jobId: string, cookie = admin.cookie) => f.request(`/api/account/admin/bulk-actions/${jobId}/cancel`, {}, cookie);
    const status = async (person: Person) => (await f.pool.query<{ suspended: boolean }>(
      'SELECT suspended_at IS NOT NULL AS suspended FROM rezics_account_security WHERE user_id = $1', [person.id])).rows[0]!.suspended;
    expect((await bulk({ undoSeconds: 31 })).status).toBe(400);

    // Inside the window nothing has happened; undoing cancels every item.
    const { jobId } = await json<{ jobId: string }>(bulk({ undoSeconds: 20 }));
    const waiting = await job(jobId);
    expect(waiting).toMatchObject({ pending: 2, finishedAt: null });
    expect(Date.parse(waiting.startsAt)).toBeGreaterThan(Date.now() + 10_000);
    expect((await cancel(jobId, first.cookie)).status).toBe(403);
    // Stopping only withholds changes, so it needs no fresh sign-in.
    await age(f, admin);
    expect(await json<object>(cancel(jobId))).toEqual({ cancelled: 2 });
    const undone = await job(jobId);
    expect(undone).toMatchObject({ pending: 0, cancelled: 2, succeeded: 0 });
    expect(undone.cancelledAt).toBeTruthy();
    expect(undone.items.map(item => item.state)).toEqual(['cancelled', 'cancelled']);
    expect([await status(first), await status(second)]).toEqual([false, false]);
    expect(await json<object>(cancel(jobId))).toEqual({ cancelled: 0 });
    const audit = await json<Page<Entry>>(f.request(`/api/account/admin/audit?action=bulk_action_cancelled`, undefined, owner.cookie));
    expect(audit.items[0]).toMatchObject({ targetId: jobId, after: { cancelled: 2 } });

    // An owner may stop another operator's job; after its window a job runs.
    await json(f.request('/api/account/reauthenticate', { password: admin.password }, admin.cookie));
    const started = await json<{ jobId: string }>(bulk({ undoSeconds: 1 }));
    expect((await cancel(started.jobId, owner.cookie)).status).toBe(200);
    const late = await json<{ jobId: string }>(bulk({ undoSeconds: 1, commandId: randomUUID(), reason: 'Second wave' }));
    for (let attempt = 0; attempt < 100 && !(await job(late.jobId)).finishedAt; attempt++) await Bun.sleep(100);
    expect(await job(late.jobId)).toMatchObject({ succeeded: 2, cancelled: 0 });
    expect([await status(first), await status(second)]).toEqual([true, true]);
  } finally { await f.close(); }
}, 90_000);

test('G356 admin audit: reason codes, request IDs, text and emails narrow the log; JSON Lines export', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const member = await f.signup('member@example.test');
    const other = await f.signup('other@example.test');
    const suspended = await act(f, member.id, { action: 'suspend', reasonCode: 'abuse', reason: 'Harassment report #1182' }, owner.cookie);
    await act(f, member.id, { action: 'unsuspend', reasonCode: 'appeal', reason: 'Appeal accepted' }, owner.cookie);
    await act(f, other.id, { action: 'revoke-sessions', reasonCode: 'compromised', reason: 'Lost laptop', userMessage: 'We signed you out after report #1182' },
      owner.cookie);
    const audit = (query: string) => json<Page<Entry>>(f.request(`/api/account/admin/audit?${query}`, undefined, owner.cookie));
    expect((await audit('reasonCode=abuse')).items.map(item => item.requestId)).toEqual([suspended.requestId]);
    expect((await audit(`requestId=${suspended.requestId}`)).items).toHaveLength(1);
    expect((await audit('q=%231182')).items.map(item => item.action)).toEqual(['revoke-sessions', 'suspend']);
    expect((await audit('q=HARASSMENT')).items.map(item => item.action)).toEqual(['suspend']);
    expect((await audit(`targetId=${encodeURIComponent(member.email.toUpperCase())}`)).items.map(item => item.action)).toEqual(['unsuspend', 'suspend']);
    expect((await audit(`actorId=${encodeURIComponent(owner.email)}&targetId=${other.id}`)).items.map(item => item.action)).toEqual(['revoke-sessions']);
    expect((await f.request('/api/account/admin/audit?requestId=not-a-uuid', undefined, owner.cookie)).status).toBe(400);
    expect((await f.request('/api/account/admin/audit?reasonCode=bogus', undefined, owner.cookie)).status).toBe(400);
    const page = await audit('q=%231182&limit=1');
    expect((await audit(`q=%231182&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).items.map(item => item.action)).toEqual(['suspend']);
    expect((await f.request(`/api/account/admin/audit?q=appeal&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`, undefined, owner.cookie)).status).toBe(400);

    const exported = await f.request('/api/account/admin/audit/export?format=jsonl&q=%231182', undefined, owner.cookie);
    expect(exported.headers.get('content-type')).toContain('application/x-ndjson');
    expect(exported.headers.get('content-disposition')).toContain('.jsonl');
    const lines = (await exported.text()).trim().split('\n').map(line => JSON.parse(line) as Entry & { targetEmail: string });
    expect(lines.map(line => [line.action, line.targetEmail])).toEqual([['revoke-sessions', other.email], ['suspend', member.email]]);
    expect(lines[1]!.after).toMatchObject({ status: 'suspended' });
    const recorded = await audit('action=audit_exported');
    expect(recorded.items[0]!.after).toMatchObject({ format: 'jsonl', filters: { q: '#1182' }, rows: 2 });
  } finally { await f.close(); }
}, 90_000);
