import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolveSubject, readableSubjects } from '../../src/library/subject-anchor.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';

let fixture: EpochFixture;

beforeAll(async () => {
  fixture = await epochFixture();
});

afterAll(async () => {
  await fixture?.close();
});

test('Library member filtering consumes the current native mapping and preserves the stored original', async () => {
  const created = await fixture.create('Identity source consumer');
  const actor = await fixture.actor();
  const mapping = await resolveSubject({ pool: fixture.pool, access: fixture.access }, actor, created.subject.id);

  expect(mapping).toEqual({ subjectId: created.subject.id, requestedSubjectId: null });
  expect(await readableSubjects({ pool: fixture.pool, access: fixture.access }, actor, [created.subject.id])).toEqual([
    created.subject.id,
  ]);
});
