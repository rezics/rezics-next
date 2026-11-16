import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import { readIdentityEpochCutover } from '../../src/semantic/identity-epoch-bootstrap.ts';
import type { IdentityIntent } from '../../src/semantic/identity-epoch-contract.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubjectIndex } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { readSearchConfig } from '../../src/search/work.ts';
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
      const owner = system.actors.author.bearer;
      const outsider = system.actors.other.bearer;
      const kernel = system.kernel;
      const call = async (method: 'GET' | 'POST', path: string, body?: unknown, bearer = owner) => {
        const response = await kernel.handle(
          new Request(`https://kernel.test${path}`, {
            method,
            headers: {
              authorization: `Bearer ${bearer}`,
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
      const inventory = `/v1/accounts/${system.actors.author.actor.accountId}/knowledge/notebooks`;
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
        await awaitWorker(
          async () => (await identityEpochStore().readJob(pool, job))?.state === 'published',
          intent.kind,
        );
        return job;
      }

      const merged = await publish({ kind: 'merge', survivor, redirected: original, release: release.digest });
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
      expect(await call('GET', continued(beforeUnmerge))).toMatchObject({
        status: 409,
        value: { code: 'stale_cursor' },
      });
      const { notebooks } = await listed(survivor);
      expect(notebooks).toHaveLength(2);
      expect(notebooks).toEqual(expect.arrayContaining(own));
      expect((await listed(original)).notebooks).toEqual([old]);
      expect(await call('GET', privatePath)).toEqual(privateBefore);
    } finally {
      await worker.stop();
    }
  } finally {
    await system.close();
  }
}, 480_000);
