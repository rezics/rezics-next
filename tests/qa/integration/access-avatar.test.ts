import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { startMediaStack, png, sha } from './media-support.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const original = [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL];
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(); }
  catch (error) { await databases.close(); throw error; }
  finally { [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL] = original; }
  const storage = await startMediaStack('access-avatar');
  const access = new AccessAdmissionRegistry(h.accessPool);
  let baselineQueries = 0;
  access.configureBaseline({ query: async (sparql, maxBytes) => {
    baselineQueries++;
    return h.fuseki.query(sparql, maxBytes);
  } });
  const account = { verify: (request: Request) => h.verifier.verify(request, ['agent:create']) };
  const app = createMainApp(h.fuseki, { environment: h.env, account, access,
    content: storage.content, media: storage.media });
  const call = (method: string, path: string, body: unknown, key = randomUUID()) => app.handle(new Request(
    `http://main.test${path}`, { method, headers: { authorization: `Bearer ${h.token}`,
      'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
  await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
  const personResponse = await h.call(h.main(), h.token, randomUUID(), {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Avatar owner' });
  expect(personResponse.status).toBe(201);
  const person = (await personResponse.json() as { agent: string }).agent;
  const principal = await account.verify(new Request('http://main.test', {
    headers: { authorization: `Bearer ${h.token}` } }));
  const principalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0]!.id;
  const admit = (target: string) => access.register({ principal, actingSubject: person,
    action: 'media.avatar', scope: `media:avatar:${target}`,
    idempotencyKey: randomUUID(), requestDigest: digest(target) });
  const agent = async (kind: 'organization' | 'person') => {
    const response = await h.call(h.main(), h.token, randomUUID(), {
      profile: 'agent-provision-v1', kind, displayName: 'Avatar target' });
    expect(response.status).toBe(201);
    return (await response.json() as { agent: string }).agent;
  };
  return { ...h, storage, access, app, call, principal, principalId, person, admit, agent,
    baselineQueries: () => baselineQueries,
    close: async () => { await storage.stop(); await h.close(); await databases.close(); } };
}

test('G-317: verified controller selects Person, pen-name and managed Organization avatars', async () => {
  const h = await fixture();
  try {
    const organization = await h.agent('organization');
    const penName = id();
    await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [penName]);
    const penControl = randomUUID();
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [penControl, h.principalId, penName]);
    await h.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${penName}> a rv:Agent ; rv:agentKind rv:PenNameAgent . }
    }`);
    for (const target of [h.person, penName, organization]) {
      const before = h.baselineQueries();
      const registered = await h.admit(target);
      expect(registered.dispatchEligible).toBe(true);
      const claim = await h.access.claim(registered.id, registered.requestDigest, h.principal);
      expect(claim.state).toBe('claimed');
      expect(h.baselineQueries() - before).toBeLessThanOrEqual(2);
    }
    const bytes = png(64, 64);
    const reserved = await h.call('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1',
      asset: null, mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes),
      disclosure: 'public', actingSubject: h.person });
    expect(reserved.status, await reserved.clone().text()).toBe(201);
    const upload = await reserved.json() as { upload: string; asset: string };
    const activated = await h.app.handle(new Request(`http://main.test/v1/media/uploads/${upload.upload}/bytes`, {
      method: 'PUT', headers: { authorization: `Bearer ${h.token}`,
        'content-type': 'application/octet-stream' }, body: new Blob([bytes]) }));
    expect(activated.status, await activated.clone().text()).toBe(201);
    const selected = await h.call('PUT', `/v1/resources/${h.person.slice(-36)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: upload.asset, expectedSelection: null,
      actingSubject: h.person });
    expect(selected.status, await selected.clone().text()).toBe(201);
  } finally { await h.close(); }
}, 120_000);

test('G-317: another controller, lost pen-name control and suspension deny admission or claim', async () => {
  const h = await fixture();
  try {
    const foreign = await h.agent('person');
    const foreignPrincipal = randomUUID();
    await h.accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [foreignPrincipal, 'https://foreign.test', randomUUID()]);
    await h.accessPool.query(`UPDATE access.representation SET active = false
      WHERE subject_id = $1 AND action = 'agent.control'`, [foreign]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), foreignPrincipal, foreign]);
    await expect(h.admit(foreign)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('PUT', `/v1/resources/${foreign.slice(-36)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: randomUUID(), expectedSelection: null,
      actingSubject: h.person })).status).toBe(403);
    const penName = id();
    await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [penName]);
    const control = randomUUID();
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [control, h.principalId, penName]);
    await h.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${penName}> a rv:Agent ; rv:agentKind rv:PenNameAgent . }
    }`);
    const pending = await h.admit(penName);
    await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1', [control]);
    await expect(h.access.claim(pending.id, pending.requestDigest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.admit(penName)).rejects.toBeInstanceOf(AdmissionDenied);
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), h.principalId, penName]);
    await expect(h.access.claim(pending.id, pending.requestDigest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const suspended = await h.admit(h.person);
    await h.accountPool.query(`UPDATE rezics_account_security SET suspended_at = now(),
      generation = generation + 1 WHERE user_id = $1`, [h.user.id]);
    await expect(h.access.claim(suspended.id, suspended.requestDigest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('PUT', `/v1/resources/${h.person.slice(-36)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: randomUUID(), expectedSelection: null,
      actingSubject: h.person })).status).toBe(401);
  } finally { await h.close(); }
}, 120_000);
