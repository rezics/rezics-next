import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import collection from '../src/kernel/recorded/library-collection.json';
import {
  captureFilteredStatus,
  FilteredStatusJourney,
  type FilteredStatusSender,
  type FilteredStatusOperation,
} from '../src/library/bulk-filtered-status';
import { previewFilteredStatusNative } from '../src/library/bulk-filtered-status-native';

const sourceId = collection.collection.id;
const filter = { statement: { property: 'schema:keywords', in: ['later-page'] } };
const capture = () => captureFilteredStatus(sourceId, filter, 'completed');
const operation = (change: Partial<FilteredStatusOperation> = {}): FilteredStatusOperation => ({
  id: '12345678-1234-4234-8234-123456789abc',
  route: 1,
  action: 'set_status',
  state: 'completed',
  collectionId: null,
  selectionKind: 'query',
  phase: 'preview',
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  selectionSource: {
    id: sourceId,
    revision: 2,
    membershipKind: 'curated',
    exposure: 'private',
    sourceDigest: 'native-digest',
    filter: JSON.stringify(filter),
    sort: null,
    scannedCandidates: 201,
    selectedSubjects: 201,
  },
  counts: {
    scannedCandidates: 201,
    selectedSubjects: 201,
    scannedOccurrences: 0,
    capturedOccurrences: 0,
    targets: 201,
    pending: 201,
    reconciling: 0,
    applied: 0,
    no_effect: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
  },
  summary: null,
  admittedAt: '2026-11-04T00:00:00Z',
  targetBoundAt: null,
  expiresAt: '2099-11-05T00:00:00Z',
  resultsExpireAt: '2099-11-06T00:00:00Z',
  finishedAt: null,
  reason: null,
  ...change,
});
function harness(overrides: Partial<FilteredStatusSender> = {}) {
  const calls: unknown[] = [];
  const sender: FilteredStatusSender = {
    capture: async (call) => {
      calls.push(call);
      return 'sealed-preview';
    },
    preview: async (call) => {
      calls.push(call);
      return { kind: 'ready', operation: operation(), confirmation: 'sealed-confirm' };
    },
    confirm: async (call) => {
      calls.push(call);
      return { kind: 'ready', operation: operation({ phase: 'queued' }) };
    },
    read: async () => ({
      state: 'ready',
      operation: operation({ phase: 'applying' }),
      page: { outcomes: [], next: null },
    }),
    ...overrides,
  };
  let current = true;
  const journey = new FilteredStatusJourney(
    capture(),
    'owner',
    { 'x-csrf-token': 'original', cookie: 'session=original' },
    sender,
    () => current,
    () => true,
    () => {},
  );
  return {
    journey,
    calls,
    retire: () => {
      current = false;
    },
  };
}

test('a later-page Collection previews all native matches, then explicitly confirms its stored manifest', async () => {
  const { journey, calls } = harness();
  await journey.preview();
  expect(JSON.parse((calls[0] as { body: string }).body)).toEqual({
    action: 'set_status',
    state: 'completed',
    selection: { kind: 'query', sourceId, filter: JSON.stringify(filter) },
  });
  expect(journey.state.operation?.counts.targets).toBe(201);
  expect(calls).toHaveLength(2);
  expect(journey.canConfirm).toBe(true);
  await journey.confirm();
  expect(calls[2]).toMatchObject({ token: 'sealed-confirm', headers: { 'x-csrf-token': 'original' } });
});

test('preparing, refused, unavailable and incomplete captures cannot confirm an empty or truncated success', async () => {
  for (const kind of ['preparing', 'unsupported', 'denied', 'limit', 'unavailable'] as const) {
    const { journey, calls } = harness({ preview: async () => ({ kind }) });
    await journey.preview();
    expect(journey.state.phase).toBe(kind);
    await journey.confirm();
    expect(calls).toHaveLength(1);
  }
  for (const change of [
    { selectionComplete: false },
    { occurrencesComplete: false },
    { selectionSource: null },
    { counts: { ...operation().counts, targets: 1001 } },
    { state: 'planned' },
  ]) {
    const { journey } = harness({
      preview: async () => ({ kind: 'ready', operation: operation(change), confirmation: 'bad' }),
    });
    await journey.preview();
    expect(journey.canConfirm).toBe(false);
  }
  const empty = operation({
    counts: { ...operation().counts, targets: 0, selectedSubjects: 0, pending: 0 },
    selectionSource: { ...operation().selectionSource!, selectedSubjects: 0 },
  });
  const { journey } = harness({ preview: async () => ({ kind: 'ready', operation: empty, confirmation: 'empty' }) });
  await journey.preview();
  expect(journey.canConfirm).toBe(true);
});

