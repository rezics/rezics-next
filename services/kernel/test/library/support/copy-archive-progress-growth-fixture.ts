import { expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  libraryProfile,
  unitData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';
import { createCopyArchive } from '../../../src/library/copy-archive.ts';
import { routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { authenticateAccount } from '../../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthReport } from '../../support/growth.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import type { AccountActor } from '../../../src/request/access.ts';
import { testRouteKey } from '../../support/test-kernel.ts';
import { createProfileEntryFixture, entryKey } from './profile-entry-fixture.ts';

export const SCALES = [64, 512, 4096] as const;
export const COMMAND_JSON_CAP = 8 * 1024;
export const CLEANUP_CHILD_BUDGET = 100;
const additionalUnits = ['volume', 'page', 'minute', 'episode', 'percent', 'plot-key.v2', 'edition.v1'] as const;
const scopes = [
  'subject:read',
  'subject:create',
  'statement:propose',
  'copy:create',
  'copy:read',
  'copy:list',
  'library_entry:list',
  'library_entry:read',
  'progress_session:list',
  'progress_session:read',
  'progress_session:create',
  'progress_session:update',
];
function asPerson(identity: { actor: AccountActor; bearer: string }): GrowthPerson {
  return { actor: identity.actor, bearer: identity.bearer, reviews: [] };
}

export type GrowthPerson = {
  actor: AccountActor;
  bearer: string;
  uploadId?: string;
  reviews: string[];
};

function archiveRelease(changedProfile: boolean) {
  const profile = libraryProfile('fixture.archive', changedProfile ? 'volume' : 'chapter');
  profile.progress.allowed[0]!.units.push(
    ...additionalUnits
      .filter((unit) => unit !== profile.progress.allowed[0]!.units[0]!.id)
      .map((unit) => unitData(unit)),
  );
  profile.copies.kinds = [{ id: 'physical', statuses: [{ id: 'owned' }, { id: 'lent' }] }];
  const sources = fixture(profile);
  const schema = JSON.parse(sources.schemas['fixture.yaml']!);
  schema.prefixes.schema = 'http://schema.org/';
  sources.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, source] of Object.entries(sources.presentation)) {
    const labels = JSON.parse(source);
    const locale = key.slice('fixture/'.length) as Parameters<typeof libraryLabels>[1];
    labels.libraryProfiles[profile.id] = libraryLabels(profile, locale);
    sources.presentation[key] = JSON.stringify(labels);
  }
  return compileCatalogue(sources);
}

async function json(response: Response, status = 200) {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
}

export function paddedActiveCommand(target = 8000) {
  const command = { key: 'archive:seed:0', kind: 'create', input: { subjectId: 'seed', pad: '' } };
  const used = Buffer.byteLength(JSON.stringify(command), 'utf8');
  command.input.pad = 'x'.repeat(Math.max(0, target - used));
  return command;
}

export function expectNoGrownScans(report: GrowthReport) {
  for (const sample of report.samples)
    for (const cost of sample.repetitions)
      for (const relation of [
        'library.progress_session',
        'library.progress_unit',
        'library.progress_change',
        'library.copy_archive_upload',
        'library.copy_archive_row',
        'library.copy_archive_progress_review',
        'library.copy_archive_progress_apply',
      ])
        expect(cost.relations?.[relation]?.sequentialScans ?? 0, `${relation} at scale ${sample.scale}`).toBe(0);
}

