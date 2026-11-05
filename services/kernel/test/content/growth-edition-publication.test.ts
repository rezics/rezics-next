import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { seedResourceDenial } from './support/disclosure-fixtures.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  seed,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import {
  growthEditionPublicationFixture,
  seedUnrelatedPublicationHistory,
  unrelatedEditionPopulation,
} from './support/growth-edition-publication-fixture.ts';

setDefaultTimeout(600_000);

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
type Fixture = Awaited<ReturnType<typeof growthEditionPublicationFixture>>;
type Mode = 'publish' | 'unpublish';
type Axis = 'unrelated-editions' | 'source-revisions' | 'publication-receipts';
type CommandRun = { editionId: string; key: string; editionRevision: string };

async function body<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response;
  const text = await result.text();
  expect({ status: result.status, error: result.status === status ? null : text }).toEqual({ status, error: null });
  return JSON.parse(text) as T;
}

async function publish(fixture: Fixture, editionId: string, version: string, key: string) {
  return body<{ editionId: string; editionRevision: string }>(
    fixture.call(`/v1/contentEditions/${editionId}:publish`, 'POST', {}, version, key),
    200,
  );
}

async function unpublish(fixture: Fixture, editionId: string, version: string, key: string) {
  return body<{ editionId: string; editionRevision: string }>(
    fixture.call(`/v1/contentEditions/${editionId}:unpublish`, 'POST', {}, version, key),
    200,
  );
}

async function prepare(fixture: Fixture, mode: Mode, key: string) {
  const draft = await fixture.createDraft(`${key}-create`);
  const publication = mode === 'unpublish' ? await publish(fixture, draft.editionId, '1', `${key}-prepare`) : undefined;
  return { editionId: draft.editionId, expected: publication?.editionRevision ?? '1' };
}

async function execute(fixture: Fixture, mode: Mode, editionId: string, expected: string, key: string) {
  return mode === 'publish' ? publish(fixture, editionId, expected, key) : unpublish(fixture, editionId, expected, key);
}

async function publicationRows(fixture: Fixture, editionId: string) {
  return fixture.database.admin.query<{
    operation_id: string;
    recorded_transaction_id: string;
    initiator_account_id: string;
    actor_client_id: string;
    actor_scopes: string[];
    source_digest: string;
    creation_idempotency_key: string;
    creation_request_digest: string;
  }>(
    `SELECT operation_id,recorded_transaction_id,initiator_account_id,actor_client_id,actor_scopes,
            source_digest,creation_idempotency_key,creation_request_digest
       FROM content.edition_publication WHERE route=$1 AND edition_id=$2`,
    [fixture.route, editionId],
  );
}

