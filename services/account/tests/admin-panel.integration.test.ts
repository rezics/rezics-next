import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { csvCell } from '../src/admin-audit.ts';

type Fixture = Awaited<ReturnType<typeof accountFixture>>;
type Person = Awaited<ReturnType<Fixture['signup']>>;
interface Page<T> { items: T[]; nextCursor: string | null }
interface Row { id: string; email: string; status: string; role: string | null; lastSignInAt: string | null;
  suspensionCode: string | null; suspendedAt: string | null }
interface Entry { action: string; outcome: string; reasonCode: string | null; userMessage: string | null; actorEmail: string | null;
  targetKind: string; targetEmail: string | null; targetName: string | null }
interface Job { id: string; finishedAt: string | null; succeeded: number; skipped: number; failed: number; pending: number;
  items: { userId: string; state: string; error: string | null; email: string | null }[] }

const json = async <T>(response: Response | Promise<Response>) => {
  const resolved = await response;
  if (!resolved.ok) throw new Error(`${resolved.status} ${await resolved.clone().text()}`);
  return await resolved.json() as T;
};
const act = (f: Fixture, userId: string, body: Record<string, unknown>, cookie: string) =>
  f.request(`/api/account/admin/users/${userId}/actions`, { commandId: randomUUID(), ...body }, cookie);
/** Moves the operator's sign-in outside the five-minute step-up window. */
const age = (f: Fixture, person: Person) => f.pool.query(`UPDATE "session" SET "createdAt" = now() - interval '1 hour'
  WHERE "userId" = $1`, [person.id]);
async function settle(f: Fixture, jobId: string, cookie: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await json<Job>(f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, cookie));
    if (job.finishedAt) return job;
    await Bun.sleep(100);
  }
  throw new Error('Bulk job did not finish');
}