export async function createCopyArchiveProgressGrowthFixture() {
  const db = await openGrowthDatabase();
  let now = Date.now();
  const clock = () => new Date(now);
  const f = await createProfileEntryFixture({ pool: db.pool, clock, projectLinks: false });
  const workClient = await createWorkClient(db.url, db.pool);
  const service = createCopyArchive({
    pool: db.pool,
    access: f.access,
    workClient,
    tokens: f.tokens,
    routeKey: testRouteKey(),
    clock,
  });
  for (const group of ['reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  const goodDigest = await f.publish(await archiveRelease(false));
  const staleDigest = await f.publish(await archiveRelease(true));
  await f.activate(goodDigest);
  const applyOwner = asPerson(await f.identity(scopes));
  const rejectOwner = asPerson(await f.identity(scopes));
  const cleanupOwners = {
    applications: asPerson(await f.identity(scopes)),
    crossing: asPerson(await f.identity(scopes)),
    finalPage: asPerson(await f.identity(scopes)),
    continuation: asPerson(await f.identity(scopes)),
  };
  const subjectId = await f.createSubject('game');
  const send = (person: { bearer: string }, method: string, path: string, body?: unknown, key = entryKey()) =>
    f.send(person.bearer, method, path, body, key);
  expect(
    (
      await send(applyOwner, 'POST', '/v1/copies', {
        subjectId,
        kind: 'physical',
        status: 'owned',
        note: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
      })
    ).status,
  ).toBe(201);
  const started = await json(
    await send(
      applyOwner,
      'POST',
      '/v1/progressSessions',
      {
        subjectId,
        mode: 'scalar_amount',
        unit: 'chapter',
        total: '999999999999.999999',
        additionalMeasures: additionalUnits.map((unit) => ({ unit, total: '5.000001' })),
      },
      entryKey(),
    ),
    201,
  );
  const session = started.progressSession as { id: string };
  await json(await send(applyOwner, 'POST', `/v1/progressSessions/${session.id}:record`, { revision: 1, amount: '0' }));
  let revision = 2;
  for (const unit of additionalUnits) {
    await json(
      await send(applyOwner, 'POST', `/v1/progressSessions/${session.id}:record`, {
        revision,
        measureId: unit,
        amount: '4.125000',
      }),
    );
    revision++;
  }
  await json(await send(applyOwner, 'POST', `/v1/progressSessions/${session.id}:complete`, { revision }));
  const exported = await json(await send(applyOwner, 'POST', '/v1/libraryExports'));
  const records: Record<string, any>[] = [];
  let cursor = exported.first,
    manifest: Record<string, any> | null = null;
  for (let n = 0; cursor && n < 100; n++) {
    const page = await json(
      await send(
        applyOwner,
        'GET',
        `/v1/libraryExports/${exported.exportId}/pages?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    records.push(...page.records);
    cursor = page.next;
    manifest = page.manifest;
  }
  if (cursor || !manifest) throw new Error('Bounded export did not finish');
  const artifact = { manifest, records };
  const reviewBody = {
    sessionId: session.id,
    subjectId,
    mode: 'scalar_amount',
    unit: 'chapter',
    additionalMeasures: additionalUnits.map((unit) => ({ sourceUnit: unit, unit })),
    unitIds: [] as string[],
  };

  async function renew(person: { actor: AccountActor; bearer: string }) {
    person.actor = await authenticateAccount(f.access, { pool: db.pool, deadline: deadlineFor(300_000) }, person.actor);
    return person.actor;
  }

  async function uploadFor(person: { actor: AccountActor; bearer: string; uploadId?: string }) {
    const uploaded = await json(await send(person, 'POST', '/v1/libraryCopyArchives', artifact, entryKey()), 200);
    person.uploadId = uploaded.uploadId;
    return uploaded.uploadId as string;
  }

  async function addReviews(person: GrowthPerson, count: number) {
    if (!person.uploadId) throw new Error('Reviews need an upload');
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const review = await json(
        await send(person, 'POST', `/v1/libraryCopyArchives/${person.uploadId}/progressReviews`, reviewBody, entryKey()),
      );
      ids.push(review.reviewId);
    }
    return ids;
  }

  async function growUnrelated(accountId: string, prefix: string, previous: number, scale: number) {
    if (previous >= scale) return;
    const route = routeOf(accountId);
    if (route === null) throw new Error('Growth owner is missing a route');
    const from = previous + 1;
    const sessionSql = `('${prefix}-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid`;
    const txSql = `('b${prefix.slice(1)}-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid`;
    await db.admin.query(
      `INSERT INTO library.progress_session
        (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator,
         "position", completed_unit_count, state, revision, started_at, completed_at, transaction_id)
       SELECT $1, ${sessionSql}, $4, $5, NULL, 'scalar_amount', 'page', NULL, NULL, NULL, NULL,
         0, 'active', 1, $6::timestamptz, NULL, ${txSql}
       FROM generate_series($2::int, $3::int) AS n`,
      [route, from, scale, accountId, subjectId, clock().toISOString()],
    );
    await db.admin.query(
      `INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
       SELECT $1, ${sessionSql}, 'seed-unit', $4::timestamptz
       FROM generate_series($2::int, $3::int) AS n`,
      [route, from, scale, clock().toISOString()],
    );
    await db.admin.query(
      `INSERT INTO library.progress_change (route, session_id, change_no, intent, recorded_at, transaction_id)
       SELECT $1, ${sessionSql}, 1, '{"amount":"0"}'::jsonb, $4::timestamptz, ${txSql}
       FROM generate_series($2::int, $3::int) AS n`,
      [route, from, scale, clock().toISOString()],
    );
  }

  async function seedChildren(
    person: { actor: AccountActor; uploadId: string },
    spec: { apply: number; extraReviews?: number; extraRows?: number; commandBytes?: number },
  ) {
    const route = routeOf(person.actor.accountId)!;
    const extraReviews = spec.extraReviews ?? 0;
    const extraRows = spec.extraRows ?? 0;
    const totalReviews = spec.apply + extraReviews;
    const prefix = `cc${randomBytes(3).toString('hex')}`;
    const reviewSql = `('${prefix}-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid`;
    if (totalReviews) {
      await db.admin.query(
        `INSERT INTO library.copy_archive_progress_review
          (route, account_id, upload_id, review_id, source_session_id, source_ordinal, subject_id, binding,
           request_key_hash, input_digest, evidence, evidence_bytes, created_at)
         SELECT $1, $2, $3, ${reviewSql}, $4, 0, $5, '{}'::jsonb, decode(lpad(to_hex(n), 64, '0'), 'hex'),
           decode(lpad(to_hex(n + 100000), 64, '0'), 'hex'), '{}'::jsonb, 2, $6::timestamptz
         FROM generate_series(1, $7::int) AS n`,
        [route, person.actor.accountId, person.uploadId, session.id, subjectId, clock().toISOString(), totalReviews],
      );
    }
    const command = paddedActiveCommand(spec.commandBytes ?? 8000);
    if (spec.apply) {
      await db.admin.query(
        `INSERT INTO library.copy_archive_progress_apply
          (route, account_id, upload_id, review_id, request_key_hash, state, next_step, active_step,
           active_started, active_command, updated_at)
         SELECT $1, $2, $3, ${reviewSql}, decode(lpad(to_hex(n + 200000), 64, '0'), 'hex'),
           'applying', 0, 0, true, $4::jsonb, $5::timestamptz
         FROM generate_series(1, $6::int) AS n`,
        [route, person.actor.accountId, person.uploadId, JSON.stringify(command), clock().toISOString(), spec.apply],
      );
    }
    const existing = await db.admin.query<{ ordinal: number }>(
      `SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM library.copy_archive_row
       WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
      [route, person.actor.accountId, person.uploadId],
    );
    const startOrdinal = Number(existing.rows[0]?.ordinal ?? -1);
    if (extraRows) {
      await db.admin.query(
        `INSERT INTO library.copy_archive_row
          (route, account_id, upload_id, ordinal, section, source_session_id, source_unit_id, evidence)
         SELECT $1, $2, $3, $4 + n, 'holdings', NULL, NULL, '{}'::jsonb
         FROM generate_series(1, $5::int) AS n`,
        [route, person.actor.accountId, person.uploadId, startOrdinal, extraRows],
      );
    }
    const applyRows = spec.apply
      ? await db.admin.query<{ review_id: string }>(
          `SELECT review_id FROM library.copy_archive_progress_apply
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY review_id`,
          [route, person.actor.accountId, person.uploadId],
        )
      : { rows: [] as { review_id: string }[] };
    return {
      applyIds: applyRows.rows.map((row) => row.review_id),
      rowOrdinals: Array.from({ length: extraRows }, (_, index) => startOrdinal + index + 1),
    };
  }

  async function finishRemoval(person: { actor: AccountActor; uploadId?: string }) {
    if (!person.uploadId) return;
    for (let n = 0; n < 64; n++) {
      try {
        const page = await service.remove(person.actor, person.uploadId);
        if (page.complete) {
          person.uploadId = undefined;
          return;
        }
      } catch {
        person.uploadId = undefined;
        return;
      }
    }
    throw new Error('Bounded cleanup did not exhaust the upload');
  }

  async function knownApplyBytes(accountId: string, uploadId: string, reviewIds: readonly string[]) {
    if (!reviewIds.length) return { ids: [] as string[], bytes: 0 };
    const route = routeOf(accountId)!;
    const rows = await db.admin.query<{ review_id: string; bytes: number }>(
      `SELECT review_id, octet_length(active_command::text)::int AS bytes
       FROM library.copy_archive_progress_apply
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id = ANY($4::uuid[])
       ORDER BY review_id`,
      [route, accountId, uploadId, reviewIds],
    );
    return {
      ids: rows.rows.map((row) => row.review_id),
      bytes: rows.rows.reduce((sum, row) => sum + row.bytes, 0),
    };
  }

  async function measure(
    name: string,
    person: GrowthPerson,
    prefix: string,
    operation: (actor: AccountActor, scale: number, repetition: number) => Promise<unknown>,
    hooks?: {
      prepare?: (actor: AccountActor, scale: number, repetition: number) => Promise<void>;
    },
  ) {
    const accountId = person.actor.accountId;
    return checkGrowth(db, {
      name,
      scales: SCALES,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      indexProbes: 2,
      async grow(_database, scale, previous) {
        await growUnrelated(accountId, prefix, previous, scale);
      },
      async prepare(_database, scale, repetition) {
        await renew(person);
        await hooks?.prepare?.(person.actor, scale, repetition);
      },
      async warmup(_database, scale, repetition) {
        await renew(person);
        await hooks?.prepare?.(person.actor, scale, repetition);
        await operation(person.actor, scale, repetition);
      },
      async operation(_database, scale, repetition) {
        return operation(person.actor, scale, repetition);
      },
    });
  }

  return {
    db,
    f,
    service,
    subjectId,
    sessionId: session.id,
    artifact,
    reviewBody,
    applyOwner,
    rejectOwner,
    cleanupOwners,
    goodDigest,
    staleDigest,
    renew,
    uploadFor,
    addReviews,
    growUnrelated,
    seedChildren,
    finishRemoval,
    knownApplyBytes,
    measure,
    setNow(value: number) {
      now = value;
    },
    now() {
      return now;
    },
    async close() {
      await workClient.close();
      await f.close();
      await db.close();
    },
  };
}

export type CopyArchiveProgressGrowthFixture = Awaited<ReturnType<typeof createCopyArchiveProgressGrowthFixture>>;
export { entryKey };
