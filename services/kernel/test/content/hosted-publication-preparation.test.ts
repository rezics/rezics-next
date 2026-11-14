import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { sealHostedPublicationStaging } from '../../src/content/hosted-publication-staging.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('progress observes retained preparation without materializing or advancing, including replay and stale live heads', async () => {
  const { native, catalogueId, threadId } = f;
  const route = routeOf(catalogueId)!;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const occurrenceId = f.newOccurrenceId();
  const target = f.target(await native.thread());
  const created = await native.command('/v1/hostedCatalogues', {
    postId: catalogueId, threadId,
    placements: [{ occurrenceId, parentId: null, position: 0, title: 'Retained chapter', kind: 'chapter', target }],
  });
  const published = await native.command(`${path}:publish`, {
    expectedRevisionId: created.revisionId, expectedPublicationId: null, occurrenceIds: [occurrenceId],
  }, 200);
  const stageId = f.newOccurrenceId();
  const stagePath = `${path}/publicationPreparations/${stageId}`;
  const call = (operation: string, body = {}, key?: string) =>
    native.call('POST', `${stagePath}:${operation}`, body, key ? { key } : {});
  const retainedState = async () => (await native.pool.query(
    `SELECT
       (SELECT count(*)::text FROM content.hosted_tree_generation
        WHERE route=$1 AND catalogue_id=$2) AS generations,
       (SELECT count(*)::text FROM content.hosted_tree_snapshot_version
        WHERE route=$1 AND catalogue_id=$2) AS snapshots,
       (SELECT to_jsonb(candidate) FROM content.hosted_version_release_candidate candidate
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidate,
       publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
    [route, catalogueId, stageId],
  )).rows[0];
  const started = await native.call('POST', `${path}:prepareRelease`, {
    stageId, expectedRevisionId: created.revisionId, expectedPublicationId: published.revisionId, mode: 'whole',
  });
  expect(started.status).toBe(202);
  const initial = await retainedState();
  const building = await call('progress');
  expect(building.status).toBe(200);
  expect(building.value).toMatchObject({ stage: { state: 'building' }, candidate: null, candidateReady: false });
  expect(await retainedState()).toEqual(initial);
  const ready = await call('advance', { stepId: f.newOccurrenceId() });
  expect(ready.value.stage.state).toBe('ready');
  expect((await call('progress')).value).toEqual(ready.value);
  expect(await retainedState()).toEqual(initial);

  // A retained source seal can predate the first materialization command.
  const client = await native.pool.connect();
  try {
    await client.query('BEGIN');
    await sealHostedPublicationStaging(client, native.author.actor, { catalogueId, stageId });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const emptyKey = crypto.randomUUID();
  const empty = await call('progress', {}, emptyKey);
  expect(empty.status).toBe(200);
  expect(empty.value).toMatchObject({ stage: { state: 'sealed' }, candidate: null, candidateReady: false });
  expect(await retainedState()).toEqual(initial);
  expect((await call('progress')).value).toEqual(empty.value);
  expect(await retainedState()).toEqual(initial);

  const begun = await call('seal');
  expect(begun.status).toBe(200);
  expect(begun.value.candidate).toMatchObject({ placementCount: '0', coverageComplete: false, sealed: false });
  const beforePage = await retainedState();
  expect((await call('progress')).value).toEqual(begun.value);
  expect(await retainedState()).toEqual(beforePage);
  expect((await call('progress', {}, emptyKey)).value).toEqual(empty.value);
  const advanced = await call('advance', { stepId: f.newOccurrenceId() });
  expect(advanced.status).toBe(200);
  expect(advanced.value.candidate).toMatchObject({ placementCount: '1', coverageComplete: true, sealed: false });
  const beforeSeal = await retainedState();
  expect((await call('progress')).value).toEqual(advanced.value);
  expect(await retainedState()).toEqual(beforeSeal);
  const sealed = await call('seal');
  expect(sealed.value).toMatchObject({ candidate: { sealed: true }, candidateReady: true });
  const progressKey = crypto.randomUUID();
  const retained = await call('progress', {}, progressKey);
  expect(retained.status).toBe(200);
  expect(retained.value).toEqual(sealed.value);

  const moved = await native.command(`${path}:appendRootChapter`, {
    expectedRevisionId: created.revisionId, occurrenceId: f.newOccurrenceId(), title: 'Later draft', target,
  }, 200);
  for (const changePublication of [false, true]) {
    const release = changePublication ? await native.command(`${path}:publish`, {
      expectedRevisionId: moved.revisionId, expectedPublicationId: published.revisionId, occurrenceIds: [],
    }, 200) : published;
    const beforeRead = await retainedState();
    expect(beforeRead.publication_id).toBe(release.revisionId);
    expect((await call('progress')).value).toEqual(retained.value);
    expect((await call('progress', {}, progressKey)).value).toEqual(retained.value);
    expect((await call('progress', {}, emptyKey)).value).toEqual(empty.value);
    expect((await call('advance', { stepId: f.newOccurrenceId() })).status).toBe(412);
    expect((await call('seal')).status).toBe(412);
    expect((await native.call('POST', `${path}:prepareRelease`, {
      stageId: f.newOccurrenceId(), expectedRevisionId: created.revisionId,
      expectedPublicationId: published.revisionId, mode: 'whole',
    })).status).toBe(412);
    expect(await retainedState()).toEqual(beforeRead);
  }

  // Candidate/source/epoch mismatches must still withhold an existing checkpoint.
  for (const column of ['input_version', 'owner_epoch'] as const) {
    await native.pool.query(`UPDATE content.hosted_version_release_candidate SET ${column}=${column}+1
      WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`, [route, catalogueId, stageId]);
    expect((await call('progress')).status).toBe(404);
    await native.pool.query(`UPDATE content.hosted_version_release_candidate SET ${column}=${column}-1
      WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`, [route, catalogueId, stageId]);
  }
  expect((await native.call('POST', `${stagePath}:progress`, {}, { key: progressKey, other: true })).status).toBe(403);
  await native.pool.query(`UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 second'
    WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`, [route, catalogueId, stageId]);
  const expired = await call('progress');
  expect(expired.status).toBe(200);
  expect(expired.value).toMatchObject({ stage: { state: 'expired' }, candidate: null, candidateReady: false });
  expect((await call('cancel')).value).toEqual(expired.value);
  expect((await call('progress', {}, progressKey)).value).toEqual(retained.value);
  await native.pool.query(`UPDATE content.hosted_publication_staging SET owner_epoch=owner_epoch+1
    WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`, [route, catalogueId, stageId]);
  expect((await call('progress', {}, progressKey)).status).toBe(404);
});
