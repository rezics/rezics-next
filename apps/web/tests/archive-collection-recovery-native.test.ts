import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type {
  RecoveryEffectCommand,
  RecoveryReview,
  RecoveryStatus,
} from '../src/library/archive-collection-recovery/contract';

mock.module('../src/session/request', () => ({
  prepareSession: async () => true,
  viewerCredential: () => 'Bearer current-viewer',
}));
const { kernelArchiveCollectionRecoveryPort, nativeArchiveCollectionRecovery } =
  await import('../src/library/archive-collection-recovery/native');

const uploadId = '00000000-0000-4000-8000-000000000011';
const status: RecoveryStatus = {
  uploadId,
  state: 'preview',
  createdAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  manifest: null,
  coverage: [],
  sourceRecordCount: 0,
  selectedCollectionId: null,
  selectedOccurrences: 0,
  cancelRequested: false,
  collectionId: null,
  confirmation: null,
  fullRestoration: false,
  presentation: { state: 'unattempted', kind: null, source: null, releaseDigest: null, reason: null },
  pin: { state: 'unsupported', reason: null },
  sectionReasons: {},
};
const command: Extract<RecoveryEffectCommand, { kind: 'upload' }> = {
  kind: 'upload',
  key: 'original-upload-key',
  body: { archiveBase64: 'e30=' },
};

test('the generated native route receives the exact private upload command and an uncertain response retains it verbatim', async () => {
  const requests: Request[] = [];
  let fetches = 0;
  let responseStatus = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      fetches++;
      requests.push(new Request(input, init));
      return responseStatus === 200
        ? Response.json(status)
        : Response.json({ code: 'temporarily_unavailable' }, { status: responseStatus });
    }) as typeof fetch,
  });
  expect(nativeArchiveCollectionRecovery(client)).toBeTruthy();
  const request = new Request('https://site.test/library/recovery', { headers: { cookie: 'private-session' } });
  const port = kernelArchiveCollectionRecoveryPort(client, request, {}, true);
  expect(await port.upload(command)).toEqual({ kind: 'ok', value: status });
  expect(requests[0]?.url).toContain('/v1/libraryArchiveCollectionRecoveries');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(requests[0]?.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
  expect(await requests[0]?.clone().json()).toEqual(command.body);

  const closed = kernelArchiveCollectionRecoveryPort(
    client,
    new Request('https://site.test/library/recovery'),
    {},
    false,
  );
  expect(await closed.upload(command)).toEqual({ kind: 'unavailable' });
  expect(fetches).toBe(1);

  responseStatus = 503;
  const uncertain = await port.upload(command);
  expect(uncertain).toEqual({ kind: 'unknown', command });
});

test('the current Collection reader refuses another account at the native boundary', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ code: 'forbidden' }, { status: 403 })) as typeof fetch,
  });
  const port = kernelArchiveCollectionRecoveryPort(
    client,
    new Request('https://site.test/library/recovery', { headers: { cookie: 'private-session' } }),
    {},
    true,
  );
  expect(await port.receivingCollection(uploadId)).toEqual({ kind: 'denied' });
});

test('native binding forwards the explicit review and replays only the original confirmation with its credential', async () => {
  const requests: Request[] = [];
  const choice = { kind: 'schema:Book', source: 'archived' as const, releaseDigest: 'a'.repeat(64) };
  const confirmation = { reviewId: uploadId, digest: 'b'.repeat(64) };
  const reviewed: RecoveryReview = {
    ...status,
    state: 'reviewed',
    confirmation,
    review: {
      ...confirmation,
      presentation: choice,
      epoch: 1,
      completeMembership: true,
      completeOrder: true,
      selectedOccurrences: 1,
      mappings: [],
    },
    completeMembership: true,
    completeOrder: true,
    mappings: [],
    pin: { state: 'unsupported', reason: null, reviewedRevision: null },
    presentation: { ...choice, state: 'unattempted', reason: null },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1 || requests.length === 3) return Response.json({}, { status: 503 });
      return Response.json(
        request.url.endsWith('/review')
          ? reviewed
          : {
              ...status,
              state: 'complete',
              collectionId: uploadId,
              presentation: { ...choice, state: 'adopted', reason: null },
            },
      );
    }) as typeof fetch,
  });
  const port = kernelArchiveCollectionRecoveryPort(client, new Request('https://site.test/library/recovery'), {}, true);
  const review: Extract<RecoveryEffectCommand, { kind: 'review' }> = {
    kind: 'review',
    uploadId,
    key: 'original-Type-review',
    body: { collectionId: uploadId, presentationKind: choice.kind, selectedOccurrenceIds: [uploadId], mappings: [] },
  };
  expect(await port.review(review)).toEqual({ kind: 'unknown', command: review });
  const acknowledgement = await port.review(review);
  expect(acknowledgement).toMatchObject({ kind: 'ok', value: { review: { presentation: choice } } });
  const apply: Extract<RecoveryEffectCommand, { kind: 'apply' }> = { kind: 'apply', uploadId, body: confirmation };
  expect(await port.apply(apply)).toEqual({ kind: 'unknown', command: apply });
  expect(await port.apply(apply)).toMatchObject({
    kind: 'ok',
    value: { fullRestoration: false, presentation: { ...choice, state: 'adopted' } },
  });
  expect(requests).toHaveLength(4);
  for (const [index, request] of requests.entries()) {
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(await request.clone().json()).toEqual(index < 2 ? review.body : confirmation);
    expect(request.headers.get('idempotency-key')).toBe(index < 2 ? JSON.stringify(review.key) : null);
  }
});

test.each(['owner', 'mixed'] as const)(
  'Collection readback projects the current %s presentation independently of archive outcomes',
  async (source) => {
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        return Response.json(
          url.pathname.endsWith('/members')
            ? {
                members: [
                  {
                    id: uploadId,
                    subjectId: uploadId,
                    note: 'Same occurrence note',
                    addedAt: '2024-01-01T00:00:00.000Z',
                  },
                ],
                next: null,
              }
            : {
                collection: {
                  id: uploadId,
                  title: 'Current private Collection',
                  memberCount: 1,
                  visibility: 'private',
                  presentationKind: source === 'owner' ? 'schema:Book' : null,
                  presentationKindSource: source,
                },
              },
        );
      }) as typeof fetch,
    });
    const port = kernelArchiveCollectionRecoveryPort(
      client,
      new Request('https://site.test/library/recovery'),
      {},
      true,
    );
    expect(await port.receivingCollection(uploadId)).toMatchObject({
      kind: 'ok',
      value: {
        presentationKind: source === 'owner' ? 'schema:Book' : null,
        presentationKindSource: source,
        members: [{ note: 'Same occurrence note' }],
      },
    });
  },
);