async function assertCommandCommitted(fixture: Fixture, mode: Mode, run: CommandRun): Promise<void> {
  const edition = (
    await fixture.database.admin.query<{
      state: string;
      security_revision: string;
      creator_account_id: string;
      target_subject_id: string;
      thread_id: string;
      post_id: string;
      revision_id: string;
      sha256: string;
      licence: string;
    }>(
      `SELECT state,security_revision::text,creator_account_id,target_subject_id,thread_id,post_id,revision_id,
              encode(body_sha256,'hex') AS sha256,licence
         FROM content.edition WHERE route=$1 AND edition_id=$2`,
      [fixture.route, run.editionId],
    )
  ).rows[0];
  expect(edition).toEqual({
    state: mode === 'publish' ? 'published' : 'unpublished',
    security_revision: mode === 'publish' ? '2' : '3',
    creator_account_id: fixture.author.actor.accountId,
    target_subject_id: fixture.targetSubjectId,
    thread_id: fixture.thread.id,
    post_id: fixture.source.id,
    revision_id: fixture.source.revisionId,
    sha256: fixture.source.sha256,
    licence: 'CC0-1.0',
  });

  const commandKind = mode === 'publish' ? 'content.edition.publish' : 'content.edition.unpublish';
  const eventType =
    mode === 'publish' ? 'com.rezics.content.edition.published.v1' : 'com.rezics.content.edition.unpublished.v1';
  const receipt = await fixture.database.admin.query<{
    transaction_id: string;
    request_digest: string;
    response: { editionId: string; editionRevision: string };
    position: string;
  }>(
    `SELECT transaction_id,encode(request_digest,'hex') AS request_digest,response,position::text
       FROM core.receipt
      WHERE partition_no=$1 AND principal_id=$2 AND principal_kind='account'
        AND command_kind=$3 AND idempotency_key=$4`,
    [fixture.partition, fixture.author.actor.accountId, commandKind, run.key],
  );
  const events = await fixture.database.admin.query<{ position: string; data: Record<string, unknown> }>(
    `SELECT position::text,data FROM core.outbox
      WHERE partition_no=$1 AND subject=$2 AND type=$3`,
    [fixture.partition, run.editionId, eventType],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0]!.response).toEqual({ editionId: run.editionId, editionRevision: run.editionRevision });
  expect(events.rows.filter(({ data }) => data.editionRevision === run.editionRevision)).toHaveLength(1);
  expect(events.rows.find(({ data }) => data.editionRevision === run.editionRevision)!.position).toBe(
    receipt.rows[0]!.position,
  );

  const publications = await publicationRows(fixture, run.editionId);
  expect(publications.rows).toHaveLength(1);
  expect(publications.rows[0]!.initiator_account_id).toBe(fixture.author.actor.accountId);
  expect(publications.rows[0]!.actor_client_id).toBe(fixture.author.actor.clientId);
  expect(publications.rows[0]!.actor_scopes).toEqual([...fixture.author.actor.scopes]);
  expect(publications.rows[0]!.actor_scopes.length).toBeLessThanOrEqual(512);
  expect(publications.rows[0]!.source_digest).toMatch(/^[0-9a-f]{64}$/);

  if (mode === 'publish') {
    expect(publications.rows[0]!.creation_idempotency_key).toBe(run.key);
    expect(publications.rows[0]!.creation_request_digest).toBe(receipt.rows[0]!.request_digest);
    expect(publications.rows[0]!.recorded_transaction_id).toBe(receipt.rows[0]!.transaction_id);
    const basis = await fixture.database.admin.query<{
      principal_id: string;
      client_id: string;
      requested_by: string | null;
    }>(
      `SELECT principal_id,client_id,requested_by FROM editorial.write_basis
        WHERE partition_no=$1 AND transaction_id=$2`,
      [fixture.partition, publications.rows[0]!.recorded_transaction_id],
    );
    expect(basis.rows).toEqual([
      {
        principal_id: fixture.author.actor.accountId,
        client_id: fixture.author.actor.clientId,
        requested_by: fixture.author.actor.requestedBy,
      },
    ]);
  }
}

async function assertGrowthEvidence(report: GrowthReport, mode: Mode): Promise<void> {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ repetitions }) => repetitions.length === 1)).toBe(true);
  const relations = [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
  expect(relations).toContain('content.edition');
  expect(relations).toContain('content.post');
  expect(relations).toContain('content.revision');
  expect(relations).toContain('core.receipt');
  expect(relations).toContain('core.outbox');
  if (mode === 'publish') expect(relations).toContain('content.edition_publication');
  for (const sample of report.samples) {
    const cost = sample.repetitions[0]!;
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.statements).toBeGreaterThan(0);
    expect(cost.blocks).toBe(cost.sharedHit + cost.sharedRead);
    expect(cost.blocks).toBeGreaterThan(0);
    for (const relation of relations) expect(sample.relationSizes[relation]).toBeDefined();
  }
  assertGrowthAccessPaths(report.name, report.samples, relations);
}

async function growAxis(
  fixture: Fixture,
  database: GrowthDatabase,
  mode: Mode,
  axis: Axis,
  scale: number,
  previous: number,
): Promise<void> {
  const offset = mode === 'publish' ? 0 : 4096;
  if (axis === 'unrelated-editions') {
    await seed(
      { pool: database.pool, admin: database.admin },
      unrelatedEditionPopulation(fixture, `growth-edition-${mode}-unrelated-editions`),
      { from: previous, to: scale },
    );
  } else if (axis === 'source-revisions') {
    await fixture.reviseSourceHistoryTo(offset + scale);
  } else {
    await seedUnrelatedPublicationHistory(
      fixture,
      database,
      `growth-edition-${mode}-publication-history`,
      previous,
      scale,
    );
  }
}