test('G262 admin panel: directory operators, exact jump, work queues and per-operator preferences', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const support = await f.signup('support@example.test');
    const li = await f.signup('li.ming@example.test');
    const wang = await f.signup('wang@example.test');
    const pending = await f.signup('pending@example.test');
    const member = await f.signup('member@example.test');
    await f.pool.query(`UPDATE "user" SET name = CASE id WHEN $1 THEN '李明' WHEN $2 THEN '王芳' ELSE name END`, [li.id, wang.id]);
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [pending.id]);
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie));
    const users = (query: string, cookie = owner.cookie) =>
      json<Page<Row> & { exact: Row | null }>(f.request(`/api/account/admin/users?${query}`, undefined, cookie));

    // A given name finds a CJK full name anywhere in it; email is a prefix.
    expect((await users(`name=${encodeURIComponent('明')}`)).items.map(row => row.id)).toEqual([li.id]);
    expect((await users('email=WANG')).items.map(row => row.id)).toEqual([wang.id]);
    expect(new Set((await users('role=owner,support')).items.map(row => row.id))).toEqual(new Set([owner.id, support.id]));
    const people = await users('role=none&sort=email&direction=asc');
    expect(people.items.map(row => row.email)).toEqual([li.email, member.email, pending.email, wang.email]);
    expect(people.items.every(row => row.role === null && row.lastSignInAt !== null)).toBe(true);
    expect((await f.request('/api/account/admin/users?status=active,bogus', undefined, owner.cookie)).status).toBe(400);
    // The exact ID or email is offered wherever it sorts, whatever the case.
    expect((await users(`q=${encodeURIComponent(li.email.toUpperCase())}`)).exact?.id).toBe(li.id);
    expect((await users(`q=${li.id}&status=suspended`)).exact?.id).toBe(li.id);
    expect((await users('q=li.min')).exact).toBeNull();
    // A cursor is bound to every filter, including the new ones.
    const first = await users('role=none&limit=2&sort=email');
    expect(first.nextCursor).toBeTruthy();
    expect((await users(`role=none&limit=2&sort=email&cursor=${encodeURIComponent(first.nextCursor!)}`)).items).toHaveLength(2);
    expect((await f.request(`/api/account/admin/users?role=owner&limit=2&sort=email&cursor=${encodeURIComponent(first.nextCursor!)}`,
      undefined, owner.cookie)).status).toBe(400);

    await json(act(f, wang.id, { action: 'suspend', reasonCode: 'spam', reason: 'Bulk link spam',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, owner.cookie));
    await json(act(f, member.id, { action: 'require-password-reset', reasonCode: 'compromised', reason: 'Password in breach corpus' }, owner.cookie));
    expect((await users('status=suspended')).items.map(row => row.id)).toEqual([wang.id]);
    expect((await users('status=active,password-reset-required&role=none')).items.map(row => row.id).sort())
      .toEqual([li.id, member.id, pending.id].sort());
    for (let attempt = 0; attempt < 5; attempt++) {
      await f.request('/api/auth/sign-in/email', { email: li.email, password: 'not the password at all' });
    }
    const overview = await json<Record<'suspended' | 'passwordResetRequired' | 'unverified',
      { count: number; capped: boolean; users: { id: string; reasonCode: string | null; until: string | null }[] }>
      & { recentActions: Entry[] | null; signals: { items: { key: string; evidence: { failures?: number } }[] } }>(
      f.request('/api/account/admin/overview', undefined, owner.cookie));
    expect(overview.suspended).toMatchObject({ count: 1, capped: false, users: [{ id: wang.id, reasonCode: 'spam' }] });
    expect(overview.suspended.users[0]!.until).toBeTruthy();
    expect(overview.passwordResetRequired).toMatchObject({ count: 1, users: [{ id: member.id, reasonCode: 'compromised' }] });
    expect(overview.unverified).toMatchObject({ count: 1, users: [{ id: pending.id }] });
    expect(overview.signals.items).toEqual([expect.objectContaining({ key: `failed-sign-ins:${li.id}`, evidence: expect.objectContaining({ failures: 5 }) })]);
    expect(overview.recentActions?.[0]).toMatchObject({ action: 'require-password-reset', actorEmail: owner.email });
    const supportView = await json<{ recentActions: unknown }>(f.request('/api/account/admin/overview', undefined, support.cookie));
    expect(supportView.recentActions).toBeNull();
    expect((await f.request('/api/account/admin/overview', undefined, li.cookie)).status).toBe(403);

    // Preferences are private, reversible display state: no step-up needed.
    await age(f, support);
    expect((await act(f, pending.id, { action: 'resend-verification', reason: 'Asked for a new link' }, support.cookie)).status).toBe(403);
    expect(await json<object>(f.request('/api/account/admin/preferences', undefined, support.cookie)))
      .toEqual({ density: 'comfortable', columns: null, views: [] });
    const views = [{ id: 'suspended', name: '暂停的用户', query: 'status:suspended' }];
    expect(await json<object>(f.request('/api/account/admin/preferences', { density: 'compact', views }, support.cookie)))
      .toEqual({ density: 'compact', columns: null, views });
    expect(await json<object>(f.request('/api/account/admin/preferences', { columns: ['name', 'status'] }, support.cookie)))
      .toEqual({ density: 'compact', columns: ['name', 'status'], views });
    expect(await json<object>(f.request('/api/account/admin/preferences', { columns: null }, support.cookie)))
      .toMatchObject({ density: 'compact', columns: null });
    expect(await json<object>(f.request('/api/account/admin/preferences', undefined, owner.cookie))).toMatchObject({ density: 'comfortable' });
    expect((await f.request('/api/account/admin/preferences', { columns: ['name', 'name'] }, support.cookie)).status).toBe(400);
    expect((await f.request('/api/account/admin/preferences', { views: [...views, ...views] }, support.cookie)).status).toBe(400);
    expect((await f.request('/api/account/admin/preferences', { density: 'compact' }, li.cookie)).status).toBe(403);
    expect((await f.request('/api/account/admin/preferences', { density: 'compact' }, support.cookie, { origin: 'https://evil.example' })).status).toBe(403);
  } finally { await f.close(); }
}, 90_000);

