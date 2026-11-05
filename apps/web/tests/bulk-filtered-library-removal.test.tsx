import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import {
  FilteredLibraryRemoval,
  filteredRemovalRequest,
  type FilteredRemovalTransport,
  type FilteredRemovalOperation,
} from '../src/library/bulk-filtered-library-removal';
import { FilteredLibraryRemovalReview } from '../src/library/bulk-filtered-library-removal-view';

const source = { id: collection.collection.id, filter: { statement: { property: 'P31', in: ['book'] } } };
function operation(phase: FilteredRemovalOperation['phase'] = 'preview'): FilteredRemovalOperation {
  return {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
    route: 1,
    action: 'remove_from_library',
    selectionKind: 'query',
    state: null,
    collectionId: null,
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    selectionSource: {
      id: source.id,
      revision: 2,
      membershipKind: 'curated',
      exposure: 'private',
      sourceDigest: 'native-digest',
      filter: JSON.stringify(source.filter),
      sort: 'id',
      scannedCandidates: 251,
      selectedSubjects: 250,
    },
    counts: {
      scannedCandidates: 251,
      selectedSubjects: 250,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 250,
      pending: 250,
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
    expiresAt: '2026-11-05T00:00:00Z',
    resultsExpireAt: '2026-11-06T00:00:00Z',
    finishedAt: null,
    reason: null,
  };
}
function setup() {
  const calls: { kind: string; value: unknown }[] = [];
  let uncertain = false;
  let current = true;
  const deadline = '2026-12-04T00:00:00Z';
  const transport: FilteredRemovalTransport = {
    capture: async (value) => {
      calls.push({ kind: 'capture', value });
      return 'sealed-preview';
    },
    preview: async (value) => {
      calls.push({ kind: 'preview', value });
      return { state: 'ready', operation: operation(), confirmation: 'sealed-confirmation' };
    },
    confirm: async (value) => {
      calls.push({ kind: 'confirm', value });
      return uncertain ? { state: 'uncertain' } : { state: 'ready', operation: operation('queued') };
    },
    read: async (value) => {
      calls.push({ kind: 'read', value });
      return {
        state: 'ready',
        operation: operation('completed_with_errors'),
        page: {
          next: 'native-next',
          outcomes: [
            {
              ordinal: '0',
              subjectId: members.members[0]!.subjectId,
              memberId: null,
              resultingMemberId: null,
              state: 'conflict',
              reason: 'incarnation_mismatch',
              deletion: null,
              memberDeletion: null,
            },
            {
              ordinal: '1',
              subjectId: members.members[1]!.subjectId,
              memberId: null,
              resultingMemberId: null,
              state: 'applied',
              reason: null,
              deletion: { deletionId: 'native-deletion', revision: 7, restoreUntil: deadline },
              memberDeletion: null,
            },
          ],
        },
      };
    },
  };
  const journey = new FilteredLibraryRemoval(
    filteredRemovalRequest(source),
    'viewer',
    'en',
    { 'x-csrf-token': 'original', 'accept-language': 'en' },
    transport,
    { context: () => current, allowed: () => current, capture: () => () => current },
    () => {},
  );
  return {
    journey,
    calls,
    deadline,
    uncertain: () => {
      uncertain = true;
    },
    retire: () => {
      current = false;
    },
  };
}

test('whole-filtered removal delegates complete canonical population and entry expectations to native admission', async () => {
  const before = JSON.stringify(members);
  const { journey, calls } = setup();
  await journey.preview();
  expect(calls.map(({ kind }) => kind)).toEqual(['capture', 'preview']);
  expect(journey.request).toEqual({
    action: 'remove_from_library',
    selection: {
      kind: 'query',
      sourceId: source.id,
      filter: JSON.stringify(source.filter),
      sort: 'id',
    },
  });
  expect(journey.state.operation?.counts.targets).toBe(250); // Includes later native pages, beyond loaded rows.
  const html = renderToStaticMarkup(<FilteredLibraryRemovalReview journey={journey} canWrite canRead />);
  expect(html).toContain('Remove 250 personal Library entries');
  for (const label of ['Collection', 'Copies', 'Progress', 'purchases']) expect(html).toContain(label);
  expect(calls.some(({ kind }) => kind === 'confirm')).toBe(false);
  await journey.confirm();
  expect(calls.at(-1)?.kind).toBe('confirm');
  expect(JSON.stringify(members)).toBe(before); // Occurrences, order and notes remain independent.
});

test('uncertain confirmation keeps exact command after read recovery, including native conflicts and receipt deadline', async () => {
  const { journey, calls, uncertain, deadline } = setup();
  await journey.preview();
  uncertain();
  await journey.confirm();
  const original = calls.at(-1)!.value;
  await journey.read();
  expect(journey.state.phase).toBe('confirmation_uncertain');
  expect(journey.state.page?.outcomes[1]!.deletion?.restoreUntil).toBe(deadline);
  const html = renderToStaticMarkup(<FilteredLibraryRemovalReview journey={journey} canWrite canRead />);
  expect(html).toContain('Changed or recreated since preview; skipped');
  expect(html).toContain(deadline);
  await journey.confirm(true);
  expect(calls.at(-1)!.value).toBe(original);
  expect(calls.filter(({ kind }) => kind === 'capture')).toHaveLength(1);
  await journey.read('native-next');
  expect(journey.state.page?.outcomes).toHaveLength(2); // Replace bounded result page.
});

test('preparing, unavailable and unsupported previews cannot become empty confirmation; retirement is permanent', async () => {
  for (const state of ['preparing', 'unavailable', 'unsupported'] as const) {
    const { journey, calls, retire } = setup();
    journey.transport.preview = async () => ({ state });
    await journey.preview();
    await journey.confirm();
    expect(journey.state.phase).toBe(state);
    expect(calls.some(({ kind }) => kind === 'confirm')).toBe(false);
    retire();
    await journey.preview();
    expect(journey.state.phase).toBe('retired');
  }
});

test('only a complete native empty capture can confirm zero targets; oversized and incomplete captures stay unconfirmed', async () => {
  for (const targets of [0, 1001]) {
    const { journey, calls } = setup();
    journey.transport.preview = async () => ({
      state: 'ready',
      confirmation: 'same-command',
      operation: {
        ...operation(),
        counts: { ...operation().counts, targets },
      },
    });
    await journey.preview();
    await journey.confirm();
    expect(calls.some(({ kind }) => kind === 'confirm')).toBe(targets === 0);
  }
  const { journey, calls } = setup();
  journey.transport.preview = async () => ({
    state: 'ready',
    confirmation: 'incomplete',
    operation: {
      ...operation(),
      selectionComplete: false,
    },
  });
  await journey.preview();
  await journey.confirm();
  expect(journey.state.phase).toBe('preview_uncertain');
  expect(calls.some(({ kind }) => kind === 'confirm')).toBe(false);
});

test('failed private read and authority churn retain the original uncertain write, while stale responses cannot disclose', async () => {
  let epoch = 0,
    write = true;
  const base = setup();
  let resolve!: (result: Awaited<ReturnType<FilteredRemovalTransport['read']>>) => void;
  const transport = {
    ...base.journey.transport,
    read: () =>
      new Promise<Awaited<ReturnType<FilteredRemovalTransport['read']>>>((done) => {
        resolve = done;
      }),
  };
  const journey = new FilteredLibraryRemoval(
    filteredRemovalRequest(source),
    'viewer',
    'en',
    { 'x-csrf-token': 'original' },
    transport,
    {
      context: () => true,
      allowed: (kind) => kind === 'read' || write,
      capture: () => {
        const original = epoch;
        return () => original === epoch;
      },
    },
    () => {},
  );
  await journey.preview();
  base.uncertain();
  await journey.confirm();
  const original = base.calls.at(-1)!.value;
  write = false; // A healthy private read has no CSRF requirement.
  const pending = journey.read();
  epoch += 2; // Exposure may leave and return before rendering.
  resolve(await base.journey.transport.read({ id: operation().id, viewer: 'viewer' }));
  await pending;
  expect(journey.state.page).toBeUndefined();
  expect(journey.state.phase).toBe('confirmation_uncertain');
  write = true;
  await journey.confirm(true);
  expect(base.calls.at(-1)!.value).toBe(original);
});
