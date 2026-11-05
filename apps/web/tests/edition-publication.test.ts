import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { ExactRevision } from '../src/threads/exact-revision';
import type { EditionMetadata } from '../src/content-editions/edition-api';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import {
  EditionPublicationController,
  editionCreateHref,
  editionCreateNavigationContext,
  editionSourceFromLink,
  type EditionCommandRead,
  type EditionCreateApi,
  type EditionPublicationIntent,
  type EditionSourceRead,
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
  let postOperations = ['post.revise', 'content_edition.create'];
  let concealed = false;
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
              ...(concealed
                ? { error: 'not_found' }
                : {
                    viewerActions:
                      resource.type === 'content.post'
                        ? postActions
                          ? [{ action: 'post:revise', operations: postOperations }]
                          : []
                        : [{ action: 'edition:sell', operations: ['content_edition.publish'] }],
                  }),
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
    setPostOperations: (operations: string[]) => {
      postOperations = operations;
    },
    concealActions: () => {
      concealed = true;
    },
    denyPostActions: () => {
      postActions = false;
    },
    advanceDraft: () => {
      if (edition) edition = { ...edition, editionRevision: '2' };
    },
  };
}

test('retirement ignores late source reads and refuses later actions', async () => {
  const native = await fixture();
  let resolveSource!: (result: EditionSourceRead) => void;
  let reads = 0;
  const pending = new Promise<EditionSourceRead>((resolve) => {
    resolveSource = resolve;
  });
  const controller = new EditionPublicationController({
    ...native.api,
    source: async () => {
      reads++;
      return pending;
    },
  });
  const selecting = controller.select(identity);
  controller.retire();
  await controller.select(identity);
  await controller.resume(editionId);
  await controller.create();
  expect(reads).toBe(1);
  resolveSource(await native.api.source(identity));
  await selecting;
  expect(controller.snapshot()).toMatchObject({ source: null, identity: null, intent: null, busy: false });
});

test('publication route identity ignores unrelated search metadata', () => {
  const current = { pathname: '/de/editions/new', search: { ...identity, campaign: 'one' } };
  expect(editionCreateNavigationContext(current)).toBe(
    editionCreateNavigationContext({ ...current, search: { ...current.search, campaign: 'two' } }),
  );
  expect(editionCreateNavigationContext(current)).not.toBe(
    editionCreateNavigationContext({ ...current, search: { ...current.search, postId: id(4) } }),
  );
});

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

async function persistedDraft() {
  const native = await fixture();
  const original = new EditionPublicationController(native.api);
  await original.select(identity);
  original.chooseSubject(subject);
  await original.create();
  await original.retry();
  expect(original.snapshot().edition?.state).toBe('draft');
  return native;
}

test('Resume a genuine native authored edition draft without recreating immutable source', async () => {
  const native = await persistedDraft();
  const before = native.calls.length;
  const resumed = new EditionPublicationController(native.api);
  await resumed.resume(editionId);
  expect(native.calls.slice(before).map((call) => call.path)).toEqual([
    `/v1/contentEditions/${editionId}`,
    '/v1/viewerActions',
  ]);
  expect(resumed.snapshot().edition).toMatchObject({
    editionId,
    editionRevision: '1',
    state: 'draft',
    creatorAccountId: creator,
    revisionId: identity.revisionId,
    targetSubjectId: subject,
    sha256: native.revision.sha256,
    licence: native.revision.licence,
  });
  expect(resumed.snapshot().source).toBeNull();
  expect(resumed.snapshot().identity).toBeNull();
  expect(resumed.snapshot().intent).toBeNull();
  const loaded = native.calls.length;
  await resumed.select({ postId: id(999), revisionId: id(998) });
  resumed.chooseSubject(id(997));
  await resumed.create();
  expect(resumed.snapshot().targetSubjectId).toBe(subject);
  expect(native.calls).toHaveLength(loaded);
  await resumed.publish();
  const intent = resumed.snapshot().intent;
  expect(intent).toMatchObject({ kind: 'publish', source: null, editionId, editionRevision: '1' });
  expect(resumed.snapshot().failure?.kind).toBe('uncertain');
  await resumed.refresh();
  resumed.acceptReview();
  expect(resumed.snapshot().intent).toBe(intent); // A current read preserves the lost request's key and CAS.
  await resumed.retry();
  expect(resumed.snapshot().edition?.state).toBe('published');
  expect(resumed.snapshot().edition?.editionId).toBe(editionId);
  const publishes = native.calls.slice(before).filter((call) => call.path.endsWith(':publish'));
  expect(publishes).toHaveLength(2);
  expect(publishes[0]!.headers.get('idempotency-key')).toBe(publishes[1]!.headers.get('idempotency-key'));
  expect(publishes.map((call) => call.headers.get('if-match'))).toEqual(['"1"', '"1"']);
  expect(publishes.map((call) => call.body)).toEqual([{}, {}]);
  expect(native.calls.slice(before).some((call) => /\/posts\/|\/contentEditions$|\/revision$/.test(call.path))).toBe(
    false,
  );
});

