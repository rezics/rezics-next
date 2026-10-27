import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import type { Boundary, BulkAdmission, LibraryBulkDriver, OperationResult, OperationView,
  OutcomePage, Persona } from './library-bulk-driver.ts';

async function usingDriver(body: (driver: LibraryBulkDriver) => Promise<void>) {
  const path = process.env.LIBRARY_BULK_DRIVER;
  if (!path) throw new Error('Library bulk outcome driver is required');
  const module = await import(path.startsWith('file:') ? path : pathToFileURL(path).href);
  const driver: LibraryBulkDriver = await module.createLibraryBulkDriver();
  try { await body(driver); } finally { await driver.close(); }
}
const explicit = (ids: readonly string[]) => ({ kind: 'explicit' as const, targets: ids.map(subjectId => ({ subjectId })) });
const query = (state: 'planned' | 'in_progress' = 'planned') => ({ kind: 'query' as const, filter: { state } });
const status = (selection: BulkAdmission['selection']): BulkAdmission => {
  if (selection.kind === 'occurrences') throw new Error('Fixture requires subject selection');
  return { action: 'set_status', state: 'completed', selection };
};
async function post(d: LibraryBulkDriver, body: unknown, key = d.key(), as: Persona = 'owner') {
  return d.request(as, { method: 'POST', path: '/v1/libraryOperations', body, headers: { 'idempotency-key': key } });
}
async function admit(d: LibraryBulkDriver, body: BulkAdmission, key = d.key(), as: Persona = 'owner') {
  const response = await post(d, body, key, as);
  expect(response.status).toBe(202);
  const result = await response.json() as OperationResult;
  expect(response.headers.get('location')).toBe(`/v1/libraryOperations/${result.operation.id}`);
  return result.operation;
}
async function read(d: LibraryBulkDriver, id: string) {
  const response = await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${id}` });
  expect(response.status).toBe(200);
  return (await response.json() as OperationResult).operation;
}
async function page(d: LibraryBulkDriver, id: string, suffix = '') {
  const response = await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${id}/outcomes?limit=20${suffix}` });
  expect(response.status).toBe(200);
  return await response.json() as OutcomePage;
}
async function all(d: LibraryBulkDriver, id: string) {
  const rows: OutcomePage['outcomes'][number][] = [];
  let cursor: string | null = null;
  do {
    const result = await page(d, id, cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    expect(result.outcomes.length).toBeLessThanOrEqual(20);
    rows.push(...result.outcomes);
    cursor = result.next;
    expect(rows.length).toBeLessThan(10_000);
  } while (cursor);
  expect(new Set(rows.map(row => row.ordinal)).size).toBe(rows.length);
  return rows;
}
function counters(view: OperationView) {
  const c = view.counts;
  expect(c.targets).toBe(c.pending + c.reconciling + c.applied + c.no_effect + c.conflict + c.denied + c.failed + c.cancelled);
  for (const value of Object.values(c)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
}
async function finish(d: LibraryBulkDriver, id: string, applied: number) {
  await d.settle();
  const view = await read(d, id);
  counters(view);
  expect(view.phase).toBe('completed');
  expect(view.selectionComplete).toBe(true);
  expect(view.occurrencesComplete).toBe(true);
  expect(view.counts.applied).toBe(applied);
  expect(view.counts.pending + view.counts.reconciling).toBe(0);
  return view;
}
async function frozen(d: LibraryBulkDriver, body: BulkAdmission, boundary: Boundary = 'after_discovery_seal') {
  await d.pauseAt(boundary);
  const op = await admit(d, body);
  await d.runUntil(boundary);
  return op;
}

test('explicit status deduplicates subjects and replays admission and target receipts once', () => usingDriver(async d => {
  const ids = await d.provisionEntries(2);
  const key = d.key();
  const body = status(explicit([ids[0]!, ids[0]!, ids[1]!]));
  const op = await admit(d, body, key);
  expect((await admit(d, body, key)).id).toBe(op.id);
  const done = await finish(d, op.id, 2);
  await d.replay(op.id); await d.settle();
  expect((await read(d, op.id)).counts).toEqual(done.counts);
  expect((await all(d, op.id)).map(row => row.state)).toEqual(['applied', 'applied']);
  expect((await post(d, { ...body, state: 'paused' }, key)).status).toBe(409);
}));

test('explicit admission rejects empty over-limit mixed selection and unknown predicates', () => usingDriver(async d => {
  const ids = await d.provisionEntries(101);
  for (const body of [status(explicit([])), status(explicit(ids)),
    { ...status(query()), selection: { ...query(), targets: [{ subjectId: ids[0] }] } },
    { ...status(query()), selection: { kind: 'query', filter: { rating: 4 } } },
    { ...status(query()), accountId: d.accounts.other.id },
    { ...status(query()), selection: { kind: 'query', filter: {}, sort: 'updatedAt' } }]) {
    expect((await post(d, body)).status).toBe(400);
  }
  expect((await d.inspect()).operations).toHaveLength(0);
}));

test('query selection exceeds one hundred and seals before status writes shrink its filter', () => usingDriver(async d => {
  const ids = await d.provisionEntries(237);
  const op = await frozen(d, status(query()));
  expect((await d.inspect()).entries.filter(entry => entry.state === 'planned')).toHaveLength(ids.length);
  expect((await read(d, op.id)).counts.selectedSubjects).toBe(237);
  await d.resume(); await finish(d, op.id, 237);
  expect((await all(d, op.id))).toHaveLength(237);
}));

test('growing sparse and no-match input advances bounded raw pages to the admitted high-water', () => usingDriver(async d => {
  await d.provisionEntries(257, { state: 'paused' });
  await d.provisionEntries(2);
  const sparse = await admit(d, status(query()));
  const done = await finish(d, sparse.id, 2);
  expect(done.counts.scannedCandidates).toBe(259);
  const empty = await admit(d, status(query()));
  expect((await finish(d, empty.id, 0)).counts.scannedCandidates).toBe(259);
  for (const step of (await d.inspect()).steps) {
    expect(step.rawCandidates).toBeLessThanOrEqual(100);
    expect(step.targets).toBeLessThanOrEqual(100);
    expect(step.externalProbes).toBeLessThanOrEqual(100);
    expect(step.pagesInSegment).toBeLessThanOrEqual(100);
    expect(new Set(step.heldPartitions).size).toBeLessThanOrEqual(1);
  }
}));

test('entries created after admission high-water are excluded even on later discovery pages', () => usingDriver(async d => {
  await d.provisionEntries(150);
  await d.pauseAt('before_discovery_page');
  const op = await admit(d, status(query()));
  await d.runUntil('before_discovery_page');
  const later = await d.provisionEntries(3);
  await d.resume(); await finish(d, op.id, 150);
  expect((await d.inspect()).entries.filter(entry => later.includes(entry.subjectId)).every(entry => entry.state === 'planned')).toBe(true);
}));

test('delete and recreate before discovery cannot admit a new revision-one incarnation', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1);
  await d.pauseAt('before_discovery_page');
  const op = await admit(d, status(query()));
  await d.runUntil('before_discovery_page');
  await d.deleteEntry(id!, 1); await d.putEntry(id!, 'planned');
  await d.resume(); await finish(d, op.id, 0);
  expect((await d.inspect()).entries[0]!.state).toBe('planned');
}));

