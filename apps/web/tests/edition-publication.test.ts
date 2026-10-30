import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { ExactRevision } from '../src/threads/exact-revision';
import type { EditionMetadata } from '../src/content-editions/edition-api';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import {
  EditionPublicationController,
  editionCreateHref,
  editionSourceFromLink,
  type EditionCommandRead,
  type EditionCreateApi,
  type EditionPublicationIntent,
} from '../src/content-editions/edition-create';
import {
  createNativeEditionCreateApi,
  parseEditionCommand,
  unavailableEditionCreateApi,
} from '../src/content-editions/edition-create-native';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const identity = { postId: id(1), revisionId: id(3) };
const creator = id(90);
const subject = id(20);
const editionId = id(80);

/** Boundary responses, not a native-authority or database harness. */
async function fixture() {
  const body = fromPlainText('The original authored source, fixed independently of subsequent post edits.');
  const revision: ExactRevision = {
    id: identity.postId,
    revisionId: identity.revisionId,
    authorId: creator,
    threadId: id(2),
    boardId: id(30),
    route: 0,
    parentId: null,
    availability: 'available',
    visibility: 'protected',
    securityRevision: '1',
    createdAt: '2026-10-31T12:00:00Z',
    revisedAt: null,
    sha256: await editionDocumentDigest(body),
    mediaIds: [],
    licence: 'CC-BY-SA-4.0',
    subjectIds: [subject],
    voteCitation: null,
    body,
  };
  let edition: EditionMetadata | null = null;
  let sourceStatus = 200;
  let postActions = true;
  let lostCreate = true;
  let lostPublish = true;
  const receipts = new Map<string, { editionId: string; editionRevision: string }>();
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const inputBody: unknown = request.method === 'POST' ? await request.json() : null;
      calls.push({ path, method: request.method, headers: request.headers, body: inputBody });
      expect(request.headers.get('authorization')).toBe('Bearer actual-session');
      if (path === `/v1/posts/${identity.postId}/revisions/${identity.revisionId}`)
        return Response.json(sourceStatus === 200 ? { post: revision } : { code: 'not_found' }, {
          status: sourceStatus,
        });
      if (path === '/v1/viewerActions') {
        const resource = (inputBody as { resources: { type: string; id: string }[] }).resources[0]!;
        return Response.json({
          resources: [
            {
              ...resource,
              viewerActions:
                resource.type === 'content.post'
                  ? postActions
                    ? [{ action: 'post:revise', operations: ['post.revise'] }]
                    : []
                  : [{ action: 'edition:sell', operations: ['content_edition.publish'] }],
            },
          ],
        });
      }
      if (path === `/v1/subjects/${subject}`) return Response.json({ subject: { id: subject } });
      if (path === '/v1/contentEditions') {
        expect(inputBody).toEqual({ ...identity, targetSubjectId: subject });
        expect(request.headers.has('if-match')).toBe(false);
        const key = request.headers.get('idempotency-key')!;
        edition ??= {
          editionId,
          editionRevision: '1',
          state: 'draft',
          targetSubjectId: subject,
          creatorAccountId: creator,
          revisionId: identity.revisionId,
          sha256: revision.sha256,
          licence: revision.licence,
        };
        receipts.set(key, { editionId, editionRevision: '1' });
        if (lostCreate) {
          lostCreate = false;
          throw new Error('lost create response');
        }
        return Response.json(receipts.get(key), {
          status: 201,
          headers: { 'rezics-session-token': 'native-write-session' },
        });
      }
      if (path === `/v1/contentEditions/${editionId}:publish` && edition) {
        expect(inputBody).toEqual({});
        const key = request.headers.get('idempotency-key')!;
        // Constructed replay is admitted before its original receipt, as in the producer contract.
        if (receipts.has(key)) return Response.json(receipts.get(key));
        if (request.headers.get('if-match') !== `"${edition.editionRevision}"`)
          return Response.json({ code: 'precondition_failed' }, { status: 412 });
        edition = { ...edition, state: 'published', editionRevision: String(Number(edition.editionRevision) + 1) };
        receipts.set(key, { editionId, editionRevision: edition.editionRevision });
        if (lostPublish) {
          lostPublish = false;
          throw new Error('lost publish response');
        }
        return Response.json(receipts.get(key));
      }
      if (path === `/v1/contentEditions/${editionId}` && edition) return Response.json(edition);
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
    { preconnect() {} },
  );
  const api = createNativeEditionCreateApi('https://kernel.example', 'Bearer actual-session', creator, transport);
  return {
    api,
    calls,
    revision,
    setSourceStatus: (status: number) => {
      sourceStatus = status;
    },
    denyPostActions: () => {
      postActions = false;
    },
    advanceDraft: () => {
      if (edition) edition = { ...edition, editionRevision: '2' };
    },
  };
}

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  const native = await fixture();
  let key = 0;
  const controller = new EditionPublicationController(native.api, () => `intent-${++key}`);
  expect(editionSourceFromLink(`/en/posts/${identity.postId}/revisions/${identity.revisionId}`)).toEqual(identity);
  expect(
    editionSourceFromLink(`https://borrowed.example/en/posts/${identity.postId}/revisions/${identity.revisionId}`),
  ).toBeNull();
  expect(editionCreateHref(identity, 'en')).toBe(
    `/en/editions/new?postId=${identity.postId}&revisionId=${identity.revisionId}`,
  );
  expect(parseEditionCommand({ edition: { editionId, editionRevision: '1' } })).toBeNull();
  expect(parseEditionCommand({ editionId, editionRevision: 'revision-1' })).toBeNull();
  await controller.select(identity);
  expect(native.calls).toHaveLength(3); // exact source, one native action batch, final exact source
  expect(controller.snapshot().source?.body).toEqual(native.revision.body);
  controller.chooseSubject(id(21)); // A later head or caller input cannot add a target to the original revision.
  await controller.create();
  expect(controller.snapshot().intent).toBeNull();
  controller.chooseSubject(subject);
  await controller.create();
  const originalCreate = controller.snapshot().intent;
  expect(controller.snapshot().failure?.kind).toBe('uncertain');
  expect(controller.snapshot().source?.licence).toBe(native.revision.licence);
  await controller.retry();
  expect(controller.snapshot().edition?.state).toBe('draft');
  const creates = native.calls.filter((call) => call.path === '/v1/contentEditions');
  expect(creates).toHaveLength(2);
  expect(creates[0]!.body).toEqual(creates[1]!.body);
  expect(creates[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(originalCreate?.key));
  expect(creates[1]!.headers.get('idempotency-key')).toBe(creates[0]!.headers.get('idempotency-key'));
  expect(native.calls.at(-1)!.headers.get('rezics-session-token')).toBe('native-write-session');

  native.advanceDraft();
  await controller.publish();
  const conflictIntent = controller.snapshot().intent;
  expect(controller.snapshot().failure?.kind).toBe('conflict');
  const count = native.calls.length;
  await controller.publish();
  await controller.retry();
  expect(native.calls).toHaveLength(count); // No automatic retry, CAS rebase or new key.
  await controller.refresh();
  expect(controller.snapshot().edition?.editionRevision).toBe('1');
  expect(controller.snapshot().review?.edition?.editionRevision).toBe('2');
  controller.acceptReview();
  await controller.publish();
  const originalPublish = controller.snapshot().intent;
  expect(originalPublish?.kind).toBe('publish');
  expect(originalPublish?.key).not.toBe(conflictIntent?.key);
  expect(originalPublish?.key).not.toBe(originalCreate?.key);
  expect(controller.snapshot().edition?.state).toBe('draft'); // A lost publish response cannot claim publication.
  expect(controller.snapshot().failure?.kind).toBe('uncertain');
  await controller.retry();
  expect(controller.snapshot().edition?.state).toBe('published');
  expect(controller.snapshot().edition?.editionId).toBe(editionId);
  const publishes = native.calls.filter((call) => call.path.endsWith(':publish'));
  expect(publishes.map((call) => call.headers.get('if-match'))).toEqual(['"1"', '"2"', '"2"']);
  expect(publishes[1]!.headers.get('idempotency-key')).toBe(publishes[2]!.headers.get('idempotency-key'));
  expect(native.calls.every((call) => !/offers|orders|checkout|history|\/posts\/[^/]+$/.test(call.path))).toBe(true);
  // Each command examines one source twice, one action batch and one chosen subject; publish adds one edition batch.
  expect(native.calls.filter((call) => call.path.startsWith('/v1/subjects/'))).toHaveLength(5);
});

