/** Pure progress-operation bound arithmetic. SQL texts arrive as catalog values; this module imports none of them. */

import { BOUND_AXES, declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import {
  SESSION_LIMITS,
  type ProgressOperationCatalog,
  type ProgressSqlDescriptor,
  type ProgressShelfStatement,
  type SessionCommandOriginal,
  type SessionOperationKind,
  type SessionReadInput,
  type SessionReadKind,
  type SessionWork,
} from '../contract/index.ts';
import { partitionOf, routeOf } from './route.ts';

export { SESSION_LIMITS } from '../contract/index.ts';

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;
const size = (value: unknown) => utf8(JSON.stringify(value));

const uuid = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
const timestamp = '\0'.repeat(64);
const numeric = '9'.repeat(131_072 + 16_383 + 2);
const text = (characters: number) => '\0'.repeat(characters);
const pin = { provenance: 'profile', releaseDigest: `sha256:${'f'.repeat(64)}`, acceptingType: '', profileId: '' };
const measure = { unit: text(128), amount: numeric, total: numeric };
const session = {
  route: 65535,
  id: uuid,
  accountId: uuid,
  subjectId: uuid,
  versionSubjectId: uuid,
  mode: 'completed_units',
  unit: text(128),
  total: numeric,
  amount: numeric,
  locator: text(256),
  position: numeric,
  completedUnitCount: 20_000,
  state: 'completed',
  revision: 2_147_483_647,
  startedAt: timestamp,
  completedAt: timestamp,
  transactionId: uuid,
  additionalMeasures: [],
};
const sessionBytes = size(session) + 6 * 4096;
const responseSessionBytes = sessionBytes + size({ measures: [measure] });
const journalBytes = size({
  sessionId: uuid,
  accountId: uuid,
  revision: 2_147_483_646,
  startYear: 9999,
  startMonth: 12,
  startDay: 31,
  finishYear: 9999,
  finishMonth: 12,
  finishDay: 31,
  reflection: text(2000),
  assessmentPresence: 'explicit_null',
  assessmentUnits: 20,
  assessmentMeaningRevision: 1,
});
const unitBytes = size({ route: 65535, sessionId: uuid, unitId: text(128), addedAt: timestamp });
const intentBytes = size({ add: [], remove: [] }) + 100 * (size(text(128)) + 1) + size(measure);
const changeBytes =
  size({
    route: 65535,
    sessionId: uuid,
    changeNo: 2_147_483_647,
    intent: null,
    recordedAt: timestamp,
    transactionId: uuid,
  }) + intentBytes;
const bigint = '-9223372036854775808';
const ownerKey = { route: 65535, accountId: uuid };
const subjectKey = { ...ownerKey, subjectId: uuid };
const consumptionOwnerBytes = size({
  ...ownerKey,
  retainedSessions: bigint,
  completedOccurrences: bigint,
  completedSubjects: bigint,
  unknownProfileCompleted: bigint,
  revision: uuid,
});
const consumptionSubjectBytes = size({ ...subjectKey, retainedSessions: bigint, completedOccurrences: bigint });
const reportedBucketBytes = size({
  ...ownerKey,
  year: 9999,
  bucket: 13,
  completed: bigint,
  subjects: bigint,
  unknownProfile: bigint,
  monthPrecision: bigint,
  dayPrecision: bigint,
});
const reportedSubjectBytes = size({ ...subjectKey, year: 9999, bucket: 13, completed: bigint });
const insightsProfileBytes = size({
  ...subjectKey,
  year: 9999,
  profileKey: text(1024),
  completed: bigint,
  subjects: bigint,
  repeats: bigint,
  knownProfiles: bigint,
});
const assessmentBytes = size({
  ...ownerKey,
  meaningRevision: 16,
  units: 20,
  occurrences: bigint,
  absent: bigint,
  explicitNull: bigint,
  valued: bigint,
  historicalUnknown: bigint,
  revision: uuid,
});

const pinByteCaches = new Map<number, number>();
function pinBytes(releaseBytes: number) {
  const cached = pinByteCaches.get(releaseBytes);
  if (cached !== undefined) return cached;
  const value = size(pin) + 2 * 6 * releaseBytes;
  pinByteCaches.set(releaseBytes, value);
  return value;
}

function factBytes(releaseBytes: number) {
  return sessionBytes + size({ libraryProfilePin: null }) + pinBytes(releaseBytes);
}

function projectedMeaningBytes(releaseBytes: number) {
  return (
    pinBytes(releaseBytes) +
    size({
      profilePin: null,
      unitId: text(128),
      meaningRevision: 1,
      mode: 'completed_units',
      unit: text(128),
      dimension: '',
      precision: 6,
      minimum: numeric,
      maximum: numeric,
      totalPolicy: 'forbidden',
      identityKind: 'session_local',
      structureKind: 'none',
      locator: text(256),
    }) +
    6 * releaseBytes
  );
}

function currentProgressBytes(releaseBytes: number) {
  return (
    projectedMeaningBytes(releaseBytes) +
    size({
      ...subjectKey,
      sessionId: uuid,
      scope: 'backlog',
      state: 'abandoned',
      covered: false,
      occurrences: bigint,
      currentKnown: bigint,
      currentSum: numeric,
      totalKnown: bigint,
      totalSum: numeric,
      revision: uuid,
    })
  );
}

export function sessionWorkOf(bound: Bound): SessionWork {
  return {
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
    engineRequests: 0,
  };
}

export function boundOf(work: SessionWork): Bound {
  return declareBound({
    candidateKeys: work.candidateKeys,
    nativeRows: work.nativeRows,
    identityMetadataRows: work.identityMetadataRows,
    emptySeeks: work.emptySeeks,
    nativePoints: work.nativePoints,
    witnessKeys: work.witnessKeys,
    statements: work.statements,
    bytes: work.bytes,
    engineRequests: work.engineRequests,
  });
}

export function sessionBytesWork(bytes: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
    engineRequests: 0,
  });
}

