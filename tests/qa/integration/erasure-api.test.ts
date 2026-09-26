import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type QueryResult } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { ensureRetentionDomain, ERASURE_JOURNAL_EPOCH, retireRetentionDomain } from
  '../../../services/main/src/modules/erasure/journal.ts';
import { verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { CONTENT_LIVE_DOMAIN, CONTENT_LIVE_RETENTION, CONTENT_WAL_DOMAIN, completePendingContentErasures,
  erasureReceiptIri, ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

interface Costs { calls: number; rows: number }

/** Counts every SQL statement and returned row an owner adapter issues. */
function counted(pool: Pool, costs: Costs): Pool {
  const count = (result: QueryResult) => {
    costs.calls++;
    costs.rows += result.rows.length;
    return result;
  };
  return { query: async (sql: string, values?: unknown[]) => count(await pool.query(sql, values)),
    connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => count(await client.query(sql, values)),
        release: () => client.release() };
    } } as unknown as Pool;
}

interface Report {
  erasureId: string; erasureEpoch: string; stage: string; suppression: string; destruction: string;
  replayed: boolean; targets: { owner: string; kind: string; ref: string }[];
  dispositions: { domain: string; store: string; custody: string; suppression: string; destruction: string;
    retainedUntil: string | null; reason: string | null; evidenceDigest: string | null }[];
}

