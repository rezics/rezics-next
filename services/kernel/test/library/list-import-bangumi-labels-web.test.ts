import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { routeOf } from '../../src/route/route.ts';

let f: NativeProfileFixture;
const root = '/v1/libraryImports/bangumi';
const wrapper = (collections: unknown[]) => ({
  upload: JSON.stringify({ format: 'rezics.bangumi-collection.v1', collections }),
});

beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

async function send(method: 'GET' | 'POST', path: string, body?: unknown, persona = 'owner', key = randomUUID()) {
  return f.send(persona, method, path.startsWith('/v1/') ? path : root + path, body, key);
}

async function json(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await send(method, path, body);
  expect(response.status).toBe(200);
  if (path.startsWith('/')) expect(response.headers.get('cache-control')).toBe('private, no-store');
  return response.json();
}

test('retained tag pages compose with exact native label review, replay and current assignment readback', async () => {
  const subjectId = await f.createSubject('game');
  const labels = createPersonalLabelCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const existing = (await labels.createLabel(f.owner.actor, { name: 'Owned adoption target' }, randomUUID())).value
    .label;
  const colliding = (await labels.createLabel(f.owner.actor, { name: 'Name collision' }, randomUUID())).value.label;
  const retainedTags = [
    'repeat source',
    'repeat source',
    'different source',
    'Name collision',
    'new native label',
    ...Array.from({ length: 60 }, (_, i) => `tag ${i}`),
  ];
  const uploaded = await json(
    'POST',
    ':preview',
    wrapper([
      { subject_type: 4, type: 1, tags: retainedTags },
      { subject_type: 4, type: 1 },
      { subject_type: 4, type: 1, tags: [] },
      { subject_type: 4, type: 1, tags: ['admitted subset must not escape', 4] },
    ]),
  );
  const uploadId = uploaded.uploadId as string;
  const rowReview = await json('POST', `/${uploadId}:review`, { ordinal: 0, target: subjectId });
  const rowRevision = rowReview.review.token as string;
  const pages = await Promise.all([
    json('GET', `/${uploadId}/rows/0/tags?after=-1`),
    json('GET', `/${uploadId}/rows/0/tags?after=31`),
    json('GET', `/${uploadId}/rows/0/tags?after=63`),
  ]);
  expect(pages.map((page) => page.tags.length)).toEqual([32, 32, 1]);
  expect(pages.map((page) => page.next)).toEqual([31, 63, null]);
  expect(pages[0].tags[0]).toMatchObject({ index: 0, value: 'repeat source', status: 'supported' });
  const evidence = await Promise.all([1, 2, 3].map((ordinal) => json('GET', `/${uploadId}/rows/${ordinal}/tags`)));
  expect(evidence.map((page) => page.evidence)).toEqual(['missing', 'empty', 'invalid']);
  expect(evidence[2].tags[0]).toMatchObject({ status: 'invalid', proposedName: null });

  const collision = await send('POST', `/${uploadId}:reviewLabels`, {
    ordinal: 0,
    rowRevision,
    mappings: [{ index: 3, target: { name: 'Name collision' } }],
  });
  expect(collision.status).toBe(409);
  expect((await json('GET', `/v1/libraryLabels?q=Name%20collision&limit=20`)).labels).toContainEqual(
    expect.objectContaining({ id: colliding.id, name: 'Name collision' }),
  );

  const request = {
    ordinal: 0,
    rowRevision,
    mappings: [
      { index: 0, target: { labelId: existing.id } },
      { index: 1, target: { labelId: existing.id } },
      { index: 2, target: { labelId: existing.id } },
      { index: 4, target: { name: ' new   native label ' } },
    ],
  };
  const reviewed = await json('POST', `/${uploadId}:reviewLabels`, request);
  const labelReview = reviewed.labels.review;
  expect(labelReview).toMatchObject({ rowRevision, evidence: 'known' });
  expect(labelReview.items.map((item: { status: string }) => item.status)).toEqual([
    'ready',
    'duplicate',
    'duplicate',
    'ready',
  ]);
  const result = await json('POST', `/${uploadId}:applyLabels`, { ordinal: 0, reviewToken: labelReview.token });
  expect(result.outcomes.map((item: { status: string }) => item.status)).toEqual([
    'assigned',
    'duplicate',
    'duplicate',
    'assigned',
  ]);
  expect(result.outcomes[3]).toMatchObject({ created: true, label: { revision: 1 }, assignment: { revision: 1 } });
  expect(result.remaining).toEqual([]);

  const reopened = await json('GET', `/${uploadId}/rows/0/tags`);
  expect(reopened.labels).toMatchObject({ confirmed: true, outcomes: result.outcomes });
  const assignments = await json('GET', `/v1/libraryLabelAssignments?subjectId=${subjectId}&view=FULL&limit=32`);
  expect(assignments.assignments.map((item: { labelId: string }) => item.labelId).sort()).toEqual(
    [existing.id, result.outcomes[3].label.id].sort(),
  );
  expect(assignments.assignments).toContainEqual(
    expect.objectContaining({
      labelId: result.outcomes[3].label.id,
      label: expect.objectContaining({ name: 'new native label' }),
    }),
  );

  await f.pool.query(
    `UPDATE library.bangumi_upload_row SET labels=jsonb_set(labels,'{outcomes}','[]')
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=0`,
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, uploadId],
  );
  expect(await json('POST', `/${uploadId}:applyLabels`, { ordinal: 0, reviewToken: labelReview.token })).toEqual(
    result,
  );
  expect(
    (await json('GET', `/v1/libraryLabelAssignments?subjectId=${subjectId}&view=FULL&limit=32`)).assignments,
  ).toHaveLength(2);
  expect((await send('GET', `/${uploadId}/rows/0/tags`, undefined, 'other')).status).toBe(404);
  expect(
    (await send('POST', `/${uploadId}:applyLabels`, { ordinal: 0, reviewToken: labelReview.token }, 'other')).status,
  ).toBe(404);
}, 180000);