type Shape = Readonly<{ keys: number; rows: number; points: number; seeks: number; output: number; rowBytes: number }>;
const point = (rowBytes: number): Shape => ({ keys: 1, rows: 1, points: 1, seeks: 1, output: 1, rowBytes });

function nativePoint(rows: number, points: number, statements: number, bytes: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    emptySeeks: points,
    witnessKeys: 0,
    statements,
    bytes,
    engineRequests: 0,
  });
}

export function retainSessionOperands<I>(input: I): I {
  const original = structuredClone(input);
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(original);
  return original;
}

export function statementWork(sql: string, inputBytes: number, shape: Shape, nested?: Bound): Bound {
  return sumBounds(
    declareBound({
      candidateKeys: shape.keys,
      nativeRows: shape.rows,
      identityMetadataRows: 0,
      nativePoints: shape.points,
      emptySeeks: shape.seeks,
      witnessKeys: 0,
      statements: 1,
      bytes: utf8(sql) + inputBytes + 2 + shape.output * (shape.rowBytes + 1),
      engineRequests: 0,
    }),
    ...(nested ? [nested] : []),
  );
}

function sqlWork(sql: string, input: unknown, rows: number, points: number, outputBytes: number, metadata = 0): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: metadata,
    nativePoints: points,
    emptySeeks: points,
    witnessKeys: 0,
    statements: 1,
    bytes: utf8(sql) + size(input) + outputBytes,
    engineRequests: 0,
  });
}

function descriptorWork(descriptor: ProgressSqlDescriptor, input: unknown, outputBytes = descriptor.resultBytes): Bound {
  return sqlWork(
    descriptor.sql,
    input,
    descriptor.nativeRows,
    descriptor.nativePoints,
    outputBytes,
    descriptor.identityMetadataRows,
  );
}

function alternative(...branches: readonly Bound[]): Bound {
  const values = branches.length ? branches : [sqlWork('', [], 0, 0, 0)];
  return declareBound(
    Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])),
  );
}

function boundedCommandReadWork(): Bound {
  return sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '200ms'",
      'COMMIT',
      'ROLLBACK',
    ].map((sql) => sqlWork(sql, [], 0, 0, 0)),
  );
}

function snapshotControls(): Bound {
  return sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map((sql) => sqlWork(sql, [], 0, 0, 0)),
  );
}

