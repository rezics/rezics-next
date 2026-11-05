import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { decodeLocator } from '../../src/history/locator.ts';
import { commandHistoryKind } from '../../src/history/record.ts';
import { recordHistorySourceKey } from '../../src/history/record-source.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  prepareRecordPurgeAuthority,
  readRecordPurgeAuthoritySource,
  type NativeRecordPurgeReference,
} from '../../src/semantic/record-purge-authority.ts';
import {
  lockRecordPurgeReceivingHold,
  prepareRecordPurgeReceivingHold,
  readRecordPurgeReceivingHold,
  releaseRecordPurgeReceivingHold,
} from '../../src/semantic/record-purge-custody.ts';
import { semanticRetention } from '../../src/semantic/retention.ts';
import { checkGrowth } from '../support/growth.ts';
import { createBody, day, resourceFixture, type ResourceFixture } from '../zones/resource-fixture.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

let zones: ResourceFixture;
let f: Awaited<ReturnType<typeof createDeletionFixture>>;
beforeAll(async () => {
  zones = await resourceFixture();
  await zones.available();
  f = await createDeletionFixture(zones.db);
  await f.setup();
  f.setNow(zones.clock());
});
afterAll(async () => {
  await f?.close();
  await zones?.close();
});

const context = () => ({ deadline: Date.now() + 10_000 });
const deps = () => ({ pool: zones.db.pool, clock: f.clock });
function advance(ms: number) {
  zones.advance(ms);
  f.setNow(zones.clock());
}
async function community(label: string) {
  const made = await f.call('POST', '/v1/contexts', 'owner', { labels: { en: label } });
  f.status(made, 201);
  return made.body.context.id as string;
}
async function contextReference(id: string): Promise<NativeRecordPurgeReference> {
  const row = (
    await f.pool.query('SELECT deletion_generation FROM semantic.context WHERE route=$1 AND context_id=$2', [
      routeOf(id),
      id,
    ])
  ).rows[0]!;
  return { kind: 'context', contextId: id, deletionGeneration: row.deletion_generation };
}

