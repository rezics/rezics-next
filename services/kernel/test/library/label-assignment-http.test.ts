import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native label assignment HTTP publishes exact identity pages capacity errors and replay-stable undo headers in the generated contract', async () => {
  const subjectId = await f.createSubject('unprofiled');
  const createLabel = async (name: string) => {
    const r = await f.send('owner', 'POST', '/v1/libraryLabels', { name });
    expect(r.status).toBe(201);
    return (await r.json()).label.id as string;
  };
  const labelId = await createLabel('HTTP assignment'),
    path = '/v1/libraryLabels/' + labelId;
  const first = await f.send('owner', 'POST', path + ':assign', { subjectId });
  expect(first.status).toBe(200);
  const a = (await first.json()).assignment;
  expect(Object.keys(a).sort()).toEqual(['id', 'revision']);
  const duplicate = await f.send('owner', 'POST', path + ':assign', { subjectId });
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).assignment).toEqual(a);
  for (const filter of ['labelId=' + labelId, 'subjectId=' + subjectId]) {
    const r = await f.send('owner', 'GET', '/v1/libraryLabelAssignments?' + filter + '&limit=100');
    expect(r.status).toBe(200);
    const page = await r.json();
    expect(page.assignments).toContainEqual({ id: a.id, labelId, subjectId, revision: a.revision });
    expect(page).toHaveProperty('next');
  }
  for (const query of ['', '?labelId=' + labelId + '&subjectId=' + subjectId, '?labelId=' + labelId + '&limit=101'])
    expect((await f.send('owner', 'GET', '/v1/libraryLabelAssignments' + query)).status).toBe(400);
  const other = await f.send('other', 'GET', '/v1/libraryLabelAssignments?labelId=' + labelId);
  expect(other.status).toBe(404);
  expect([401, 403]).toContain(
    (await f.send('anonymous', 'GET', '/v1/libraryLabelAssignments?labelId=' + labelId)).status,
  );
  const body = { subjectId, assignmentId: a.id, revision: a.revision },
    deleteKey = entryKey();
  const removed = await f.send('owner', 'POST', path + ':unassign', body, deleteKey);
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ deleted: true });
  const deletedRevision = Number(removed.headers.get('Library-Label-Assignment-Revision'));
  expect(deletedRevision).toBe(a.revision + 1);
  const restored = await f.send('owner', 'POST', path + ':restoreAssignment', {
    subjectId,
    assignmentId: a.id,
    revision: deletedRevision,
  });
  expect(restored.status).toBe(200);
  const b = (await restored.json()).assignment;
  expect(b.id).toBe(a.id);
  expect(b.revision).toBe(deletedRevision + 1);
  const replay = await f.send('owner', 'POST', path + ':unassign', body, deleteKey);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ deleted: true });
  expect(replay.headers.get('Library-Label-Assignment-Revision')).toBe(String(deletedRevision));
  const stale = await f.send('owner', 'POST', path + ':restoreAssignment', {
    subjectId,
    assignmentId: a.id,
    revision: deletedRevision,
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe('library_label_restore_stale');
  const labels = [labelId];
  for (let n = 1; n < 33; n++) labels.push(await createLabel('HTTP cap ' + n));
  for (const id of labels.slice(1, 32))
    expect((await f.send('owner', 'POST', '/v1/libraryLabels/' + id + ':assign', { subjectId })).status).toBe(200);
  const capacity = await f.send('owner', 'POST', '/v1/libraryLabels/' + labels[32] + ':assign', { subjectId });
  expect(capacity.status).toBe(409);
  expect((await capacity.json()).code).toBe('library_label_capacity');
  const secondRemoval = await f.send('owner', 'POST', path + ':unassign', {
    subjectId,
    assignmentId: b.id,
    revision: b.revision,
  });
  expect(secondRemoval.status).toBe(200);
  const secondRevision = Number(secondRemoval.headers.get('Library-Label-Assignment-Revision'));
  expect((await f.send('owner', 'POST', '/v1/libraryLabels/' + labels[32] + ':assign', { subjectId })).status).toBe(
    200,
  );
  const restoreFull = await f.send('owner', 'POST', path + ':restoreAssignment', {
    subjectId,
    assignmentId: a.id,
    revision: secondRevision,
  });
  expect(restoreFull.status).toBe(409);
  expect((await restoreFull.json()).code).toBe('library_label_restore_capacity');
  const contract = await Bun.file(resolve(import.meta.dir, '../../../../contracts/openapi.json')).json();
  for (const endpoint of [
    '/v1/libraryLabels/{id}:assign',
    '/v1/libraryLabels/{id}:unassign',
    '/v1/libraryLabels/{id}:restoreAssignment',
  ])
    expect(contract.paths[endpoint]?.post).toBeDefined();
  expect(contract.paths['/v1/libraryLabelAssignments']?.get).toBeDefined();
  const headerNames = (endpoint: string, method: string) =>
    Object.keys(contract.paths[endpoint][method].responses['200'].headers ?? {}).map((x) => x.toLowerCase());
  expect(headerNames('/v1/libraryLabels/{id}', 'delete')).toContain('library-label-revision');
  expect(headerNames('/v1/libraryLabels/{id}:unassign', 'post')).toContain('library-label-assignment-revision');
}, 120000);
