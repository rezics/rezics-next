import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

test('A verified creator reads a newly private Work without a manual work.read grant', async () => {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const accountUrl = Bun.env.ACCOUNT_DATABASE_URL;
  const accessUrl = Bun.env.ACCESS_DATABASE_URL;
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(); }
  catch (error) { await databases.close(); throw error; }
  finally { Bun.env.ACCOUNT_DATABASE_URL = accountUrl; Bun.env.ACCESS_DATABASE_URL = accessUrl; }
  try {
    const access = new AccessAdmissionRegistry(h.accessPool);
    access.configureBaseline(h.fuseki);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    const agent = await h.call(h.main(), h.token, randomUUID(), {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Creator' });
    expect(agent.status).toBe(201);
    const subject = (await agent.json() as { agent: string }).agent;
    const create = createMainApp(h.fuseki, { environment: h.env, account: h.verifier, access });
    const work = await create.handle(new Request('http://main.local/v1/works', { method: 'POST',
      headers: { authorization: `Bearer ${h.wrongScopeToken}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify({ profile: 'metadata-only-v1',
        title: 'New private Work', actingSubject: subject }) }));
    expect(work.status).toBe(201);
    const id = (await work.json() as { work: string }).work;
    const principal = await h.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${h.token}` } }), ['agent:create']);
    expect(await access.canReadWork(principal, subject, id)).toBe(true);
    const granted = await h.accessPool.query('SELECT id FROM access.permission_grant WHERE scope_id = $1',
      [`work:read:${id}`]);
    expect(granted.rowCount).toBe(0);
    const read = createMainApp(h.fuseki, { environment: h.env, access,
      account: { verify: request => h.verifier.verify(request, ['agent:create']) } });
    const response = await read.handle(new Request(`http://main.local/v1/works/${id.slice(-36)}?actingSubject=${encodeURIComponent(subject)}`,
      { headers: { authorization: `Bearer ${h.token}` } }));
    expect(response.status).toBe(200);
    expect((await response.json() as { id: string }).id).toBe(id);
  } finally { await h.close(); await databases.close(); }
}, 180_000);
