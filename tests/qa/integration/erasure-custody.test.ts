import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence,
  releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { graphErasureSuppressed } from '../../../services/main/src/modules/erasure/graph.ts';
import { ensureRetentionDomain, ErasureUnavailable, readErasure } from
  '../../../services/main/src/modules/erasure/journal.ts';
import { CONTENT_LIVE_DOMAIN, CONTENT_LIVE_RETENTION, CONTENT_WAL_DOMAIN,
  completePendingContentErasures, ErasureService } from
  '../../../services/main/src/modules/erasure/request.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { assertGraphAdmissionOpen } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

interface Report {
  erasureId: string; erasureEpoch: string; stage: string; suppression: string;
  destruction: string; replayed: boolean;
  dispositions: { domain: string; custody: string; suppression: string; destruction: string;
    retainedUntil: string | null; reason: string | null; evidenceDigest: string | null }[];
}

/** Fail after both owners suppress, before the separately retryable inventory commits. */
function inventoryFault(pool: Pool) {
  const fault = { pending: false };
  const check = (sql: string) => {
    if (fault.pending && sql.includes("FROM relay.retention_domain WHERE state = 'active'")) {
      fault.pending = false;
      throw new ErasureUnavailable('private inventory diagnostic');
    }
  };
  const owner = { query: async (sql: string, values?: unknown[]) => {
    check(sql);
    return pool.query(sql, values);
  }, connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      check(sql);
      return client.query(sql, values);
    }, release: () => client.release() };
  } } as unknown as Pool;
  return { owner, fault };
}

