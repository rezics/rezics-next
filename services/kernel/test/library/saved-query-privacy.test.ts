import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import { createOwnerFilterFixture, ownerRecord, ownerStatus, ownerString } from './support/owner-filter-fixture.ts';

test('a saved positive/negative owner rule sees native writes and parent deletion; cursors retain their owner basis', async () => {
  const f = await createOwnerFilterFixture();
  try {
    const filter = { and: [{ or: [f.leaves.state, f.leaves.holding] }, { not: f.leaves.label }] };
    const created = await f.native.request('alice', 'POST', '/v1/collections', {
      membershipKind: 'dynamic', title: 'Current private facts', visibility: 'private', rule: { filter },
    }, discoveryKey());
    ownerStatus(created, 201);
    ownerRecord(created.body.collection);
    const id = ownerString(created.body.collection.id);
    const path = (cursor?: string) => `/v1/collections/${id}/members?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.entry.id, f.subjects.copyOnly.id].sort());
    const first = await f.native.request('alice', 'GET', path());
    ownerStatus(first, 200);
    const cursor = ownerString(first.body.next);
    // Unrelated identity work cannot stall a finite unchanged saved query or its continuation.
    await f.native.createSubject(f.type, 'Disjoint from the private source');
    ownerStatus(await f.native.request('alice', 'GET', path(cursor)), 200);
    ownerStatus(await f.native.request('alice', 'POST', `/v1/libraryLabels/${f.labelId}:assign`, {
      subjectId: f.subjects.entry.id,
    }, discoveryKey()), 200);
    ownerStatus(await f.native.request('alice', 'GET', path(cursor)), 409);
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.copyOnly.id]);
    ownerStatus(await f.native.request('alice', 'DELETE', `/v1/libraryLabels/${f.labelId}?revision=1`, undefined, discoveryKey()), 200);
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.entry.id, f.subjects.copyOnly.id].sort());
    ownerRecord(f.written.body.libraryEntry);
    const other = f.stateSet.states.find((choice) => choice.id !== f.state.id)!;
    ownerStatus(await f.native.request('alice', 'PUT', `/v1/libraryEntries/${f.subjects.entry.id}`, {
      revision: f.written.body.libraryEntry.revision, state: other.id,
    }, discoveryKey()), 200);
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.copyOnly.id]);
    const copy = f.native.release.definition.libraryProfiles![f.profileId]!.copies!.kinds.find((kind) => kind.statuses.length > 0)!;
    ownerStatus(await f.native.request('alice', 'POST', '/v1/copies', {
      subjectId: f.subjects.noEntry.id, kind: copy.id, status: copy.statuses[0]!.id,
    }, discoveryKey()), 201);
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.copyOnly.id, f.subjects.noEntry.id].sort());
    const reduced = await f.native.scoped('alice', ['collection:read', 'subject:read']);
    ownerStatus(await reduced.request('GET', path()), 403);
  } finally { await f.close(); }
}, 180_000);

test('saved reads refuse hidden originals/terminals and never turn missing query acknowledgement into catalogue safety', async () => {
  const f = await createOwnerFilterFixture({ search: 'native' });
  try {
    await f.native.grant('acceptor', ['gate:subject_identity', 'moderation:hide'], GLOBAL_CONTEXT);
    const merged = await f.native.request('acceptor', 'POST', '/v1/subjects:merge', {
      subjects: [f.subjects.entry.id, f.subjects.sessionOnly.id],
    }, discoveryKey());
    ownerStatus(merged, 200);
    const terminal = ownerString(merged.body.survivor);
    const original = terminal === f.subjects.entry.id ? f.subjects.sessionOnly.id : f.subjects.entry.id;
    const filter = { and: [f.leaves.presence, { not: f.leaves.label }] };
    const created = await f.native.request('alice', 'POST', '/v1/collections', {
      membershipKind: 'dynamic', title: 'Current original disclosure', visibility: 'private', rule: { filter },
    }, discoveryKey());
    ownerStatus(created, 201);
    ownerRecord(created.body.collection);
    const id = ownerString(created.body.collection.id);
    expect(await f.members(filter, 'alice', id)).toContain(terminal);
    await f.native.search!.indexing('paused');
    const catalogue = { and: [filter, { not: { type: { in: [f.type] } } }] };
    // No native queried observation exists for this direct saved read, even after the index catches up.
    // Neither returned-ID guards nor empty results can stand in for full NOT/order acknowledgement.
    ownerStatus(await f.native.request('alice', 'GET', f.path(catalogue, undefined, id)), 503);
    await f.native.search!.indexing('running');
    ownerStatus(await f.native.request('alice', 'GET', f.path(catalogue, undefined, id)), 503);
    ownerStatus(await f.native.request('acceptor', 'POST', `/v1/subjects/${f.subjects.copyOnly.id}:hide`, {
      reason: 'Reauthorize terminal saved-query support',
    }, discoveryKey()), 200);
    expect(await f.members(filter, 'alice', id)).toEqual([terminal]);
    ownerStatus(await f.native.request('acceptor', 'POST', `/v1/subjects/${original}:hide`, {
      reason: 'Reauthorize independent saved-query support',
    }, discoveryKey()), 200);
    ownerStatus(await f.native.request('alice', 'GET', `/v1/collections/${id}/members`), 503);
  } finally { await f.close(); }
}, 180_000);
