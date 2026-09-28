import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { writeAudit } from '../src/operators.ts';

test('G373 admin: creation intents and outcomes name the client, including historical unnamed intents', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient();
    type Entry = { targetId: string; targetName: string | null; targetKind: string; outcome: string; requestId: string };
    const list = async () => {
      const response = await f.request('/api/account/admin/audit', undefined, oauth.owner.cookie);
      expect(response.status).toBe(200);
      return (await response.json() as { items: Entry[] }).items;
    };
    const entries = (await list()).filter(entry => entry.targetId === client.client_id);
    expect(entries.map(entry => entry.outcome).sort()).toEqual(['attempted', 'succeeded']);
    expect(entries.every(entry => entry.targetKind === 'client' && entry.targetName === 'Notes')).toBe(true);

    // Model an existing append-only intent, whose client did not yet have an ID.
    const requestId = crypto.randomUUID();
    const audit = { actorId: oauth.owner.id, action: '/admin/oauth2/create-client', reason: 'Historical seed',
      before: null, requestId };
    await writeAudit(f.pool, { ...audit, targetId: 'new-client', after: null, outcome: 'attempted' });
    await writeAudit(f.pool, { ...audit, targetId: client.client_id,
      after: { name: 'Notes', clientId: client.client_id }, outcome: 'succeeded' });
    expect((await list()).filter(entry => entry.requestId === requestId)).toEqual([
      expect.objectContaining({ targetId: client.client_id, targetName: 'Notes', targetKind: 'client', outcome: 'succeeded' }),
      expect.objectContaining({ targetId: client.client_id, targetName: 'Notes', targetKind: 'client', outcome: 'attempted' }),
    ]);
    const overview = await (await f.request('/api/account/admin/overview', undefined, oauth.owner.cookie)).json() as { recentActions: Entry[] };
    expect(overview.recentActions.filter(entry => entry.requestId === requestId).every(entry => entry.targetName === 'Notes')).toBe(true);
    // An unfinished intent still has its requested name; no unrelated client is substituted.
    const pending = crypto.randomUUID();
    await writeAudit(f.pool, { ...audit, requestId: pending, targetId: 'new-client', after: { name: 'Pending app' }, outcome: 'attempted' });
    expect((await list()).find(entry => entry.requestId === pending))
      .toMatchObject({ targetId: 'new-client', targetName: 'Pending app', targetKind: 'client', outcome: 'attempted' });
    expect((await f.pool.query(`SELECT target_id, after_summary FROM rezics_account_operator_audit
      WHERE request_id = $1 AND outcome = 'attempted'`, [requestId])).rows)
      .toEqual([{ target_id: 'new-client', after_summary: null }]);
  } finally { await f.close(); }
}, 60_000);