test('G262 admin panel: sanctions need a reason code, message the user, and read back as history, audit and CSV', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const support = await f.signup('support@example.test');
    const member = await f.signup('member@example.test');
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie));
    const me = await json<{ reasonCodes: Record<string, string[]>; stepUpUntil: string | null; secondFactor: boolean; bulkLimit: number }>(
      f.request('/api/account/admin/me', undefined, owner.cookie));
    expect(me).toMatchObject({ secondFactor: false, bulkLimit: 100 });
    expect(me.reasonCodes.suspend).toContain('spam');
    expect(me.stepUpUntil).toBeTruthy();

    const suspend = { action: 'suspend', reason: '=HYPERLINK("https://evil.example")', userMessage: 'Your account posted spam links.' };
    expect((await act(f, member.id, suspend, owner.cookie)).status).toBe(400);
    expect((await act(f, member.id, { ...suspend, reasonCode: 'appeal' }, owner.cookie)).status).toBe(400);
    expect((await act(f, member.id, { action: 'add-note', reason: 'Call notes', note: 'Asked about spam', userMessage: 'Hi' }, owner.cookie)).status).toBe(400);
    expect((await act(f, member.id, { ...suspend, reasonCode: 'spam' }, support.cookie)).status).toBe(403);
    await json(act(f, member.id, { ...suspend, reasonCode: 'spam' }, owner.cookie));
    await f.email.drain();
    const notice = f.messages.find(message => message.to === member.email && message.subject === 'A message about your REZICS account');
    expect(notice?.text).toContain('Your account posted spam links.');
    expect(notice?.html).not.toContain('<script');
    await json(act(f, member.id, { action: 'add-note', reason: 'Call notes', note: 'Explained the spam policy' }, support.cookie));
    const detail = await json<{ profile: Row; notes: { authorEmail: string; body: string }[] }>(
      f.request(`/api/account/admin/users/${member.id}`, undefined, support.cookie));
    expect(detail.profile).toMatchObject({ status: 'suspended', suspensionCode: 'spam', role: null });
    expect(detail.profile.suspendedAt).toBeTruthy();
    expect(detail.notes).toEqual([expect.objectContaining({ authorEmail: support.email, body: 'Explained the spam policy' })]);
    await json(act(f, member.id, { action: 'unsuspend', reasonCode: 'appeal', reason: 'Appeal accepted' }, owner.cookie));
    const sanctions = await json<Page<Entry>>(f.request(`/api/account/admin/users/${member.id}/sanctions`, undefined, support.cookie));
    expect(sanctions.items.map(item => [item.action, item.reasonCode])).toEqual([['unsuspend', 'appeal'], ['suspend', 'spam']]);
    expect(sanctions.items[1]).toMatchObject({ userMessage: 'Your account posted spam links.', actorEmail: owner.email });

    const audit = await json<Page<Entry>>(f.request(`/api/account/admin/audit?targetId=${member.id}&action=suspend`, undefined, owner.cookie));
    expect(audit.items).toEqual([expect.objectContaining({ targetKind: 'user', targetEmail: member.email, actorEmail: owner.email,
      reasonCode: 'spam', outcome: 'succeeded' })]);
    const denied = await json<Page<Entry>>(f.request(`/api/account/admin/audit?outcome=failed&actorId=${support.id}`, undefined, owner.cookie));
    expect(denied.items.map(item => item.action)).toEqual(['permission_denied']);
    expect((await f.request('/api/account/admin/audit?outcome=lost', undefined, owner.cookie)).status).toBe(400);

    expect((await f.request('/api/account/admin/audit/export', undefined, support.cookie)).status).toBe(403);
    const exported = await f.request(`/api/account/admin/audit/export?targetId=${member.id}`, undefined, owner.cookie);
    expect(exported.headers.get('content-type')).toContain('text/csv');
    expect(exported.headers.get('x-rezics-rows')).toBe('3');
    // TextDecoder drops a byte-order mark unless asked to keep it.
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await exported.arrayBuffer());
    expect(csv.startsWith('﻿occurred_at,action,outcome,')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
    expect(csvCell('-1+1')).toBe(`"'-1+1"`);
    expect(csvCell(null)).toBe('""');
    const recorded = await json<Page<Entry & { after: { rows: number; truncated: boolean } }>>(
      f.request('/api/account/admin/audit?action=audit_exported', undefined, owner.cookie));
    expect(recorded.items[0]!.after).toMatchObject({ rows: 3, truncated: false });

    await age(f, owner);
    expect(await json<object>(f.request('/api/account/admin/me', undefined, owner.cookie))).toMatchObject({ stepUpUntil: null });
    expect((await act(f, member.id, { action: 'revoke-sessions', reasonCode: 'support', reason: 'Asked to sign out' }, owner.cookie)).status).toBe(403);
    await json(f.request('/api/account/reauthenticate', { password: owner.password }, owner.cookie));
    expect((await act(f, member.id, { action: 'revoke-sessions', reasonCode: 'support', reason: 'Asked to sign out' }, owner.cookie)).status).toBe(200);
  } finally { await f.close(); }
}, 90_000);

