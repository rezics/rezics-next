import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomBytes, randomUUID } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import type { IdentityIntent } from '../../src/semantic/identity-epoch-contract.ts';
import { resumeIdentityEpochJob, waitIdentityEpochPublished } from '../../src/semantic/identity-epoch-coordinator.ts';
import { cutoverFixture, installIdentityEpochPublication } from '../semantic/support/identity-epoch-cutover.ts';
import { digest, release } from '../semantic/support/identity-epoch.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { TEST_REQUEST_DEADLINE_MS } from '../support/test-kernel.ts';

test('private Knowledge attachments stay on their originals through published merge and unmerge', async () => {
  const fixture = await cutoverFixture();
  try {
    const worker = await installIdentityEpochPublication(fixture);
    try {
      const { pool, real, accounts } = fixture;
      const accessActions = ['account:read', 'account:update', 'subject:read'];
      const [owner, outsider] = await Promise.all([
        real.bearerFor('editor', accessActions),
        real.bearerFor('outsider', accessActions),
      ]);
      const kernel = createKernel({
        pool,
        routeKey: randomBytes(32),
        tokens: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
        receiptKeys: testReceiptKeys(),
        requestDeadlineMs: TEST_REQUEST_DEADLINE_MS,
        access: (config) => real.access(config),
      });
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
      const survivor = (await fixture.create('Knowledge attachment survivor', 0x5d10)).id;
      const original = (await fixture.create('Knowledge attachment original', 0x5e10)).id;
      const inventory = `/v1/accounts/${accounts.editor}/knowledge/notebooks`;
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

      const actor = await fixture.actor();
      if (actor.kind !== 'account') throw new Error('Expected the native Subject editor');
      async function publish(intent: IdentityIntent) {
        const key = randomUUID();
        const job = await identityEpochStore().prepareAdmission(
          pool,
          {
            basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
            authorizationFor: () => fixture.authorization('subject:merge'),
            deadline: Date.now() + TEST_REQUEST_DEADLINE_MS,
          },
          {
            intent,
            receipt: {
              kind: 'subject.merge',
              command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
            },
          },
        );
        await resumeIdentityEpochJob(pool, job);
        await waitIdentityEpochPublished(pool, job);
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
    await fixture.close();
  }
}, 420_000);
