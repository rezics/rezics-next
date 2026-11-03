import { createHash } from 'node:crypto';
import type {
  LibraryLabelsDriver,
  LabelAction,
  LibraryLabelsPersona,
  LibraryLabelsInspection,
} from '../../../../../specs/library-labels-driver.ts';
import { createLibraryDriver } from './outcome-driver.ts';
import { inspectNativeLabelCollections } from './native-labels-inspection.ts';
import { costOf } from '../../support/growth.ts';
import { compileProfileRelease, profileTypes } from './native-conformance-profiles.ts';
import { json, write, setEntry, publish, requestKey, unavailable, deleteAccount } from './native-conformance.ts';
import { purgeLabelRetentionPage } from '../../../src/library/label-retention.ts';
import { provisionOwnerUnreadableSubject } from './native-private-subject.ts';

/** Transport mapping only: expectedRevision is the fixture interface's name for the public revision field. */
function encode(action: LabelAction, input: Record<string, unknown>) {
  const { labelId, expectedRevision, ...rest } = input;
  const query = (values: Record<string, unknown>) => {
    const result = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) result.set(key, String(value));
    return result.toString();
  };
  switch (action) {
    case 'library_label.create':
      return { method: 'POST' as const, path: '/v1/libraryLabels', body: input };
    case 'library_label.rename':
      return {
        method: 'PATCH' as const,
        path: `/v1/libraryLabels/${labelId}`,
        body: { ...rest, revision: expectedRevision },
      };
    case 'library_label.delete':
      return {
        method: 'DELETE' as const,
        path: `/v1/libraryLabels/${labelId}?${query({ ...rest, revision: expectedRevision })}`,
      };
    case 'library_label.assign':
      return { method: 'POST' as const, path: `/v1/libraryLabels/${labelId}:assign`, body: rest };
    case 'library_label.unassign':
      return {
        method: 'POST' as const,
        path: `/v1/libraryLabels/${labelId}:unassign`,
        body: { ...rest, revision: expectedRevision },
      };
    case 'library_label.list':
      return { method: 'GET' as const, path: `/v1/libraryLabels?${query(input)}` };
    case 'library_label.assignment_list':
      return { method: 'GET' as const, path: `/v1/libraryLabelAssignments?${query(input)}` };
  }
}
export async function createLibraryLabelsDriver(): Promise<LibraryLabelsDriver> {
  const world = await createLibraryDriver();
  try {
    const request = world.native.request;
    const invoke: LibraryLabelsDriver['invoke'] = (as, action, input, key) =>
      request(as, { ...encode(action, input), headers: key === undefined ? {} : { 'Idempotency-Key': `"${key}"` } });
    const read = (as: LibraryLabelsPersona, path: string) => request(as, { method: 'GET', path });
    const mutate = (
      as: LibraryLabelsPersona,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ) => write(world, as, method, path, body);
    const collection = async (as: LibraryLabelsPersona, id: string) =>
      (await json<{ collection: { revision: number } }>(await read(as, `/v1/collections/${id}`))).collection;
    let unrelatedLabels = 0,
      unrelatedAssignments = 0;
    let unprofiledInstalled = false;
    const subjects = new Set<string>();
    async function inspect(input: Parameters<LibraryLabelsDriver['inspect']>[0]): Promise<LibraryLabelsInspection> {
      const account =
        input.owner === 'other'
          ? world.accounts.other
          : input.owner === 'suspended'
            ? world.accounts.suspended
            : world.accounts.owner;
      const args = [account.route, account.id];
      const database = world.native.reader;
      const labels = (
        await database.query<LibraryLabelsInspection['labels'][number]>(
          `SELECT account_id AS "ownerAccountId", route AS "ownerRoute", label_id AS "labelId", normalized_name AS "normalizedName",
        revision, revision AS generation, deleted_at::text AS "deletedAt" FROM library.personal_label
        WHERE route=$1 AND account_id=$2 AND ($3::uuid[] IS NULL OR label_id=ANY($3)) ORDER BY label_id`,
          [...args, input.labelIds ?? null],
        )
      ).rows;
      const retainedAssignments = (
        await database.query<LibraryLabelsInspection['retainedAssignments'][number]>(
          `SELECT account_id AS "ownerAccountId", route AS "ownerRoute", subject_id AS "subjectId", label_id AS "labelId",
        assignment_id AS "assignmentId", revision, slot_no AS "slotNo", deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
        FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND ($3::uuid[] IS NULL OR subject_id=ANY($3))
        AND ($4::uuid[] IS NULL OR label_id=ANY($4)) ORDER BY subject_id,label_id`,
          [...args, input.subjectIds ?? null, input.labelIds ?? null],
        )
      ).rows;
      const native = await world.inspect();
      const head = (
        await database.query<{ epoch: number; position: string }>(
          'SELECT epoch, position::text FROM core.partition WHERE partition_no=$1',
          [account.partition],
        )
      ).rows[0];
      if (!head) throw new Error('Native owner command head is absent');
      const fence = (
        await database.query<{ generation: string }>(
          'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2',
          args,
        )
      ).rows[0];
      const writeBasis = (
        await database.query(
          'SELECT * FROM editorial.write_basis WHERE partition_no=$1 AND principal_id=$2 ORDER BY epoch,position',
          [account.partition, account.id],
        )
      ).rows;
      const receipts = (
        await database.query<LibraryLabelsInspection['receipts'][number]>(
          `SELECT principal_id AS "ownerAccountId", command_kind AS action,
        encode(request_digest,'hex') AS "keyDigest", response::text AS "resultDigest"
        FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 ORDER BY command_kind,idempotency_key`,
          [account.partition, account.id],
        )
      ).rows;
      // These are observations of the owning facts, not a second effective-label/membership evaluator.
      const subjectFacts = (
        await database.query<LibraryLabelsInspection['subjectFacts'][number]>(
          `
        SELECT account_id AS "ownerAccountId",route AS "ownerRoute",subject_id AS "subjectId",'state'::text AS kind,
          subject_id AS "sourceId",true AS active FROM library.entry WHERE route=$1 AND account_id=$2 AND ($3::uuid[] IS NULL OR subject_id=ANY($3))
        UNION ALL SELECT a.account_id,a.route,a.subject_id,'label',a.assignment_id,a.deleted_at IS NULL AND p.deleted_at IS NULL AND p.label_id IS NOT NULL
          FROM library.label_assignment a LEFT JOIN library.personal_label p ON p.route=a.route AND p.account_id=a.account_id AND p.label_id=a.label_id
          WHERE a.route=$1 AND a.account_id=$2 AND a.slot_no IS NOT NULL AND ($3::uuid[] IS NULL OR a.subject_id=ANY($3))
        UNION ALL SELECT account_id,route,subject_id,'session',session_id,true FROM library.progress_session
          WHERE route=$1 AND account_id=$2 AND ($3::uuid[] IS NULL OR subject_id=ANY($3))
        UNION ALL SELECT account_id,route,subject_id,'holding',copy_id,deletion_id IS NULL FROM library.copy
          WHERE route=$1 AND account_id=$2 AND ($3::uuid[] IS NULL OR subject_id=ANY($3))
        ORDER BY "subjectId",kind,"sourceId"`,
          [...args, input.subjectIds ?? null],
        )
      ).rows;
      const collectionObservations = await inspectNativeLabelCollections(world, account, input.collectionIds ?? []);
      // Unknown inspection tables must fail at SQL instead of supplying a successful empty privacy proof.
      const publicSubjectRows = (
        await database.query<LibraryLabelsInspection['publicSubjectRows'][number]>(
          `SELECT subject_id AS "subjectId",
        'library.subject_collection' AS "table", collection_id AS "collectionId", multiplicity, NULL::text AS "eventType"
        FROM library.subject_collection WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id,collection_id`,
          [input.subjectIds ?? [...subjects]],
        )
      ).rows;
      return {
        commandHead: head,
        writeBasis,
        ownerFactFence: fence?.generation ?? null,
        labels,
        retainedAssignments,
        assignments: retainedAssignments.filter((row) => row.deletedAt === null),
        subjectFacts,
        entries: native.entries
          .filter(
            (row) => row.accountId === account.id && (!input.subjectIds || input.subjectIds.includes(row.subjectId)),
          )
          .map((row) => ({
            ownerAccountId: row.accountId,
            subjectId: row.subjectId,
            state: row.state,
            revision: row.revision,
          })),
        sessions: native.sessions
          .filter((row) => row.accountId === account.id)
          .map((row) => ({
            ownerAccountId: row.accountId,
            subjectId: row.subjectId,
            sessionId: row.id,
            state: row.state,
          })),
        holdings: native.copies
          .filter((row) => row.accountId === account.id)
          .map((row) => ({
            ownerAccountId: row.accountId,
            subjectId: row.subjectId,
            holdingId: row.id,
            status: row.status,
          })),
        follows: native.follows
          .filter((row) => row.accountId === account.id)
          .map((row) => ({
            ownerAccountId: row.accountId,
            targetId: row.targetId,
            targetType: row.targetType,
            state: row.state,
          })),
        receipts: receipts.map((row) => ({
          ...row,
          resultDigest: createHash('sha256').update(row.resultDigest).digest('hex'),
        })),
        privateOutbox: (
          await database.query<LibraryLabelsInspection['privateOutbox'][number]>(
            'SELECT type,subject,data FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq',
            [account.partition, account.id],
          )
        ).rows,
        cleanup: unavailable(
          'services/kernel/src/library/label-retention.ts purgeLabelRetentionPage exposes page counts and a cursor, but no per-label cleanup run identity or committed-page snapshot',
        ),
        ...collectionObservations,
        publicSubjectRows,
      };
    }
    const driver: LibraryLabelsDriver = {
      accounts: { ...world.accounts, unscoped: world.accounts.owner },
      unknown: { labelId: world.unknown.copyId, subjectId: world.unknown.subjectId },
      async provisionSubject(options = {}) {
        if (options.unprofiled && !unprofiledInstalled) {
          await publish(world, await compileProfileRelease());
          unprofiledInstalled = true;
        }
        const type = options.unprofiled ? profileTypes.people : profileTypes.book;
        const subject =
          options.ownerReadable === false
            ? await provisionOwnerUnreadableSubject(world, type)
            : await world.native.subject(type);
        subjects.add(subject.id);
        return subject;
      },
      invoke,
      async invokeRaw(as, action, rawJson, key) {
        // The raw parser receives the original bytes, including duplicate keys. Never JSON.parse/re-encode them.
        if (action !== 'library_label.create') return unavailable(`raw ${action} has no resource locator argument`);
        return world.native.rawRequest(
          as,
          'POST',
          '/v1/libraryLabels',
          rawJson,
          key === undefined ? {} : { 'Idempotency-Key': `"${key}"` },
        );
      },
      request,
      setState: (as, id, state) => setEntry(world, as, id, state),
      createProgressSession: (as, subjectId) =>
        mutate(as, 'POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'page' }),
      createHolding: (as, subjectId) =>
        mutate(as, 'POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }),
      followSubject: (as, targetId) => mutate(as, 'PUT', `/v1/follows/${targetId}`, { targetType: 'subject' }),
      readPersonalSubject: (as, subjectId) => read(as, `/v1/subjects/${subjectId}`),
      async createCollection(as, visibility) {
        const result = await json<{ collection: { id: string } }>(
          await mutate(as, 'POST', '/v1/collections', { title: 'Native label Collection', visibility }),
          201,
        );
        return result.collection;
      },
      async appendCollectionMember(as, id, subjectId) {
        await json(await mutate(as, 'POST', `/v1/collections/${id}/members`, { subjectId }), 201);
      },
      async setCollectionVisibility(as, id, visibility) {
        const current = await collection(as, id);
        await json(await mutate(as, 'PATCH', `/v1/collections/${id}`, { revision: current.revision, visibility }));
      },
      readPublicCollection: (id) => read('anonymous', `/v1/collections/${id}`),
      inspect,
      async publicExposure(subjectId) {
        const publicResponses = [];
        for (const path of [`/v1/subjects/${subjectId}`, `/v1/subjects/${subjectId}/collections`]) {
          const response = await read('anonymous', path);
          publicResponses.push({ status: response.status, body: await response.json() });
        }
        const publicRows = (
          await world.native.reader.query(
            'SELECT * FROM library.subject_collection WHERE subject_id=$1 ORDER BY collection_id',
            [subjectId],
          )
        ).rows;
        return { publicResponses, publicRows };
      },
      async growUnrelated(input) {
        while (unrelatedLabels < input.labels) {
          await json(
            await invoke(
              'other',
              'library_label.create',
              { name: `unrelated ${unrelatedLabels++}` },
              requestKey().slice(1, -1),
            ),
            201,
          );
        }
        while (unrelatedAssignments < input.assignments) {
          const subject = await world.native.subject(profileTypes.book);
          const { label } = await json<{ label: { id: string } }>(
            await invoke(
              'other',
              'library_label.create',
              { name: `assignment ${unrelatedAssignments++}` },
              requestKey().slice(1, -1),
            ),
            201,
          );
          await json(
            await invoke(
              'other',
              'library_label.assign',
              { subjectId: subject.id, labelId: label.id },
              requestKey().slice(1, -1),
            ),
          );
        }
      },
      async measure(operation) {
        const measured = await world.native.capture(operation);
        const cost = costOf(measured.capture);
        return {
          value: measured.value,
          statements: cost.statements,
          rowsRead: cost.rows,
          buffers: cost.blocks,
          rowsWritten: unavailable('native per-statement affected-row attribution'),
        };
      },
      async measurePage(operation) {
        await world.native.capture(operation);
        return unavailable('native request page peak-memory and candidate observations');
      },
      async traceCommand(operation) {
        await operation();
        return unavailable('native Access-return and receipt-read trace binding');
      },
      async measureLabelSource(operation) {
        await world.native.capture(operation);
        return unavailable('native reservation keys/parent points and wire-byte observations');
      },
      async growInactiveHistory(subjectId, totalCount) {
        const rows = await world.native.reader.query<{ count: string }>(
          'SELECT count(*)::text FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [world.accounts.owner.route, world.accounts.owner.id, subjectId],
        );
        for (let n = Number(rows.rows[0]!.count); n < totalCount; n++) {
          const { label } = await json<{ label: { id: string; revision: number } }>(
            await invoke(
              'owner',
              'library_label.create',
              { name: `history ${subjectId} ${n}` },
              requestKey().slice(1, -1),
            ),
            201,
          );
          await json(
            await invoke('owner', 'library_label.assign', { labelId: label.id, subjectId }, requestKey().slice(1, -1)),
          );
          await json(
            await invoke(
              'owner',
              'library_label.delete',
              { labelId: label.id, expectedRevision: label.revision },
              requestKey().slice(1, -1),
            ),
          );
        }
      },
      now: world.now,
      setTime: world.setTime,
      restoreLabel: (as, id, revision, key) =>
        write(world, as, 'POST', `/v1/libraryLabels/${id}:restore`, { revision }, `"${key}"`),
      restoreAssignment: (as, { labelId, expectedRevision, ...rest }, key) =>
        write(
          world,
          as,
          'POST',
          `/v1/libraryLabels/${labelId}:restoreAssignment`,
          { ...rest, revision: expectedRevision },
          `"${key}"`,
        ),
      async holdNextAssignmentPurge() {
        return unavailable('native durable assignment-purge capture latch');
      },
      holdCleanup: world.native.hold,
      async startLabelCleanup() {
        return unavailable('native per-label durable cleanup run identity; retention pages do not return a run ID');
      },
      async runCleanupPage() {
        await purgeLabelRetentionPage(
          { pool: world.native.pool, clock: () => new Date(world.now()) },
          { partition: world.accounts.owner.partition, limit: 100, after: null },
        );
      },
      async pauseAfterCleanupCommit() {
        return unavailable('native retention post-commit/pre-ack worker latch');
      },
      async crashCleanupWorker() {
        return unavailable('native per-retention-run worker restart boundary');
      },
      async resumeCleanup() {
        await driver.runCleanupPage('');
      },
      deleteAccount: (as) => deleteAccount(world, as),
      settle: world.settle,
      close: world.close,
    };
    return driver;
  } catch (error) {
    await world.close();
    throw error;
  }
}