async function measureAxis(fixture: Fixture, mode: Mode, axis: Axis): Promise<void> {
  const measuredRuns: CommandRun[] = [];
  const prepared = new Map<number, { editionId: string; expected: string }>();
  const name = `Edition ${mode} as ${axis} grows`;
  const report = await checkGrowth(fixture.database, {
    name,
    scales,
    bounds,
    rule: 'series',
    repetitions: 1,
    warmups: 1,
    grow: (database, scale, previous) => growAxis(fixture, database, mode, axis, scale, previous),
    async warmup(_database, scale, repetition) {
      const selected = await prepare(fixture, mode, `growth-warmup-${mode}-${axis}-${scale}-${repetition}`);
      await execute(
        fixture,
        mode,
        selected.editionId,
        selected.expected,
        `growth-warmup-command-${mode}-${axis}-${scale}-${repetition}`,
      );
    },
    async prepare(_database, _scale, repetition) {
      const selected = await prepare(fixture, mode, `growth-selected-${mode}-${axis}-${repetition}`);
      prepared.set(repetition, selected);
    },
    async operation(_database, _scale, repetition) {
      const selected = prepared.get(repetition);
      if (!selected) throw new Error('Growth command was not prepared outside its measured callback');
      const key = `growth-measured-${mode}-${axis}-${repetition}`;
      const result = await execute(fixture, mode, selected.editionId, selected.expected, key);
      measuredRuns.push({ editionId: result.editionId, key, editionRevision: result.editionRevision });
      return result;
    },
  });
  await assertGrowthEvidence(report, mode);
  expect(measuredRuns).toHaveLength(scales.length);
  for (const run of measuredRuns) await assertCommandCommitted(fixture, mode, run);
}

