import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import { captureFilteredAdd, FilteredAddJourney, type FilteredAddPort } from '../src/library/bulk-filtered-add';
import {
  sendFilteredAdd,
  type FilteredAddCommand,
  type FilteredAddOperation,
} from '../src/library/bulk-filtered-add-native';

const source = { id: collection.collection.id, filter: { statement: { property: 'schema:genre', in: ['novel'] } } };
const destination = { ...collection.collection, id: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba3' };
function capture() {
  const value = captureFilteredAdd(source, destination);
  if (!value.ok) throw new Error('Expected admitted input');
  return value;
}
function operation(count = 4): FilteredAddOperation {
  return {
    id: crypto.randomUUID(),
    route: 1,
    action: 'add_to_collection',
    collectionId: destination.id,
    state: null,
    selectionKind: 'query',
    selectionSource: {
      id: source.id,
      revision: 1,
      membershipKind: 'curated',
      exposure: 'public',
      sourceDigest: 'a'.repeat(64),
      filter: capture().request.selection.filter!,
      sort: null,
      scannedCandidates: count,
      selectedSubjects: count,
    },
    phase: 'preview',
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: count,
      selectedSubjects: count,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: count,
      pending: count,
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
  };
}
const command = (): FilteredAddCommand => ({
  capture: capture(),
  sender: collection.collection.curatorAccountId,
  credential: 'encrypted-original',
  headers: { 'x-csrf-token': 'original-csrf', 'accept-language': 'en', 'content-type': 'application/json' },
  previewKey: crypto.randomUUID(),
  confirmKey: crypto.randomUUID(),
});
function setup(preview: FilteredAddPort['preview'], confirm?: FilteredAddPort['confirm']) {
  let current = true;
  const original = command();
  const port: FilteredAddPort = {
    capture: async () => ({ state: 'captured', command: original }),
    preview,
    confirm: confirm ?? (async () => ({ state: 'uncertain' })),
    read: async () => ({ state: 'unavailable' }),
  };
  const journey = new FilteredAddJourney(
    capture(),
    () => current,
    () => true,
    port,
    () => {},
  );
  return {
    journey,
    original,
    retire: () => {
      current = false;
    },
  };
}

test('whole-filtered preview sends only a native query and displays its exact later-page count', async () => {
  const calls: unknown[] = [];
  const native = operation(members.members.length + 20);
  const { journey } = setup(async (value) => {
    calls.push(value);
    return { state: 'ready', operation: native };
  });
  await journey.preview('original-csrf');
  expect(journey.state.phase).toBe('previewed');
  expect(journey.state.operation?.counts.targets).toBe(members.members.length + 20);
  expect(journey.capture.destination).toMatchObject({ id: destination.id, revision: destination.revision });
  expect((calls[0] as FilteredAddCommand).capture.request).toEqual({
    action: 'add_to_collection',
    collectionId: destination.id,
    selection: { kind: 'query', sourceId: source.id, filter: capture().request.selection.filter },
  });
  expect(JSON.stringify(calls)).not.toContain('targets');
});

test('preparation, unsupported, unavailable and over-limit results cannot become an empty ready preview', async () => {
  for (const state of ['preparing', 'unsupported', 'unavailable', 'limit'] as const) {
    const { journey } = setup(async () => ({ state }));
    await journey.preview('original-csrf');
    expect(journey.state.phase).toBe(state);
    expect(journey.state.operation).toBeUndefined();
    await journey.confirm();
    expect(journey.state.phase).toBe(state);
  }
  const oversized = setup(async () => ({ state: 'ready', operation: operation(1001) }));
  await oversized.journey.preview('original-csrf');
  expect(oversized.journey.state.phase).toBe('limit');
  expect(captureFilteredAdd({ ...source, filter: { text: '語'.repeat(23000) } }, destination)).toEqual({
    ok: false,
    reason: 'limit',
  });
  const empty = setup(async () => ({ state: 'ready', operation: operation(0) }));
  await empty.journey.preview('original-csrf');
  expect(empty.journey.state.phase).toBe('previewed');
});

test('predicate, destination and authority retirement cannot confirm the old review', async () => {
  const wrongDestination = { ...operation(), collectionId: source.id };
  const wrongFilter = { ...operation(), selectionSource: { ...operation().selectionSource!, filter: '{}' } };
  for (const native of [wrongDestination, wrongFilter]) {
    const { journey } = setup(async () => ({ state: 'ready', operation: native }));
    await journey.preview('original-csrf');
    expect(journey.state.phase).toBe('changed');
  }
  const { journey, retire } = setup(async () => ({ state: 'ready', operation: operation() }));
  await journey.preview('original-csrf');
  retire();
  await journey.confirm();
  expect(journey.state.phase).toBe('retired');
});

test('uncertain replay keeps original command and operation after read recovery without recapturing a query', async () => {
  const native = operation();
  const calls: [FilteredAddCommand, string][] = [];
  let attempt = 0;
  const { journey, original } = setup(
    async () => ({ state: 'ready', operation: native }),
    async (value, id) => {
      calls.push([value, id]);
      return ++attempt === 1 ? { state: 'uncertain' } : { state: 'ready', operation: { ...native, phase: 'queued' } };
    },
  );
  await journey.preview('original-csrf');
  await journey.confirm();
  await journey.read();
  await journey.confirm();
  expect(calls).toEqual([
    [original, native.id],
    [original, native.id],
  ]);
  expect(calls[0]![0]).toBe(calls[1]![0]);
  expect(journey.state.phase).toBe('confirmed');
});

test('typed native transport preserves preparing without accepting it as preview readiness', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      return Response.json({ preparing: true }, { status: 202 });
    }) as typeof fetch,
  });
  expect(await sendFilteredAdd(client, 'Bearer original', command())).toEqual({ state: 'preparing' });
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer original');
  expect(await requests[0]!.json()).toEqual(capture().request);
});

test('result reads keep native per-target skips, capacity and denial on the original operation', async () => {
  const native = operation(3);
  const outcomes = (['no_effect', 'failed', 'denied'] as const).map((state, index) => ({
    ordinal: String(index),
    subjectId: members.members[index]!.subjectId,
    memberId: null,
    state,
    reason: index === 1 ? ('collection_full' as const) : index === 2 ? ('target_denied' as const) : null,
    resultingMemberId: null,
    deletion: null,
    memberDeletion: null,
  }));
  const port: FilteredAddPort = {
    capture: async () => ({ state: 'captured', command: command() }),
    preview: async () => ({ state: 'ready', operation: native }),
    confirm: async () => ({ state: 'ready', operation: { ...native, phase: 'queued' } }),
    read: async (id, cursor) => {
      expect(id).toBe(native.id);
      return {
        state: 'ready',
        operation: { ...native, phase: 'completed_with_errors' },
        page: { outcomes: cursor ? [outcomes[2]!] : outcomes.slice(0, 2), next: cursor ? null : 'native-cursor' },
      };
    },
  };
  const journey = new FilteredAddJourney(
    capture(),
    () => true,
    () => true,
    port,
    () => {},
  );
  await journey.preview('original-csrf');
  await journey.confirm();
  await journey.read();
  expect(journey.state.read).toMatchObject({ page: { outcomes: outcomes.slice(0, 2), next: 'native-cursor' } });
  await journey.read('native-cursor');
  expect(journey.state.read).toMatchObject({ page: { outcomes: [outcomes[2]], next: null } });
  expect(journey.state.operation?.id).toBe(native.id);
});