test('OPS11: Content erasure journals exact targets with receipts, denial, stale and recovery outcomes and explicit per-store retention', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaAccountAccessDatabases(runId);
  const accessPool = new Pool({ connectionString: databases.urls.access });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
    Record<string, string>, 'openid access:manage work:read');
  const objects = join(root, '.temp', `erasure-api-${randomUUID()}`);
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const registry = new AccessAdmissionRegistry(accessPool);
    const relayCosts: Costs = { calls: 0, rows: 0 };
    const contentCosts: Costs = { calls: 0, rows: 0 };
    const service = new ErasureService(counted(relayPool, relayCosts), counted(contentPool, contentCosts));
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const main = createMainApp(fuseki, { environment: { fuseki, objectDirectory: objects,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } },
    account: account.verifier, access: registry, erasures: service });
    const call = (method: string, path: string, token: string | null, body?: object,
      key: string | null = `erasure-${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));

    // Principal A may erase inside one Work's erasure scope; principal B holds no grant.
    const work = `https://rezics.com/id/${randomUUID()}`;
    const otherWork = `https://rezics.com/id/${randomUUID()}`;
    const actorA = `https://rezics.com/id/${randomUUID()}`;
    const actorB = `https://rezics.com/id/${randomUUID()}`;
    const [principalA, principalB] = [randomUUID(), randomUUID()];
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $3, $4), ($2, $3, $5)`, [principalA, principalB, account.issuer, account.a.id, account.b.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent'), ($2, 'agent')`,
      [actorA, actorB]);
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1), ($2)',
      [`erasure:${work}`, `erasure:${otherWork}`]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'erasure.request', now() + interval '1 hour'),
             ($4, $5, $6, 'erasure.request', now() + interval '1 hour')`,
    [randomUUID(), principalA, actorA, randomUUID(), principalB, actorB]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'erasure.request', now() + interval '1 hour')`,
    [randomUUID(), actorA, `erasure:${work}`]);

    // Unpublished Content revisions of the Work; one revision belongs to another Work.
    const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    let head: string | null = null;
    const save = async (body: string, target = variant) => {
      const saved = await content.saveDraft({ operationId: `erasure-api-${randomUUID()}`, variant: target,
        expectedHead: target === variant ? head : null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-api' }, serializedJson: JSON.stringify({ body }) });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content save failed');
      if (target === variant) head = saved.revisionId;
      return saved.revisionId;
    };
    const [erased, kept, raced, crashed, pending] = [
      await save('private text to erase'), await save('unrelated kept text'),
      await save('raced text'), await save('crash text'), await save('pending text')];
    const costTargets = [];
    for (let i = 0; i < 12; i++) costTargets.push(await save(`cost text ${i}`));
    const published = await save('published text');
    const foreign = await save('other work text', { ...variant, id: `urn:rezics:variant:${randomUUID()}`,
      resourceId: otherWork });
    const publishedExact = (await content.readExactBatch([published], async ids => new Set(ids)))[0];
    if (publishedExact?.status !== 'available') throw new Error('published revision is unavailable');
    await content.preparePublication(`erasure-api-publish-${randomUUID()}`, published,
      publishedExact.reference.byteDigest);
    const status = async (id: string) =>
      (await content.readExactBatch([id], async ids => new Set(ids)))[0]?.status;

    // Copy locations are declared: the live owner and a backup with a declared expiry.
    const backupLabel = `content:backup:erasure-api-${randomUUID()}`;
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await ensureRetentionDomain(relayPool, { label: CONTENT_LIVE_DOMAIN, owner: 'content',
      store: 'postgresql', custody: 'live' });
    await ensureRetentionDomain(relayPool, { label: backupLabel, owner: 'content',
      store: 'postgresql', custody: 'backup', expiresAt: expiry });
    const request = (revisionIds: string[], resourceId = work) => ({
      profile: 'content-revision-erasure-v1', actingSubject: actorA, resourceId, revisionIds });

    // Denied or malformed requests journal nothing.
    const journaled = async () => Number((await relayPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM relay.erasure WHERE principal_id = ANY($1::uuid[])',
      [[principalA, principalB]])).rows[0]!.n);
    expect((await call('POST', '/v1/erasures', null, request([erased]))).status).toBe(401);
    expect([401, 403]).toContain((await call('POST', '/v1/erasures', account.noScope, request([erased]))).status);
    // A narrower consent exchange can retire the earlier token for the same user.
    account.tokenA = await account.tokenFor(account.a);
    expect((await call('POST', '/v1/erasures', account.tokenB,
      { ...request([erased]), actingSubject: actorB })).status).toBe(403);
    expect((await call('POST', '/v1/erasures', account.tokenA, request([erased]), null)).status).toBe(400);
    expect((await call('POST', '/v1/erasures', account.tokenA, request([foreign]))).status).toBe(400);
    expect((await call('POST', '/v1/erasures', account.tokenA, request([randomUUID()]))).status).toBe(400);
    const publishedResponse = await call('POST', '/v1/erasures', account.tokenA, request([published]));
    expect(publishedResponse.status).toBe(409);
    expect(((await publishedResponse.json()) as { code: string }).code).toBe('graph_suppression_unavailable');
    expect(await status(published)).toBe('available');
    expect(await journaled()).toBe(0);

    // One admitted erasure: Content tombstone, journal suppression and explicit retention.
    const key = `erasure-${randomUUID()}`;
    const accepted = await call('POST', '/v1/erasures', account.tokenA, request([erased]), key);
    expect(accepted.status).toBe(200);
    const report = await accepted.json() as Report;
    expect(report).toMatchObject({ stage: 'inventory_complete', suppression: 'suppressed',
      destruction: 'retained', replayed: false,
      targets: [{ owner: 'content', kind: 'content_revision', ref: erased }] });
    const dispositions = new Map(report.dispositions.map(entry => [entry.domain, entry]));
    expect(dispositions.get(CONTENT_LIVE_DOMAIN)).toMatchObject({ custody: 'live',
      suppression: 'suppressed', destruction: 'retained', reason: CONTENT_LIVE_RETENTION });
    expect(dispositions.get(CONTENT_WAL_DOMAIN)).toMatchObject({ store: 'postgresql_wal',
      suppression: 'suppressed', destruction: 'retained', reason: CONTENT_LIVE_RETENTION });
    expect(dispositions.get(backupLabel)).toMatchObject({ custody: 'backup',
      suppression: 'not_applicable', destruction: 'retained', retainedUntil: expiry.toISOString() });
    expect(await status(erased)).toBe('erased');
    expect(await status(kept)).toBe('available');
    expect((await contentPool.query(`SELECT erasure_id, erasure_epoch::text AS epoch
      FROM content.revision_erasure WHERE revision_id = $1`, [erased])).rows)
      .toEqual([{ erasure_id: report.erasureId, epoch: report.erasureEpoch }]);
    const seal = (await accessPool.query<{ state: string; graph_receipt: string; graph_outcome: string;
      graph_data_epoch: string; graph_sequence: string; id: string }>(`SELECT id, state, graph_receipt,
      graph_outcome, graph_data_epoch, graph_sequence FROM access.admission
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalA, key])).rows[0]!;
    expect(seal).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded',
      graph_receipt: erasureReceiptIri(seal.id), graph_data_epoch: ERASURE_JOURNAL_EPOCH,
      graph_sequence: report.erasureEpoch });

    // Replay returns the same erasure; the key cannot bind another intent.
    const replay = await call('POST', '/v1/erasures', account.tokenA, request([erased]), key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ erasureId: report.erasureId, replayed: true });
    // A crash after the Access seal but before inventory must finish on replay.
    await relayPool.query(`UPDATE relay.erasure SET stage = 'fenced', destruction_status = 'pending'
      WHERE id = $1`, [report.erasureId]);
    const resumed = await call('POST', '/v1/erasures', account.tokenA, request([erased]), key);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ erasureId: report.erasureId,
      stage: 'inventory_complete', destruction: 'retained', replayed: true });
    const changed = await call('POST', '/v1/erasures', account.tokenA, request([kept]), key);
    expect(changed.status).toBe(409);
    expect(await status(kept)).toBe('available');

    // Stale and concurrent targets: an exact reference is erased once and never retargeted.
    const stale = await call('POST', '/v1/erasures', account.tokenA, request([erased]));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('erasure_target_stale');
    const racing = await Promise.all([0, 1].map(() =>
      call('POST', '/v1/erasures', account.tokenA, request([raced]))));
    expect(racing.map(response => response.status).sort()).toEqual([200, 409]);
    expect(Number((await relayPool.query<{ n: string }>(`SELECT count(*)::text AS n
      FROM relay.erasure_target WHERE owner = 'content' AND target_ref = $1`, [raced])).rows[0]!.n)).toBe(1);
    expect(Number((await accessPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM access.admission
      WHERE principal_id = $1 AND state <> 'sealed'`, [principalA])).rows[0]!.n)).toBe(0);

    // Exact read belongs to the requesting principal only.
    const read = await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ erasureId: report.erasureId, stage: 'inventory_complete' });
    expect((await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenB)).status).toBe(404);
    expect((await call('GET', `/v1/erasures/${randomUUID()}`, account.tokenA)).status).toBe(404);

    // Access recovery hold keeps the command and read offline without journaling.
    const fence = await engageAccessRecoveryFence(accessPool);
    const before = await journaled();
    expect((await call('POST', '/v1/erasures', account.tokenA, request([crashed]))).status).toBe(503);
    expect((await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA)).status).toBe(503);
    expect(await journaled()).toBe(before);
    await releaseAccessRecoveryFence(accessPool, fence);

    // A failure after journaling leaves committed intent; the same key completes it.
    await contentPool.query(`CREATE FUNCTION content.erasure_api_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.revision_id = ANY(ARRAY['${crashed}', '${pending}']::uuid[]) THEN
        RAISE EXCEPTION 'forced Content erasure failure'; END IF; RETURN NEW; END $$`);
    await contentPool.query(`CREATE TRIGGER erasure_api_fail BEFORE INSERT ON content.revision_erasure
      FOR EACH ROW EXECUTE FUNCTION content.erasure_api_fail()`);
    const crashKey = `erasure-${randomUUID()}`;
    try {
      expect((await call('POST', '/v1/erasures', account.tokenA, request([crashed]), crashKey)).status).toBe(503);
      expect((await call('POST', '/v1/erasures', account.tokenA, request([pending]))).status).toBe(503);
      expect(await status(crashed)).toBe('available');
      expect((await relayPool.query<{ stage: string }>(`SELECT e.stage FROM relay.erasure e
        JOIN relay.erasure_target t ON t.erasure_id = e.id WHERE t.target_ref = $1`, [crashed])).rows)
        .toEqual([{ stage: 'requested' }]);
    } finally {
      await contentPool.query('DROP TRIGGER erasure_api_fail ON content.revision_erasure');
      await contentPool.query('DROP FUNCTION content.erasure_api_fail()');
    }
    const completed = await call('POST', '/v1/erasures', account.tokenA, request([crashed]), crashKey);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ suppression: 'suppressed', replayed: true });
    expect(await status(crashed)).toBe('erased');
    // The operator reconciler completes an abandoned journaled erasure without its client.
    expect((await completePendingContentErasures(service, registry)).completed).toBeGreaterThanOrEqual(1);
    expect(await status(pending)).toBe('erased');
    expect(Number((await relayPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM relay.erasure
      WHERE principal_id = $1 AND stage = 'requested'`, [principalA])).rows[0]!.n)).toBe(0);

    // Verification probes every target and copy; expiry of the backup is its own evidence.
    const verified = await verifyErasure(relayPool, { content: contentPool }, report.erasureId,
      `verify:${report.erasureId}`);
    expect(verified).toMatchObject({ state: 'reconciled', counts: { erased: 1 } });
    await retireRetentionDomain(relayPool, backupLabel, 'expired', sha(`${backupLabel} expired`));
    const final = await (await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA)).json() as Report;
    expect(final).toMatchObject({ stage: 'verified', suppression: 'suppressed', destruction: 'retained' });
    expect(final.dispositions.find(entry => entry.domain === backupLabel)).toMatchObject({
      destruction: 'expired', evidenceDigest: sha(`${backupLabel} expired`) });
    expect(final.dispositions.find(entry => entry.domain === CONTENT_LIVE_DOMAIN)).toMatchObject({
      suppression: 'suppressed', destruction: 'retained' });

    // Cost contract: constant owner SQL calls across journal size and target count.
    const measure = async (revisionIds: string[]) => {
      relayCosts.calls = relayCosts.rows = contentCosts.calls = contentCosts.rows = 0;
      const response = await call('POST', '/v1/erasures', account.tokenA, request(revisionIds));
      expect(response.status).toBe(200);
      return { relay: { ...relayCosts }, content: { ...contentCosts } };
    };
    const grow = async (count: number) => {
      const client = await relayPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
        // Background entries are blocked so no reconciler treats them as pending work.
        await client.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest, kind,
            authority, principal_id, admission_id, authority_epoch, stage, blocked_reason)
          SELECT gen_random_uuid(), m.epoch + g, 'erasure-api-background:' || gen_random_uuid(),
            repeat('0', 64), 'revision', 'access_admission', gen_random_uuid(), gen_random_uuid(), 0,
            'blocked', 'cost fixture'
          FROM generate_series(1, $1::int) AS g,
            (SELECT coalesce(max(erasure_epoch), 0) AS epoch FROM relay.erasure) AS m`, [count]);
        await client.query('COMMIT');
      } finally { client.release(); }
    };
    const small = await measure([costTargets[0]!]);
    await grow(32);
    const grown = await measure([costTargets[1]!]);
    await grow(224);
    const large = await measure([costTargets[2]!]);
    expect(grown.relay.calls).toBe(small.relay.calls);
    expect(large.relay.calls).toBe(small.relay.calls);
    expect(large.content.calls).toBe(small.content.calls);
    expect(large.relay.rows).toBe(small.relay.rows);
    const wide = await measure(costTargets.slice(3, 11));
    expect(wide.relay.calls).toBe(small.relay.calls);
    expect(wide.content.calls).toBe(small.content.calls);
    expect(wide.relay.rows).toBeLessThanOrEqual(small.relay.rows + 7 * 2);
    expect(small.relay.calls).toBeLessThanOrEqual(40);
    expect(small.content.calls).toBeLessThanOrEqual(12);
    relayCosts.calls = relayCosts.rows = 0;
    expect((await call('GET', `/v1/erasures/${report.erasureId}`, account.tokenA)).status).toBe(200);
    expect(relayCosts.calls).toBe(3);
    const plan = async (sql: string, params: unknown[]) => {
      const client = await relayPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        return JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    expect(await plan('SELECT max(erasure_epoch) FROM relay.erasure', [])).toContain('erasure_erasure_epoch_key');
    expect(await plan(`SELECT erasure_id FROM relay.erasure_target WHERE owner = $1 AND target_kind = $2
      AND target_ref = $3`, ['content', 'content_revision', erased])).toContain('erasure_target_ref');
  } finally {
    await account.close();
    await Promise.allSettled([accessPool.end(), contentPool.end(), relayPool.end()]);
    await databases.close();
    rmSync(objects, { recursive: true, force: true });
  }
}, 180_000);