test('resumed stale versions need explicit current review; a published reload never writes', async () => {
  const native = await persistedDraft();
  let keys = 0;
  const resumed = new EditionPublicationController(native.api, () => `resume-${++keys}`);
  await resumed.resume(editionId);
  native.advanceDraft();
  await resumed.publish();
  const stale = resumed.snapshot().intent;
  expect(resumed.snapshot().failure).toMatchObject({ kind: 'conflict', status: 412 });
  const before = native.calls.length;
  await resumed.publish();
  expect(native.calls).toHaveLength(before);
  await resumed.refresh();
  expect(resumed.snapshot().review?.edition?.editionRevision).toBe('2');
  expect(resumed.snapshot().intent).toBe(stale);
  expect(resumed.snapshot().targetSubjectId).toBe(subject);
  resumed.acceptReview();
  expect(resumed.snapshot().edition?.editionRevision).toBe('2');
  await resumed.publish();
  expect(resumed.snapshot().intent?.key).not.toBe(stale?.key);
  await resumed.retry();
  const reloaded = new EditionPublicationController(native.api);
  const commands = native.calls.filter((call) => call.path.endsWith(':publish')).length;
  await reloaded.resume(editionId);
  expect(reloaded.snapshot().edition).toMatchObject({ editionId, state: 'published', editionRevision: '3' });
  await reloaded.create();
  await reloaded.publish();
  expect(native.calls.filter((call) => call.path.endsWith(':publish'))).toHaveLength(commands);

  const retryNative = resumeBoundary();
  const retrying = new EditionPublicationController(retryNative.api);
  await retrying.resume(editionId);
  retryNative.setCommandStatus(503);
  await retrying.publish();
  const uncertain = retrying.snapshot().intent;
  expect(retrying.snapshot().uncertain).toBe(true);
  retryNative.setCommandStatus(412);
  await retrying.retry();
  expect(retrying.snapshot().failure?.kind).toBe('conflict');
  expect(retrying.snapshot().intent).toBe(uncertain);
  await retrying.refresh();
  retrying.acceptReview();
  expect(retrying.snapshot().intent).toBeNull();
  expect(retrying.snapshot().edition?.editionRevision).toBe('7');
});

/** Exact closed native metadata responses; no document source, post/head lookup or local authority. */
function resumeBoundary() {
  const edition: EditionMetadata = {
    editionId,
    editionRevision: '7',
    state: 'draft',
    creatorAccountId: creator,
    revisionId: identity.revisionId,
    targetSubjectId: subject,
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-SA-4.0',
  };
  let status = 200;
  let admission: 'allowed' | 'denied' | 'missing' = 'allowed';
  let commandStatus = 403;
  let loseRead = false;
  const calls: string[] = [];
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      expect(request.headers.get('authorization')).toBe('Bearer current-creator');
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      if (path === `/v1/contentEditions/${editionId}`) {
        if (loseRead) throw new Error('metadata transport unavailable');
        return Response.json(status === 200 ? edition : { code: 'not_found' }, { status });
      }
      if (path === '/v1/viewerActions')
        return Response.json({
          resources:
            admission === 'missing'
              ? []
              : [
                  {
                    type: 'content.edition',
                    id: editionId,
                    viewerActions:
                      admission === 'allowed'
                        ? [{ action: 'edition:sell', operations: ['content_edition.publish'] }]
                        : [],
                  },
                ],
        });
      if (path === `/v1/contentEditions/${editionId}:publish`)
        return Response.json({ code: 'forbidden' }, { status: commandStatus });
      throw new Error(`Unexpected resume request: ${request.method} ${path}`);
    },
    { preconnect() {} },
  );
  return {
    api: createNativeEditionCreateApi('https://kernel.example', 'Bearer current-creator', creator, transport),
    edition,
    calls,
    setStatus: (value: number) => {
      status = value;
    },
    setAdmission: (value: typeof admission) => {
      admission = value;
    },
    setCommandStatus: (value: number) => {
      commandStatus = value;
    },
    loseRead: () => {
      loseRead = true;
    },
  };
}