test('external edits before a candidate page change discovery-time membership', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1, { primaryType: 'book' });
  await d.pauseAt('before_discovery_page');
  const op = await admit(d, status({ kind: 'query', filter: { primaryType: 'book' } }));
  await d.runUntil('before_discovery_page');
  await d.changePrimaryType(id!, 'game');
  await d.resume(); await finish(d, op.id, 0);
}));

test('state edits before discovery match live predicates while post-seal edits conflict', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1);
  await d.pauseAt('before_discovery_page');
  const op = await admit(d, status(query('in_progress')));
  await d.runUntil('before_discovery_page');
  await d.putEntry(id!, 'in_progress', 1);
  await d.pauseAt('after_discovery_seal'); await d.resume(); await d.runUntil('after_discovery_seal');
  expect((await read(d, op.id)).counts.selectedSubjects).toBe(1);
  await d.putEntry(id!, 'paused', 2);
  await d.resume(); await d.settle();
  expect((await all(d, op.id))[0]!.state).toBe('conflict');
  expect((await read(d, op.id)).phase).toBe('completed_with_errors');
}));

test('frozen incarnation CAS rejects delete recreate ABA and missing expected entries', () => usingDriver(async d => {
  const ids = await d.provisionEntries(2);
  const op = await frozen(d, status(explicit(ids)));
  await d.deleteEntry(ids[0]!, 1); await d.putEntry(ids[0]!, 'planned');
  await d.deleteEntry(ids[1]!, 1);
  await d.resume(); await d.settle();
  expect((await all(d, op.id)).every(row => row.state === 'conflict')).toBe(true);
  const view = await read(d, op.id); counters(view); expect(view.counts.conflict).toBe(2);
}));

