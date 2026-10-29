import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolveSubject, readableSubjects } from '../../src/library/subject-anchor.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';
import { home, seedLegacyGroup } from '../semantic/support/identity-epoch.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';

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

test('bounded native legacy bootstrap supplies the Library members reader with the direct terminal mapping', async () => {
  const root = (await fixture.create('Legacy Library terminal')).subject.id;
  const [original] = await seedLegacyGroup(fixture, root, 1);
  let complete = false;
  for (let page = 0; page < 1000; page++) {
    const progress = await stepIdentityEpochBootstrap(fixture.pool, home(original!));
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'caught-up') {
      complete = true;
      break;
    }
  }
  expect(complete, 'native owner bootstrap must make bounded progress to its finite source head').toBe(true);
  const actor = await fixture.actor();
  expect(await resolveSubject({ pool: fixture.pool, access: fixture.access }, actor, original!)).toEqual({
    subjectId: root,
    requestedSubjectId: original,
  });
  await fixture.admin.query(
    "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE subject_id=$1",
    [original],
  );
  expect(await resolveSubject({ pool: fixture.pool, access: fixture.access }, actor, original!)).toBeNull();
});
