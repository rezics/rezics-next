import { expect, test } from 'bun:test';
import { createOwnerFilterFixture, ownerRecord, ownerStatus, ownerString } from './support/owner-filter-fixture.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import { routeOf } from '../../src/route/route.ts';

test('post-activation owner working queries keep private exclusions and leave the selected public set unchanged', async () => {
  const f = await createOwnerFilterFixture();
  try {
    const filter = { and: [f.leaves.presence, { not: f.leaves.label }] };
    const created = await f.native.request(
      'alice',
      'POST',
      '/v1/collections',
      {
        membershipKind: 'dynamic',
        title: 'Separate working graph',
        visibility: 'private',
        rule: { filter },
      },
      discoveryKey(),
    );
    ownerStatus(created, 201);
    ownerRecord(created.body.collection);
    const id = ownerString(created.body.collection.id);
    const published = await f.native.request(
      'alice',
      'POST',
      `/v1/collections/${id}:publishSelected`,
      {
        revision: created.body.collection.revision,
        subjectIds: [f.subjects.entry.id],
      },
      discoveryKey(),
    );
    ownerStatus(published, 200);
    const expected = [f.subjects.entry.id, f.subjects.sessionOnly.id, f.subjects.copyOnly.id].sort();
    expect(await f.members(filter, 'alice', id)).toEqual(expected);
    const selected = await f.native.inspect<{ subject: string }>(
      `SELECT m.subject_id::text AS subject FROM library.collection_source_output_member m
       JOIN library.collection_source_output_head h USING (route,collection_id,generation)
       WHERE m.route=$1 AND m.collection_id=$2 ORDER BY m.subject_id`,
      [routeOf(id), id],
    );
    expect(selected.rows).toEqual([{ subject: f.subjects.entry.id }]);
    const reduced = await f.native.scoped('alice', ['collection:read', 'subject:read']);
    ownerStatus(await reduced.request('GET', f.path(filter, undefined, id)), 403);
    ownerStatus(await f.native.request('bob', 'GET', f.path(filter, undefined, id)), 422);
    const unchanged = await f.native.inspect<{ subject: string }>(
      `SELECT m.subject_id::text AS subject FROM library.collection_source_output_member m
       JOIN library.collection_source_output_head h USING (route,collection_id,generation)
       WHERE m.route=$1 AND m.collection_id=$2 ORDER BY m.subject_id`,
      [routeOf(id), id],
    );
    expect(unchanged.rows).toEqual(selected.rows);
  } finally {
    await f.close();
  }
}, 180_000);

test('Current native owner-filter admission binds actual Source time scope and complete originals instead of unconditional unavailable', async () => {
  const f = await createOwnerFilterFixture();
  try {
    const filter = { and: [f.leaves.presence, { not: f.leaves.label }] };
    const created = await f.native.request(
      'alice',
      'POST',
      '/v1/collections',
      {
        membershipKind: 'dynamic',
        title: 'Native owner closure',
        visibility: 'private',
        rule: { filter, sort: 'id' },
      },
      discoveryKey(),
    );
    ownerStatus(created, 201);
    ownerRecord(created.body.collection);
    const id = ownerString(created.body.collection.id);
    const expected = [f.subjects.entry.id, f.subjects.sessionOnly.id, f.subjects.copyOnly.id].sort();
    expect(await f.members(filter, 'alice', id)).toEqual(expected);
    ownerStatus(await f.native.request('bob', 'GET', f.path(filter, undefined, id)), 404);
    const route = routeOf(id)!;
    const source = await f.native.inspect<{
      incarnation: string;
      generation: string;
      account: string;
      capture: string;
      revision: string;
    }>(
      `SELECT s.identity->>'incarnation' AS incarnation, s.identity->>'generation' AS generation,
      s.identity->>'accountId' AS account, s.capture_id::text AS capture, s.committed_revision::text AS revision
      FROM library.canonical_source_scope s JOIN library.collection c USING (route,collection_id)
      WHERE s.route=$1 AND s.collection_id=$2 AND s.identity->>'generation'=c.source_generation::text
        AND s.capture_id IS NOT NULL`,
      [route, id],
    );
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]).toMatchObject({
      account: f.native.personas.alice.accountId,
      incarnation: expect.any(String),
      capture: expect.any(String),
      revision: expect.any(String),
    });
    const excluded = await f.native.inspect<{ original: string }>(
      `SELECT DISTINCT r.stored_subject_id::text AS original FROM library.canonical_source_reference r
       JOIN library.canonical_source_state s USING (route,collection_id)
       WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=s.ready_generation
         AND r.stored_subject_id=$3`,
      [route, id, f.subjects.labelOnly.id],
    );
    expect(excluded.rows).toEqual([{ original: f.subjects.labelOnly.id }]);

    // A real ordinary write changes the owner fact fence. An old binding cannot imply the old negative.
    ownerStatus(
      await f.native.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${f.labelId}:assign`,
        { subjectId: f.subjects.entry.id },
        discoveryKey(),
      ),
      200,
    );
    expect(await f.members(filter, 'alice', id)).toEqual([f.subjects.sessionOnly.id, f.subjects.copyOnly.id].sort());

    const key = discoveryKey();
    const input = { revision: created.body.collection.revision, subjectIds: [f.subjects.sessionOnly.id] };
    const published = await f.native.request('alice', 'POST', `/v1/collections/${id}:publishSelected`, input, key);
    ownerStatus(published, 200);
    const selected = await f.native.inspect<{ subject: string }>(
      `SELECT m.subject_id::text AS subject FROM library.collection_source_output_member m
       JOIN library.collection_source_output_head h USING (route,collection_id,generation)
       WHERE m.route=$1 AND m.collection_id=$2 ORDER BY m.subject_id`,
      [route, id],
    );
    expect(selected.rows).toEqual([{ subject: f.subjects.sessionOnly.id }]);
    const replay = await f.native.request('alice', 'POST', `/v1/collections/${id}:publishSelected`, input, key);
    ownerStatus(replay, 200);
    expect(replay.body).toEqual(published.body);
    const reduced = await f.native.scoped('alice', ['collection:read', 'collection:update', 'subject:read']);
    ownerStatus(await reduced.request('POST', `/v1/collections/${id}:publishSelected`, input, key), 403);
  } finally {
    await f.close();
  }
}, 180_000);
