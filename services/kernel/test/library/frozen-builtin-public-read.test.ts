import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import outputHead from '../../src/library/collection-source-output-head.sql';
import { routeOf } from '../../src/route/route.ts';
import { createSubjectIndex } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { startConsentServer, type ConsentServer } from '../community/membership-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import {
  createOwnedErasureFixture,
  readLibraryErasureDispatch,
  readLibraryMergeDispatch,
  readLibraryWorkerResult,
} from './support/erasure-worker.ts';

async function waitFor<T>(phase: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 60_000;
  let value = await read();
  while (!ready(value)) {
    if (performance.now() >= deadline) throw new Error(`${phase}: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
    value = await read();
  }
  return value;
}

async function verifyFrozenPublication(redirect: boolean) {
  const searchUrl = process.env.OPENSEARCH_URL;
  if (!searchUrl) throw new Error('Built-in publication Staging needs the owned Search service');
  const f = await createOwnedErasureFixture();
  let consentServer: ConsentServer | undefined;
  try {
    const owner = f.people.alice;
    const id = builtinCollectionId(owner.accountId, { kind: 'everything' });
    const path = `/v1/collections/${id}`;
    const membersPath = `${path}/members`;
    const subjects = [await f.subject(), await f.subject()];
    if (redirect) subjects.push(await f.subject());
    subjects.sort();
    const terminal = subjects[0]!;
    const original = redirect ? subjects[1]! : terminal;
    const independent = subjects.at(-1)!;
    for (const subjectId of [original, independent])
      await f.json(owner, 'PUT', `/v1/libraryEntries/${subjectId}`, 201, { state: 'planned' });

    const temporaryRoot = resolve(import.meta.dir, '../../../../.temp');
    await mkdir(temporaryRoot, { recursive: true });
    const consent = createCurrentConsentReader({ database: f.auth.authPool });
    consentServer = await startConsentServer(
      async (input) => (await consent.readCurrentConsent(input))?.scopes ?? null,
      temporaryRoot,
    );
    const searchPrefix = `library-publish-${randomUUID().replaceAll('-', '')}`;
    await createSubjectIndex(createOpenSearch(searchUrl), searchPrefix, 1);
    await f.start({
      ...consentServer.env,
      KERNEL_ROUTE_KEY: Buffer.from(testRouteKey()).toString('base64url'),
      OPENSEARCH_URL: searchUrl,
      KERNEL_SEARCH_PREFIX: searchPrefix,
    });

    const steward = f.people.staff;
    if (redirect) {
      await f.json(steward, 'POST', '/v1/platform/exposure/subject_identity:open', 200);
      await f.json(steward, 'POST', '/v1/grants', 201, {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: steward.accountId },
        actions: ['subject:merge', 'gate:subject_identity'],
        valid: '(,)',
      });
      // Establish the redirect after saving the original and before the immutable output is selected.
      const { operation } = await f.json(steward, 'POST', '/v1/subjects:merge', 202, {
        subjects: [terminal, original],
      });
      const merged = await waitFor(
        'Subject redirect did not publish',
        async () => (await f.json(steward, 'GET', `/v1/subjectIdentityOperations/${operation.id}`, 200)).operation,
        (value) => value.done === true,
      ).catch(async (cause: unknown) => {
        const dispatch = await readLibraryMergeDispatch(f.db.pool, f.client, operation.id, f.effectsQueueWarning);
        throw new Error(`Subject merge dispatch: ${JSON.stringify(dispatch)}`, { cause });
      });
      expect(merged.result).toMatchObject({ survivor: terminal, redirected: original });
    }

    const admitted = await f.json(owner, 'POST', `${path}:publish`, 202, { revision: 0, visibility: 'public' });
    const completed = await waitFor(
      'Built-in publication did not complete',
      async () => {
        const status = await f.json(owner, 'GET', `/v1/collectionPublications/${admitted.id}`, 200);
        if (status.phase !== 'complete' && (await f.client.getWorkflow(admitted.id))?.status === 'ERROR')
          await readLibraryWorkerResult(f.client, admitted.id);
        return status;
      },
      (value) => {
        expect(value.phase).not.toBe('refused');
        return value.phase === 'complete';
      },
    ).catch(async (error: unknown) => {
      const workflow = await f.client.getWorkflow(admitted.id);
      throw new Error(`Publication workflow status: ${workflow?.status ?? 'absent'}`, { cause: error });
    });
    const generation: string = completed.publication.generation;
    const members = [terminal, independent].map((subjectId) => ({ kind: 'dynamic', subjectId }));
    const live = await waitFor(
      'Selected output did not become readable',
      async () => {
        const response = await f.request(null, 'GET', membersPath);
        expect([200, 503]).toContain(response.status);
        return { status: response.status, body: await response.json() };
      },
      (value) => value.status === 200,
    );
    expect(live.body).toEqual({ members, next: null });

    const outside = await f.subject();
    await f.json(owner, 'PUT', `/v1/libraryEntries/${outside}`, 201, { state: 'planned' });
    const readSelection = async () =>
      (
        await f.db.pool.query<{
          sourceGeneration: string;
          selectedSourceGeneration: string | null;
          selectedGeneration: string | null;
          outputState: string | null;
          retainedGeneration: string | null;
        }>(
          `SELECT c.source_generation::text AS "sourceGeneration",
                  h.source_generation::text AS "selectedSourceGeneration",
                  h.generation::text AS "selectedGeneration", g.state AS "outputState",
                  retained.generation::text AS "retainedGeneration"
           FROM library.collection c
           LEFT JOIN library.collection_source_output_head h USING (route,collection_id)
           LEFT JOIN library.collection_source_output g
             ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
           LEFT JOIN library.collection_retained_output retained
             ON (retained.route,retained.collection_id)=(c.route,c.collection_id)
           WHERE c.route=$1 AND c.collection_id=$2`,
          [routeOf(id), id],
        )
      ).rows[0];
    const selectedBeforeErasure = await readSelection();
    expect(selectedBeforeErasure).toMatchObject({
      selectedGeneration: generation,
      outputState: 'complete',
      retainedGeneration: null,
    });
    expect(selectedBeforeErasure?.selectedSourceGeneration).toBe(selectedBeforeErasure?.sourceGeneration);
    await deletePersona(f.options, owner);
    expect((await f.request(owner, 'GET', membersPath)).status).toBe(401);
    const retained = async () =>
      (
        await f.db.pool.query(
          `SELECT c.curator_account_id,g.account_id,f.generation::text,f.members::int AS members
             FROM library.collection c
             LEFT JOIN library.collection_retained_output f USING (route,collection_id)
             LEFT JOIN library.collection_source_output g USING (route,collection_id,generation)
             WHERE c.route=$1 AND c.collection_id=$2`,
          [routeOf(id), id],
        )
      ).rows[0];
    await waitFor(
      'Terminal participant did not select the retained generation',
      retained,
      (row) => row?.generation === generation,
    ).catch(async (cause: unknown) => {
      const [dispatch, selection] = await Promise.all([
        readLibraryErasureDispatch(f.db.pool, f.client, owner.accountId),
        readSelection(),
      ]);
      const eligible = selection
        ? (await f.db.pool.query<{ generation: string }>(outputHead.sql, [routeOf(id), id, selection.sourceGeneration]))
            .rows[0]?.generation
        : undefined;
      throw new Error(
        `Library terminal dispatch: ${JSON.stringify({
          dispatch,
          selectedBeforeErasure,
          selection,
          eligibleGeneration: eligible ?? null,
          queueWarning: f.effectsQueueWarning,
        })}`,
        {
          cause,
        },
      );
    });
    await f.client.triggerSchedule('library.canonicalSource.every-10-minutes');
    const frozen = await waitFor(
      'Selected output did not lose curator attribution',
      retained,
      (row) => row?.curator_account_id === null,
    );
    expect(frozen).toEqual({ curator_account_id: null, account_id: null, generation, members: 2 });
    const { collection } = await f.json(null, 'GET', path, 200);
    expect(collection).toMatchObject({ id, curatorAccountId: null, builtinKind: 'everything', visibility: 'public' });

    const first = await f.json(null, 'GET', `${membersPath}?limit=1`, 200);
    expect(first.members).toEqual(members.slice(0, 1));
    expect(first.next).toBeString();
    const second = await f.json(null, 'GET', `${membersPath}?limit=1&cursor=${encodeURIComponent(first.next)}`, 200);
    expect(second).toEqual({ members: members.slice(1), next: null });

    for (const subjectId of new Set([original, terminal])) {
      await f.json(steward, 'POST', `/v1/subjects/${subjectId}:hide`, 200, {
        reason: 'Current disclosure of an exact frozen member',
      });
      expect(await f.json(null, 'GET', `${membersPath}?limit=1`, 200)).toEqual({
        members: members.slice(1),
        next: null,
      });
      await f.json(steward, 'POST', `/v1/subjects/${subjectId}:restore`, 200, {
        reason: 'Restore disclosure of the exact frozen member',
      });
      expect(await f.json(null, 'GET', membersPath, 200)).toEqual({ members, next: null });
    }
    expect(await retained()).toEqual(frozen);
  } finally {
    try {
      await f.close();
    } finally {
      await consentServer?.close();
    }
  }
}

test(
  'anonymous members retain the selected built-in generation after curator erasure',
  () => verifyFrozenPublication(false),
  360_000,
);

test(
  'anonymous members recheck the original and terminal after curator erasure',
  () => verifyFrozenPublication(true),
  360_000,
);