test('G262 admin panel: bulk actions run as jobs with per-user results, replay and recovery after a lost runner', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const admin = await f.signup('admin@example.test');
    const support = await f.signup('support@example.test');
    const [first, second, third] = [await f.signup('one@example.test'), await f.signup('two@example.test'), await f.signup('three@example.test')];
    await json(f.request(`/api/account/admin/operators/${admin.id}`, { role: 'admin', reason: 'Moderation team' }, owner.cookie));
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie));
    const bulk = { action: 'suspend', reasonCode: 'spam', reason: 'Coordinated spam wave', commandId: randomUUID(),
      userIds: [first.id, second.id, owner.id, 'missing-user'], userMessage: 'Your account took part in a spam wave.' };
    expect((await f.request('/api/account/admin/bulk-actions', bulk, support.cookie)).status).toBe(403);
    expect((await f.request('/api/account/admin/bulk-actions', { ...bulk, userIds: [first.id, first.id] }, admin.cookie)).status).toBe(400);
    expect((await f.request('/api/account/admin/bulk-actions', { ...bulk,
      userIds: Array.from({ length: 101 }, (_, index) => `user-${index}`) }, admin.cookie)).status).toBe(400);
    const { jobId } = await json<{ jobId: string }>(f.request('/api/account/admin/bulk-actions', bulk, admin.cookie));
    expect(await json<object>(f.request('/api/account/admin/bulk-actions', bulk, admin.cookie))).toEqual({ jobId });
    expect((await f.request('/api/account/admin/bulk-actions', { ...bulk, reason: 'Changed reason' }, admin.cookie)).status).toBe(409);
    const job = await settle(f, jobId, admin.cookie);
    expect(job).toMatchObject({ succeeded: 2, failed: 2, skipped: 0, pending: 0 });
    // An admin cannot sanction an operator; a missing user fails alone.
    expect(job.items.map(item => [item.userId, item.state, item.error])).toEqual([[first.id, 'succeeded', null],
      [second.id, 'succeeded', null], [owner.id, 'failed', 'forbidden'], ['missing-user', 'failed', 'not_found']]);
    expect(job.items[0]!.email).toBe(first.email);
    await f.email.drain();
    expect(f.messages.filter(message => message.subject === 'A message about your REZICS account').map(message => message.to).sort())
      .toEqual([first.email, second.email].sort());
    expect((await f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, support.cookie)).status).toBe(404);
    expect((await f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, owner.cookie)).status).toBe(200);
    const audit = await json<Page<Entry>>(f.request(`/api/account/admin/audit?actorId=${admin.id}&action=suspend`, undefined, owner.cookie));
    expect(audit.items.map(item => item.targetEmail).sort()).toEqual([first.email, second.email].sort());
    const started = await json<Page<Entry & { after: { users: number } }>>(f.request('/api/account/admin/audit?action=bulk_action_started', undefined, owner.cookie));
    expect(started.items[0]).toMatchObject({ actorEmail: admin.email, targetKind: 'other', after: { users: 4 } });

    const lift = await json<{ jobId: string }>(f.request('/api/account/admin/bulk-actions', { action: 'unsuspend', reasonCode: 'error-correction',
      reason: 'Wave was a false positive', commandId: randomUUID(), userIds: [first.id, third.id] }, admin.cookie));
    const lifted = await settle(f, lift.jobId, admin.cookie);
    expect(lifted.items.map(item => item.state)).toEqual(['succeeded', 'skipped']);

    // The runner dies waiting for the operator-roles lock; meanwhile the actor
    // signs out. Reading the job resumes it and the rest fails as forbidden.
    const blocker = await f.pool.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('account-operator-roles', 0))");
      const stuck = await json<{ jobId: string }>(f.request('/api/account/admin/bulk-actions', { action: 'revoke-sessions',
        reasonCode: 'compromised', reason: 'Token leak', commandId: randomUUID(), userIds: [second.id, third.id] }, admin.cookie));
      await Bun.sleep(3_500);
      await f.pool.query('DELETE FROM "session" WHERE "userId" = $1', [admin.id]);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('account-operator-roles', 0))");
      const recovered = await settle(f, stuck.jobId, owner.cookie);
      expect(recovered.items.map(item => [item.state, item.error])).toEqual([['failed', 'forbidden'], ['failed', 'forbidden']]);
    } finally { blocker.release(); }
    expect(await json<object | null>(f.request('/api/auth/get-session', undefined, third.cookie))).not.toBeNull();
  } finally { await f.close(); }
}, 90_000);