test('explicit absent status uses validated create and conflicts with concurrent creation', () => usingDriver(async d => {
  const first = await d.provisionSubject(); const second = await d.provisionSubject();
  const op = await frozen(d, status(explicit([first, second])));
  await d.putEntry(second, 'paused');
  await d.resume(); await d.settle();
  const rows = await all(d, op.id);
  expect(rows.find(row => row.subjectId === first)!.state).toBe('applied');
  expect(rows.find(row => row.subjectId === second)!.state).toBe('conflict');
}));

test('already desired unchanged status has a native no-effect receipt and never rewrites revision', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1, { state: 'completed' });
  const op = await admit(d, status(explicit(ids))); await d.settle();
  expect((await all(d, op.id))[0]!.state).toBe('no_effect');
  expect((await d.inspect()).entries[0]!.revision).toBe(1);
  const before = await read(d, op.id); counters(before);
  await d.replay(op.id); await d.settle();
  expect((await read(d, op.id)).counts).toEqual(before.counts);
  const target = (await d.inspect()).targets[0]!;
  expect(target.evidence?.outcome).toBe('no_effect');
}));

test('owner other anonymous suspended and consent-revoked use real private admission boundaries', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1);
  for (const as of ['anonymous', 'suspended', 'consent_revoked'] as const) {
    expect([401, 403]).toContain((await post(d, status(explicit(ids)), d.key(), as)).status);
  }
  const other = await admit(d, status(query()), d.key(), 'other'); await d.settle();
  expect((await d.inspect()).operations.find(op => op.id === other.id)!.view.counts.targets).toBe(0);
  expect((await d.inspect()).entries[0]!.state).toBe('planned');
}));

test('scope role and personal-library gate refusal cannot create a durable operation', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1);
  for (const change of [
    { kind: 'scope', action: 'library_entry:update', enabled: false },
    { kind: 'role', action: 'library_operation:create', enabled: false },
    { kind: 'gate', gate: 'personal_library', enabled: false },
  ] as const) {
    await d.changeAuthority('owner', change);
    expect((await post(d, status(explicit(ids)))).status).toBe(403);
    await d.changeAuthority('owner', { ...change, enabled: true });
  }
  expect((await d.inspect()).operations).toHaveLength(0);
}));

test('target Collection gate and update scope are required in addition to personal-library authority', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); const collectionId = await d.provisionCollection();
  const body: BulkAdmission = { action: 'add_to_collection', collectionId, selection: explicit(ids) };
  await d.changeAuthority('owner', { kind: 'gate', gate: 'collections', resourceId: collectionId, enabled: false });
  expect((await post(d, body)).status).toBe(403);
  await d.changeAuthority('owner', { kind: 'gate', gate: 'collections', resourceId: collectionId, enabled: true });
  await d.changeAuthority('owner', { kind: 'scope', action: 'collection:update', enabled: false });
  expect((await post(d, body)).status).toBe(403);
}));

test('delegated initiator restoration stops undispatched work on midway consent revocation', () => usingDriver(async d => {
  const ids = await d.provisionEntries(3, { as: 'delegated' });
  await d.pauseAt('after_outcome_ack');
  const op = await admit(d, status(explicit(ids)), d.key(), 'delegated');
  await d.runUntil('after_outcome_ack');
  await d.changeAuthority('delegated', { kind: 'consent', enabled: false });
  await d.resume(); await d.settle();
  const stored = (await d.inspect()).operations.find(row => row.id === op.id)!.view;
  expect(stored.phase).toBe('stopped'); expect(stored.counts.applied).toBe(1);
  expect(stored.counts.denied).toBe(2); counters(stored);
  const response = await d.request('delegated', { method: 'GET', path: `/v1/libraryOperations/${op.id}` });
  expect(response.status).toBe(403);
}));