function mappingSnapshotControls(): Bound {
  return sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SET LOCAL statement_timeout = '5000ms'",
      'COMMIT',
      'ROLLBACK',
    ].map((sql) => sqlWork(sql, [], 0, 0, 0)),
  );
}

export function createProgressOperationBounds(catalog: ProgressOperationCatalog) {
  const releaseBytes = catalog.releaseBytes;
  const facts = factBytes(releaseBytes);
  const progressRow = currentProgressBytes(releaseBytes);

  function sessionHeapAndIndexes() {
    return nativePoint(2 + 2 * 21, 1 + 2 * 21, 0, 2 * facts);
  }
  function sourceHeads() {
    return nativePoint(4 * 4, 4, 4, 4 * 4 * size({ ...ownerKey, generation: bigint }));
  }
  function consumption() {
    return repeatBound(
      nativePoint(
        4 + 1 + 3 + 3 + 2 + 2,
        6,
        6,
        (4 + 3 + 2) * consumptionOwnerBytes + (1 + 3 + 2) * consumptionSubjectBytes,
      ),
      2,
    );
  }
  function reportedYear() {
    return repeatBound(
      nativePoint(4 + 3 + 2 + 4 + 3, 5, 5, (4 + 3) * reportedSubjectBytes + (2 + 4 + 3) * reportedBucketBytes),
      2,
    );
  }
  function insightsYear() {
    return repeatBound(
      nativePoint(
        4 + 3 + 1 + 4 + 1 + 3 + 3 + 1 + 3 + 3,
        10,
        10,
        (4 + 3 + 1 + 4 + 1 + 3 + 3 + 1 + 3 + 3) * insightsProfileBytes,
      ),
      2,
    );
  }
  function assessment() {
    return sumBounds(
      nativePoint(4 + 1 + 3, 3, 3, (4 + 1 + 3) * assessmentBytes),
      repeatBound(nativePoint(4 + 3 + 1 + 4 + 2, 5, 5, (4 + 3 + 1 + 4 + 2) * assessmentBytes), 2),
    );
  }
  function progressApply() {
    return nativePoint(1 + 4 + 3 + 3 + 2, 5, 5, (1 + 4 + 3 + 3 + 2) * progressRow);
  }
  function progressRefresh() {
    return sumBounds(
      nativePoint(1 + 1 + 2 + 3 + 2 + 3 + 2 + 2 + 1 + 4 + 1 + 2 + 4 + 3 + 3 + 3, 16, 16, 2 * facts),
      repeatBound(sumBounds(nativePoint(3 + 1 + 3, 3, 3, (3 + 1 + 3) * progressRow), progressApply()), 2 * SESSION_LIMITS.measures),
    );
  }
  function migration() {
    return nativePoint(4 + 1 + 4 + 3, 7, 7, pinBytes(releaseBytes));
  }
  function memberScope() {
    return repeatBound(nativePoint(1 + 2 + 4 + 4 + 4 + 2 + 2 + 2 + 64, 9, 9, pinBytes(releaseBytes)), 2);
  }
  function sessionTriggers() {
    return sumBounds(
      sourceHeads(),
      consumption(),
      reportedYear(),
      insightsYear(),
      assessment(),
      progressRefresh(),
      migration(),
      memberScope(),
    );
  }
  function childFence() {
    return nativePoint(1 + 4, 2, 2, (1 + 4) * size({ route: 65535, sessionId: uuid, writeState: 'active' }));
  }
  function sessionMutationEffects() {
    return sumBounds(sessionHeapAndIndexes(), sessionTriggers());
  }

  function shelf(statement: ProgressShelfStatement, values: readonly unknown[], input: unknown): Bound {
    return boundOf(catalog.shelf.plan(statement, values, size(input)));
  }

  function sessionReadTimeWork(): Bound {
    return sqlWork(catalog.command.timeRead, { at: timestamp }, 1, 1, size({ value: timestamp }));
  }

  function sessionPartitionWork(partition: number): Bound {
    return sqlWork(
      catalog.command.partitionRead,
      { partition_no: partition },
      1,
      1,
      size({
        partitionNo: 4095,
        node: text(256),
        movedTo: text(256),
        writeState: 'active',
        epoch: 2_147_483_647,
        position: '-9223372036854775808',
      }),
    );
  }

  function sessionSnapshotWork(accountId: string): Bound {
    return sumBounds(
      snapshotControls(),
      descriptorWork(catalog.access.accountRead, { route: 65535, account_id: accountId }, 0),
    );
  }

  function sessionReleaseWork(digest: string, active = false): Bound {
    return sumBounds(
      descriptorWork(catalog.semantic.releaseExists, { route: 0, digest }, size({ digest })),
      descriptorWork(catalog.semantic.releaseRead, { route: 0, digest }),
      ...(active ? [descriptorWork(catalog.semantic.releaseActive, { route: 0 })] : []),
    );
  }

  function sessionSourceWork(subjectId: string, withProfile: boolean): Bound {
    const mapping = sumBounds(
      descriptorWork(catalog.semantic.mappingOwners, [[4095]]),
      descriptorWork(catalog.semantic.mappingSources, [[subjectId], [65535]]),
      descriptorWork(catalog.semantic.mappingOwners, [[4095]]),
      descriptorWork(catalog.semantic.mappingPending, [[4095], [uuid]]),
      descriptorWork(catalog.semantic.mappingCurrent, [[4095], [uuid], [subjectId]]),
      repeatBound(mappingSnapshotControls(), 2),
    );
    return sumBounds(
      repeatBound(mapping, 2 * 3),
      descriptorWork(catalog.access.accountRead, { route: 65535, account_id: uuid }, 0),
      repeatBound(
        sumBounds(
          sessionPartitionWork(4095),
          descriptorWork(catalog.semantic.subjectReference, { route: 65535, subject_id: subjectId }),
          mappingSnapshotControls(),
        ),
        3,
      ),
      descriptorWork(catalog.semantic.itemTypes, {
        partition_no: partitionOf(routeOf(subjectId)!),
        routes: [routeOf(subjectId)!],
        subject_ids: [subjectId],
      }),
      ...(withProfile ? [sessionReleaseWork(pin.releaseDigest, true)] : []),
    );
  }

  function sessionHeadWork(input: { route: number; account_id: string; subject_id: string }): Bound {
    return shelf('head-ensure', [input.route, input.account_id, input.subject_id], input);
  }

  function sessionActivityWork(input: {
    route: number;
    account_id: string;
    subject_id: string;
    time: string;
    completed: boolean;
  }): Bound {
    const key = { route: input.route, account_id: input.account_id, subject_id: input.subject_id };
    return sumBounds(
      shelf('head-touch', [key.route, key.account_id, key.subject_id, input.time], input),
      shelf('entry-raise', [key.route, key.account_id, key.subject_id], key),
      sourceHeads(),
      memberScope(),
    );
  }

  function sessionShelfWork(route: number, accountId: string, counters: boolean): Bound {
    const input = { route, account_id: accountId };
    const owner = [route, accountId] as const;
    const runId = uuid;
    const epoch = '-9223372036854775808';
    const gate = sumBounds(
      descriptorWork(catalog.access.accountShare, input),
      shelf('gate-read', owner, input),
      shelf('gate-ensure', owner, input),
      shelf('gate-lock', owner, input),
      shelf('inputs', owner, input),
      shelf(
        'run-create',
        [route, accountId, runId, epoch, 'backfill', 'drain', null],
        { ...input, run_id: runId, epoch, kind: 'backfill', phase: 'drain', build_generation: null },
      ),
      shelf(
        'gate-save',
        [route, accountId, 'open', false, epoch, uuid, runId],
        { ...input, mode: 'open', ready: false, epoch, active_generation: uuid, run_id: runId },
      ),
      shelf('step-save', [route, accountId, runId], { ...input, run_id: runId }),
      repeatBound(shelf('run-read', [route, accountId, runId], { ...input, run_id: runId }), 2),
      repeatBound(shelf('gate-share', owner, input), 2),
    );
    return counters
      ? sumBounds(
          gate,
          shelf('counter-initialize', [route, accountId, uuid], { ...input, fence_id: uuid }),
          repeatBound(shelf('counter-read', owner, input), 2),
          shelf(
            'counter-complete',
            [route, accountId, false, epoch, uuid],
            { ...input, ready: false, epoch, generation_id: uuid },
          ),
        )
      : gate;
  }

  function sessionProfileMigrationWork(route: number, accountId: string): Bound {
    return sqlWork(
      catalog.session.profileMigration,
      { route, account_id: accountId },
      1,
      1,
      size({ phase: 'progress_meanings', digest: pin.releaseDigest, after: uuid }),
    );
  }

  function sessionPresentationWork(measures: number, sessions = 1): Bound {
    return repeatBound(
      sessionBytesWork(responseSessionBytes + pinBytes(releaseBytes) + (1 + measures) * 6 * releaseBytes),
      sessions,
    );
  }

  function sessionCoreCommandAttemptWork(
    kind: string,
    accountId: string,
    receiptKeys: number,
    response: object,
  ): Bound {
    const keys = Math.max(1, receiptKeys);
    const receipt = {
      principal: { kind: 'account', id: accountId },
      kind,
      key: 'rk1.2147483647.' + 'f'.repeat(64),
      digest: 'f'.repeat(44),
      response,
    };
    const controls = [
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      "SET LOCAL lock_timeout = '200ms'",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL statement_timeout = '5000ms'",
    ].map((sql) => sqlWork(sql, [], 0, 0, 0));
    const receiptBound = sqlWork(
      catalog.command.receiptRead,
      {
        partition_no: 4095,
        principal_kind: 'account',
        principal_id: accountId,
        command_kind: kind,
        idempotency_keys: Array(keys).fill(receipt.key),
      },
      keys,
      keys,
      size({
        requestDigest: 'f'.repeat(64),
        epoch: 2_147_483_647,
        position: '-9223372036854775808',
        transactionId: uuid,
        response: null,
        payloadState: 'retained',
      }) + size(response),
    );
    const fenceBound = sqlWork(
      catalog.command.eventFence,
      {
        partition_no: 4095,
        transaction_id: uuid,
        receipt,
        basis: { principal: { kind: 'account', id: accountId }, clientId: uuid, requestedBy: uuid },
        events: [{ type: 'com.rezics.library.label.changed.v1', subject: accountId, id: uuid, data: { labelId: uuid } }],
      },
      4 + 6 + 4 + 4,
      1 + 5 + 3 + 3,
      size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
    );
    const noEffect = sqlWork(
      catalog.command.noEffectFence,
      { partition_no: 4095, transaction_id: uuid, receipt },
      1 + 4,
      1 + 3,
      size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
    );
    const terminal = alternative(sqlWork('COMMIT', [], 0, 0, 0), sumBounds(sqlWork('ROLLBACK', [], 0, 0, 0), sessionPartitionWork(4095)));
    return sumBounds(
      ...controls,
      boundedCommandReadWork(),
      sessionReadTimeWork(),
      receiptBound,
      alternative(sumBounds(fenceBound, sessionBytesWork(size(response))), noEffect),
      terminal,
    );
  }

  function commandJourneyWork(
    kind: SessionOperationKind,
    original: SessionCommandOriginal,
    preparesSource: boolean,
  ): Bound {
    const route = routeOf(original.accountId)!;
    const input = original.input as Record<string, unknown>;
    const bindBytes = size(original.input) + 2 * facts + size({ time: timestamp, transactionId: uuid });
    const read = statementWork(catalog.session.read, size({ route, session_id: uuid }), point(facts));
    const lock = statementWork(catalog.session.lock, size({ route, session_id: uuid }), point(size({ session_id: uuid })));
    const head = sessionHeadWork({ route, account_id: original.accountId, subject_id: uuid });
    const activity = sessionActivityWork({
      route,
      account_id: original.accountId,
      subject_id: uuid,
      time: timestamp,
      completed: true,
    });
    const gate = sessionShelfWork(route, original.accountId, false);
    if (kind === 'journal') {
      return sumBounds(
        gate,
        lock,
        read,
        statementWork(catalog.session.journalLock, bindBytes, point(journalBytes)),
        statementWork(
          catalog.session.journalUpdate,
          bindBytes,
          point(journalBytes),
          sessionMutationEffects(),
        ),
      );
    }
    const owner = sessionShelfWork(route, original.accountId, true);
    if (kind === 'start') {
      const subjectId = input.subjectId as string;
      const versionId = input.versionSubjectId as string | null;
      const measures = 1 + ((input.additionalMeasures as readonly unknown[] | undefined)?.length ?? 0);
      return sumBounds(
        gate,
        owner,
        head,
        activity,
        repeatBound(sessionSourceWork(subjectId, true), 2),
        ...(versionId !== null && versionId !== subjectId ? [repeatBound(sessionSourceWork(versionId, true), 2)] : []),
        statementWork(catalog.session.insert, bindBytes, point(sessionBytes), sessionMutationEffects()),
        statementWork(catalog.session.meaningInsert, bindBytes + measures * (pinBytes(releaseBytes) + size(measure)), {
          keys: measures,
          rows: measures * 2,
          points: measures,
          seeks: measures,
          output: 0,
          rowBytes: 0,
        }),
        statementWork(
          catalog.session.meaningRefresh,
          size({ route, sessionId: uuid }),
          { keys: 0, rows: 0, points: 0, seeks: 0, output: 1, rowBytes: 4 },
          progressRefresh(),
        ),
      );
    }
    const preparation = !preparesSource
      ? sessionBytesWork(0)
      : sumBounds(
          sessionSnapshotWork(original.accountId),
          read,
          repeatBound(sessionSourceWork(uuid, true), 2),
          ...(kind === 'record' && input.clear !== true ? [sessionReleaseWork(pin.releaseDigest)] : []),
        );
    const changes: Bound[] = [];
    if (kind === 'record') {
      if (input.clear === true) {
        changes.push(
          statementWork(
            catalog.session.unitClear,
            size({ route, session_id: uuid }),
            { keys: SESSION_LIMITS.units, rows: 3 * SESSION_LIMITS.units, points: 1, seeks: 1, output: 0, rowBytes: 0 },
            repeatBound(childFence(), SESSION_LIMITS.units),
          ),
        );
      } else {
        const add = (input.add as readonly string[] | undefined)?.length ?? 0;
        const remove = (input.remove as readonly string[] | undefined)?.length ?? 0;
        if (add)
          changes.push(
            statementWork(
              catalog.session.unitAdd,
              size({ route, session_id: uuid, unit_ids: input.add }),
              {
                keys: add,
                rows: 1 + add * 4,
                points: 1 + add * 2,
                seeks: 1 + add,
                output: 1,
                rowBytes: size({ added: 100 }),
              },
              repeatBound(childFence(), add),
            ),
          );
        if (remove)
          changes.push(
            statementWork(
              catalog.session.unitRemove,
              size({ route, session_id: uuid, unit_ids: input.remove }),
              {
                keys: remove,
                rows: remove * 3,
                points: remove,
                seeks: remove,
                output: 1,
                rowBytes: size({ removed: 100 }),
              },
              repeatBound(childFence(), remove),
            ),
          );
      }
    }
    return sumBounds(
      preparation,
      gate,
      owner,
      head,
      activity,
      repeatBound(read, 2),
      lock,
      statementWork(catalog.session.update, bindBytes, point(sessionBytes), sessionMutationEffects()),
      statementWork(catalog.session.changeAppend, bindBytes, { ...point(changeBytes), rows: 3, points: 2 }, childFence()),
      ...changes,
    );
  }

  function sessionCommandPlan(
    kind: SessionOperationKind,
    original: SessionCommandOriginal,
    receiptKeys: number,
    preparesSource = false,
    durationMs = 5000,
  ): { kind: SessionOperationKind; original: SessionCommandOriginal; total: Bound } {
    const retained = retainSessionOperands(original);
    const responseBytes =
      kind === 'journal' ? size({ sessionId: uuid, revision: 2_147_483_646, changed: false }) : responseSessionBytes;
    const receipt = {
      principal: { kind: 'account', id: retained.accountId },
      kind: retained.kind,
      key: 'rk1.2147483647.' + 'f'.repeat(64),
      digest: 'f'.repeat(44),
      response: null,
    };
    const controls = [
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      "SET LOCAL lock_timeout = '200ms'",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL statement_timeout = '5000ms'",
      'COMMIT',
      'ROLLBACK',
    ];
    const control = sumBounds(
      ...controls.map((sql) => sqlWork(sql, [], 0, 0, 0)),
      boundedCommandReadWork(),
      sqlWork(catalog.command.timeRead, { at: timestamp }, 1, 1, size({ value: timestamp })),
      descriptorWork(
        catalog.access.accountRead,
        { route: routeOf(retained.accountId)!, account_id: retained.accountId },
        0,
      ),
      descriptorWork(catalog.access.accountShare, { route: 65535, account_id: retained.accountId }),
      sqlWork(
        catalog.command.receiptRead,
        {
          partition_no: 4095,
          principal_kind: 'account',
          principal_id: retained.accountId,
          command_kind: retained.kind,
          idempotency_keys: Array(receiptKeys).fill(receipt.key),
        },
        receiptKeys,
        receiptKeys,
        responseBytes +
          size({
            requestDigest: 'f'.repeat(64),
            epoch: 2_147_483_647,
            position: '-9223372036854775808',
            transactionId: uuid,
            response: null,
            payloadState: 'retained',
          }),
      ),
      sqlWork(
        catalog.command.eventFence,
        {
          partition_no: 4095,
          transaction_id: uuid,
          receipt,
          basis: {
            principal: { kind: 'account', id: retained.accountId },
            clientId: retained.clientId,
            requestedBy: retained.requestedBy,
          },
          events: [
            {
              type: 'com.rezics.library.progress_session.updated.v1',
              subject: retained.accountId,
              id: uuid,
              data: { sessionId: uuid },
            },
          ],
        },
        4 + 6 + 4 + 4,
        1 + 5 + 3 + 3,
        size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
      ),
      sqlWork(
        catalog.command.noEffectFence,
        { partition_no: 4095, transaction_id: uuid, receipt },
        1 + 4,
        1 + 3,
        size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
      ),
      sessionPartitionWork(partitionOf(routeOf(retained.accountId)!)),
      repeatBound(
        sumBounds(boundedCommandReadWork(), sessionPartitionWork(partitionOf(routeOf(retained.accountId)!))),
        1 + Math.ceil(durationMs / 25),
      ),
      sessionBytesWork(size(retained) + 3 * responseBytes),
    );
    return Object.freeze({
      kind,
      original: retained,
      total: sumBounds(control, commandJourneyWork(kind, retained, preparesSource)),
    });
  }

  function sessionReadOperationPlan(
    kind: SessionReadKind,
    accountId: string,
    input: SessionReadInput,
  ): { kind: SessionReadKind; original: SessionReadInput; total: Bound } {
    const original = retainSessionOperands(input);
    const route = routeOf(accountId)!;
    const targetId = original.targetId ?? uuid;
    const pointInput = size({ route, session_id: targetId });
    const read = statementWork(catalog.session.read, pointInput, point(facts));
    const legacy = sessionProfileMigrationWork(route, accountId);
    const snapshot = sessionSnapshotWork(accountId);
    const partition = sessionPartitionWork(partitionOf(route));
    const parts: Bound[] = [snapshot, sessionBytesWork(size(original))];
    if (kind.endsWith('page')) {
      const payloadBytes = size({
        e: 2_147_483_647,
        a: [timestamp, uuid, text(128), '-9223372036854775808'],
        t: Number.MAX_SAFE_INTEGER,
      });
      parts.push(sessionBytesWork(4 * Math.ceil((2 + payloadBytes) / 3) + 1 + 43 + size(original)));
    }
    switch (kind) {
      case 'read':
        parts.push(read, legacy, sessionBytesWork(responseSessionBytes));
        break;
      case 'inspect':
        parts.push(read, sessionBytesWork(facts));
        break;
      case 'journal-read':
        parts.push(
          statementWork(
            catalog.session.journalRead,
            size({ route, account_id: accountId, session_id: targetId }),
            point(journalBytes),
          ),
          sessionBytesWork(journalBytes),
        );
        break;
      case 'presentation':
        parts.push(
          snapshot,
          repeatBound(read, 2),
          repeatBound(partition, 2),
          repeatBound(sessionReadTimeWork(), 2),
          sessionReleaseWork(pin.releaseDigest),
          repeatBound(sessionSourceWork(uuid, true), 2),
          repeatBound(sessionSourceWork(uuid, false), 2),
          repeatBound(sessionPresentationWork(8), 2),
        );
        break;
      case 'owner-current':
        parts.push(
          partition,
          statementWork(
            catalog.session.ownerGeneration,
            size({ route, account_id: accountId }),
            point(size({ generation: '-9223372036854775808' })),
          ),
        );
        break;
      case 'owner-page': {
        const limit = original.limit ?? 20;
        parts.push(
          partition,
          legacy,
          statementWork(
            catalog.session.ownerGeneration,
            size({ route, account_id: accountId }),
            point(size({ generation: '-9223372036854775808' })),
          ),
          statementWork(
            catalog.session.ownerPage,
            size(original) +
              size({
                route,
                account_id: accountId,
                subject_id: uuid,
                filter_kind: 'subject_profile',
                state_filter: 'completed',
                mode_filter: 'completed_units',
                profile_filter: '',
                after_started_at: timestamp,
                after_session_id: uuid,
                has_cursor: true,
                limit: limit + 1,
              }),
            {
              keys: limit + 1,
              rows: 2 * (limit + 1),
              points: limit + 2,
              seeks: limit + 2,
              output: limit + 1,
              rowBytes: facts,
            },
          ),
          sessionBytesWork(2 + limit * (responseSessionBytes + pinBytes(releaseBytes) + 1)),
        );
        break;
      }
      default: {
        const limit = original.limit ?? 20;
        const sent = Math.min(SESSION_LIMITS.page, limit + 1);
        const next = original.cursor !== undefined;
        const binds =
          size(original) +
          size({
            route,
            account_id: accountId,
            subject_id: targetId,
            session_id: targetId,
            after_started_at: timestamp,
            after_session_id: uuid,
            after_unit_id: text(128),
            after_change_no: 2_147_483_647,
            has_cursor: next,
            limit: sent,
          });
        parts.push(partition);
        if (kind === 'subject-page') {
          const ranges = next ? 2 : 1;
          parts.push(
            legacy,
            statementWork(catalog.session.subjectPage, binds, {
              keys: ranges * sent,
              rows: ranges * sent,
              points: ranges,
              seeks: ranges,
              output: sent,
              rowBytes: facts,
            }),
          );
          if (limit === SESSION_LIMITS.page)
            parts.push(
              statementWork(catalog.session.subjectPage, binds, {
                keys: 2,
                rows: 2,
                points: 2,
                seeks: 2,
                output: 1,
                rowBytes: facts,
              }),
            );
          parts.push(sessionBytesWork(2 + limit * (responseSessionBytes + 1)));
        } else {
          const sql = kind === 'unit-page' ? catalog.session.unitPage : catalog.session.changePage;
          const width = kind === 'unit-page' ? unitBytes : changeBytes;
          parts.push(
            read,
            legacy,
            statementWork(sql, binds, { keys: sent, rows: sent, points: 1, seeks: 1, output: sent, rowBytes: width }),
          );
          if (limit === SESSION_LIMITS.page)
            parts.push(statementWork(sql, binds, { keys: 1, rows: 1, points: 1, seeks: 1, output: 1, rowBytes: width }));
          parts.push(sessionBytesWork(2 + limit * (width + 1)));
        }
        break;
      }
    }
    return Object.freeze({ kind, original, total: sumBounds(...parts) });
  }

  return {
    sessionBytes,
    responseSessionBytes,
    factBytes: facts,
    journalBytes,
    unitBytes,
    changeBytes,
    pinBytes: pinBytes(releaseBytes),
    point,
    childFence,
    progressRefresh,
    sessionMutationEffects,
    statementWork,
    sessionBytesWork,
    sessionPresentationWork,
    sessionCoreCommandAttemptWork,
    sessionCommandPlan,
    sessionSnapshotWork,
    sessionPartitionWork,
    sessionReleaseWork,
    sessionSourceWork,
    sessionHeadWork,
    sessionActivityWork,
    sessionShelfWork,
    sessionProfileMigrationWork,
    sessionReadTimeWork,
    sessionReadOperationPlan,
    sessionWorkOf,
  };
}

export type ProgressOperationBounds = ReturnType<typeof createProgressOperationBounds>;
