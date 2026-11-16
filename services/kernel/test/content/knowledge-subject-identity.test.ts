import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { validateContentDocument } from '../../src/content/document.ts';
import { withBoundedReadConnection } from '../../src/database/pool.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import { readIdentityEpochCutover } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { identityJobPartition, type IdentityIntent } from '../../src/semantic/identity-epoch-contract.ts';
import { identityEpochWorkflowId } from '../../src/semantic/core/identity-epoch-sequence.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubjectIndex } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { readSearchConfig } from '../../src/search/work.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { digest, release } from '../semantic/support/identity-epoch.ts';
import { nativeOperator } from './support/native-system.ts';
import { openUserCasesSystem, startUserCasesWorker } from './support/user-cases-fixtures.ts';

test('private Knowledge attachments stay on their originals through published merge and unmerge', async () => {
  const system = await openUserCasesSystem();
  try {
    const { pool } = system.database;
    await bootstrapRelease(pool, release.release);
    const prefix = `knowledge-${randomUUID().replaceAll('-', '')}-`;
    const search = readSearchConfig({ ...process.env, KERNEL_SEARCH_PREFIX: prefix });
    if (!search) throw new Error('Knowledge identity requires the native Search producer');
    await createSubjectIndex(createOpenSearch(search.url), prefix, 1);
    const worker = await startUserCasesWorker(system, prefix);
    try {
      async function awaitWorker(condition: () => Promise<boolean>, stage: string) {
        const deadline = Date.now() + 120_000;
        while (worker.child.exitCode === null && Date.now() < deadline) {
          if (await condition()) return;
          await Bun.sleep(300);
        }
        throw new Error(`Native worker did not complete ${stage}: ${worker.diagnostics().slice(-8000)}`);
      }

      await awaitWorker(async () => (await readIdentityEpochCutover(pool)).state === 'ready', 'identity topology');
      const accountId = system.actors.author.actor.accountId;
      const owner = system.actors.author.bearer;
      const outsider = system.actors.other.bearer;
      const kernel = system.kernel;
      const call = async (method: 'GET' | 'POST', path: string, body?: unknown, bearer: string | null = owner) => {
        const response = await kernel.handle(
          new Request(`https://kernel.test${path}`, {
            method,
            headers: {
              ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(randomUUID()) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return { status: response.status, value: await response.json() };
      };
      const create = async (path: string, input: unknown) => {
        const result = await call('POST', path, input);
        expect(result.status, JSON.stringify(result.value)).toBe(201);
        return result.value;
      };
      const { subject: survivorSubject } = await create('/v1/subjects', {
        type: 'schema:Person',
        labels: { en: 'Knowledge attachment survivor' },
      });
      const { subject: originalSubject } = await create('/v1/subjects', {
        type: 'schema:Person',
        labels: { en: 'Knowledge attachment original' },
      });
      const survivor: string = survivorSubject.id;
      const original: string = originalSubject.id;
      const inventory = `/v1/accounts/${accountId}/knowledge/notebooks`;
      const scope = (id: string, limit = 20) => `${inventory}?subjectId=${id}&limit=${limit}`;
      const first = await create('/v1/knowledge/notebooks', { subjectId: survivor, title: 'Survivor notes' });
      const second = await create('/v1/knowledge/notebooks', { subjectId: survivor, title: 'More survivor notes' });
      const third = await create('/v1/knowledge/notebooks', { subjectId: original, title: 'Original notes' });
      const document = await create(`/v1/knowledge/notebooks/${third.notebookId}/documents`, {
        title: 'Private manuscript',
        body: fromPlainText('Private original notes'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: third.structureRevisionId,
        parentPlacementId: null,
      });
      const selectedBody = {
        body: fromPlainText('Selected public original notes'),
        licence: 'MIT',
        subjectIds: [original],
      };
      const selected = await create(`/v1/knowledge/notebooks/${third.notebookId}/documents`, {
        ...selectedBody,
        title: 'Selected original manuscript',
        expectedStructureRevisionId: document.structureRevisionId,
        parentPlacementId: null,
      });
      const publicPath = `/v1/knowledge/documents/${selected.documentId}`;
      const publication = await call('POST', `${publicPath}/publication:select`, {
        expectedHeadRevisionId: selected.revisionId,
        expectedPublicationId: null,
        revisionId: selected.revisionId,
      });
      expect(publication.status, JSON.stringify(publication.value)).toBe(200);
      const unselected = await call('POST', `${publicPath}/revisions:revise`, {
        ...selectedBody,
        body: fromPlainText('Unselected replacement manuscript'),
        title: 'Unselected replacement',
        expectedHeadRevisionId: selected.revisionId,
      });
      expect(unselected.status, JSON.stringify(unselected.value)).toBe(200);
      const exactPath = `${publicPath}?revisionId=${selected.revisionId}`;
      const expectedPublicRevision = {
        revisionId: selected.revisionId,
        publicationId: publication.value.publicationId,
        canonicalBytes: Buffer.from(validateContentDocument(selectedBody).canonicalBytes).toString('base64'),
      };
      async function expectPublicSelection(phase: string, erased = false) {
        const expected = erased ? { ...expectedPublicRevision, authorId: null } : expectedPublicRevision;
        for (const path of [publicPath, exactPath]) {
          const read = await call('GET', path, undefined, null);
          expect(read.status, `${phase} ${path} ${JSON.stringify(read.value)}`).toBe(200);
          expect(read.value.document).toMatchObject(expected);
          expect(read.value.document).not.toHaveProperty('notebookId');
        }
        const privateRevision = await call(
          'GET',
          `${publicPath}?revisionId=${unselected.value.revisionId}`,
          undefined,
          null,
        );
        expect(privateRevision.status, phase).toBe(404);
      }
      await expectPublicSelection('before identity publication');
      const privatePath = `${inventory}/${third.notebookId}/documents/${document.documentId}`;
      const privateBefore = await call('GET', privatePath);
      expect(privateBefore.status).toBe(200);
      expect(privateBefore.value.document).toMatchObject({
        documentId: document.documentId,
        revisionId: document.revisionId,
      });

      const listed = async (id: string, limit?: number) => {
        const result = await call('GET', scope(id, limit));
        expect(result.status, JSON.stringify(result.value)).toBe(200);
        return result.value;
      };
      const expected = (notebookId: string, subjectId: string) => expect.objectContaining({ notebookId, subjectId });
      const own = [expected(first.notebookId, survivor), expected(second.notebookId, survivor)];
      const old = expected(third.notebookId, original);
      expect((await listed(survivor)).notebooks).toEqual(expect.arrayContaining(own));
      expect((await listed(original)).notebooks).toEqual([old]);
      const beforeMerge = (await listed(survivor, 1)).next;
      expect(beforeMerge).toEqual(expect.any(String));

      async function publish(intent: IdentityIntent) {
        const key = randomUUID();
        const deadline = Date.now() + 5_000;
        const actor = await system.access.authenticate(nativeOperator(system).bearer, { pool, deadline });
        if (actor.kind !== 'account')
          throw new Error('Native Subject identity needs the authenticated governance actor');
        const job = await identityEpochStore().prepareAdmission(
          pool,
          {
            basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
            authorizationFor: () =>
              accessCommandAuthorization(
                system.access,
                actor,
                'subject:merge',
                { route: 0, id: GLOBAL_CONTEXT },
                { pool, deadline },
                () => new Error('Native Subject identity maintenance is forbidden'),
              ),
            deadline,
          },
          {
            intent,
            receipt: {
              kind: 'subject.merge',
              command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
            },
          },
        );
        try {
          await awaitWorker(
            async () => (await identityEpochStore().readJob(pool, job))?.state === 'published',
            intent.kind,
          );
        } catch (error) {
          // The fixture drops its database after stopping the worker. Read the
          // retained boundary once before teardown without fetching source bodies.
          const locator = { jobId: job.jobId, epoch: job.epoch.toString() };
          const workflows = [0, 1, 2, 3].map((segment) => identityEpochWorkflowId(locator, segment));
          const observed = await withBoundedReadConnection(pool, Date.now() + 3_000, (client) =>
            client.query(
              `WITH job_homes AS MATERIALIZED (
                 SELECT resource_home,prepared_transaction_id IS NOT NULL AS prepared,
                   acquired_transaction_id IS NOT NULL AS acquired
                 FROM semantic.identity_epoch_admission_plan
                 WHERE partition_no=$1 AND job_id=$2 ORDER BY resource_home LIMIT 2
               )
               SELECT j.state,j.prearm_phase,
               (SELECT jsonb_agg(h ORDER BY h.resource_home) FROM job_homes h) AS homes,
               (SELECT jsonb_agg(r ORDER BY r.resource_home,r.revision,r.phase) FROM (
                 SELECT h.resource_home,p.revision::text AS revision,p.state,
                   p.applied_transaction_id IS NOT NULL AS application_recorded,
                   CASE
                     WHEN p.after_key IS NULL THEN 'initial'
                     WHEN p.after_key IS JSON OBJECT THEN CASE
                       WHEN p.after_key::jsonb->>'phase'='original' THEN 'original-source'
                       WHEN p.after_key::jsonb->>'phase'='terminal' THEN 'terminal-source'
                       WHEN p.after_key::jsonb->'terminal'='true'::jsonb THEN 'terminal'
                       WHEN p.after_key::jsonb ? 'support' THEN 'source-directory'
                       WHEN p.after_key::jsonb ? 'copy' THEN 'copy'
                       ELSE 'unknown'
                     END
                     ELSE 'unknown'
                   END AS phase
                 FROM job_homes h
                 CROSS JOIN LATERAL (
                   SELECT revision,state,applied_transaction_id,after_key
                   FROM semantic.identity_epoch_receiving_search_progress
                   WHERE partition_no=h.resource_home AND job_id=j.job_id ORDER BY effect_key LIMIT 2
                 ) p
               ) r) AS reconciliation,
               (SELECT count(*)::int FROM semantic.identity_epoch_admission_source s
                WHERE s.partition_no=j.partition_no AND s.job_id=j.job_id) AS sources,
               (SELECT count(*)::int FROM semantic.identity_epoch_admission_validation v
                WHERE v.partition_no=j.partition_no AND v.job_id=j.job_id) AS validated_sources,
               (SELECT jsonb_agg(p ORDER BY p.generation) FROM (
                 SELECT d.generation,d.sequence::text AS frontier,d.exhausted,
                   d.sealed_transaction_id IS NOT NULL AS sealed,
                   page.sequence::text AS last_page,page.capture_id IS NOT NULL AS captured,
                   (SELECT array_agg(x.stage ORDER BY x.stage)
                    FROM semantic.identity_epoch_prearm_disposition x
                    WHERE x.partition_no=d.partition_no AND x.page_id=page.page_id) AS disposition
                 FROM semantic.identity_epoch_prearm_directory d
                 LEFT JOIN LATERAL (
                   SELECT p.sequence,p.page_id,p.capture_id FROM semantic.identity_epoch_prearm_page p
                   WHERE p.partition_no=d.partition_no AND p.job_id=d.job_id AND p.generation=d.generation
                   ORDER BY p.sequence DESC LIMIT 1
                 ) page ON true
                 WHERE d.partition_no=j.partition_no AND d.job_id=j.job_id ORDER BY d.generation LIMIT 2
               ) p) AS prearm,
               (SELECT jsonb_agg(w ORDER BY w.ordinal) FROM (
                 SELECT ids.ordinal,s.status,NULLIF(s.error,'') IS NOT NULL AS error_recorded,
                   (SELECT step.function_name FROM dbos.operation_outputs step
                    WHERE step.workflow_uuid=ids.workflow_uuid ORDER BY step.function_id DESC LIMIT 1) AS last_step,
                   (SELECT jsonb_build_object('step',step.function_name,'code',
                      substring(step.error FROM '"code"[[:space:]]*:[[:space:]]*"(identity_[a-z_]+)"'))
                    FROM dbos.operation_outputs step
                    WHERE step.workflow_uuid=ids.workflow_uuid AND NULLIF(step.error,'') IS NOT NULL
                    ORDER BY step.function_id LIMIT 1) AS first_error
                 FROM unnest($3::text[]) WITH ORDINALITY AS ids(workflow_uuid,ordinal)
                 LEFT JOIN dbos.workflow_status s USING (workflow_uuid)
               ) w) AS coordinator
               FROM semantic.identity_epoch_job j WHERE j.partition_no=$1 AND j.job_id=$2`,
              [identityJobPartition(job), job.jobId, workflows],
            ),
          ).then(
            ({ rows }) => rows[0] ?? null,
            () => 'unavailable',
          );
          console.info('Knowledge retained identity admission', JSON.stringify({ intent: intent.kind, observed }));
          throw error;
        }
        return job;
      }

      const merged = await publish({ kind: 'merge', survivor, redirected: original, release: release.digest });
      await expectPublicSelection('after merge publication');
      for (const id of [survivor, original]) {
        const { notebooks } = await listed(id);
        expect(notebooks).toHaveLength(3);
        expect(notebooks).toEqual(expect.arrayContaining([...own, old]));
      }
      expect(await call('GET', privatePath)).toEqual(privateBefore);
      expect((await call('GET', privatePath, undefined, outsider)).status).toBe(404);
      const continued = (cursor: string) => `${scope(survivor, 1)}&cursor=${encodeURIComponent(cursor)}`;
      expect(await call('GET', continued(beforeMerge))).toMatchObject({
        status: 409,
        value: { code: 'stale_cursor' },
      });
      const beforeUnmerge = (await listed(survivor, 1)).next;
      expect(beforeUnmerge).toEqual(expect.any(String));
      expect((await call('GET', continued(beforeUnmerge), undefined, outsider)).status).toBe(404);

      await publish({ kind: 'unmerge', original, undoJob: merged, verificationReceipt: null, release: release.digest });
      await expectPublicSelection('after unmerge publication');
      expect(await call('GET', continued(beforeUnmerge))).toMatchObject({
        status: 409,
        value: { code: 'stale_cursor' },
      });
      const { notebooks } = await listed(survivor);
      expect(notebooks).toHaveLength(2);
      expect(notebooks).toEqual(expect.arrayContaining(own));
      expect((await listed(original)).notebooks).toEqual([old]);
      expect(await call('GET', privatePath)).toEqual(privateBefore);
      expect((await call('GET', privatePath, undefined, outsider)).status).toBe(404);

      const runtime = accountDeletionRuntime(system);
      const obligation = await deletePersona({ pool, auth: runtime.auth }, { accountId, bearer: owner });
      await awaitWorker(async () => {
        const status = await readErasureStatus(pool, accountId);
        return status?.at === obligation.at && status.participants.content?.outcome === 'erased';
      }, 'Knowledge account disposition after merge and unmerge');

      const route = routeOf(accountId)!;
      const notebooksAfterErasure = await pool.query(
        'SELECT notebook_id FROM content.knowledge_notebook WHERE route=$1 AND owner_account_id=$2',
        [route, accountId],
      );
      expect(notebooksAfterErasure.rowCount).toBe(0);
      const remainingRevisions = await pool.query(
        `SELECT document_id,revision_id,author_account_id FROM content.knowledge_revision
         WHERE route=$1 AND document_id=ANY($2::uuid[])`,
        [route, [document.documentId, selected.documentId]],
      );
      expect(remainingRevisions.rows).toEqual([
        { document_id: selected.documentId, revision_id: selected.revisionId, author_account_id: null },
      ]);
      await expectPublicSelection('after content erasure acknowledgement', true);
      expect(await call('GET', privatePath)).toMatchObject({ status: 401, value: { code: 'invalid_credentials' } });
      expect((await call('GET', privatePath, undefined, outsider)).status).toBe(404);
    } finally {
      await worker.stop();
    }
  } finally {
    await system.close();
  }
}, 600_000);