test('account and delegation revocation after a commit reconcile its evidence without another effect', () => usingDriver(async d => {
  for (const kind of ['account', 'delegation'] as const) {
    await d.changeAuthority('delegated', { kind, enabled: true });
    const ids = await d.provisionEntries(2, { as: 'delegated' });
    await d.pauseAt('after_target_commit');
    const op = await admit(d, status(explicit(ids)), d.key(), 'delegated');
    await d.runUntil('after_target_commit');
    await d.changeAuthority('delegated', { kind, enabled: false });
    await d.resume(); await d.settle();
    const view = (await d.inspect()).operations.find(row => row.id === op.id)!.view;
    expect(view.counts.applied).toBe(1); expect(view.counts.denied).toBe(1); counters(view);
  }
}));

test('one target denial records partial completion and continues other authorized targets', () => usingDriver(async d => {
  const ids = await d.provisionEntries(2); const collectionId = await d.provisionCollection();
  const op = await frozen(d, { action: 'add_to_collection', collectionId, selection: explicit(ids) });
  await d.changeAuthority('owner', { kind: 'role', action: 'subject:read', resourceId: ids[0]!, enabled: false });
  await d.resume(); await d.settle();
  const view = await read(d, op.id); counters(view);
  expect(view.phase).toBe('completed_with_errors'); expect(view.counts.applied).toBe(1); expect(view.counts.denied).toBe(1);
}));

test('bulk add preserves duplicates appends once per operation and returns the same member on replay', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1);
  const collectionId = await d.provisionCollection({ members: [id!, id!] });
  const body: BulkAdmission = { action: 'add_to_collection', collectionId, selection: explicit([id!, id!]) };
  const op = await admit(d, body); await finish(d, op.id, 1);
  const memberId = (await all(d, op.id))[0]!.resultingMemberId; expect(memberId).not.toBeNull();
  await d.replay(op.id); await d.settle();
  expect((await all(d, op.id))[0]!.resultingMemberId).toBe(memberId);
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId)).toHaveLength(3);
  const second = await admit(d, body); await finish(d, second.id, 1);
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId)).toHaveLength(4);
}));

test('Collection capacity refusal is a failed target and never silent duplicate suppression', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1);
  const collectionId = await d.provisionCollection({ members: Array.from({ length: 5000 }, () => id!) });
  const op = await admit(d, { action: 'add_to_collection', collectionId, selection: explicit([id!]) }); await d.settle();
  expect((await all(d, op.id))[0]).toMatchObject({ state: 'failed', reason: 'collection_full' });
  expect((await read(d, op.id)).phase).toBe('completed_with_errors');
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId)).toHaveLength(5000);
}));

test('explicit occurrence removal deletes only its member identity and deduplicates member ids', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1); const collectionId = await d.provisionCollection({ members: [id!, id!] });
  const members = (await d.inspect()).members.filter(row => row.collectionId === collectionId);
  const op = await admit(d, { action: 'remove_from_collection', collectionId,
    selection: { kind: 'occurrences', memberIds: [members[0]!.id, members[0]!.id] } });
  await finish(d, op.id, 1);
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId).map(row => row.id)).toEqual([members[1]!.id]);
}));

test('query Collection removal freezes all occurrences once and later additions survive reorders', () => usingDriver(async d => {
  const ids = await d.provisionEntries(103);
  const collectionId = await d.provisionCollection({ members: [...ids, ...ids] });
  const op = await frozen(d, { action: 'remove_from_collection', collectionId, selection: query() }, 'after_occurrence_seal');
  const later = await d.appendMember(collectionId, ids[0]!); await d.reorderMember(collectionId, later);
  await d.resume(); const done = await finish(d, op.id, 206);
  expect(done.counts.selectedSubjects).toBe(103); expect(done.counts.capturedOccurrences).toBe(206);
  expect(done.counts.scannedOccurrences).toBe(206);
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId).map(row => row.id)).toEqual([later]);
}));

test('explicit subjects remove all captured occurrences while a missing captured member conflicts', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1); const collectionId = await d.provisionCollection({ members: [id!, id!] });
  const op = await frozen(d, { action: 'remove_from_collection', collectionId, selection: explicit([id!]) }, 'after_occurrence_seal');
  const member = (await d.inspect()).members.find(row => row.collectionId === collectionId)!;
  await d.removeMember(collectionId, member.id);
  await d.resume(); await d.settle();
  const view = await read(d, op.id); counters(view);
  expect(view.counts.applied).toBe(1); expect(view.counts.conflict).toBe(1);
}));