test('changed predicates/status retire review; uncertain confirmation and paged skips keep the original command', async () => {
  const sent: unknown[] = [];
  const { journey, retire } = harness({
    confirm: async (call) => {
      sent.push(call);
      if (sent.length === 1) throw Error('lost response');
      return { kind: 'ready', operation: operation({ phase: 'applying' }) };
    },
    read: async (address) => ({
      state: 'ready',
      operation: operation({ phase: 'applying' }),
      page: {
        outcomes: [
          {
            ordinal: '0',
            subjectId: 'changed',
            memberId: null,
            state: 'conflict',
            reason: 'revision_mismatch',
            resultingMemberId: null,
            deletion: null,
            memberDeletion: null,
          },
        ],
        next: address.cursor ? null : 'native-next',
      },
    }),
  });
  await journey.preview();
  await journey.confirm();
  expect(journey.state.phase).toBe('confirmation_uncertain');
  await journey.read();
  expect(journey.state.phase).toBe('confirmation_uncertain');
  expect(journey.state.read?.state === 'ready' && journey.state.read.page.outcomes[0]?.reason).toBe(
    'revision_mismatch',
  );
  await journey.confirm();
  expect(sent[1]).toBe(sent[0]);
  expect(journey.state.operation?.expiresAt).toBe(operation().expiresAt);
  retire();
  await journey.confirm();
  expect(journey.state.phase).toBe('retired');
  expect(sent).toHaveLength(2);
  expect(captureFilteredStatus(sourceId, filter, 'planned').body).not.toBe(capture().body);
  expect(captureFilteredStatus(sourceId, undefined, 'completed').body).not.toBe(capture().body);
});

test('typed native preview preserves preparing, unsupported, denial, limit and unavailable responses', async () => {
  for (const [status, body, kind] of [
    [202, { preparing: true }, 'preparing'],
    [422, {}, 'unsupported'],
    [403, {}, 'denied'],
    [413, {}, 'limit'],
    [503, {}, 'unavailable'],
    [201, { operation: operation() }, 'ready'],
  ] as const) {
    const requests: Request[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json(body, { status });
      }) as typeof fetch,
    });
    const result = await previewFilteredStatusNative(client, capture().body, {
      authorization: 'Bearer original',
      'idempotency-key': 'original-key',
    });
    expect(result.kind).toBe(kind);
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toEqual(JSON.parse(capture().body));
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer original');
  }
});

test('exposure retirement hides old delivery, while a null-CSRF private read recovers the original operation', async () => {
  let episode = { active: true };
  let csrf: string | null = 'original';
  const sender: FilteredStatusSender = {
    capture: async () => 'sealed',
    preview: async () => ({ kind: 'ready', operation: operation(), confirmation: 'original' }),
    confirm: async () => {
      throw Error('response lost');
    },
    read: async () => ({ state: 'ready', operation: operation(), page: { outcomes: [], next: null } }),
  };
  const journey = new FilteredStatusJourney(
    capture(),
    'owner',
    { 'x-csrf-token': 'original' },
    sender,
    () => true,
    (kind) => kind === 'read' || !!csrf,
    () => {},
    () => {
      const original = episode;
      return () => original.active;
    },
  );
  await journey.preview();
  expect(journey.visible).toBe(true);
  episode.active = false;
  episode = { active: true };
  csrf = null;
  expect(journey.visible).toBe(false);
  expect(journey.canConfirm).toBe(false);
  await journey.read();
  expect(journey.visible).toBe(true);
  expect(journey.state.operation?.id).toBe(operation().id);
});