// All population is made by existing commands: proposals grow owned history and receipts,
// Contexts grow native owner roles, and real accepted holds grow both custody homes.
// The unrelated source has a different home, so its pending key cannot consume the hot page.
async function population(subject: string, partition: number, receiver = partition) {
  let id = await community('Unrelated custody source');
  while (partitionOf(routeOf(id)!) === partition) id = await community('Unrelated custody source');
  f.status(await f.call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  advance(30 * day);
  const ref = await contextReference(id);
  return async (_database: unknown, scale: number, previous: number) => {
    for (let i = previous; i < scale; i++) {
      await f.proposal(subject);
      await community(`Unrelated owned Context ${i}`);
      const authority = await prepareRecordPurgeAuthority(deps(), ref, context());
      expect(authority).not.toBeNull();
      expect(
        await prepareRecordPurgeReceivingHold(
          deps(),
          authority!,
          {
            partition: receiver,
            receivingId: randomUUID(),
          },
          context(),
        ),
      ).not.toBeNull();
    }
  };
}

type Selected = {
  id: string;
  route: number;
  partition: number;
  secret: string;
  key: string;
  ref: NativeRecordPurgeReference;
  stale?: NativeRecordPurgeReference;
  read(): Promise<Record<string, any>>;
  restore(): Promise<{ status: number }>;
};

async function selected(kind: 'candidate' | 'context' | 'zone', subject: string): Promise<Selected> {
  const secret = `Ordinary retained payload ${randomUUID()}`;
  if (kind === 'candidate') {
    const made = await f.call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
      statement: {
        property: { id: 'schema:abstract' },
        value: {
          type: 'value',
          content: {
            document: fromPlainText(secret),
            licence: 'CC-BY-4.0',
            language: 'en',
          },
        },
        references: [],
      },
    });
    f.status(made, 201);
    const id = made.body.candidate as string;
    const route = routeOf(subject)!;
    const path = `/v1/subjects/${subject}/candidates/${id}`;
    const read = async () =>
      (
        await f.pool.query(
          `SELECT c.candidate_id,c.revision,c.statement,l.state,l.deletion_generation,d.id AS document_id,
         convert_from(d.body,'UTF8') AS body,d.availability
       FROM semantic.candidate c LEFT JOIN semantic.record_lifecycle l USING(route,subject_id,candidate_id)
       JOIN content.authored_field d ON (d.route,d.subject,d.candidate)=(c.route,c.subject_id,c.candidate_id)
       WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
          [route, subject, id],
        )
      ).rows[0]!;
    expect(JSON.stringify(await read())).toContain(secret);
    f.status(await f.call('DELETE', path, 'owner'), 200);
    const stale = await read();
    // Restore before expiry, then delete again: the original generation must never authorize cleanup.
    f.status(await f.call('POST', `${path}:restore`, 'owner', {}), 200);
    f.status(await f.call('DELETE', path, 'owner'), 200);
    const current = await read();
    expect(current.deletion_generation).not.toBe(stale.deletion_generation);
    const original = {
      kind: 'contribution' as const,
      subjectId: subject,
      candidateId: id,
      revision: Number(current.revision),
      documentId: current.document_id as string,
    };
    return {
      id,
      route,
      partition: partitionOf(route),
      secret,
      read,
      key: recordHistorySourceKey(original),
      ref: { ...originalReference(original), deletionGeneration: current.deletion_generation },
      stale: { ...originalReference(original), deletionGeneration: stale.deletion_generation },
      restore: () => f.call('POST', `${path}:restore`, 'owner', {}),
    };
  }
  if (kind === 'context') {
    const id = await community(secret);
    const route = routeOf(id)!;
    f.status(await f.call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
    return {
      id,
      route,
      partition: partitionOf(route),
      secret,
      key: recordHistorySourceKey({ kind: 'context', contextId: id }),
      ref: await contextReference(id),
      read: async () =>
        (
          await f.pool.query('SELECT context_id,state,labels FROM semantic.context WHERE route=$1 AND context_id=$2', [
            route,
            id,
          ])
        ).rows[0]!,
      restore: () => f.call('POST', `/v1/contexts/${id}:restore`, 'owner', {}),
    };
  }
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = secret;
  const made = await zones.create(body);
  const id = made.id,
    route = routeOf(id)!;
  const deleted = await zones.call('owner', 'DELETE', `/v1/zones/${id}`, undefined, zones.conditional(made.revision));
  expect(deleted.status).toBe(200);
  const raw = (await zones.raw(id))!;
  return {
    id,
    route,
    partition: partitionOf(route),
    secret,
    key: recordHistorySourceKey({ kind: 'zone', zoneId: id }),
    ref: { kind: 'zone', zoneId: id, deletionGeneration: raw.deletion_generation },
    read: async () =>
      (
        await f.pool.query(
          'SELECT zone_id,state,configuration,mounts,owner_id FROM zones.zone WHERE route=$1 AND zone_id=$2',
          [route, id],
        )
      ).rows[0]!,
    restore: () =>
      zones.call('owner', 'POST', `/v1/zones/${id}:restore`, {}, zones.conditional(deleted.body.zone.revision)),
  };
}

function originalReference(ref: { subjectId: string; candidateId: string; revision: number; documentId: string }) {
  return { subjectId: ref.subjectId, candidateId: ref.candidateId, revision: ref.revision, documentId: ref.documentId };
}

async function copies(source: Selected) {
  return (
    await f.pool.query(
      `SELECT artifact_type,locator,state,original_position FROM core.record_history_locator
     WHERE source_key=$1 ORDER BY partition_no,artifact_type,locator`,
      [source.key],
    )
  ).rows;
}

async function fragments(source: Selected) {
  const ref = source.ref;
  if ('subjectId' in ref) {
    const stores = [
      'candidate',
      'revision',
      'fact',
      'retraction',
      'moderation',
      'source_candidate',
      'statement_disclosure',
    ];
    const selects = stores.map((store) => {
      const predicate =
        store === 'revision' ? 'revision=$4' : `${store === 'fact' ? 'statement_id' : 'candidate_id'}=$3`;
      return `SELECT '${store}:'||erasure_key AS key,to_jsonb(r) AS payload FROM semantic.${store} r
        WHERE route=$1 AND subject_id=$2 AND ${predicate} AND $3::uuid IS NOT NULL AND $4::bigint IS NOT NULL`;
    });
    selects.push(`SELECT 'document:'||id,to_jsonb(r) FROM content.authored_field r
      WHERE route=$1 AND subject=$2 AND candidate=$3 AND revision=$4 AND id=$5`);
    return (
      await f.pool.query(selects.join(' UNION ALL ') + ' ORDER BY key', [
        source.route,
        ref.subjectId,
        ref.candidateId,
        ref.revision,
        ref.documentId,
      ])
    ).rows;
  }
  const sql =
    ref.kind === 'context'
      ? `SELECT 'context:'||erasure_key AS key,jsonb_build_array(labels,settings_id,settings_release,defaults) AS payload
       FROM semantic.context WHERE route=$1 AND context_id=$2
       UNION ALL SELECT 'extension:'||erasure_key,to_jsonb(body) FROM semantic.context_extension
       WHERE route=$1 AND context_id=$2 ORDER BY key`
      : `SELECT 'zone' AS key,jsonb_build_array(configuration,mounts,owner_id) AS payload
       FROM zones.zone WHERE route=$1 AND zone_id=$2`;
  return (await f.pool.query(sql, [source.route, source.id])).rows;
}

async function physicalCopiesAbsent(source: Selected) {
  const rows = await copies(source);
  expect(rows.length, 'Native writers must enroll their actual history copies').toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.original_position).not.toBeNull();
    expect(row.state).toBe('minimized');
    const locator = decodeLocator(row.artifact_type, row.locator);
    let physical;
    if (locator.artifactType === 'command-receipt/v1') {
      physical = await f.pool.query(
        `SELECT response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3
         AND command_kind=$4 AND idempotency_key=$5`,
        [
          locator.partitionNo,
          locator.principalKind,
          locator.principalId,
          commandHistoryKind(locator.commandKindId),
          `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`,
        ],
      );
    } else if (locator.artifactType === 'outbox-event/v1') {
      physical = await f.pool.query(
        'SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3',
        [locator.partitionNo, locator.position.toString(), locator.eventSeq],
      );
    } else {
      // A newly introduced native work copy needs its real owner absence oracle, never a fake completion.
      throw new Error(`Native ordinary-retention durable-work absence oracle required for ${locator.workId}`);
    }
    expect(physical.rows).toHaveLength(1);
    expect(JSON.stringify(physical.rows)).not.toContain(source.secret);
  }
}

for (const kind of ['candidate', 'context', 'zone'] as const) {
  test(`ordinary ${kind} retention counts native cleanup, replay and retained copies as unrelated ownership grows`, async () => {
    const made = await f.call('POST', '/v1/subjects', 'owner', {
      type: 'schema:Recipe',
      labels: { en: 'Retention growth neighbourhood' },
    });
    f.status(made, 201);
    const subject = made.body.subject.id as string;
    const grow = await population(subject, partitionOf(routeOf(subject)!));
    let source: Selected;
    let held: Awaited<ReturnType<typeof f.proposal>> | undefined;
    async function prepare() {
      source = await selected(kind, subject);
      if (kind === 'candidate') {
        held = await f.proposal(subject);
        f.status(await f.call('DELETE', f.path(held), 'owner'), 200);
        f.status(
          await f.call('POST', `${f.path(held)}:hold`, 'platform', {
            held: true,
            reason: 'Retain evidence during ordinary cleanup',
          }),
          200,
        );
      }
    }
    async function operation() {
      expect(await prepareRecordPurgeAuthority(deps(), source.ref, context())).toBeNull();
      advance(30 * day - 1);
      const early = await semanticRetention(f.pool, { clock: f.clock }).step({
        partition: source.partition,
        limit: 2,
        key: randomUUID(),
      });
      expect(early.examined).toBeLessThanOrEqual(2);
      expect(early.purged).toBe(0);
      expect(JSON.stringify(await source.read())).toContain(source.secret);
      advance(1);
      expect((await source.restore()).status).toBe(409);
      if (source.stale) expect(await prepareRecordPurgeAuthority(deps(), source.stale, context())).toBeNull();
      const authority = await prepareRecordPurgeAuthority(deps(), source.ref, context());
      expect(authority).not.toBeNull();
      const native = await readRecordPurgeAuthoritySource(deps(), authority!, context());
      expect(native?.reference).toEqual(source.ref);
      expect(Date.parse(native!.purgeAfter) - Date.parse(native!.deletionCommittedAt)).toBe(30 * day);
      // The shared fixture's existing 100-page exhaustion guard is retained. Every page,
      // receiver call, restart replay and physical evidence read is inside this capture.
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const input = { partition: source.partition, limit: 2, key: randomUUID() };
        const before = await copies(source);
        const localBefore = await fragments(source);
        const result = await semanticRetention(f.pool, { clock: f.clock }).step(input);
        expect(result.examined).toBeLessThanOrEqual(2);
        expect(result.purged).toBeLessThanOrEqual(result.examined);
        const localAfter = await fragments(source);
        const remaining = new Map(localAfter.map((row) => [row.key, JSON.stringify(row.payload)]));
        expect(
          localBefore.filter((row) => remaining.get(row.key) !== JSON.stringify(row.payload)).length,
        ).toBeLessThanOrEqual(4);
        expect(await semanticRetention(f.pool, { clock: f.clock }).step(input)).toEqual(result);
        expect(await fragments(source)).toEqual(localAfter);
        const after = await copies(source);
        // Accounts performs at most one physical history effect per selected source.
        expect(
          after.filter((row) => row.state === 'minimized').length -
            before.filter((row) => row.state === 'minimized').length,
        ).toBeLessThanOrEqual(2);
        if ((await source.read()).state === 'purged') {
          complete = true;
          break;
        }
      }
      expect(complete, 'Native ordinary retention must complete; pending/unavailable is not cleanup').toBe(true);
      const retained = await source.read();
      expect(JSON.stringify(retained)).not.toContain(source.secret);
      if (kind === 'candidate') {
        expect(retained.candidate_id).toBe(source.id);
        expect(retained.body).toBeNull();
        expect(retained.availability).toBe('erased');
      } else if (kind === 'context') {
        expect(retained.context_id).toBe(source.id);
        expect(retained.labels).toEqual({});
      } else {
        expect(retained.zone_id).toBe(source.id);
        expect(retained.configuration).toBeNull();
        expect(retained.mounts).toEqual([]);
        expect(retained.owner_id).toBeNull();
      }
      await physicalCopiesAbsent(source);
      if (held) {
        const read = async () =>
          (
            await f.pool.query(
              'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
              [routeOf(held!.subject), held!.subject, held!.candidate],
            )
          ).rows;
        expect(JSON.stringify(await read())).toContain(held.payload);
        f.status(await f.call('POST', `${f.path(held)}:hold`, 'platform', { held: false, reason: 'Released' }), 200);
        // Existing bounded drain, including shared cleanup, remains in the measured operation.
        await f.drain(subject);
        expect(JSON.stringify(await read())).not.toContain(held.payload);
      }
    }
    const report = await checkGrowth(zones.db, {
      name: `ordinary native ${kind} retention fixed neighbourhood`,
      scales: [64, 512, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      grow,
      prepare,
      operation,
      warmup: async () => {
        await prepare();
        await operation();
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  });
}

test('native receiving custody stays bounded and survives restart without releasing an unfinished receiver', async () => {
  const subject = await f.person();
  const id = await community(`Receiving source ${randomUUID()}`);
  const partition = partitionOf(routeOf(id)!);
  const grow = await population(subject, partition, (partition + 1) % 4096);
  f.status(await f.call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  const stale = await contextReference(id);
  f.status(await f.call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 200);
  f.status(await f.call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  const ref = await contextReference(id);
  expect(ref.deletionGeneration).not.toBe(stale.deletionGeneration);
  advance(30 * day);
  const report = await checkGrowth(zones.db, {
    name: 'ordinary native receiving hold and restart',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow,
    async operation() {
      expect(await prepareRecordPurgeAuthority(deps(), stale, context())).toBeNull();
      const authority = await prepareRecordPurgeAuthority(deps(), ref, context());
      expect(authority).not.toBeNull();
      const target = { partition: (partition + 1) % 4096, receivingId: randomUUID() };
      expect(await prepareRecordPurgeReceivingHold(deps(), authority!, target, context())).not.toBeNull();
      const resumed = await readRecordPurgeReceivingHold(deps(), ref, target, context());
      expect(resumed).not.toBeNull();
      const source = (
        await runCommand(f.pool, { ...context(), partition: target.partition, clock: f.clock }, async (tx) =>
          noEffect(await lockRecordPurgeReceivingHold(tx, resumed!)),
        )
      ).value;
      expect(source?.reference).toEqual(ref);
      expect(source).toEqual(await readRecordPurgeAuthoritySource(deps(), authority!, context()));
      expect(await releaseRecordPurgeReceivingHold(deps(), ref, target, context())).toEqual({ state: 'pending' });
      const durable = (
        await f.pool.query(
          `SELECT h.released,r.completion_transaction_id,r.completion_position,
          r.source_transaction_id=h.transaction_id AS same_source
         FROM semantic.record_purge_hold h JOIN semantic.record_purge_receiving r
         ON r.hold_id=h.hold_id AND r.partition_no=h.receiving_partition
         WHERE h.partition_no=$1 AND h.receiving_id=$2 AND h.receiving_partition=$3`,
          [partition, target.receivingId, target.partition],
        )
      ).rows;
      expect(durable).toEqual([
        { released: false, completion_transaction_id: null, completion_position: null, same_source: true },
      ]);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});