test('resume distinguishes unavailable, missing and terminal state without replacing the edition', async () => {
  const { editionCreateSearch } = await import('../src/content-editions/edition-create');
  expect(editionCreateSearch({ ...identity, editionId })).toEqual({
    editionId,
    postId: undefined,
    revisionId: undefined,
  });
  expect(editionCreateSearch({ ...identity, editionId: '' }).editionId).toBe('');
  const native = resumeBoundary();
  for (const status of [404, 410, 401, 403, 503]) {
    native.setStatus(status);
    const controller = new EditionPublicationController(native.api);
    await controller.resume(editionId);
    expect(controller.snapshot().failure?.kind).toBe(
      status === 404 || status === 410 ? 'missing' : status === 503 ? 'unavailable' : 'refused',
    );
    expect(controller.snapshot().knownEditionId).toBe(editionId);
    await controller.select(identity);
    await controller.create();
  }
  native.setStatus(200);
  native.setAdmission('missing');
  expect(await native.api.resume(editionId)).toMatchObject({ kind: 'unavailable', reason: 'admission-pending' });
  native.setAdmission('denied');
  expect(await native.api.resume(editionId)).toMatchObject({ kind: 'refused', status: 403 });
  native.setAdmission('allowed');
  native.edition.state = 'withdrawn';
  const withdrawn = new EditionPublicationController(native.api);
  await withdrawn.resume(editionId);
  expect(withdrawn.snapshot().edition?.state).toBe('withdrawn');
  await withdrawn.publish();
  expect(native.calls.every((call) => call.startsWith('GET ') || call === 'POST /v1/viewerActions')).toBe(true);
  expect((await unavailableEditionCreateApi.resume(editionId)).kind).toBe('unavailable');
  native.loseRead();
  expect((await native.api.resume(editionId)).kind).toBe('unavailable');
});

test('resumed publish repeats current admission and native source checks; denial defeats late success', async () => {
  const native = resumeBoundary();
  const controller = new EditionPublicationController(native.api);
  await controller.resume(editionId);
  native.setAdmission('denied');
  await controller.publish();
  expect(controller.snapshot().failure?.kind).toBe('refused');
  expect(native.calls.some((call) => call.endsWith(':publish'))).toBe(false);
  native.setAdmission('allowed');
  await controller.refresh();
  controller.acceptReview();
  await controller.publish(); // Native command refuses a revoked source even though metadata/sell reads were admitted.
  expect(controller.snapshot().failure?.kind).toBe('refused');
  expect(native.calls.filter((call) => call.endsWith(':publish'))).toHaveLength(1);

  let complete!: (result: EditionCommandRead) => void;
  const late = new EditionPublicationController({
    ...native.api,
    command: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await late.resume(editionId);
  const pending = late.publish();
  const intent = late.snapshot().intent;
  native.setStatus(404);
  await late.refresh();
  complete({ kind: 'confirmed', edition: { ...native.edition, state: 'published', editionRevision: '8' } });
  await pending;
  expect(late.snapshot().failure?.kind).toBe('missing');
  expect(late.snapshot().edition?.state).toBe('draft');
  expect(late.snapshot().intent).toBe(intent);
  const before = native.calls.length;
  await late.retry();
  expect(native.calls).toHaveLength(before);
});

test('Current native media in exact authored edition creation and resumed draft preview', async () => {
  const { parseDocument } = await import('@rezics/document');
  const { editionPreviewImageIds } = await import('../src/content-editions/edition-create');
  const native = await fixture();
  const imageId = id(40);
  native.revision.body = parseDocument({
    ...native.revision.body,
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        ...native.revision.body.doc.content!,
        { type: 'image', attrs: { id: 'illustration', src: imageId, alt: 'The authored illustration' } },
        { type: 'image', attrs: { id: 'repeated-illustration', src: imageId, alt: '' } },
        { type: 'image', attrs: { id: 'undeclared-illustration', src: id(41), alt: 'Unavailable illustration' } },
      ],
    },
  });
  native.revision.mediaIds = [id(42), imageId];
  native.revision.sha256 = await editionDocumentDigest(native.revision.body);
  expect(editionPreviewImageIds(native.revision.body, native.revision.mediaIds)).toEqual([imageId]);
  expect(editionPreviewImageIds(native.revision.body, [imageId, imageId])).toBeNull();
  expect(
    editionPreviewImageIds(
      native.revision.body,
      Array.from({ length: 33 }, (_, index) => id(100 + index)),
    ),
  ).toBeNull();

  const controller = new EditionPublicationController(native.api, () => 'media-preview-create');
  await controller.select(identity);
  expect(controller.snapshot().source?.body).toEqual(native.revision.body);
  // This checkout has no original reusable media producer. It must not substitute uploader GETs or guessed facts.
  expect(controller.snapshot().source?.media).toEqual({ kind: 'unavailable' });
  expect(controller.snapshot().failure).toBeNull();
  controller.chooseSubject(subject);
  await controller.create();
  await controller.retry();
  expect(controller.snapshot().edition?.state).toBe('draft');
  const before = native.calls.length;
  const resumed = new EditionPublicationController(native.api);
  await resumed.resume(editionId);
  expect(resumed.snapshot().edition?.editionId).toBe(editionId);
  expect(resumed.snapshot().source).toBeNull(); // Metadata supplies neither a post identity nor draft body references.
  expect(
    native.calls
      .slice(before)
      .every((call) => call.path === `/v1/contentEditions/${editionId}` || call.path === '/v1/viewerActions'),
  ).toBe(true);
  expect(native.calls.some((call) => /\/media\/[^/]+$|\/revision$|\/posts\/[^/]+$/.test(call.path))).toBe(false);
});

