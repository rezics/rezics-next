import { expect } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  libraryProfile,
  unitData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';
import { admittedAccess, authenticateAccount } from '../../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthReport } from '../../support/growth.ts';
import { configureTestReceiptKeys } from '../../support/receipt-keys.ts';
import { ACCOUNT_ROLE_BITS } from '../../../src/history/contracts.ts';
import { bindCommandHistoryEvidence } from '../../../src/history/record.ts';
import { createCopyArchive } from '../../../src/library/copy-archive.ts';
import { exportSectionsV2, LIBRARY_EXPORT_FORMAT } from '../../../src/library/library-export-format.ts';
import { createSessionCommands } from '../../../src/library/sessions.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import type { Access, AccountActor, ActionCatalogue, ActionMetadata } from '../../../src/request/access.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { activateRelease, activeRelease, bootstrapRelease, publishRelease } from '../../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../../src/semantic/subject.ts';
import { testRouteKey, testTokens } from '../../support/test-kernel.ts';
import { createWorkClient } from '../../../src/work/client.ts';

export const SCALES = [64, 512, 4096] as const;
export const COMMAND_JSON_CAP = 8 * 1024;
export const CLEANUP_CHILD_BUDGET = 100;
export const entryKey = () => randomUUID();
const additionalUnits = ['volume', 'page', 'minute', 'episode', 'percent', 'plot-key.v2', 'edition.v1'] as const;
const clientId = 'archive-progress-growth';
const own: ActionMetadata = { anonymous: false, authority: 'own-account' };
const actions: ActionCatalogue = new Map<string, ActionMetadata>([
  ['subject:read', { anonymous: true }],
  ['copy:list', own],
  ['progress_session:list', own],
  ['progress_session:read', own],
  ['progress_session:create', own],
  ['progress_session:update', own],
]);
const scopes = [...actions.keys()];
const v2Omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers:
    'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport:
    'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported',
} as const;

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

function stamp(value: string) {
  return new Date(Date.parse(value)).toISOString();
}

function v2Artifact(exportId: string, capturedAt: string, session: Record<string, unknown>) {
  const record = {
    section: 'sessions',
    session_id: session.session_id,
    subject_id: session.subject_id,
    subject_id_reference: {
      id: session.subject_id,
      href: `https://rezics.com/subjects/${session.subject_id}`,
    },
    version_subject_id: session.version_subject_id,
    mode: session.mode,
    unit: session.unit,
    total: session.total,
    amount: session.amount,
    additional_measures: session.additional_measures,
    locator: session.locator,
    position: session.position,
    completed_unit_count: session.completed_unit_count,
    state: session.state,
    revision: session.revision,
    library_profile_pin: session.library_profile_pin,
    started_at: stamp(String(session.started_at)),
    completed_at: session.completed_at === null ? null : stamp(String(session.completed_at)),
    last_changed_at: stamp(String(session.last_changed_at)),
  };
  const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
  const sectionTotals = Object.fromEntries(
    exportSectionsV2.map((section) => [
      section,
      section === 'sessions' ? { rows: 1, recordBytes: size } : { rows: 0, recordBytes: 0 },
    ]),
  );
  const expiresAt = new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString();
  return {
    manifest: {
      format: LIBRARY_EXPORT_FORMAT,
      version: 2 as const,
      coverage: 'private-library-owner-facts-v2' as const,
      exportId,
      capturedAt,
      expiresAt,
      privacy: 'private' as const,
      completeness: 'supported-native-facts' as const,
      sections: [...exportSectionsV2],
      omissions: { ...v2Omissions },
      fullExport: false as const,
      rows: 1,
      recordBytes: size,
      sectionTotals,
    },
    records: [record],
  };
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
        'library.copy_archive_row',
        'library.copy_archive_progress_review',
        'library.copy_archive_progress_apply',
      ])
        expect(cost.relations?.[relation]?.sequentialScans ?? 0, `${relation} at scale ${sample.scale}`).toBe(0);
}

