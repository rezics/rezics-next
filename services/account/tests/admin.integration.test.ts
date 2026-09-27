import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { bootstrapOperators } from '../src/operators.ts';

test('G205 admin: stored roles, directory filters/cursors, notes, audit and denied/last-owner actions', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const owner = oauth.owner;
    const support = await f.signup('support@example.test');
    const member = await f.signup('member@example.test');
    const grant = await f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' }, owner.cookie);
    expect(grant.status).toBe(200);
    expect(await (await f.request('/api/account/admin/me', undefined, support.cookie)).json()).toMatchObject({ role: 'support' });
    expect((await f.request('/api/account/admin/users', undefined, member.cookie)).status).toBe(403);
    const search = await f.request('/api/account/admin/users?q=member&verified=true&hasTwoFactor=false&sort=email&direction=asc', undefined, support.cookie);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ items: [{ id: member.id, email: member.email, status: 'active' }], nextCursor: null });
    const directory = await (await f.request('/api/account/admin/users?limit=1&sort=name', undefined, owner.cookie)).json() as {
      items: { id: string }[]; nextCursor: string };
    const next = await (await f.request(`/api/account/admin/users?limit=1&sort=name&cursor=${encodeURIComponent(directory.nextCursor)}`, undefined, owner.cookie)).json() as { items: { id: string }[] };
    expect(next.items[0]!.id).not.toBe(directory.items[0]!.id);
    expect((await f.request(`/api/account/admin/users?sort=email&cursor=${encodeURIComponent(directory.nextCursor)}`, undefined, owner.cookie)).status).toBe(400);
    const action = { action: 'suspend', reason: 'Abuse review pending', commandId: randomUUID() };
    expect((await f.request(`/api/account/admin/users/${member.id}/actions`, action, support.cookie)).status).toBe(403);
    expect((await f.request('/api/account/admin/audit', undefined, support.cookie)).status).toBe(403);
    const note = { action: 'add-note', reason: 'Support conversation', note: 'Verified ownership by support procedure', commandId: randomUUID() };
    const writes = await Promise.all([1, 2].map(() => f.request(`/api/account/admin/users/${member.id}/actions`, note, support.cookie)));
    const bodies = await Promise.all(writes.map(response => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect((await f.request(`/api/account/admin/users/${member.id}/actions`, { ...note, note: 'Changed request' }, support.cookie)).status).toBe(409);
    const detail = await (await f.request(`/api/account/admin/users/${member.id}`, undefined, owner.cookie)).json() as { notes: unknown[]; methods: { password: boolean } };
    expect(detail.notes).toHaveLength(1);
    expect(detail.methods.password).toBe(true);
    const audit = await (await f.request(`/api/account/admin/audit?targetId=${member.id}&action=add-note`, undefined, owner.cookie)).json() as { items: { before: unknown; after: unknown; requestId: string }[] };
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]!.requestId).toBeTruthy();
    await expect(f.pool.query('DELETE FROM rezics_account_operator_audit')).rejects.toThrow('append-only');
    expect((await f.request(`/api/account/admin/operators/${owner.id}`, { role: null, reason: 'Remove owner' }, owner.cookie)).status).toBe(409);
    expect((await f.request(`/api/account/admin/users/${owner.id}/actions`, action, owner.cookie)).status).toBe(409);
    await f.request(`/api/account/admin/operators/${support.id}`, { role: 'owner', reason: 'Ownership handover' }, owner.cookie);
    await f.request(`/api/account/admin/operators/${owner.id}`, { role: 'admin', reason: 'Ownership handover' }, support.cookie);
    await bootstrapOperators(f.pool, f.operators);
    expect(await (await f.request('/api/account/admin/me', undefined, owner.cookie)).json()).toMatchObject({ role: 'admin' });
    const clients = await f.request('/api/account/admin/clients', undefined, owner.cookie);
    expect(clients.status).toBe(200);
    expect(await clients.text()).not.toContain('client_secret');
  } finally { await f.close(); }
}, 60_000);

test('G205 admin: suspension and required reset stop sign-in, sessions, refresh and Main access; expiry never revives old tokens', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('suspended@example.test');
    const peer = await f.signup('unaffected@example.test');
    const client = await oauth.createClient(true);
    const tokens = await oauth.issue(client.client_id, member.cookie);
    const peerTokens = await oauth.issue(client.client_id, peer.cookie);
    const held = await oauth.code(client.client_id, member.cookie);
    expect(await oauth.introspect(tokens.access_token)).toMatchObject({ active: true });
    const suspension = { action: 'suspend', reason: 'Temporary abuse review', commandId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const response = await f.request(`/api/account/admin/users/${member.id}/actions`, suspension, oauth.owner.cookie);
    expect(response.status).toBe(200);
    expect(await (await f.request('/api/auth/get-session', undefined, member.cookie)).json()).toBeNull();
    expect((await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password })).status).toBe(403);
    expect(await oauth.introspect(tokens.access_token)).toEqual({ active: false });
    expect(await oauth.introspect(peerTokens.access_token)).toMatchObject({ active: true });
    expect((await oauth.token({ ...held, grant_type: 'authorization_code' })).ok).toBe(false);
    expect((await oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: tokens.refresh_token, resource: f.config.resource })).ok).toBe(false);
    await f.pool.query('UPDATE rezics_account_security SET suspended_until = now() - interval \'1 second\' WHERE user_id = $1', [member.id]);
    const newSignIn = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(newSignIn.status).toBe(200);
    const newTokens = await oauth.issue(client.client_id, newSignIn.headers.get('set-cookie')!);
    expect(await oauth.introspect(newTokens.access_token)).toMatchObject({ active: true });
    expect(await oauth.introspect(tokens.access_token)).toEqual({ active: false });
    const reset = await f.request(`/api/account/admin/users/${member.id}/actions`, { action: 'require-password-reset',
      reason: 'Credential exposure report', commandId: randomUUID() }, oauth.owner.cookie);
    expect(reset.status).toBe(200);
    expect(await oauth.introspect(newTokens.access_token)).toEqual({ active: false });
    expect((await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password })).status).toBe(403);
    await f.request('/api/auth/request-password-reset', { email: member.email, redirectTo: `${f.baseURL}/reset-password` });
    await f.email.drain();
    const callback = await f.request(/https?:\/\/\S+/.exec(f.messages.at(-1)!.text)![0]);
    const token = new URL(callback.headers.get('location')!).searchParams.get('token');
    expect((await f.request('/api/auth/reset-password', { token, newPassword: 'a new secure password' })).status).toBe(200);
    expect((await f.request('/api/auth/sign-in/email', { email: member.email, password: 'a new secure password' })).status).toBe(200);
    expect(await oauth.introspect(newTokens.access_token)).toEqual({ active: false });
  } finally { await f.close(); }
}, 60_000);