test('library removal retains sessions progress history copies follows and Collection members', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1); await d.provisionHistory(id!);
  const collectionId = await d.provisionCollection({ members: [id!] });
  const before = await d.inspect();
  const op = await admit(d, { action: 'remove_from_library', selection: explicit([id!]) }); await finish(d, op.id, 1);
  const after = await d.inspect(); expect(after.entries).toHaveLength(0);
  expect(after.history).toEqual(before.history);
  expect(after.history[0]!.sessions.length).toBeGreaterThan(0);
  expect(after.history[0]!.changes.length).toBeGreaterThan(0);
  expect(after.history[0]!.copies.length).toBeGreaterThan(0);
  expect(after.history[0]!.follows.length).toBeGreaterThan(0);
  expect(after.members.filter(row => row.collectionId === collectionId)).toEqual(before.members.filter(row => row.collectionId === collectionId));
}));

test('cancellation during discovery labels selection incomplete and applies nothing', () => usingDriver(async d => {
  await d.provisionEntries(237); await d.pauseAt('after_discovery_commit');
  const op = await admit(d, status(query())); await d.runUntil('after_discovery_commit');
  const response = await d.request('owner', { method: 'POST', path: `/v1/libraryOperations/${op.id}:cancel`,
    body: {}, headers: { 'idempotency-key': d.key() } }); expect(response.status).toBe(202);
  await d.resume(); await d.settle();
  const done = await read(d, op.id); counters(done);
  expect(done.phase).toBe('cancelled'); expect(done.selectionComplete).toBe(false);
  expect(done.counts.applied).toBe(0); expect(done.counts.cancelled).toBe(done.counts.targets);
}));

test('cancellation reconciles an in-flight commit and never compensates over later edits', () => usingDriver(async d => {
  const ids = await d.provisionEntries(3);
  const op = await frozen(d, status(explicit(ids)), 'after_target_commit');
  const changed = (await d.inspect()).entries.find(entry => entry.state === 'completed')!;
  await d.putEntry(changed.subjectId, 'paused', changed.revision);
  const key = d.key();
  for (let repeat = 0; repeat < 2; repeat++) {
    expect((await d.request('owner', { method: 'POST', path: `/v1/libraryOperations/${op.id}:cancel`, body: {},
      headers: { 'idempotency-key': key } })).status).toBe(202);
  }
  await d.resume(); await d.settle();
  const done = await read(d, op.id); counters(done);
  expect(done.counts.applied).toBe(1); expect(done.counts.cancelled).toBe(2);
  expect((await d.inspect()).entries.find(entry => entry.subjectId === changed.subjectId)!.state).toBe('paused');
}));

test('crashes at discovery commit and seal recover atomic manifest checkpoint and enqueue intent', () => usingDriver(async d => {
  await d.provisionEntries(121);
  for (const boundary of ['after_discovery_commit', 'after_discovery_seal', 'before_segment_enqueue', 'after_segment_enqueue'] as const) {
    await d.crashAt(boundary);
    const op = await admit(d, { action: 'set_status', state: 'paused', selection: { kind: 'query', filter: {} } });
    await d.runUntil(boundary); await d.restart(); await d.settle();
    const view = await read(d, op.id); counters(view); expect(view.counts.targets).toBe(121);
    expect(view.phase).toBe('completed');
    expect((await all(d, op.id))).toHaveLength(121);
  }
}));

test('crashes before target commit after commit and before or after acknowledgement never duplicate effects', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); const collectionId = await d.provisionCollection();
  for (const boundary of ['before_target_commit', 'after_target_commit', 'before_outcome_ack', 'after_outcome_ack'] as const) {
    await d.crashAt(boundary);
    const op = await admit(d, { action: 'add_to_collection', collectionId, selection: explicit(ids) });
    await d.runUntil(boundary); await d.restart(); await finish(d, op.id, 1);
    const before = await page(d, op.id); await d.replay(op.id); await d.settle();
    expect(await page(d, op.id)).toEqual(before);
  }
  expect((await d.inspect()).members.filter(row => row.collectionId === collectionId)).toHaveLength(4);
}));

test('occurrence transfer commit and acknowledgement crashes preserve immutable pages across partitions', () => usingDriver(async d => {
  const [id] = await d.provisionEntries(1);
  for (const boundary of ['after_occurrence_commit', 'before_occurrence_ack'] as const) {
    const collectionId = await d.provisionCollection({ members: Array.from({ length: 201 }, () => id!) });
    await d.crashAt(boundary);
    const op = await admit(d, { action: 'remove_from_collection', collectionId, selection: query() });
    await d.runUntil(boundary); await d.restart(); await finish(d, op.id, 201);
    expect((await all(d, op.id))).toHaveLength(201);
  }
}));

