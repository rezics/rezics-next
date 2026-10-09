import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('GOV04: ending one offering does not change another recognition or reopen the ended slot', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const directory = join(root, '.temp', `rights-offering-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 5 });
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
    Record<string, string>, 'openid work:create work:read rights:offer rights:decide');
  try {
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
    const access = new AccessAdmissionRegistry(accessPool);
    const actor = agent();
    const reviewer = agent();
    const principals = new Map([[account.a.id, randomUUID()], [account.b.id, randomUUID()]]);
    for (const [subject, id] of principals) {
      await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
        [id, account.issuer, subject]);
      await grantRecordedPlatformUse(accessPool, id, ['commerce']);
    }
    const grant = async (user: { id: string }, subject: string, scope: string, action: string) => {
      await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')
        ON CONFLICT DO NOTHING`, [subject]);
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), principals.get(user.id), subject, action]);
      await accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject,
        scope_id, action, valid_until) VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), subject, scope, action]);
    };
    await grant(account.a, actor, 'work:create:root', 'work.create');
    const work = await createAdmittedMetadataWork(env, account.verifier, access,
      new Request('https://main.rezics.test/v1/works', {
        headers: { authorization: `Bearer ${account.tokenA}` } }),
      { actingSubject: actor, title: 'Rights offering target', idempotencyKey: randomUUID() });
    await grant(account.a, actor, `work:read:${work.work}`, 'work.read');
    const app = createMainApp(fuseki, { environment: env, account: account.verifier,
      access, platformAccess: new AccessExposure(accessPool) } as MainWorkDependencies);
    const call = async (method: string, path: string, token: string, body?: Record<string, unknown>) => {
      const response = await app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json',
          ...('idempotencyKey' in body ? { 'idempotency-key': String(body.idempotencyKey) } : {}) } : {}) },
        body: body ? JSON.stringify(body) : undefined }));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const instrumentA = 'https://creativecommons.org/licenses/by-sa/4.0/';
    const instrumentB = 'https://creativecommons.org/licenses/by/4.0/';
    await grant(account.a, actor, `rights:offer:${work.work}`, 'rights.offer-create');
    const create = (instrument: string, idempotencyKey: string) => call('POST', '/v1/rights/offerings',
      account.tokenA, { profile: 'rights-offering-create-v1', target: work.work, instrument,
        actingSubject: actor, idempotencyKey });
    expect((await call('POST', '/v1/rights/offerings', account.noScope,
      { profile: 'rights-offering-create-v1', target: work.work, instrument: instrumentA,
        actingSubject: actor, idempotencyKey: 'scope-denied' })).status).toBe(401);
    expect((await call('POST', '/v1/rights/offerings', account.tokenB,
      { profile: 'rights-offering-create-v1', target: work.work, instrument: instrumentA,
        actingSubject: actor, idempotencyKey: 'grant-denied' })).status).toBe(403);
    const a = await create(instrumentA, 'offer-a');
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await create(instrumentB, 'offer-b');
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await create(instrumentA, 'offer-a')).body).toMatchObject({ offering: a.body.offering, replayed: true });
    const duplicate = await create(instrumentA, 'offer-a-new');
    expect(duplicate.status).toBe(409);
    const missingTarget = agent();
    await grant(account.a, actor, `rights:offer:${missingTarget}`, 'rights.offer-create');
    expect((await call('POST', '/v1/rights/offerings', account.tokenA, {
      profile: 'rights-offering-create-v1', target: missingTarget, instrument: instrumentA,
      actingSubject: actor, idempotencyKey: 'missing-target' })).status).toBe(409);
    const path = (offering: string) => `/v1/rights/offerings/${offering.split('/').at(-1)}`;
    await grant(account.a, actor, `rights:offer:${a.body.offering}`, 'rights.offer-end');
    await grant(account.b, reviewer, `rights:recognize:${b.body.offering}`, 'rights.offer-recognize');
    const recognize = await call('POST', `${path(b.body.offering)}/changes`, account.tokenB,
      { profile: 'rights-offering-change-v1', action: 'recognize', actingSubject: reviewer,
        expectedOfferingHead: b.body.revision, expectedRecognitionHead: null, idempotencyKey: 'recognize-b' });
    expect(recognize.status, JSON.stringify(recognize.body)).toBe(201);
    const end = await call('POST', `${path(a.body.offering)}/changes`, account.tokenA,
      { profile: 'rights-offering-change-v1', action: 'end', actingSubject: actor,
        expectedOfferingHead: a.body.revision, expectedRecognitionHead: null, idempotencyKey: 'end-a' });
    expect(end.status, JSON.stringify(end.body)).toBe(201);
    const ended = await call('GET', `${path(a.body.offering)}?actingSubject=${encodeURIComponent(actor)}`,
      account.tokenA);
    expect(ended.body).toMatchObject({ state: 'ended', recognition: null, offeringHead: end.body.revision });
    const remaining = await call('GET', `${path(b.body.offering)}?actingSubject=${encodeURIComponent(actor)}`,
      account.tokenA);
    expect(remaining.body).toMatchObject({ state: 'open', recognition: 'recognized',
      recognitionHead: recognize.body.revision });
    const exact = (offering: string, revision: string) =>
      `${path(offering)}/revisions/${revision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`;
    expect((await call('GET', exact(a.body.offering, a.body.revision), account.tokenA)).body)
      .toMatchObject({ kind: 'offering', state: 'open', predecessor: null });
    expect((await call('GET', exact(a.body.offering, end.body.revision), account.tokenA)).body)
      .toMatchObject({ kind: 'offering', state: 'ended', predecessor: a.body.revision });
    expect((await call('GET', exact(b.body.offering, recognize.body.revision), account.tokenA)).body)
      .toMatchObject({ kind: 'recognition', state: 'recognized', predecessor: null });
    await grant(account.b, reviewer, `rights:recognize:${a.body.offering}`, 'rights.offer-recognize');
    const reopen = await call('POST', `${path(a.body.offering)}/changes`, account.tokenB,
      { profile: 'rights-offering-change-v1', action: 'recognize', actingSubject: reviewer,
        expectedOfferingHead: end.body.revision, expectedRecognitionHead: null, idempotencyKey: 'reopen-a' });
    expect(reopen.status).toBe(409);
    expect((await call('GET', `${path(a.body.offering)}?actingSubject=${encodeURIComponent(actor)}`,
      account.tokenA)).body).toMatchObject({ state: 'ended', recognition: null });
    const late = await call('POST', `${path(a.body.offering)}/changes`, account.tokenA,
      { profile: 'rights-offering-change-v1', action: 'end', actingSubject: actor,
        expectedOfferingHead: a.body.revision, expectedRecognitionHead: null, idempotencyKey: 'end-a-late' });
    expect(late.status).toBe(409);
    for (const [result, action] of [[a, 'rights.offer-create'],
      [recognize, 'rights.offer-recognize'], [end, 'rights.offer-end']] as const) {
      const batch = await readNextMainOutboxBatch(fuseki, env.lineage.dataEpoch,
        (BigInt(result.body.sequence) - 1n).toString());
      expect(batch?.sequence).toBe(result.body.sequence);
      const event = await readMainOutboxEnvelope(fuseki, batch!, batch!.eventIds[0]!);
      expect(event.data.receipt).toMatchObject({ action, offering: result.body.offering,
        revision: result.body.revision });
    }
  } finally {
    await account.close();
    await accessPool.end();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