test('fresh denial conceals retained previews and defeats older command responses without losing an uncertain intent', async () => {
  const native = await fixture();
  const result = await native.api.source(identity);
  if (result.kind !== 'source') throw new Error('Fixture source was not admitted');
  let complete!: (result: EditionCommandRead) => void;
  let deferred = true;
  let sent: EditionPublicationIntent | null = null;
  const api: EditionCreateApi = {
    ...native.api,
    command: (intent) => {
      sent = intent;
      return deferred
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : native.api.command(intent);
    },
  };
  const controller = new EditionPublicationController(api);
  await controller.select(identity);
  controller.chooseSubject(subject);
  const pending = controller.create();
  native.setSourceStatus(404);
  await controller.refresh();
  expect(controller.snapshot().source).toBeNull();
  expect(controller.snapshot().targetSubjectId).toBe(subject);
  expect(controller.snapshot().intent).toBe(sent);
  complete({
    kind: 'confirmed',
    edition: {
      editionId,
      editionRevision: '1',
      state: 'draft',
      targetSubjectId: subject,
      creatorAccountId: creator,
      revisionId: identity.revisionId,
      sha256: result.source.sha256,
      licence: result.source.licence,
    },
  });
  await pending;
  expect(controller.snapshot().source).toBeNull();
  expect(controller.snapshot().edition).toBeNull();
  expect(controller.snapshot().uncertain).toBe(true);
  const count = native.calls.length;
  await controller.retry();
  expect(native.calls).toHaveLength(count); // Hidden source cannot be retried using cached bytes.
  native.setSourceStatus(200);
  await controller.refresh();
  controller.acceptReview();
  expect(controller.snapshot().intent).toBe(sent); // A read cannot discard an unknown create receipt.
  deferred = false;
  await controller.retry();
  expect(controller.snapshot().intent).toBe(sent);
  await controller.retry();
  expect(controller.snapshot().edition?.state).toBe('draft');

  native.denyPostActions();
  expect((await native.api.source(identity)).kind).toBe('refused');
  expect((await unavailableEditionCreateApi.source(identity)).kind).toBe('unavailable');
  const borrowed = createNativeEditionCreateApi(
    'https://kernel.example',
    'Bearer actual-session',
    id(91),
    Object.assign(async () => Response.json({ post: native.revision }), { preconnect() {} }),
  );
  expect((await borrowed.source(identity)).kind).toBe('refused');
});