test('enqueue success never reports mutation success and unavailable receipt evidence remains reconciling', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1);
  const op = await frozen(d, status(explicit(ids)), 'after_target_commit');
  expect((await read(d, op.id)).counts.applied).toBe(0);
  await d.fault({ dependency: 'receipt_read', mode: 'unavailable' });
  await d.resume(); await d.settle();
  const pending = await read(d, op.id); counters(pending);
  expect(pending.phase).toBe('reconciling'); expect(pending.counts.applied).toBe(0);
  const key = (await d.inspect()).targets[0]!.receipt;
  await d.fault({ dependency: 'receipt_read', mode: 'clear' }); await finish(d, op.id, 1);
  expect((await d.inspect()).targets[0]!.receipt).toEqual(key);
}));

test('failed enqueue leaves native admission recoverable without a second admission or false completion', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); await d.fault({ dependency: 'enqueue', mode: 'unavailable' });
  const key = d.key(); const body = status(explicit(ids)); const op = await admit(d, body, key);
  expect(op.counts.applied).toBe(0);
  await d.fault({ dependency: 'enqueue', mode: 'clear' });
  expect((await admit(d, body, key)).id).toBe(op.id); await finish(d, op.id, 1);
}));

test('missing immutable source fails closed and cannot use current-state inference', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); const op = await frozen(d, status(explicit(ids)));
  await d.fault({ dependency: 'source_read', mode: 'missing' }); await d.resume(); await d.settle();
  const view = (await d.inspect()).operations.find(row => row.id === op.id)!.view;
  expect(view.phase).toBe('stopped'); expect(view.reason).toBe('evidence_missing'); expect(view.counts.applied).toBe(0);
  expect((await d.inspect()).entries[0]!.state).toBe('planned');
}));

test('progress is bounded truthful and outcome pagination does not repeat or expose the manifest on summary', () => usingDriver(async d => {
  await d.provisionEntries(121); const op = await frozen(d, status(query()));
  const summary = await read(d, op.id); counters(summary);
  expect(summary.counts.pending).toBe(121); expect(summary.counts.applied).toBe(0);
  expect(JSON.stringify(summary).length).toBeLessThan(4096);
  expect(summary).not.toHaveProperty('outcomes'); expect(summary).not.toHaveProperty('targets');
  await d.resume(); const done = await finish(d, op.id, 121);
  expect((await all(d, op.id))).toHaveLength(done.counts.targets);
  const measured = await d.measure(() => read(d, op.id));
  expect(measured.sequentialRelations.some(name => /bulk_target|bulk_outcome/.test(name))).toBe(false);
}));

test('foreign and unknown operations share 404 for summary outcomes and cancellation', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); const op = await admit(d, status(explicit(ids)));
  for (const suffix of ['', '/outcomes', ':cancel']) {
    const responses = [];
    for (const id of [op.id, d.unknownOperationId]) responses.push(await d.request('other', {
      method: suffix === ':cancel' ? 'POST' : 'GET', path: `/v1/libraryOperations/${id}${suffix}`,
      ...(suffix === ':cancel' ? { body: {}, headers: { 'idempotency-key': d.key() } } : {}),
    }));
    expect(responses.map(response => response.status)).toEqual([404, 404]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
  }
}));

test('opaque cursors bind viewer route operation filters and page size and reject tampering', () => usingDriver(async d => {
  await d.provisionEntries(25); const op = await admit(d, status(query())); await finish(d, op.id, 25);
  const token = (await page(d, op.id)).next!; expect(token).toBeTypeOf('string');
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  expect(decoded).not.toContain(op.id); expect(decoded).not.toContain('"a"');
  for (const suffix of [`&cursor=${token}&state=applied`, `&cursor=${token.slice(0, -2)}`, `&cursor=${token}&limit=21`]) {
    expect((await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${op.id}/outcomes?limit=20${suffix}` })).status).toBe(400);
  }
  const second = await admit(d, status(query())); await d.settle();
  expect((await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${second.id}/outcomes?limit=20&cursor=${token}` })).status).toBe(400);
  expect((await d.request('other', { method: 'GET', path: `/v1/libraryOperations/${op.id}/outcomes?limit=20&cursor=${token}` })).status).toBe(404);
}));