test('a changed source clears images synchronously and late media cannot replace the selected version', async () => {
  const { parseDocument } = await import('@rezics/document');
  const native = await fixture();
  const selected = await native.api.source(identity);
  if (selected.kind !== 'source') throw new Error('Fixture source was not admitted');
  const oldSource = {
    ...selected.source,
    body: parseDocument({
      ...selected.source.body,
      profile: 'blocks',
      doc: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { id: 'old-illustration', src: id(40), alt: 'Earlier source illustration' } },
        ],
      },
    }),
    media: {
      kind: 'ready' as const,
      images: [
        {
          id: id(40),
          containerId: id(30),
          digest: 'a'.repeat(64),
          width: 320,
          height: 200,
          variants: [{ format: 'webp' as const, width: 320, height: 200 }],
          placeholder: null,
          focalPoint: null,
          credit: null,
        },
      ],
    },
  };
  oldSource.sha256 = await editionDocumentDigest(oldSource.body);
  const pendingIdentity = { ...identity, revisionId: id(4) };
  const currentIdentity = { ...identity, revisionId: id(5) };
  let complete!: (result: typeof selected) => void;
  const controller = new EditionPublicationController({
    ...native.api,
    source: async (requested) =>
      requested.revisionId === pendingIdentity.revisionId
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : {
            kind: 'source',
            source:
              requested.revisionId === identity.revisionId ? oldSource : { ...selected.source, ...currentIdentity },
          },
  });
  await controller.select(identity);
  expect(controller.snapshot().source?.media).toBe(oldSource.media);
  const pending = controller.select(pendingIdentity);
  expect(controller.snapshot().source).toBeNull();
  await controller.select(currentIdentity);
  complete({ kind: 'source', source: { ...oldSource, ...pendingIdentity } });
  await pending;
  expect(controller.snapshot().source?.revisionId).toBe(currentIdentity.revisionId);
  expect(controller.snapshot().source?.media).toEqual({ kind: 'ready', images: [] });
  await controller.select({ ...identity, revisionId: id(6) });
  expect(controller.snapshot().source).toBeNull();
  expect(controller.snapshot().failure).toMatchObject({ kind: 'unavailable', reason: 'binding' });
});

