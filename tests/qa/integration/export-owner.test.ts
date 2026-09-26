import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { planExport } from '../../../services/main/src/modules/export/planner.ts';
import { ExportConflict, ExportStore, exportTerminal } from '../../../services/main/src/modules/export/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('LIVE07/COMP08/FACT05: Content export terminal is exact, concurrent, idempotent and recoverable',
  async () => {
    const runId = Bun.env.REZICS_QA_RUN_ID;
    if (!runId) throw new Error('Use the isolated QA integration tier');
    const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content']);
    const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
    const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
    let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
    try {
      await migrateContent(contentPool);
      account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
        Record<string, string>, 'openid export:create export:read');
      const principalId = randomUUID();
      const actor = agent();
      const selected = agent();
      const scope = `export:${selected}`;
      await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`, [principalId, account.issuer, account.a.id]);
      await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);
      await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1)`, [scope]);
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,'export.create',now() + interval '1 hour')`, [randomUUID(), principalId, actor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'export.create',now() + interval '1 hour')`, [randomUUID(), actor, scope]);
      const bearer = new Request('http://main.local/v1/exports',
        { headers: { authorization: `Bearer ${account.tokenA}` } });
      const verified = await account.verifier.verify(bearer, ['export:create']);
      await expect(account.verifier.verify(new Request('http://main.local/v1/exports',
        { headers: { authorization: `Bearer ${account.noScope}` } }), ['export:create']))
        .rejects.toThrow();
      const registry = new AccessAdmissionRegistry(accessPool);
      const admission = await registry.register({ principal: verified, actingSubject: actor,
        scope, action: 'export.create', idempotencyKey: 'export-owner-1', requestDigest: sha('intent-1') });
      const claimed = await registry.claim(admission.id, admission.requestDigest);
      const members = [0, 1].map((index) => ({ sourceOwner: 'graph' as const,
        sourceNamespace: 'product', sourceGrain: 'occurrence' as const,
        exactRef: `urn:occurrence:${index}`, contentRevisionId: null, refDigest: sha(`member-${index}`),
        ownerDataEpoch: 'graph-epoch-1', ownerSequence: String(12 + index),
        sourcePosition: `chapter/${index}`, targetGrain: 'Occurrence', mapping: 'exact' as const,
        value: { kind: 'integer' as const, lexical: String(index) } }));
      const plan = await planExport({ targetProfile: 'rezics-composition-v1', useScope: 'evaluation',
        members, residuals: [] }, async () => [{ basisKind: 'unprotected_fact', basisRef: null,
        licenseExpression: null, notice: null, obligations: [], useScope: 'evaluation',
        result: 'undetermined', memberOrdinals: [1, 2] }]);
      const store = new ExportStore(contentPool);
      const [first, concurrent] = await Promise.all([store.seal(claimed, plan), store.seal(claimed, plan)]);
      expect(first.manifestId).toBe(concurrent.manifestId);
      expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
      expect(first.plan.members.map(item => [item.exactRef, item.sourcePosition, item.ownerSequence]))
        .toEqual([['urn:occurrence:0', 'chapter/0', '12'], ['urn:occurrence:1', 'chapter/1', '13']]);
      expect(first.position.sequence).toMatch(/^[1-9][0-9]*$/);
      expect((await contentPool.query(`SELECT count(*)::int AS n FROM content.receipt
        WHERE operation_id = $1`, [`export:${admission.id}`])).rows[0].n).toBe(1);
      // Simulate a lost response before the Access seal: the retained Content
      // manifest and its receipt settle the original admission without a rewrite.
      const restored = await store.readByAdmission(admission.principalId, admission.id);
      expect(restored?.manifestDigest).toBe(plan.manifestDigest);
      await registry.recordGraphOutcome(admission.id, exportTerminal(admission, first.position, 'succeeded'));
      await registry.recordGraphOutcome(admission.id, exportTerminal(admission, first.position, 'succeeded'));
      expect((await store.seal({ ...claimed, state: 'sealed' }, plan)).replayed).toBe(true);
      await expect(store.seal({ ...claimed, state: 'sealed' }, { ...plan,
        manifestDigest: sha('wrong') })).rejects.toBeInstanceOf(ExportConflict);

      const refused = await registry.register({ principal: verified, actingSubject: actor,
        scope, action: 'export.create', idempotencyKey: 'export-owner-refused',
        requestDigest: sha('stale-selection') });
      const cancellations = await Promise.all([store.cancel(refused), store.cancel(refused)]);
      expect(cancellations.map(item => item.outcome)).toEqual(['cancelled', 'cancelled']);
      expect(cancellations[0]?.sequence).toBe(cancellations[1]?.sequence);
      const cancelled = cancellations[0]!;
      await registry.recordGraphOutcome(refused.id, cancelled);
      expect(await store.readByAdmission(refused.principalId, refused.id)).toBeNull();

      await contentPool.query(`INSERT INTO export.manifest (id, principal_id, idempotency_key,
        request_digest, admission_id, authority_epoch, target_profile, use_scope)
        SELECT gen_random_uuid(), $1, 'unrelated-' || g::text, $2, gen_random_uuid(), 0,
          'rezics-composition-v1', 'evaluation' FROM generate_series(1, 1000) AS g`,
      [principalId, sha('unrelated')]);
      const found = await contentPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT id FROM export.manifest WHERE id = $1 AND principal_id = $2 AND state = 'sealed'`,
      [first.manifestId, principalId]);
      const planText = JSON.stringify(found.rows[0]);
      expect(planText).toContain('Index Scan');
    } finally {
      await account?.close();
      await Promise.all([accessPool.end(), contentPool.end()]);
      await databases.close();
    }
  });