test('cursor key rotation retirement and clock expiry use the accounts opaque helper', () => usingDriver(async d => {
  await d.provisionEntries(25); const op = await admit(d, status(query())); await finish(d, op.id, 25);
  const token = (await page(d, op.id)).next!;
  await d.rotateCursorKey({ retainPrevious: true }); expect((await page(d, op.id, `&cursor=${token}`)).outcomes).toHaveLength(5);
  await d.rotateCursorKey({ retainPrevious: false });
  expect((await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${op.id}/outcomes?limit=20&cursor=${token}` })).status).toBe(400);
  const fresh = (await page(d, op.id)).next!;
  await d.setTime(new Date(Date.parse(d.now()) + 15 * 60_000 + 1).toISOString());
  const response = await d.request('owner', { method: 'GET', path: `/v1/libraryOperations/${op.id}/outcomes?limit=20&cursor=${fresh}` });
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'stale_cursor' });
}));

test('durable chunk budgets retry the same index and unavailability is retryable without logical counter drift', () => usingDriver(async d => {
  await d.provisionEntries(121); await d.fault({ dependency: 'write_rate', mode: 'refused', retryAfter: 2 });
  const op = await admit(d, status(query())); await d.settle();
  expect((await read(d, op.id)).counts.applied).toBe(0);
  await d.fault({ dependency: 'write_rate', mode: 'unavailable' });
  await d.setTime(new Date(Date.parse(d.now()) + 2001).toISOString()); await d.settle();
  expect((await read(d, op.id)).counts.denied).toBe(0);
  await d.fault({ dependency: 'write_rate', mode: 'clear' });
  await d.setTime(new Date(Date.parse(d.now()) + 60_000).toISOString());
  await finish(d, op.id, 121);
  const attempts = (await d.inspect()).rate.filter(row => row.operationId === op.id);
  expect(attempts.length).toBeGreaterThan(1);
  expect(attempts[0]!.index).toBe(attempts[1]!.index);
  for (const row of attempts) {
    expect(row.units).toBeGreaterThan(0); expect(row.units).toBeLessThanOrEqual(100);
    expect(row.restoredActorId).toBe(d.accounts.owner.id); expect(row.family).toBe('write');
  }
}));

test('native expiry and bounded GC prevent retained DBOS segments and stale admission keys reopening effects', () => usingDriver(async d => {
  const ids = await d.provisionEntries(1); const key = d.key(); const body = status(explicit(ids));
  const op = await frozen(d, body);
  const replayOp = await admit(d, body, key);
  await d.setTime(new Date(Date.parse(op.expiresAt) + 60_001).toISOString());
  await d.resume(); await d.replay(op.id); await d.settle();
  expect((await d.inspect()).entries[0]!.state).toBe('planned');
  await d.collect({ dbos: true, native: true });
  expect((await post(d, body, key)).status).toBe(410);
  await d.replay(replayOp.id); await d.settle();
  expect((await d.inspect()).entries[0]!.state).toBe('planned');
}));

test('growth axes retain indexed admission replay summary and fixed outcome pages without manifest recounts', () => usingDriver(async d => {
  await d.provisionEntries(25); const key = d.key(); const body = status(query());
  const op = await admit(d, body, key); await finish(d, op.id, 25);
  for (const axis of ['entries', 'sparse', 'sessions', 'jobs', 'duplicates', 'outcomes', 'accounts'] as const) {
    let initial: { statements: number; rows: number; buffers: number } | undefined;
    for (const scale of [256, 1024, 4096]) {
      await d.seed(scale, axis);
      await read(d, op.id); await page(d, op.id); // warm actual statements before observation
      const sample = await d.measure(async () => {
        expect((await admit(d, body, key)).id).toBe(op.id); await read(d, op.id); await page(d, op.id);
      });
      initial ??= sample;
      expect(sample.statements).toBeLessThanOrEqual(initial.statements);
      expect(sample.rows).toBeLessThanOrEqual(initial.rows);
      expect(sample.buffers).toBeLessThanOrEqual(initial.buffers * 4 + 64);
      expect(sample.sequentialRelations.some(name => /bulk_(target|operation)|library.entry/.test(name))).toBe(false);
    }
  }
}));