test('A temporarily unavailable exact-revision edition entry can explicitly retry the existing current admission read without presenting a stale successful entry after a failed refresh', async () => {
  const { mock } = await import('bun:test');
  const { Children, createElement, isValidElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { Button } = await import('@rezics/ui/shadcn/button');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  type Result = { kind: 'available' } | { kind: 'unavailable' | 'refused' | 'missing'; status: number };
  const requests: {
    data: typeof identity;
    resolve: (result: Result) => void;
    reject: (error: Error) => void;
  }[] = [];
  const session = { state: 'signed-in', subject: creator, csrfToken: 'entry-test' };
  mock.module('../src/session/query', () => ({ useSession: () => session }));
  mock.module('../src/content-editions/edition-create-actions', () => ({
    readEditionCreateEntry: ({ data }: { data: typeof identity }) =>
      new Promise<Result>((resolve, reject) => requests.push({ data, resolve, reject })),
  }));
  const { EditionCreateEntry } = await import('../src/content-editions/edition-create-entry');
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnMount: false, retryOnMount: false } } });
  let entry: ReturnType<typeof EditionCreateEntry> = null;
  function Surface() {
    return (entry = EditionCreateEntry({ identity }));
  }
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Surface)));
  type Props = { children?: import('react').ReactNode; disabled?: boolean; onClick?: () => void };
  function retry(node: import('react').ReactNode = entry): Props | undefined {
    if (!isValidElement<Props>(node)) return;
    if (node.type === Button) return node.props;
    return Children.toArray(node.props.children).map(retry).find(Boolean);
  }
  const unavailable = () => {
    const html = render();
    expect(html).toContain(m.edition_publication_unavailable());
    expect(html).not.toContain('href=');
    return html;
  };
  try {
    expect(render()).toBe(''); // Initial loading makes no admission claim or automatic retry request.
    const query = client.getQueryCache().getAll()[0]!;
    expect(query.queryKey).toEqual([
      'edition-create-entry',
      identity.postId,
      identity.revisionId,
      creator,
      'signed-in',
    ]);
    expect(query.options.retry).toBe(false);
    const initial = query.fetch();
    requests[0]!.resolve({ kind: 'unavailable', status: 503 });
    await initial;
    expect(unavailable()).toContain(m.edition_publication_retry());
    expect(retry()?.disabled).toBe(false);

    retry()!.onClick!();
    const recovery = query.fetch(undefined, { cancelRefetch: false });
    unavailable();
    expect(retry()?.disabled).toBe(true);
    retry()!.onClick!(); // Even a duplicate invocation shares the current read rather than restarting it.
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.data === identity)).toBe(true);
    requests[1]!.resolve({ kind: 'available' });
    await recovery;
    expect(render()).toContain(`href="${editionCreateHref(identity, getLocale()).replaceAll('&', '&amp;')}"`);
    expect(retry()).toBeUndefined();

    const refresh = query.fetch();
    unavailable();
    requests[2]!.reject(new Error('Temporary entry read failure'));
    await expect(refresh).rejects.toThrow('Temporary entry read failure');
    expect(query.state.data).toEqual({ kind: 'available' }); // React Query retains stale success after rejection.
    unavailable();
    expect(retry()?.disabled).toBe(false);
    expect(requests).toHaveLength(3);

    retry()!.onClick!();
    const recovered = query.fetch(undefined, { cancelRefetch: false });
    unavailable();
    expect(retry()?.disabled).toBe(true);
    requests[3]!.resolve({ kind: 'available' });
    await recovered;
    expect(render()).toContain(m.edition_publication_entry_action());

    for (const kind of ['missing', 'refused'] as const) {
      const read = query.fetch();
      requests.at(-1)!.resolve({ kind, status: 404 });
      await read;
      const html = render();
      expect(html).not.toContain('href=');
      expect(retry()).toBeUndefined();
      if (kind === 'refused') expect(html).toBe('');
    }
    client.setQueryData(query.queryKey, { kind: 'available' });
    for (const state of ['signed-out', 'unknown']) {
      session.state = state;
      expect(render()).toBe('');
    }
    session.state = 'signed-in';
    session.subject = id(91);
    expect(render()).toBe('');
    expect(requests).toHaveLength(6);
  } finally {
    client.clear();
  }
});

test('edition creation requires its own mounted operation and concealed advice refuses the source', async () => {
  const native = await fixture();
  native.setPostOperations(['post.revise']);
  expect(await native.api.source(identity)).toMatchObject({ kind: 'refused', status: 403 });
  native.setPostOperations(['content_edition.create']);
  expect((await native.api.source(identity)).kind).toBe('source');
  native.concealActions();
  expect(await native.api.source(identity)).toMatchObject({ kind: 'refused', status: 404 });
});