test('OPS10/OPS11/OPS12: Content suppression survives owner handoff failures and every restored read, admission and ready gate remains held', async () => {
  const apps = Bun.env as Record<string, string>;
  if (!apps.REZICS_QA_RUN_ID || !apps.FUSEKI_URL || !apps.MAIN_DATA_EPOCH
    || !apps.MAIN_ROUTING_EPOCH || !apps.CONTENT_DATABASE_URL || !apps.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaAccountAccessDatabases(apps.REZICS_QA_RUN_ID);
  const accessPool = new Pool({ connectionString: databases.urls.access });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `erasure-custody-${randomUUID()}`);
  const account = await ratingAccount({ ...apps, ACCOUNT_DATABASE_URL: databases.urls.account },
    'openid access:manage work:create work:read');
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const registry = new AccessAdmissionRegistry(accessPool);
    let failSeal = false;
    const access = new Proxy(registry, { get(target, property) {
      if (property === 'recordGraphOutcome') return async (...args: Parameters<typeof registry.recordGraphOutcome>) => {
        if (failSeal) {
          failSeal = false;
          throw new AdmissionUnavailable('private owner seal diagnostic');
        }
        return target.recordGraphOutcome(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const inventory = inventoryFault(relayPool);
    const service = new ErasureService(inventory.owner, contentPool, accessPool);
    const fuseki = new FusekiClient(apps.FUSEKI_URL);
    const environment = { fuseki, objectDirectory: directory,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
    await assertGraphAdmissionOpen(fuseki, environment.lineage);
    const dependencies = { environment, account: account.verifier, access, content, erasures: service };
    const main = createMainApp(fuseki, dependencies);
    const call = (method: string, path: string, token: string | null, body?: object,
      key = `erasure-custody:${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const otherActor = `https://rezics.com/id/${randomUUID()}`;
    const principalA = randomUUID(), principalB = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $3, $4), ($2, $3, $5)`, [principalA, principalB, account.issuer, account.a.id, account.b.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent'), ($2, 'agent')",
      [actor, otherActor]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`, [randomUUID(), principalA, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`, [randomUUID(), actor]);
    const work = (await createAdmittedMetadataWork(environment, account.verifier, access,
      new Request('http://main.local/v1/works', { headers: { authorization: `Bearer ${account.tokenA}` } }),
      { actingSubject: actor, idempotencyKey: `erasure-custody:${randomUUID()}`,
        title: `Content erasure fixture ${randomUUID()}`, language: 'en' })).work;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1), ($2)',
      [`erasure:${work}`, `work:read:${work}`]);
    for (const action of ['erasure.request', 'work.read']) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour'),
               ($5, $6, $7, $4, now() + interval '1 hour')`,
      [randomUUID(), principalA, actor, action, randomUUID(), principalB, otherActor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, action === 'work.read' ? `work:read:${work}` : `erasure:${work}`, action]);
    }
    const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    let head: string | null = null;
    const save = async (body: string) => {
      const saved = await content.saveDraft({ operationId: `erasure-custody:${randomUUID()}`, variant,
        expectedHead: head, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-custody' }, serializedJson: JSON.stringify({ body }) });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content fixture save failed');
      head = saved.revisionId;
      return saved.revisionId;
    };
    const secret = 'erased text must never appear in erasure metadata';
    const sealed = await save(secret), inventoried = await save('inventory interruption'),
      raced = await save('concurrent target'), kept = await save('unrelated retained text'),
      partial = await save('private bytes while the Content owner retries');
    const readRevision = (revision: string) => call('GET',
      `/v1/content-revisions/${revision}?actingSubject=${encodeURIComponent(actor)}`, account.tokenA);
    const readable = await readRevision(partial);
    expect(readable.status).toBe(200);
    expect(await readable.json()).toMatchObject({ body: { body: 'private bytes while the Content owner retries' } });
    const status = async (revision: string) =>
      (await content.readExactBatch([revision], async ids => new Set(ids)))[0]?.status;
    const body = (revisionIds: string[], actingSubject = actor) => ({
      profile: 'content-revision-erasure-v1', actingSubject, resourceId: work, revisionIds });
    const journalCount = async () => Number((await relayPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relay.erasure WHERE principal_id = $1', [principalA])).rows[0]!.count);
    const journalFor = async (revision: string) => (await relayPool.query<{ erasure_id: string }>(
      `SELECT erasure_id FROM relay.erasure_target
       WHERE owner = 'content' AND target_kind = 'content_revision' AND target_ref = $1`, [revision])).rows[0]!.erasure_id;
    const backup = `content:backup:erasure-custody:${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await ensureRetentionDomain(relayPool, { label: backup, owner: 'content', store: 'postgresql',
      custody: 'backup', expiresAt });

    expect((await call('POST', '/v1/erasures', null, body([sealed]))).status).toBe(401);
    expect((await call('POST', '/v1/erasures', account.tokenB, body([sealed], otherActor))).status).toBe(403);
    expect([401, 403]).toContain((await call('POST', '/v1/erasures', account.noScope, body([sealed]))).status);
    account.tokenA = await account.tokenFor(account.a);
    expect(await journalCount()).toBe(0);
    expect(await status(sealed)).toBe('available');

    // The Access seal is a tail step; its failure cannot resurrect either owner.
    const sealKey = `erasure-custody:${randomUUID()}`;
    failSeal = true;
    const sealFailure = await call('POST', '/v1/erasures', account.tokenA, body([sealed]), sealKey);
    expect(sealFailure.status).toBe(503);
    expect(await sealFailure.text()).not.toContain('private owner seal diagnostic');
    const sealErasure = await readErasure(relayPool, await journalFor(sealed));
    expect(sealErasure).toMatchObject({ stage: 'fenced', suppression: 'suppressed', destruction: 'pending' });
    expect(await status(sealed)).toBe('erased');
    expect(await graphErasureSuppressed(fuseki, sealErasure.erasureId, sealErasure.erasureEpoch, [sealed])).toBe(true);
    const retried = await call('POST', '/v1/erasures', account.tokenA, body([sealed]), sealKey);
    expect(retried.status).toBe(200);
    const report = await retried.json() as Report;
    expect(report).toMatchObject({ erasureId: sealErasure.erasureId, suppression: 'suppressed',
      stage: 'inventory_complete', destruction: 'retained', replayed: true });
    expect(await journalCount()).toBe(1);

    // A lost inventory tail is recoverable by the operator without the client.
    const inventoryKey = `erasure-custody:${randomUUID()}`;
    inventory.fault.pending = true;
    const inventoryFailure = await call('POST', '/v1/erasures', account.tokenA, body([inventoried]), inventoryKey);
    expect(inventoryFailure.status).toBe(503);
    expect(await inventoryFailure.text()).not.toContain('private inventory diagnostic');
    const inventoryErasure = await readErasure(relayPool, await journalFor(inventoried));
    expect(inventoryErasure).toMatchObject({ stage: 'fenced', suppression: 'suppressed' });
    expect(await status(inventoried)).toBe('erased');
    expect(await graphErasureSuppressed(fuseki, inventoryErasure.erasureId,
      inventoryErasure.erasureEpoch, [inventoried])).toBe(true);
    expect(await completePendingContentErasures(service, environment, access)).toEqual({ completed: 1, failed: [] });
    const operatorRetry = await call('POST', '/v1/erasures', account.tokenA, body([inventoried]), inventoryKey);
    expect(operatorRetry.status).toBe(200);
    expect(await operatorRetry.json()).toMatchObject({ erasureId: inventoryErasure.erasureId,
      suppression: 'suppressed', destruction: 'retained', replayed: true });
    expect(await journalCount()).toBe(2);

    expect((await call('POST', '/v1/erasures', account.tokenA, body([sealed]))).status).toBe(409);
    const concurrent = await Promise.all([0, 1].map(() =>
      call('POST', '/v1/erasures', account.tokenA, body([raced]))));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await journalCount()).toBe(3);
    expect((await call('POST', '/v1/erasures', account.tokenA, body([kept]), sealKey)).status).toBe(409);
    expect(await status(kept)).toBe('available');
    const requested = await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA);
    expect(requested.status).toBe(200);
    expect(requested.headers.get('cache-control')).toBe('no-store');
    const metadata = await requested.text();
    for (const privateValue of [secret, account.a.id, principalA, 'requestDigest', 'operationId', 'admissionId']) {
      expect(metadata).not.toContain(privateValue);
    }
    expect((await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenB)).status).toBe(404);
    expect((await call('GET', `/v1/erasures/${randomUUID()}`, account.tokenA)).status).toBe(404);
    const domains = new Map(report.dispositions.map(domain => [domain.domain, domain]));
    expect(domains.get(backup)).toMatchObject({ custody: 'backup', suppression: 'not_applicable',
      destruction: 'retained', retainedUntil: expiresAt.toISOString(), evidenceDigest: null });
    for (const domain of [CONTENT_LIVE_DOMAIN, CONTENT_WAL_DOMAIN]) {
      expect(domains.get(domain)).toMatchObject({ suppression: 'suppressed', destruction: 'retained',
        reason: CONTENT_LIVE_RETENTION, evidenceDigest: null });
    }
    expect(report.dispositions.some(domain => domain.destruction === 'destroyed')).toBe(false);

    // Native graph suppression prevents public delivery while Content's transaction retries.
    const partialKey = `erasure-custody:${randomUUID()}`;
    await contentPool.query(`CREATE FUNCTION content.erasure_custody_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.revision_id = '${partial}'::uuid THEN
        RAISE EXCEPTION 'private Content erasure diagnostic'; END IF; RETURN NEW; END $$`);
    await contentPool.query(`CREATE TRIGGER erasure_custody_fail BEFORE INSERT ON content.revision_erasure
      FOR EACH ROW EXECUTE FUNCTION content.erasure_custody_fail()`);
    let partialErasure = '';
    try {
      const interrupted = await call('POST', '/v1/erasures', account.tokenA, body([partial]), partialKey);
      expect(interrupted.status).toBe(503);
      expect(await interrupted.text()).not.toContain('private Content erasure diagnostic');
      partialErasure = await journalFor(partial);
      const pending = await readErasure(relayPool, partialErasure);
      expect(pending).toMatchObject({ stage: 'requested', suppression: 'pending', destruction: 'pending' });
      expect(await graphErasureSuppressed(fuseki, pending.erasureId, pending.erasureEpoch, [partial])).toBe(true);
      expect(await status(partial)).toBe('available');
      expect(await dependencies.content.readExactBatch([partial], async ids => new Set(ids)))
        .toEqual([{ revisionId: partial, status: 'erased' }]);
      expect((await readRevision(partial)).status).toBe(404);
      expect(await journalCount()).toBe(4);
    } finally {
      await contentPool.query('DROP TRIGGER erasure_custody_fail ON content.revision_erasure');
      await contentPool.query('DROP FUNCTION content.erasure_custody_fail()');
    }
    const partialRetry = await call('POST', '/v1/erasures', account.tokenA, body([partial]), partialKey);
    expect(partialRetry.status).toBe(200);
    expect(await partialRetry.json()).toMatchObject({ erasureId: partialErasure, stage: 'inventory_complete',
      suppression: 'suppressed', destruction: 'retained', replayed: true });
    expect(await status(partial)).toBe('erased');
    expect(await dependencies.content.readExactBatch([partial], async ids => new Set(ids)))
      .toEqual([{ revisionId: partial, status: 'erased' }]);
    expect(await journalCount()).toBe(4);

    const principal = await account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${account.tokenA}` },
    }), ['work:read']);
    const publicRead = () => workRead(dependencies, new Request('http://main.local/v1/works'), {},
      async () => 'public bytes');
    const exactRead = () => content.readExactBatch([kept], async ids =>
      await registry.canReadWork(principal, actor, work) ? new Set(ids) : new Set<string>());
    expect(await publicRead()).toBe('public bytes');
    expect((await exactRead())[0]?.status).toBe('available');
    expect((await readRevision(kept)).status).toBe(200);
    expect((await call('GET', '/health/ready', null)).status).toBe(200);
    const fence = await engageAccessRecoveryFence(accessPool);
    try {
      await expect(publicRead()).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(exactRead()).rejects.toBeInstanceOf(AdmissionUnavailable);
      expect((await readRevision(kept)).status).toBe(503);
      expect((await call('GET', '/health/ready', null)).status).toBe(503);
      expect((await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA)).status).toBe(503);
      const priorCount = await journalCount();
      expect((await call('POST', '/v1/erasures', account.tokenA, body([kept]))).status).toBe(503);
      await expect(registry.register({ principal, actingSubject: actor, action: 'erasure.request',
        scope: `erasure:${work}`, idempotencyKey: `held:${randomUUID()}`, requestDigest: 'a'.repeat(64) }))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect(await journalCount()).toBe(priorCount);
      expect(await status(kept)).toBe('available');
    } finally { await releaseAccessRecoveryFence(accessPool, fence); }
    expect(await publicRead()).toBe('public bytes');
    expect((await call('GET', '/health/ready', null)).status).toBe(200);
    expect((await exactRead())[0]?.status).toBe('available');
    expect((await readRevision(kept)).status).toBe(200);
    let deliveryFence: string | undefined;
    try {
      await expect(workRead(dependencies, new Request('http://main.local/v1/works'), {}, async () => {
        deliveryFence = await engageAccessRecoveryFence(accessPool);
        return 'bytes prepared before the restore fence closed';
      })).rejects.toBeInstanceOf(AdmissionUnavailable);
      expect(deliveryFence).toBeDefined();
      expect((await call('GET', '/health/ready', null)).status).toBe(503);
    } finally {
      if (deliveryFence) await releaseAccessRecoveryFence(accessPool, deliveryFence);
    }
    deliveryFence = undefined;
    try {
      await expect(workRead(dependencies, new Request('http://main.local/v1/works'),
        { localBasis: true }, async session => {
          session.observeDependency('retained-owner', 'unchanged', async () => {
            deliveryFence = await engageAccessRecoveryFence(accessPool);
            return 'unchanged';
          });
          return 'bytes prepared before the dependency fence';
        })).rejects.toBeInstanceOf(AdmissionUnavailable);
      expect(deliveryFence).toBeDefined();
    } finally {
      if (deliveryFence) await releaseAccessRecoveryFence(accessPool, deliveryFence);
    }
    expect(await status(sealed)).toBe('erased');
    expect(await status(inventoried)).toBe('erased');
  } finally {
    await account.close();
    await Promise.allSettled([accessPool.end(), contentPool.end(), relayPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
