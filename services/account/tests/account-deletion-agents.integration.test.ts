import { expect, test } from 'bun:test';
import { AdmissionUnavailable } from '../../main/src/modules/access/admission.ts';
import { AccountHasOwnedAgents } from '../../main/src/modules/access/account-deletion-agents.ts';
import { accountFixture } from './account-fixture.ts';

test('Account deletion retains owned-Agent denial and validated explicit consent through the Access hook', async () => {
  const agents = Array.from({ length: 16 }, (_, index) => ({
    id: `agent-owned-${index}`, kind: index % 2 ? 'organization' : 'realm',
    ...(index % 2 ? {} : { displayName: `Shared reading room ${index}` }),
  }));
  const calls: { subject: string; leaveOwnedAgentsStanding: boolean }[] = [];
  let unavailable: Error | undefined;
  const f = await accountFixture({ accessDeletionFence: async (subject, options) => {
    calls.push({ subject, ...options });
    if (unavailable) throw unavailable;
    if (!options.leaveOwnedAgentsStanding) throw new AccountHasOwnedAgents(agents, 40);
  } });
  try {
    const member = await f.signup('owned-agents@example.test');
    expect((await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie)).status)
      .toBe(200);
    const remove = (extra: Record<string, unknown> = {}) => f.request('/api/auth/delete-user',
      { password: member.password, ...extra }, member.cookie);
    for (const extra of [{}, { leaveOwnedAgentsStanding: false }]) {
      const denied = await remove(extra);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({ type: 'https://rezics.com/problems/account_has_owned_agents',
        title: new AccountHasOwnedAgents(agents, 40).message, status: 409, code: 'account_has_owned_agents',
        agents, hasMore: true, moreCount: 24 });
      expect((await f.pool.query<{ deletion_started_at: Date | null }>(
        'SELECT deletion_started_at FROM rezics_account_security WHERE user_id = $1', [member.id]))
        .rows[0]?.deletion_started_at).toBeNull();
      expect((await f.pool.query('SELECT id FROM "user" WHERE id = $1', [member.id])).rowCount).toBe(1);
    }
    expect(calls).toEqual([
      { subject: member.id, leaveOwnedAgentsStanding: false },
      { subject: member.id, leaveOwnedAgentsStanding: false },
    ]);
    for (const invalid of ['true', 1, null, {}, []]) {
      const denied = await remove({ leaveOwnedAgentsStanding: invalid });
      expect(denied.status).toBe(400);
      expect((await denied.json() as { code: string }).code).toBe('invalid_deletion_consent');
    }
    expect(calls).toHaveLength(2);
    for (const error of [new AdmissionUnavailable('Access recovery is held'), new Error('journal unavailable')]) {
      unavailable = error;
      const denied = await remove({ leaveOwnedAgentsStanding: true });
      expect(denied.status).toBe(503);
      expect((await f.pool.query('SELECT id FROM "user" WHERE id = $1', [member.id])).rowCount).toBe(1);
      expect((await f.pool.query<{ deletion_started_at: Date | null }>(
        'SELECT deletion_started_at FROM rezics_account_security WHERE user_id = $1', [member.id]))
        .rows[0]?.deletion_started_at).toBeNull();
    }
    unavailable = undefined;
    expect((await remove({ leaveOwnedAgentsStanding: true })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ subject: member.id, leaveOwnedAgentsStanding: true });
    expect((await f.pool.query('SELECT id FROM "user" WHERE id = $1', [member.id])).rowCount).toBe(0);

    // Embedded callers use the same validated consent despite having no Request.
    const embedded = await f.signup('embedded-owned-agents@example.test');
    const body = { password: embedded.password, leaveOwnedAgentsStanding: true };
    const deleted = await f.auth.api.deleteUser({ body,
      headers: new Headers({ cookie: embedded.cookie, origin: f.baseURL }) });
    expect(deleted.success).toBe(true);
    expect(calls.at(-1)).toEqual({ subject: embedded.id, leaveOwnedAgentsStanding: true });
  } finally { await f.close(); }
}, 120_000);
