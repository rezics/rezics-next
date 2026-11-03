import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import canonicalize from 'canonicalize';
import { CatalogueError } from '@rezics/definitions/compile';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { releaseDigest, type Release } from '@rezics/definitions';
import type {
  LibraryProfilesDriver,
  LibraryProfilesFixture,
  LibraryProfilesInspection,
  ProfileMigrationBoundary,
} from '../../../../../specs/library-profiles-driver.ts';
import { createLibraryDriver } from './outcome-driver.ts';
import { compileProfileRelease, profileTypes } from './native-conformance-profiles.ts';
import { addLabel, json, write, unavailable, grantSubjectRead, deleteAccount } from './native-conformance.ts';
import { createLibraryProfileMigrationRuntime } from '../../../src/library/profile-migration-runtime.ts';
import { costOf } from '../../support/growth.ts';
import { idempotencyKeyOf } from '../../../src/http/request.ts';
import {
  createProfileHistoricalNativeFixture,
  createProfileReceiptObservations,
  type StoredProfileReceipt,
} from './profile-historical-native-fixture.ts';

export async function createLibraryProfilesDriver(): Promise<LibraryProfilesDriver> {
  const world = await createLibraryDriver();
  try {
    await world.native.hold();
    const accounts: LibraryProfilesFixture['accounts'] = {
      owner: { accountId: world.accounts.owner.id, signedToken: world.native.token('owner') },
      other: { accountId: world.accounts.other.id, signedToken: world.native.token('other') },
      suspended: { accountId: world.accounts.suspended.id, signedToken: world.native.token('suspended') },
      steward: { accountId: world.native.steward.id, signedToken: world.native.token('steward') },
    };
    const fixture: LibraryProfilesFixture = { accounts, subjects: {}, globalContext: GLOBAL_CONTEXT };
    const assertFixture = (candidate: LibraryProfilesFixture) => {
      if (candidate !== fixture) throw new Error('Library profiles fixture belongs to another native world');
    };
    const runtime = createLibraryProfileMigrationRuntime({
      pool: world.native.pool,
      client: world.native.workClient,
      clock: () => new Date(world.now()),
    });
    const database = world.native.reader;
    const args = [world.accounts.owner.route, world.accounts.owner.id];
    const receipts = createProfileReceiptObservations(world.native.pool);
    const request = world.native.request.bind(world.native);
    world.native.request = async (persona, input) => {
      const response = await request(persona, input);
      const key = new Headers(input.headers).get('idempotency-key');
      if (persona === 'owner' && key !== null) receipts.observe(args[1] as string, idempotencyKeyOf(key), response);
      return response;
    };
    const historical = createProfileHistoricalNativeFixture({
      pool: world.native.pool,
      actor: await world.native.accountActor('owner'),
      clock: () => new Date(world.now()),
      createSubject: async () => (await world.native.subject(profileTypes.game)).id,
      send: (method, path, body, key) =>
        world.native.request('owner', { method, path, body, headers: { 'Idempotency-Key': JSON.stringify(key) } }),
      receipts,
    });
    const driver: LibraryProfilesDriver = {
      async fixture() {
        return fixture;
      },
      async compile(scenario) {
        try {
          const release = await compileProfileRelease(scenario);
          return { valid: true, digest: releaseDigest(release), release: { ...release } };
        } catch (error) {
          // Preserve real compiler diagnostics. Unexpected errors remain errors, never invalid-profile passes.
          if (!(error instanceof CatalogueError)) throw error;
          const errors = error.violations.map(({ pointer, code }) => ({ pointer, code }));
          return { valid: false, errors };
        }
      },
      async provisionSubject(f, vertical) {
        assertFixture(f);
        const subject = await world.native.subject(profileTypes[vertical]);
        fixture.subjects[vertical] = subject.id;
        return subject.id;
      },
      async readAcceptingType(f, id) {
        assertFixture(f);
        return (
          await json<{ subject: { type: string } }>(
            await world.native.request('owner', { method: 'GET', path: `/v1/subjects/${id}` }),
          )
        ).subject.type;
      },
      addLabel(f, subjectId, name) {
        assertFixture(f);
        return addLabel(world, subjectId, name);
      },
      async rateSubject(f, subjectId, value) {
        assertFixture(f);
        return write(world, 'owner', 'PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
          units: value,
        });
      },
      request(f, persona, method, path, body, headers) {
        assertFixture(f);
        return world.native.request(persona, { method, path, body, ...(headers ? { headers } : {}) });
      },
      async seedLegacyFacts(f, rows) {
        assertFixture(f);
        await historical.seed(rows);
      },
      async ensureUnrelatedFacts(f, totalCount) {
        assertFixture(f);
        const { rows } = await database.query<{ count: string }>(
          'SELECT count(*)::text FROM library.entry WHERE route=$1 AND account_id=$2',
          [world.accounts.other.route, world.accounts.other.id],
        );
        for (let n = Number(rows[0]!.count); n < totalCount; n++) {
          const subject = await world.native.subject(profileTypes.game);
          await json(await write(world, 'other', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: 'planned' }), 201);
        }
      },
      async migrateOwner(f, digest) {
        assertFixture(f);
        let state = await runtime.start({ accountId: world.accounts.owner.id, releaseDigest: digest });
        while (state.phase !== 'ready') state = await runtime.resume({ accountId: world.accounts.owner.id });
      },
      async pauseNextMigration(f, boundary: ProfileMigrationBoundary) {
        assertFixture(f);
        return unavailable(`native migration ${boundary} persistence latch`);
      },
      async crashNextMigration(f, boundary) {
        assertFixture(f);
        return unavailable(`native migration ${boundary} executor crash binding`);
      },
      async recoverMigration(f) {
        assertFixture(f);
        await world.settle();
      },
      async revoke(f, persona, action, resourceId) {
        assertFixture(f);
        const { routeOf } = await import('../../../src/route/route.ts');
        await json(
          await write(world, 'steward', 'POST', '/v1/grants:revoke', {
            resource: { route: routeOf(resourceId), id: resourceId },
            subject: { kind: 'account', id: fixture.accounts[persona].accountId },
            actions: [action],
            valid: '(,)',
          }),
        );
      },
      async revokeSubjectRead(f, id) {
        assertFixture(f);
        await grantSubjectRead(world, id, 'owner', false);
      },
      async deleteOwner(f) {
        assertFixture(f);
        const response = await deleteAccount(world);
        await json(response);
      },
      async inspectRelease(f, digest) {
        assertFixture(f);
        const { release } = await json<{ release: Release }>(
          await world.native.request('anonymous', { method: 'GET', path: `/v1/definitions/releases/${digest}` }),
        );
        return {
          canonicalBytes: Buffer.byteLength(canonicalize(release)!),
          typeCount: Object.keys(release.types).length,
          propertyCount: Object.keys(release.properties).length,
          profileRegistryBytes: Buffer.byteLength(canonicalize(release.libraryProfiles ?? {})!),
        };
      },
      async inspect(f): Promise<LibraryProfilesInspection> {
        assertFixture(f);
        const entries = (
          await database.query<LibraryProfilesInspection['entries'][number]>(
            `SELECT account_id AS "accountId", subject_id AS "subjectId",
          incarnation_id AS "incarnationId", state,revision, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
          to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt", activity_at::text AS "activityAt", finished_at::text AS "finishedAt",
          transaction_id AS "transactionId", library_profile_pin AS pin FROM library.entry WHERE route=$1 AND account_id=$2 ORDER BY subject_id`,
            args,
          )
        ).rows;
        const sessions = (
          await database.query<LibraryProfilesInspection['sessions'][number]>(
            `SELECT account_id AS "accountId", session_id AS id,subject_id AS "subjectId",
          version_subject_id AS "versionSubjectId",mode,unit,total::text,amount::text,locator,position::text,completed_unit_count AS "completedUnitCount",state,revision,
          started_at::text AS "startedAt",completed_at::text AS "completedAt",last_changed_at::text AS "lastChangedAt",transaction_id AS "transactionId", library_profile_pin AS pin
          FROM library.progress_session WHERE route=$1 AND account_id=$2 ORDER BY session_id`,
            args,
          )
        ).rows;
        const copies = (
          await database.query<LibraryProfilesInspection['copies'][number]>(
            `SELECT account_id AS "accountId",copy_id AS id,subject_id AS "subjectId",kind,status,
          location,source,acquired_on::text AS "acquiredOn",disposed_on::text AS "disposedOn",note,revision,created_at::text AS "createdAt",updated_at::text AS "updatedAt",
          transaction_id AS "transactionId",library_profile_pin AS pin FROM library.copy WHERE route=$1 AND account_id=$2 ORDER BY copy_id`,
            args,
          )
        ).rows;
        const completedUnits = (
          await database.query<LibraryProfilesInspection['completedUnits'][number]>(
            `SELECT u.session_id AS "sessionId",u.unit_id AS "unitId"
          FROM library.progress_unit u WHERE route=$1 AND session_id=ANY($2::uuid[]) ORDER BY session_id,unit_id`,
            [args[0], sessions.map((row) => row.id)],
          )
        ).rows;
        const changes = (
          await database.query<LibraryProfilesInspection['changes'][number]>(
            `SELECT session_id AS "sessionId",change_no AS "changeNo",intent,
          recorded_at::text AS "recordedAt",transaction_id AS "transactionId" FROM library.progress_change WHERE route=$1 AND session_id=ANY($2::uuid[]) ORDER BY session_id,change_no`,
            [args[0], sessions.map((row) => row.id)],
          )
        ).rows;
        const independentLabels = (
          await database.query(
            'SELECT * FROM library.label_assignment WHERE route=$1 AND account_id=$2 ORDER BY subject_id,label_id',
            args,
          )
        ).rows;
        const storedReceipts = (
          await database.query<StoredProfileReceipt>(
            `SELECT principal_id AS "accountId",command_kind AS "commandKind",idempotency_key AS "storageKey",encode(request_digest,'hex') AS digest,
          response FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 ORDER BY command_kind,idempotency_key`,
            [world.accounts.owner.partition, args[1]],
          )
        ).rows;
        const events = (
          await database.query<LibraryProfilesInspection['events'][number]>(
            'SELECT type,subject,data FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq',
            [world.accounts.owner.partition, args[1]],
          )
        ).rows;
        const checkpoints = (
          await database.query(
            'SELECT profile_migration_phase,profile_migration_digest,profile_migration_after FROM library.fact_source_head WHERE route=$1 AND account_id=$2',
            args,
          )
        ).rows;
        const jobs = (await world.native.workClient.listWorkflows({ limit: 10000 })).filter(
          (row) => row.workflowName === 'library.profileMigration',
        );
        return {
          entries,
          sessions,
          copies,
          completedUnits,
          changes,
          independentLabels,
          receipts: storedReceipts.map((row) => receipts.bind(row)),
          events,
          ratings: (
            await database.query(
              'SELECT * FROM rating.vote WHERE route=$1 AND voter_id=$2 ORDER BY question_id,target_id',
              args,
            )
          ).rows,
          migration: {
            jobs,
            checkpoints,
            pages: unavailable('native migration page transaction and EXPLAIN observations'),
          },
          importRuns: unavailable('exact native profile-fixture import-run inspection'),
        };
      },
      async measure(operation) {
        const measured = await world.native.capture(operation);
        const cost = costOf(measured.capture);
        if (cost.requestBytes === undefined || cost.responseBytes === undefined)
          return unavailable('native SQL wire bytes');
        return {
          value: measured.value,
          sql: {
            statements: cost.statements,
            rowsRead: cost.rows,
            rowsWritten: unavailable('native per-statement affected-row attribution'),
            bytesRead: cost.responseBytes,
            bytesWritten: cost.requestBytes,
          },
        };
      },
      close: world.close,
    };
    return driver;
  } catch (error) {
    await world.close();
    throw error;
  }
}