test('Native edition publication and terminal withdrawal preserve replay, CAS, authorization and rollback outcomes', async () => {
  const fixture = await growthEditionPublicationFixture();
  try {
    expect(fixture.selectedScopeCount).toBeLessThanOrEqual(512);
    const replayDraft = await fixture.createDraft();
    const replayKey = randomUUID();
    const first = await publish(fixture, replayDraft.editionId, '1', replayKey);
    expect(await publish(fixture, replayDraft.editionId, '1', replayKey)).toEqual(first);
    const replayReceipt = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.receipt
        WHERE partition_no=$1 AND principal_id=$2 AND principal_kind='account'
          AND command_kind='content.edition.publish' AND idempotency_key=$3`,
      [fixture.partition, fixture.author.actor.accountId, replayKey],
    );
    const replayEvents = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.edition.published.v1'`,
      [fixture.partition, replayDraft.editionId],
    );
    expect(replayReceipt.rows[0]!.count).toBe(1);
    expect(replayEvents.rows[0]!.count).toBe(1);
    await assertCommandCommitted(fixture, 'publish', {
      editionId: replayDraft.editionId,
      key: replayKey,
      editionRevision: '2',
    });

    const competing = await fixture.createDraft();
    const conflictKeys = [randomUUID(), randomUUID()] as const;
    const conflicts = await Promise.all(
      conflictKeys.map((key) =>
        fixture.call(`/v1/contentEditions/${competing.editionId}:publish`, 'POST', {}, '1', key),
      ),
    );
    expect(conflicts.map(({ status }) => status).sort()).toEqual([200, 412]);
    const conflictReceipts = await fixture.database.admin.query<{ key: string }>(
      `SELECT idempotency_key AS key FROM core.receipt
        WHERE partition_no=$1 AND principal_id=$2 AND principal_kind='account'
          AND command_kind='content.edition.publish' AND idempotency_key=ANY($3::text[])`,
      [fixture.partition, fixture.author.actor.accountId, [...conflictKeys]],
    );
    expect(conflictReceipts.rows).toHaveLength(1);
    const competingPublication = (await publicationRows(fixture, competing.editionId)).rows;
    expect(competingPublication).toHaveLength(1);
    const competingPublishedEvents = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.edition.published.v1'`,
      [fixture.partition, competing.editionId],
    );
    expect(competingPublishedEvents.rows[0]!.count).toBe(1);

    const withdrawDraft = await fixture.createDraft();
    const published = await publish(fixture, withdrawDraft.editionId, '1', randomUUID());
    const committedPublication = (await publicationRows(fixture, withdrawDraft.editionId)).rows[0];
    expect(committedPublication).toBeDefined();
    const withdrawKey = randomUUID();
    const withdrawn = await unpublish(fixture, withdrawDraft.editionId, published.editionRevision, withdrawKey);
    expect(await unpublish(fixture, withdrawDraft.editionId, published.editionRevision, withdrawKey)).toEqual(
      withdrawn,
    );
    expect((await publicationRows(fixture, withdrawDraft.editionId)).rows[0]).toEqual(committedPublication);
    expect((await fixture.call(`/v1/contentEditions/${withdrawDraft.editionId}:publish`, 'POST', {}, '3')).status).toBe(
      404,
    );
    await assertCommandCommitted(fixture, 'unpublish', {
      editionId: withdrawDraft.editionId,
      key: withdrawKey,
      editionRevision: '3',
    });
    const replayWithdrawEvents = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.edition.unpublished.v1'`,
      [fixture.partition, withdrawDraft.editionId],
    );
    expect(replayWithdrawEvents.rows[0]!.count).toBe(1);

    const creatorRevoked = await fixture.createDraft();
    const deniedCreatorKey = randomUUID();
    await seedResourceDenial(
      fixture.native.database.pool,
      fixture.route,
      creatorRevoked.editionId,
      fixture.author.actor.accountId,
      ['edition:sell'],
    );
    const creatorRefusal = await fixture.call(
      `/v1/contentEditions/${creatorRevoked.editionId}:publish`,
      'POST',
      {},
      '1',
      deniedCreatorKey,
    );
    expect(creatorRefusal.status).toBe(404);
    const creatorRefusedState = await fixture.database.admin.query<{ state: string; security_revision: string }>(
      'SELECT state,security_revision::text FROM content.edition WHERE route=$1 AND edition_id=$2',
      [fixture.route, creatorRevoked.editionId],
    );
    expect(creatorRefusedState.rows).toEqual([{ state: 'draft', security_revision: '1' }]);
    expect((await publicationRows(fixture, creatorRevoked.editionId)).rows).toHaveLength(0);
    const creatorRefusedReceipt = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.receipt
        WHERE partition_no=$1 AND principal_id=$2 AND principal_kind='account'
          AND command_kind='content.edition.publish' AND idempotency_key=$3`,
      [fixture.partition, fixture.author.actor.accountId, deniedCreatorKey],
    );
    const creatorRefusedEvent = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.edition.published.v1'`,
      [fixture.partition, creatorRevoked.editionId],
    );
    expect(creatorRefusedReceipt.rows[0]!.count).toBe(0);
    expect(creatorRefusedEvent.rows[0]!.count).toBe(0);

    const revoked = await fixture.createDraft();
    const deniedKey = randomUUID();
    await seedResourceDenial(
      fixture.native.database.pool,
      fixture.route,
      fixture.source.id,
      fixture.author.actor.accountId,
      ['post:revise'],
    );
    const refused = await fixture.call(`/v1/contentEditions/${revoked.editionId}:publish`, 'POST', {}, '1', deniedKey);
    expect(refused.status).toBe(404);
    const deniedEdition = await fixture.database.admin.query<{ state: string; security_revision: string }>(
      'SELECT state,security_revision::text FROM content.edition WHERE route=$1 AND edition_id=$2',
      [fixture.route, revoked.editionId],
    );
    const deniedPublication = await publicationRows(fixture, revoked.editionId);
    const deniedReceipt = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.receipt
        WHERE partition_no=$1 AND principal_id=$2 AND principal_kind='account'
          AND command_kind='content.edition.publish' AND idempotency_key=$3`,
      [fixture.partition, fixture.author.actor.accountId, deniedKey],
    );
    const deniedEvent = await fixture.database.admin.query(
      `SELECT count(*)::int AS count FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.edition.published.v1'`,
      [fixture.partition, revoked.editionId],
    );
    expect(deniedEdition.rows).toEqual([{ state: 'draft', security_revision: '1' }]);
    expect(deniedPublication.rows).toHaveLength(0);
    expect(deniedReceipt.rows[0]!.count).toBe(0);
    expect(deniedEvent.rows[0]!.count).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('Native edition publish and unpublish stay bounded across three independent same-home history axes', async () => {
  const fixture = await growthEditionPublicationFixture();
  try {
    expect(fixture.selectedScopeCount).toBeLessThanOrEqual(512);
    await measureAxis(fixture, 'publish', 'unrelated-editions');
    await measureAxis(fixture, 'publish', 'source-revisions');
    await measureAxis(fixture, 'publish', 'publication-receipts');
    await measureAxis(fixture, 'unpublish', 'unrelated-editions');
    await measureAxis(fixture, 'unpublish', 'source-revisions');
    await measureAxis(fixture, 'unpublish', 'publication-receipts');
  } finally {
    await fixture.close();
  }
});