export async function createCopyArchiveProgressGrowthFixture() {
  const db = await openGrowthDatabase();
  configureTestReceiptKeys(db.pool);
  let now = Date.now();
  const clock = () => new Date(now);
  const routeKey = testRouteKey();
  const tokens = testTokens();
  const goodRelease = await archiveRelease(false);
  const staleRelease = await archiveRelease(true);
  const goodDigest = await bootstrapRelease(db.pool, goodRelease, clock);
  let head = (await activeRelease(db.pool))!.head;
  const access: Access = admittedAccess({ actions, clock });
  const workClient = await createWorkClient(db.url, db.pool);
  const sessions = createSessionCommands({ pool: db.pool, access, tokens, clock });
  const service = createCopyArchive({
    pool: db.pool,
    access,
    workClient,
    tokens,
    routeKey,
    clock,
  });
  const editorial = {
    kind: 'account' as const,
    accountId: newId(0),
    clientId,
    scopes: ['definitions:publish', 'definitions:activate'],
    requestedBy: null,
    authnEpoch: 1,
  };
  await db.admin.query(
    `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES (0, $1, 'actor', 'active', $2, false, 1)`,
    [editorial.accountId, newId(0)],
  );
  const published = await publishRelease(db.pool, {
    actor: editorial,
    idempotencyKey: entryKey(),
    digest: createHash('sha256').update('archive-progress-stale').digest(),
    authorize: async () => true,
    release: staleRelease,
    clock,
  });
  const staleDigest = published.digest;
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    await db.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       SELECT $1, tstzrange('2020-01-01', NULL, '[)'), $2
       WHERE NOT EXISTS (SELECT 1 FROM access.exposure_opening WHERE "group"=$1 AND upper_inf(valid))`,
      [group, newId(0)],
    );

  async function identity(): Promise<GrowthPerson> {
    const route = 0x3a20;
    const accountId = newId(route);
    await db.admin.query(
      `INSERT INTO access.account
        (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, accountId, newId(route)],
    );
    const claims = { accountId, clientId, scopes, authnEpoch: 1, requestedBy: null };
    const actor = await authenticateAccount(access, { pool: db.pool, deadline: deadlineFor(300_000) }, claims);
    return { actor, bearer: actor.accountId, reviews: [] };
  }

  const applyOwner = await identity();
  const rejectOwner = await identity();
  const cleanupOwners = {
    applications: await identity(),
    crossing: await identity(),
    finalPage: await identity(),
    continuation: await identity(),
  };
  const requestKey = entryKey();
  const target = subjectTarget(routeKey, applyOwner.actor.accountId, requestKey);
  const created = await createSubject(db.pool, {
    actor: applyOwner.actor,
    target,
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'ex:Parent', labels: { en: 'Archive progress growth subject' } },
    release: { digest: goodDigest, release: goodRelease },
    authorization: {
      action: 'subject:create',
      resource: target,
      denied: () => new Error('subject create denied'),
      async authorize(tx) {
        const accountRoute = routeOf(applyOwner.actor.accountId);
        if (accountRoute === null) throw new Error('subject create owner is missing a route');
        bindCommandHistoryEvidence(tx, [
          {
            accountRoute,
            accountId: applyOwner.actor.accountId,
            roles: ACCOUNT_ROLE_BITS.principal | ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS['acting-human'],
          },
        ]);
        return 'execute';
      },
    },
    clock,
  });
  const subjectId = created.subject.id;
  const started = await sessions.startSession(
    applyOwner.actor,
    {
      subjectId,
      mode: 'scalar_amount',
      unit: 'chapter',
      total: '999999999999.999999',
      additionalMeasures: additionalUnits.map((unit) => ({ unit, total: '5.000001' })),
    },
    entryKey(),
  );
  const sessionId = started.value.id;
  let revision = started.value.revision;
  await sessions.recordProgress(applyOwner.actor, sessionId, { revision, amount: '0' }, entryKey());
  revision += 1;
  for (const unit of additionalUnits) {
    await sessions.recordProgress(
      applyOwner.actor,
      sessionId,
      { revision, measureId: unit, amount: '4.125000' },
      entryKey(),
    );
    revision += 1;
  }
  await sessions.completeSession(applyOwner.actor, sessionId, { revision }, entryKey());
  const stored = await db.admin.query<Record<string, unknown>>(
    `SELECT session_id, subject_id, version_subject_id, mode, unit, total::text AS total, amount::text AS amount,
            additional_measures, locator, position::text AS position, completed_unit_count, state, revision,
            library_profile_pin, started_at::text AS started_at, completed_at::text AS completed_at,
            last_changed_at::text AS last_changed_at
     FROM library.progress_session WHERE session_id=$1`,
    [sessionId],
  );
  const sourcePin = stored.rows[0]!.library_profile_pin;
  if (sourcePin == null) throw new Error('Native source Session omitted library_profile_pin');
  const artifact = v2Artifact(newId(routeOf(applyOwner.actor.accountId)!), clock().toISOString(), stored.rows[0]!);
  const artifactBytes = new TextEncoder().encode(JSON.stringify(artifact));
  const reviewBody = {
    sessionId,
    subjectId,
    mode: 'scalar_amount' as const,
    unit: 'chapter',
    additionalMeasures: additionalUnits.map((unit) => ({ sourceUnit: unit, unit })),
    unitIds: [] as string[],
  };

  async function activate(digest: string) {
    const activated = await activateRelease(db.pool, {
      actor: editorial,
      idempotencyKey: entryKey(),
      digest: createHash('sha256').update(`activate:${digest}:${head}`).digest(),
      authorize: async () => true,
      releaseDigest: digest,
      expectedHead: head,
      clock,
    });
    head = activated.head;
    return activated;
  }

  async function renew(person: GrowthPerson) {
    person.actor = await authenticateAccount(access, { pool: db.pool, deadline: deadlineFor(300_000) }, person.actor);
    return person.actor;
  }

  async function uploadFor(person: GrowthPerson) {
    const uploaded = await service.upload(person.actor, artifactBytes, entryKey());
    person.uploadId = uploaded.value.uploadId;
    return uploaded.value.uploadId;
  }

  async function addReviews(person: GrowthPerson, count: number) {
    if (!person.uploadId) throw new Error('Reviews need an upload');
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const review = await service.reviewProgress(person.actor, person.uploadId, entryKey(), reviewBody);
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
         "position", completed_unit_count, state, revision, library_profile_pin, started_at, completed_at,
         transaction_id)
       SELECT $1, ${sessionSql}, $4, $5, NULL, 'scalar_amount', 'page', NULL, NULL, NULL, NULL,
         0, 'active', 1, $7::jsonb, $6::timestamptz, NULL, ${txSql}
       FROM generate_series($2::int, $3::int) AS n`,
      [route, from, scale, accountId, subjectId, clock().toISOString(), sourcePin],
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
        [route, person.actor.accountId, person.uploadId, sessionId, subjectId, clock().toISOString(), totalReviews],
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

  async function finishRemoval(person: GrowthPerson) {
    if (!person.uploadId) return;
    for (let n = 0; n < 64; n++) {
      try {
        const page = await service.remove(person.actor, person.uploadId);
        if (page.complete) {
          delete person.uploadId;
          return;
        }
      } catch {
        delete person.uploadId;
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
    service,
    subjectId,
    sessionId,
    artifact,
    reviewBody,
    applyOwner,
    rejectOwner,
    cleanupOwners,
    goodDigest,
    staleDigest,
    activate,
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
      await db.close();
    },
  };
}

export type CopyArchiveProgressGrowthFixture = Awaited<ReturnType<typeof createCopyArchiveProgressGrowthFixture>>;
