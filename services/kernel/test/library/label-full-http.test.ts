import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { accountToken } from '../support/admitted-access.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('label FULL pages name current labels include bounded owner entry tiles and preserve progress gates while prefix q is published in the typed HTTP contract', async () => {
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  const owner = await f.identity([
    'subject:read',
    'library_entry:update',
    'library_entry:read',
    'library_entry:list',
    'progress_session:create',
    'progress_session:read',
    'progress_session:list',
    'progress_session:update',
  ]);
  const send = (method: string, path: string, body?: unknown) => f.send(owner.bearer, method, path, body);
  const createLabel = async (name: string) => {
    const r = await send('POST', '/v1/libraryLabels', { name });
    expect(r.status).toBe(201);
    return (await r.json()).label;
  };
  const label = await createLabel('Named shelf'),
    empty = await createLabel('Empty shelf');
  const subject = await f.createSubject('record'),
    noEntry = await f.createSubject('record');
  for (const subjectId of [subject, noEntry])
    expect((await send('POST', '/v1/libraryLabels/' + label.id + ':assign', { subjectId })).status).toBe(200);
  const entry = await send('PUT', '/v1/libraryEntries/' + subject, { state: 'listening' });
  expect(entry.status).toBe(201);
  const start = async (subjectId: string) => {
    const r = await send('POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'track',
      total: '10',
    });
    expect(r.status).toBe(201);
    return (await r.json()).progressSession;
  };
  const active = await start(subject);
  await start(noEntry);
  const subjectPath = '/v1/libraryLabelAssignments?subjectId=' + subject;
  const bySubject = await send('GET', subjectPath + '&view=FULL');
  expect(bySubject.status).toBe(200);
  const names = await bySubject.json();
  expect(names.assignments.find((x: { labelId: string }) => x.labelId === label.id).label).toEqual({
    name: 'Named shelf',
  });
  const labelPath = '/v1/libraryLabelAssignments?labelId=' + label.id;
  const basic = await send('GET', labelPath);
  expect(basic.status).toBe(200);
  const basicPage = await basic.json();
  expect(basicPage).not.toHaveProperty('label');
  expect(Object.keys(basicPage.assignments[0]).sort()).toEqual(['id', 'labelId', 'subjectId', 'revision']);
  const full = await send('GET', labelPath + '&view=FULL');
  expect(full.status).toBe(200);
  const page = await full.json();
  expect(page.label).toEqual({ id: label.id, name: 'Named shelf', revision: label.revision });
  const row = page.assignments.find((x: { subjectId: string }) => x.subjectId === subject);
  expect(row.subject.id).toBe(subject);
  expect(row.libraryEntry.state).toBe('listening');
  expect(row.libraryEntry.activeProgressSession).toEqual(active);
  expect(page.assignments.find((x: { subjectId: string }) => x.subjectId === noEntry).libraryEntry).toBeNull();
  const emptyPage = await send('GET', '/v1/libraryLabelAssignments?labelId=' + empty.id + '&view=FULL');
  expect(emptyPage.status).toBe(200);
  const emptyBody = await emptyPage.json();
  expect(emptyBody.assignments).toEqual([]);
  expect(emptyBody.label).toEqual({ id: empty.id, name: 'Empty shelf', revision: empty.revision });
  const q = await send('GET', '/v1/libraryLabels?q=' + encodeURIComponent('  Named  '));
  expect(q.status).toBe(200);
  expect((await q.json()).labels.map((x: { id: string }) => x.id)).toEqual([label.id]);
  const restricted = await accountToken({
    accountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: ['subject:read', 'library_entry:read'],
  });
  expect((await f.send(restricted, 'GET', subjectPath + '&view=FULL')).status).toBe(200);
  const denied = await f.send(restricted, 'GET', labelPath + '&view=FULL');
  expect(denied.status).toBe(403);
  const deniedBody = await denied.json();
  expect(deniedBody).not.toHaveProperty('assignments');
  expect(deniedBody).not.toHaveProperty('label');
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:close')).status).toBe(200);
  const closed = await send('GET', labelPath + '&view=FULL');
  expect(closed.status).toBe(403);
  expect((await closed.json()).code).toBe('platform_closed');
  expect((await send('GET', subjectPath + '&view=FULL')).status).toBe(200);
  expect((await send('GET', labelPath)).status).toBe(200);
  const contract = await Bun.file(resolve(import.meta.dir, '../../../../contracts/openapi.json')).json();
  const parameters = (path: string) => contract.paths[path].get.parameters.map((x: { name: string }) => x.name);
  expect(parameters('/v1/libraryLabels')).toContain('q');
  expect(parameters('/v1/libraryLabelAssignments')).toContain('view');
}, 120000);