test('G262 admin panel: disabling an App refuses its authorizations and tokens until enabled, audited', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('member@example.test');
    const support = await f.signup('support@example.test');
    await json(f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, oauth.owner.cookie));
    const client = await oauth.createClient();
    const tokens = await oauth.issue(client.client_id, member.cookie);
    const clients = await json<Page<{ clientId: string; type: string; disabled: boolean | null;
      installation: { state: string; scopes: string[] } | null }>>(f.request('/api/account/admin/clients', undefined, oauth.owner.cookie));
    expect(clients.items.find(item => item.clientId === client.client_id)).toMatchObject({ type: 'public',
      installation: { state: 'active' } });
    expect(clients.items.find(item => item.clientId === oauth.verifier.client_id)).toMatchObject({ type: 'confidential' });
    const disable = { action: 'disable', reason: 'Leaked client in public repo', commandId: randomUUID() };
    expect((await f.request(`/api/account/admin/clients/${client.client_id}/actions`, disable, support.cookie)).status).toBe(403);
    expect((await f.request('/api/account/admin/clients/unknown-client/actions', { ...disable, commandId: randomUUID() }, oauth.owner.cookie)).status).toBe(404);
    const disabled = await json<{ requestId: string }>(f.request(`/api/account/admin/clients/${client.client_id}/actions`, disable, oauth.owner.cookie));
    expect(await json<object>(f.request(`/api/account/admin/clients/${client.client_id}/actions`, disable, oauth.owner.cookie))).toEqual(disabled);
    expect(await oauth.introspect(tokens.access_token)).toEqual({ active: false });
    await expect(oauth.issue(client.client_id, member.cookie)).rejects.toThrow();
    const audit = await json<Page<Entry & { before: { disabled: boolean | null }; after: { disabled: boolean } }>>(
      f.request(`/api/account/admin/audit?targetId=${client.client_id}&action=client_disabled`, undefined, oauth.owner.cookie));
    expect(audit.items[0]).toMatchObject({ targetKind: 'client', targetName: 'Notes', after: { disabled: true } });
    await json(f.request(`/api/account/admin/clients/${client.client_id}/actions`, { action: 'enable', reason: 'Secret rotated',
      commandId: randomUUID() }, oauth.owner.cookie));
    expect(await oauth.introspect((await oauth.issue(client.client_id, member.cookie)).access_token)).toMatchObject({ active: true });
  } finally { await f.close(); }
}, 90_000);
