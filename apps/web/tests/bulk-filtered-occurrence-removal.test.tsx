import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import {
  FilteredOccurrenceRemoval,
  filteredOccurrenceRemovalManifest,
  type RemovalSender,
  type RemovalOperation,
  type RemovalOutcome,
} from '../src/library/bulk-filtered-occurrence-removal';
import { FilteredOccurrenceRemovalReview } from '../src/library/bulk-filtered-occurrence-removal-view';

const source = { id: collection.collection.id, title: collection.collection.title };
const operation = (phase: RemovalOperation['phase'] = 'preview'): RemovalOperation => ({
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  route: 1,
  action: 'remove_from_collection',
  selectionKind: 'query',
  state: null,
  collectionId: source.id,
  selectionSource: {
    id: source.id,
    revision: 4,
    membershipKind: 'curated',
    exposure: 'private',
    sourceDigest: 'native-source',
    filter: null,
    sort: 'id',
    scannedCandidates: 3,
    selectedSubjects: 1,
  },
  phase,
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  counts: {
    scannedCandidates: 3,
    selectedSubjects: 1,
    scannedOccurrences: 3,
    capturedOccurrences: 3,
    targets: 3,
    pending: 3,
    reconciling: 0,
    applied: 0,
    no_effect: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
  },
  summary: null,
  admittedAt: '2026-11-01T00:00:00.000Z',
  targetBoundAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2099-11-02T00:00:00.000Z',
  resultsExpireAt: '2099-11-03T00:00:00.000Z',
  finishedAt: null,
  reason: null,
});
const outcome = (ordinal: string, state: RemovalOutcome['state'] = 'pending'): RemovalOutcome => ({
  ordinal,
  subjectId: members.members[0]!.subjectId,
  memberId: `native-member-${ordinal}`,
  state,
  reason: state === 'conflict' ? 'revision_mismatch' : null,
  resultingMemberId: null,
  deletion: null,
  memberDeletion: null,
});
function setup(sender: RemovalSender, allowed = () => true) {
  const manifest = filteredOccurrenceRemovalManifest(
    source,
    undefined,
    'viewer',
    { 'x-csrf-token': 'original' },
    sender,
  );
  const journey = new FilteredOccurrenceRemoval(
    manifest,
    { context: allowed, read: allowed, preview: allowed, confirm: allowed },
    async (address) => ({
      state: 'ready',
      operation: operation(),
      page: {
        outcomes: address.cursor ? [outcome('2')] : [outcome('0'), outcome('1')],
        next: address.cursor ? null : 'later',
      },
    }),
    () => {},
  );
  return { manifest, journey };
}
const sender = (): RemovalSender => ({
  prepare: async () => 'sealed-original-credential',
  preview: async () => ({ state: 'ready', operation: operation() }),
  confirm: async () => ({ state: 'ready', operation: operation('queued') }),
});

test('whole-filtered review uses all persisted occurrence IDs, preserving duplicates and later pages', async () => {
  const port = sender();
  const calls: Parameters<RemovalSender['preview']>[0][] = [];
  port.preview = async (call) => {
    calls.push(call);
    return { state: 'ready', operation: operation() };
  };
  const { journey } = setup(port);
  expect(await journey.preview()).toBe(true);
  expect(JSON.parse(calls[0]!.body)).toEqual({
    action: 'remove_from_collection',
    collectionId: source.id,
    selection: { kind: 'query', sourceId: source.id, sort: 'id' },
  });
  await journey.read();
  expect(journey.state.read?.state === 'ready' && journey.state.read.page.outcomes.map((x) => x.memberId)).toEqual([
    'native-member-0',
    'native-member-1',
  ]);
  await journey.read('later');
  expect(journey.state.read?.state === 'ready' && journey.state.read.page.outcomes[0]?.memberId).toBe(
    'native-member-2',
  );
  const html = renderToStaticMarkup(<FilteredOccurrenceRemovalReview journey={journey} canPreview canConfirm />);
  expect(html).toContain('3 occurrences');
  expect(html).toContain(source.id);
  expect(html).toContain('native-member-2');
});

test('lost confirmation retains the exact stored operation, sender, headers, operands and key after reads', async () => {
  const port = sender();
  const calls: Parameters<RemovalSender['confirm']>[0][] = [];
  port.confirm = async (call) => {
    calls.push(call);
    if (calls.length === 1) throw Error('lost');
    return { state: 'ready', operation: operation('queued') };
  };
  const { journey, manifest } = setup(port);
  await journey.preview();
  expect(await journey.confirm()).toBe(false);
  await journey.read();
  expect(journey.state.phase).toBe('confirmation_uncertain');
  expect(await journey.preview()).toBe(false);
  expect(await journey.confirm(true)).toBe(true);
  expect(calls[1]).toBe(calls[0]);
  expect(calls[1]).toMatchObject({
    operationId: operation().id,
    body: '{}',
    credential: 'sealed-original-credential',
    headers: manifest.confirm.headers,
    idempotencyKey: manifest.confirm.idempotencyKey,
  });
  const removed = {
    ...outcome('0', 'applied'),
    memberDeletion: { deletionId: 'original-deletion', revision: 7, purgeAfter: '2026-11-03T00:00:00.000Z' },
  };
  journey.state = {
    ...journey.state,
    read: {
      state: 'ready',
      operation: operation('completed_with_errors'),
      page: { outcomes: [removed, outcome('1', 'conflict'), outcome('2', 'applied')], next: null },
    },
  };
  const html = renderToStaticMarkup(<FilteredOccurrenceRemovalReview journey={journey} canPreview canConfirm />);
  expect(html).toContain('Changed since preview; skipped');
  expect(html.match(/Removed/g)).toHaveLength(2);
  expect(html).toContain('original-deletion');
  expect(html).toContain('2026-11-03T00:00:00.000Z');
});

test('preparing, refusal, unavailable and retired responses never admit confirmation or report empty success', async () => {
  for (const state of ['preparing', 'refused', 'unavailable'] as const) {
    const port = sender();
    let confirms = 0;
    port.preview = async () => ({ state });
    port.confirm = async () => {
      confirms++;
      return { state: 'ready', operation: operation('queued') };
    };
    const { journey } = setup(port);
    expect(await journey.preview()).toBe(false);
    expect(journey.state.phase).toBe(state);
    expect(await journey.confirm()).toBe(false);
    expect(confirms).toBe(0);
    expect(journey.state.operation).toBeUndefined();
  }
  let current = true;
  let finish!: (value: Awaited<ReturnType<RemovalSender['preview']>>) => void;
  const port = sender();
  port.preview = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { journey } = setup(port, () => current);
  const pending = journey.preview();
  await Promise.resolve();
  await Promise.resolve();
  current = false;
  journey.retireIfStale();
  current = true;
  finish({ state: 'ready', operation: operation() });
  expect(await pending).toBe(false);
  expect(journey.state.phase).toBe('retired');
  expect(await journey.confirm()).toBe(false);
});
