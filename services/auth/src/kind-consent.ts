import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES,
  MAX_CONSENTED_SCOPES,
  kindConsentOperationActual,
  kindConsentOperationBound,
} from '@rezics/auth-contract';
import type {
  KindConsentConsumer,
  KindConsentEnrollmentInput,
  KindConsentEnrollmentNativeUsage,
  KindConsentEnrollmentResult,
  KindConsentInvalidationInput,
  KindConsentInvalidationReceiver,
  KindConsentOperation,
  KindConsentParticipant,
  KindConsentReference,
  KindConsentWorkDeclaration,
} from '@rezics/auth-contract';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export const KIND_CONSENT_PAGE_SIZE = 100;

type TransitionKind = 'consent' | 'client' | 'restore';
type TransitionState = 'pending' | 'ready' | 'applied';
type Transition = {
  transition_id: string;
  transition_key: string;
  transition_kind: TransitionKind;
  client_id: string;
  account_id: string | null;
  target: unknown;
  frontier_seq: string;
  after_seq: string;
  state: TransitionState;
};
type Dependency = {
  enrollment_seq: string;
  reference_id: string;
  account_id: string;
  client_id: string;
  consumer_route: string;
  owner_account_id: string;
  collection_id: string;
  preparation_id: string;
  origin_id: string;
};

export type KindConsentChange = Readonly<{
  /** Stable native operation key. Retries must reuse it. */
  transitionKey: string;
  kind: TransitionKind;
  clientId: string;
  accountId?: string;
  /** Exact intended authority change, retained until its native commit. */
  target: Readonly<Record<string, unknown>>;
  /** Auth-only mutation, run after all Source fences are verified. */
  apply(connection: PoolClient, transitionId: string): Promise<void>;
}>;

export type KindConsentChangeResult = Readonly<{
  status: 'applied' | 'pending';
  transitionId: string;
  /** Actual receiving Source/Access charge for this one bounded call. */
  work: KindConsentWorkDeclaration;
}>;

export interface KindConsentWriter {
  change(input: KindConsentChange): Promise<KindConsentChangeResult>;
  /** Performs at most one 100-consumer native page for host recovery. */
  continueTransition(transitionId: string): Promise<KindConsentChangeResult>;
  /** Selects one oldest pending transition and performs at most one page. */
  continuePending(): Promise<KindConsentChangeResult | null>;
  /** Closes all Auth enrollments across clients for restore/erasure. */
  fenceAll(
    input: Readonly<{
      transitionKey: string;
      operation: 'restore-admission' | 'erasure-drain';
      identity: string;
    }>,
  ): Promise<KindConsentChangeResult>;
  /** Current Auth closure, for issuance and restore guards. */
  current(accountId: string, clientId: string): Promise<boolean>;
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 && /^[\x21-\x7e]+$/.test(value);
type EnrollmentDeadline = Readonly<{ deadline: number; signal?: AbortSignal }>;
const enrollmentDeadline = new AsyncLocalStorage<EnrollmentDeadline>();

type EnrollmentQueryKind = 'control' | 'lock' | 'frontier' | 'point' | 'candidate';
type EnrollmentTrace = {
  candidateKeys: number;
  nativeRows: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  returnedMetadataBytes: number;
};

function createEnrollmentTrace(): EnrollmentTrace {
  return {
    candidateKeys: 0,
    nativeRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    returnedMetadataBytes: 0,
  };
}

async function enrollmentQuery<Row extends QueryResultRow>(
  connection: PoolClient,
  trace: EnrollmentTrace | undefined,
  kind: EnrollmentQueryKind,
  sql: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  if (!trace) return connection.query<Row>(sql, [...values]);
  trace.statements++;
  if (kind === 'lock') trace.witnessKeys++;
  if (kind === 'frontier' || kind === 'point' || kind === 'candidate') trace.nativePoints++;
  if (kind === 'candidate') trace.candidateKeys = 1;
  const result = await connection.query<Row>(sql, [...values]);
  if (kind === 'frontier' || kind === 'point' || kind === 'candidate') {
    if (result.rows.length > 1 || result.rows.some((row) => !boundedEnrollmentMetadata(row, kind, sql)))
      throw new Error('Kind enrollment metadata exceeded its native ceiling');
    trace.nativeRows += result.rows.length;
    if (!result.rows.length) trace.emptySeeks++;
    const returnedBytes = Buffer.byteLength(JSON.stringify(result.rows) ?? '');
    if (trace.returnedMetadataBytes + returnedBytes > KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES)
      throw new Error('Kind enrollment metadata exceeded its native ceiling');
    trace.returnedMetadataBytes += returnedBytes;
  }
  return result;
}

const enrollmentScope = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);

function boundedEnrollmentMetadata(value: QueryResultRow, kind: EnrollmentQueryKind, sql: string): boolean {
  const record = value as Record<string, unknown>;
  const exact = (keys: readonly string[]) =>
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  const identifierValue = (field: unknown) =>
    typeof field === 'string' && field.length > 0 && field.length <= 1024 && /^[\x21-\x7e]+$/.test(field);
  const scopeArray = (field: unknown) =>
    Array.isArray(field) && field.length <= MAX_CONSENTED_SCOPES && field.every(enrollmentScope);
  if (kind === 'frontier') return exact(['?column?']) && record['?column?'] === 1;
  if (kind === 'point') {
    return (
      exact([
        'client_id',
        'client_scopes',
        'first_party',
        'ready',
        'reducing',
        'consent_scopes',
        'pending_scopes',
        'revision',
      ]) &&
      identifierValue(record.client_id) &&
      scopeArray(record.client_scopes) &&
      typeof record.first_party === 'boolean' &&
      typeof record.ready === 'boolean' &&
      typeof record.reducing === 'boolean' &&
      (record.consent_scopes === null || scopeArray(record.consent_scopes)) &&
      (record.pending_scopes === null || scopeArray(record.pending_scopes)) &&
      (record.revision === null || (typeof record.revision === 'string' && /^\d{1,19}$/.test(record.revision)))
    );
  }
  if (sql.trimStart().startsWith('INSERT'))
    return (
      exact(['reference_id']) &&
      typeof record.reference_id === 'string' &&
      /^[\x21-\x7e]{1,36}$/.test(record.reference_id)
    );
  return (
    exact([
      'reference_id',
      'account_id',
      'client_id',
      'requested_scopes',
      'effective_scopes',
      'consumer_route',
      'owner_account_id',
      'collection_id',
      'preparation_id',
      'origin_id',
      'active',
    ]) &&
    typeof record.reference_id === 'string' &&
    /^[\x21-\x7e]{1,36}$/.test(record.reference_id) &&
    identifierValue(record.account_id) &&
    identifierValue(record.client_id) &&
    scopeArray(record.requested_scopes) &&
    scopeArray(record.effective_scopes) &&
    identifierValue(record.consumer_route) &&
    identifierValue(record.owner_account_id) &&
    identifierValue(record.collection_id) &&
    identifierValue(record.preparation_id) &&
    identifierValue(record.origin_id) &&
    typeof record.active === 'boolean'
  );
}

function consumerOf(row: Dependency): KindConsentConsumer {
  return Object.freeze({
    route: row.consumer_route,
    ownerAccountId: row.owner_account_id,
    collectionId: row.collection_id,
    preparationId: row.preparation_id,
    originId: row.origin_id,
  });
}

function referenceOf(id: string): KindConsentReference {
  return Object.freeze({ kind: 'auth-kind-consent', id });
}

const ZERO_WORK: KindConsentWorkDeclaration = Object.freeze({
  source: Object.freeze({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  }),
  access: Object.freeze({ keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 }),
});

function addWork(...parts: readonly KindConsentWorkDeclaration[]): KindConsentWorkDeclaration {
  const source = Object.fromEntries(
    Object.keys(ZERO_WORK.source).map((axis) => [
      axis,
      parts.reduce((sum, part) => sum + part.source[axis as keyof typeof ZERO_WORK.source], 0),
    ]),
  ) as unknown as KindConsentWorkDeclaration['source'];
  const access = Object.fromEntries(
    Object.keys(ZERO_WORK.access).map((axis) => [
      axis,
      parts.reduce((sum, part) => sum + part.access[axis as keyof typeof ZERO_WORK.access], 0),
    ]),
  ) as unknown as KindConsentWorkDeclaration['access'];
  return Object.freeze({ source: Object.freeze(source), access: Object.freeze(access) });
}

function withinWork(actual: KindConsentWorkDeclaration, bound: KindConsentWorkDeclaration) {
  if (!actual || typeof actual !== 'object' || !actual.source || !actual.access) return false;
  return (
    Object.keys(bound.source).every(
      (axis) =>
        Number.isSafeInteger(actual.source[axis as keyof typeof bound.source]) &&
        actual.source[axis as keyof typeof bound.source] >= 0 &&
        actual.source[axis as keyof typeof bound.source] <= bound.source[axis as keyof typeof bound.source],
    ) &&
    Object.keys(bound.access).every(
      (axis) =>
        Number.isSafeInteger(actual.access[axis as keyof typeof bound.access]) &&
        actual.access[axis as keyof typeof bound.access] >= 0 &&
        actual.access[axis as keyof typeof bound.access] <= bound.access[axis as keyof typeof bound.access],
    )
  );
}

const changeResult = (
  status: 'applied' | 'pending',
  transitionId: string,
  work: KindConsentWorkDeclaration = ZERO_WORK,
): KindConsentChangeResult => Object.freeze({ status, transitionId, work });

const PAGE_CONTROL_WORK: KindConsentWorkDeclaration = Object.freeze({
  source: Object.freeze({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 5,
    bytes: 8192,
  }),
  access: Object.freeze({ keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 8192, emptySeeks: 1 }),
});

/** One receiving page: 100 consumers, one invalidate plus one current verify
 * each, including page/lookahead and fixed control statements. */
export function kindConsentTransitionPageBound(): KindConsentWorkDeclaration {
  const consumers = KIND_CONSENT_PAGE_SIZE;
  const receiverCalls = consumers * 2;
  const bytes = receiverCalls * 10_240 + 8192;
  return Object.freeze({
    source: Object.freeze({
      candidateKeys: receiverCalls * 2,
      nativeRows: receiverCalls * 2,
      identityMetadataRows: 0,
      emptySeeks: receiverCalls + 1,
      nativePoints: receiverCalls * 4,
      witnessKeys: receiverCalls * 2,
      statements: receiverCalls * 4 + 5,
      bytes,
    }),
    access: Object.freeze({
      keys: receiverCalls * 2,
      points: receiverCalls * 8,
      witnesses: receiverCalls * 4,
      rows: receiverCalls * 8,
      bytes,
      emptySeeks: receiverCalls + 1,
    }),
  });
}

async function connectByDeadline(database: Pool, deadline?: number, signal?: AbortSignal): Promise<PoolClient> {
  if (signal?.aborted) throw new Error('Kind consent enrollment deadline expired');
  if (deadline === undefined && !signal) return database.connect();
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error('Kind consent enrollment deadline expired');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = database.connect();
  let onAbort: (() => void) | undefined;
  const cancelled = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Kind consent enrollment deadline expired'));
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  const expired =
    remaining === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Kind consent enrollment deadline expired')), remaining);
        });
  try {
    return await Promise.race([pending, ...(cancelled ? [cancelled] : []), ...(expired ? [expired] : [])]);
  } catch (error) {
    void pending
      .then((connection) => connection.release(new Error('Kind consent enrollment deadline expired')))
      .catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function withTransaction<T>(
  database: Pool,
  run: (connection: PoolClient) => Promise<T>,
  deadline?: number,
  signal?: AbortSignal,
  trace?: EnrollmentTrace,
): Promise<T> {
  const connection = await connectByDeadline(database, deadline, signal);
  let released = false;
  const expire = () => {
    if (released) return;
    released = true;
    connection.release(new Error('Kind consent enrollment deadline expired'));
  };
  const checkDeadline = () => {
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) {
      expire();
      throw new Error('Kind consent enrollment deadline expired');
    }
  };
  const timer = deadline === undefined ? undefined : setTimeout(expire, Math.max(0, deadline - Date.now()));
  signal?.addEventListener('abort', expire, { once: true });
  try {
    checkDeadline();
    await enrollmentQuery(connection, trace, 'control', 'BEGIN');
    if (deadline !== undefined) {
      checkDeadline();
      const remaining = Math.max(1, deadline - Date.now());
      await enrollmentQuery(
        connection,
        trace,
        'control',
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [`${remaining}ms`, `${remaining}ms`],
      );
    }
    const result = await run(connection);
    checkDeadline();
    await enrollmentQuery(connection, trace, 'control', 'COMMIT');
    return result;
  } catch (error) {
    if (!released) await enrollmentQuery(connection, trace, 'control', 'ROLLBACK').catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', expire);
    if (!released) connection.release();
  }
}

/** Bind an absolute caller deadline to the installed native participant without
 * changing its public enrollment callable signature. */
export function withKindConsentEnrollmentDeadline<T>(
  deadline: number,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(deadline)) return Promise.reject(new Error('Invalid Kind consent enrollment deadline'));
  return enrollmentDeadline.run({ deadline, ...(signal ? { signal } : {}) }, run);
}

async function lockChange(connection: PoolClient, clientId: string, accountId?: string, trace?: EnrollmentTrace) {
  // Close/snapshot operations share this short lock with enrollments. No foreign
  // Source call happens while this transaction lock is held.
  await enrollmentQuery(connection, trace, 'lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'auth-kind-consent-frontier',
  ]);
  // Keep the existing client lock before the exact consent lock.
  await enrollmentQuery(connection, trace, 'lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `auth-client:${clientId}`,
  ]);
  if (accountId)
    await enrollmentQuery(connection, trace, 'lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `auth-consent:${accountId}:${clientId}`,
    ]);
}

function sameJson(left: unknown, right: unknown) {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  };
  return canonical(left) === canonical(right);
}

function consumerHash(consumer: KindConsentConsumer) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        consumer.route,
        consumer.ownerAccountId,
        consumer.collectionId,
        consumer.preparationId,
        consumer.originId,
      ]),
    )
    .digest();
}

/** Auth's bounded, purpose-specific enrollment and invalidation producer.
 * There is intentionally no generic dependency registry and no event feed.
 */
export function createKindConsentParticipant(input: {
  database: Pool;
  receiver?: KindConsentInvalidationReceiver;
}): Readonly<{ participant: KindConsentParticipant; writer: KindConsentWriter }> {
  const { database, receiver } = input;

  async function noOpenTransition(
    connection: PoolClient,
    clientId: string,
    accountId?: string,
    trace?: EnrollmentTrace,
  ) {
    const result = await enrollmentQuery(
      connection,
      trace,
      'frontier',
      `SELECT 1 FROM auth_kind_consent_transition
       WHERE state<>'applied' AND (transition_kind='restore' OR
         (client_id=$1 AND (account_id IS NULL OR account_id=$2)))
       LIMIT 1`,
      [clientId, accountId ?? null],
    );
    return result.rows.length === 0;
  }

  const enrollmentCharges = new WeakMap<
    object,
    { input: KindConsentEnrollmentInput; work: KindConsentWorkDeclaration }
  >();
  async function enroll(raw: KindConsentEnrollmentInput): Promise<KindConsentEnrollmentResult> {
    const bound = kindConsentOperationBound(raw);
    if (!bound) {
      const result: KindConsentEnrollmentResult = Object.freeze({ status: 'unavailable' });
      return result;
    }
    const requestedScopes = [...raw.requestedScopes];
    const effectiveRequest = [...new Set(requestedScopes)].sort();
    const deadline = enrollmentDeadline.getStore();
    const trace = createEnrollmentTrace();
    let committed = false;
    let result: KindConsentEnrollmentResult;
    try {
      result = await withTransaction(
        database,
        async (connection) => {
          await lockChange(connection, raw.clientId, raw.accountId, trace);
          if (!(await noOpenTransition(connection, raw.clientId, raw.accountId, trace)))
            return { status: 'unavailable' };
          const current = (
            await enrollmentQuery<{
              client_id: string;
              client_scopes: string[];
              first_party: boolean;
              ready: boolean;
              reducing: boolean;
              consent_scopes: string[] | null;
              pending_scopes: string[] | null;
              revision: string | null;
            }>(
              connection,
              trace,
              'point',
              `SELECT c.client_id,c.scopes AS client_scopes,c.first_party,v.ready,
                EXISTS(SELECT 1 FROM auth_client_reduction r WHERE r.client_id=c.client_id) AS reducing,
                a.scopes AS consent_scopes,a.pending_scopes,a.revision::text AS revision
               FROM auth_client c
               LEFT JOIN auth_client_coverage v ON v.client_id=c.client_id
               LEFT JOIN auth_consent a ON a.account_id=$1 AND a.client_id=c.client_id
               WHERE c.client_id=$2`,
              [raw.accountId, raw.clientId],
            )
          ).rows[0];
          if (!current || !current.ready || current.reducing) return { status: 'unavailable' };

          const digest = consumerHash(raw.consumer);
          const existing = (
            await enrollmentQuery<{
              reference_id: string;
              account_id: string;
              client_id: string;
              requested_scopes: string[];
              effective_scopes: string[];
              consumer_route: string;
              owner_account_id: string;
              collection_id: string;
              preparation_id: string;
              origin_id: string;
              active: boolean;
            }>(
              connection,
              trace,
              'candidate',
              `SELECT reference_id,account_id,client_id,requested_scopes,effective_scopes,
                consumer_route,owner_account_id,collection_id,preparation_id,origin_id,active
               FROM auth_kind_consent_dependency
               WHERE consumer_key_hash=$1
               FOR UPDATE`,
              [digest],
            )
          ).rows[0];
          if (existing) {
            const consumerMatches =
              existing.account_id === raw.accountId &&
              existing.client_id === raw.clientId &&
              sameJson(existing.requested_scopes, requestedScopes) &&
              existing.consumer_route === raw.consumer.route &&
              existing.owner_account_id === raw.consumer.ownerAccountId &&
              existing.collection_id === raw.consumer.collectionId &&
              existing.preparation_id === raw.consumer.preparationId &&
              existing.origin_id === raw.consumer.originId;
            if (!consumerMatches || !existing.active) return { status: 'unavailable' };
            return {
              status: 'enrolled',
              reference: referenceOf(existing.reference_id),
              effectiveScopes: Object.freeze([...existing.effective_scopes]),
            };
          }

          // First-party status never creates consent here. It only controls
          // materialization in the ordinary authenticated issuance path.
          const stored = new Set(current.consent_scopes ?? []);
          const client = new Set(current.client_scopes);
          const pending = current.pending_scopes === null ? null : new Set(current.pending_scopes);
          const effectiveScopes = effectiveRequest.filter(
            (scope) => client.has(scope) && stored.has(scope) && (pending === null || pending.has(scope)),
          );
          const row = (
            await enrollmentQuery<{ reference_id: string }>(
              connection,
              trace,
              'candidate',
              `INSERT INTO auth_kind_consent_dependency
                (consumer_key_hash,account_id,client_id,requested_scopes,effective_scopes,consent_revision,client_scopes,client_first_party,
                 consumer_route,owner_account_id,collection_id,preparation_id,origin_id)
               VALUES ($1,$2,$3,$4,$5,COALESCE($6::bigint,0),$7,$8,$9,$10,$11,$12,$13)
               RETURNING reference_id::text`,
              [
                digest,
                raw.accountId,
                raw.clientId,
                requestedScopes,
                effectiveScopes,
                current.revision,
                current.client_scopes,
                current.first_party,
                raw.consumer.route,
                raw.consumer.ownerAccountId,
                raw.consumer.collectionId,
                raw.consumer.preparationId,
                raw.consumer.originId,
              ],
            )
          ).rows[0];
          if (!row) return { status: 'unavailable' };
          return { status: 'enrolled', reference: referenceOf(row.reference_id), effectiveScopes };
        },
        deadline?.deadline,
        deadline?.signal,
        trace,
      );
      committed = true;
    } catch {
      // Native coverage gaps, restore uncertainty and serialization failures
      // are unavailable; they never become empty or a negative verdict.
      result = { status: 'unavailable' };
    }
    result =
      result.status === 'enrolled'
        ? Object.freeze({ ...result, effectiveScopes: Object.freeze([...result.effectiveScopes]) })
        : Object.freeze(result);
    if (committed) {
      const work = kindConsentOperationActual(raw, trace satisfies KindConsentEnrollmentNativeUsage);
      if (work) enrollmentCharges.set(result, { input: raw, work });
    }
    return result;
  }
  const enrollOperation: KindConsentOperation<KindConsentEnrollmentInput, KindConsentEnrollmentResult> = Object.assign(
    enroll,
    {
      bound: kindConsentOperationBound,
      actual(raw: KindConsentEnrollmentInput, result: KindConsentEnrollmentResult) {
        const receipt = enrollmentCharges.get(result);
        if (!receipt || receipt.input !== raw) return undefined;
        enrollmentCharges.delete(result);
        return receipt.work;
      },
    },
  );
  const participant: KindConsentParticipant = { enroll: enrollOperation };

  async function openTransition(change: KindConsentChange): Promise<Transition | null> {
    if (
      !identifier(change.transitionKey) ||
      !identifier(change.clientId) ||
      (change.accountId !== undefined && !identifier(change.accountId)) ||
      (change.kind === 'consent' && !change.accountId) ||
      (change.kind === 'restore' && change.accountId !== undefined) ||
      !change.target ||
      typeof change.target !== 'object' ||
      Buffer.byteLength(JSON.stringify(change.target)) > 8192
    )
      return null;
    return withTransaction(database, async (connection) => {
      await lockChange(connection, change.clientId, change.accountId);
      const existing = (
        await connection.query<Transition>(
          'SELECT * FROM auth_kind_consent_transition WHERE transition_key=$1 FOR UPDATE',
          [change.transitionKey],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.client_id !== change.clientId ||
          existing.account_id !== (change.accountId ?? null) ||
          existing.transition_kind !== change.kind ||
          !sameJson(existing.target, change.target)
        )
          return null;
        return existing;
      }
      const conflict = await connection.query(
        `SELECT 1 FROM auth_kind_consent_transition WHERE state<>'applied' AND
         ($3::boolean OR transition_kind='restore' OR (client_id=$1 AND ($2::text IS NULL OR account_id IS NULL OR account_id=$2))) LIMIT 1`,
        [change.clientId, change.accountId ?? null, change.kind === 'restore'],
      );
      if (conflict.rowCount) return null;
      const frontier = (
        await connection.query<{ frontier: string }>(
          `SELECT COALESCE(max(enrollment_seq),0)::text AS frontier
           FROM auth_kind_consent_dependency
           WHERE active AND ($1::boolean OR (client_id=$2 AND ($3::text IS NULL OR account_id=$3)))`,
          [change.kind === 'restore', change.clientId, change.accountId ?? null],
        )
      ).rows[0]!.frontier;
      const transition = (
        await connection.query<Transition>(
          `INSERT INTO auth_kind_consent_transition
            (transition_key,transition_kind,client_id,account_id,target,frontier_seq)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
          [
            change.transitionKey,
            change.kind,
            change.clientId,
            change.accountId ?? null,
            JSON.stringify(change.target),
            frontier,
          ],
        )
      ).rows[0];
      return transition ?? null;
    });
  }

  async function transitionPage(id: string): Promise<KindConsentChangeResult> {
    if (!identifier(id)) return changeResult('pending', '', PAGE_CONTROL_WORK);
    const transition = await database.query<Transition>(
      'SELECT * FROM auth_kind_consent_transition WHERE transition_id=$1',
      [id],
    );
    const row = transition.rows[0];
    if (!row) return changeResult('pending', id, PAGE_CONTROL_WORK);
    if (row.state === 'applied' || row.state === 'ready') return changeResult('applied', id);
    const page = await database.query<Dependency>(
      `SELECT enrollment_seq::text,reference_id::text,account_id,client_id,consumer_route,
        owner_account_id,collection_id,preparation_id,origin_id
       FROM auth_kind_consent_dependency
       WHERE active AND ($1::boolean OR (client_id=$2 AND ($3::text IS NULL OR account_id=$3)))
         AND enrollment_seq>$4 AND enrollment_seq<=$5
       ORDER BY enrollment_seq LIMIT $6`,
      [
        row.transition_kind === 'restore',
        row.client_id,
        row.account_id,
        row.after_seq,
        row.frontier_seq,
        KIND_CONSENT_PAGE_SIZE,
      ],
    );
    if (!page.rows.length) {
      await withTransaction(database, async (connection) => {
        await lockChange(connection, row.client_id, row.account_id ?? undefined);
        await connection.query(
          `UPDATE auth_kind_consent_transition SET state='ready',updated_at=clock_timestamp()
           WHERE transition_id=$1 AND state='pending'
             AND NOT EXISTS (SELECT 1 FROM auth_kind_consent_dependency d
               WHERE d.active AND ($5::boolean OR (d.client_id=$2 AND ($3::text IS NULL OR d.account_id=$3)))
                 AND d.enrollment_seq<=$4)`,
          [id, row.client_id, row.account_id, row.frontier_seq, row.transition_kind === 'restore'],
        );
      });
      return changeResult('applied', id, PAGE_CONTROL_WORK);
    }
    const source = receiver;
    if (!source) return changeResult('pending', id, PAGE_CONTROL_WORK);
    let planned: Array<{
      dependency: Dependency;
      invalidation: KindConsentInvalidationInput;
      invalidationBound: KindConsentWorkDeclaration | undefined;
      verificationBound: KindConsentWorkDeclaration | undefined;
    }>;
    try {
      planned = page.rows.map((dependency) => {
        const invalidation: KindConsentInvalidationInput = {
          reference: referenceOf(dependency.reference_id),
          consumer: consumerOf(dependency),
          transitionId: row.transition_id,
        };
        const invalidationBound = source.invalidate.bound(invalidation);
        const verificationBound = source.verify.bound({
          ...invalidation,
          receiptReference: 'x'.repeat(1024),
        });
        return { dependency, invalidation, invalidationBound, verificationBound };
      });
    } catch {
      return changeResult('pending', id, PAGE_CONTROL_WORK);
    }
    if (planned.some((plan) => !plan.invalidationBound || !plan.verificationBound))
      return changeResult('pending', id, PAGE_CONTROL_WORK);
    const pageBound = kindConsentTransitionPageBound();
    const reserved = addWork(...planned.flatMap((plan) => [plan.invalidationBound!, plan.verificationBound!]));
    if (!withinWork(addWork(PAGE_CONTROL_WORK, reserved), pageBound))
      return changeResult('pending', id, PAGE_CONTROL_WORK);
    let charged = PAGE_CONTROL_WORK;
    for (const plan of planned) {
      const { dependency, invalidation, invalidationBound, verificationBound } = plan;
      if (!invalidationBound || !verificationBound) return changeResult('pending', id, charged);
      let result: Awaited<ReturnType<typeof source.invalidate>>;
      try {
        result = await source.invalidate(invalidation);
      } catch {
        return changeResult('pending', id, addWork(charged, invalidationBound));
      }
      let invalidatedWork: KindConsentWorkDeclaration | undefined;
      try {
        invalidatedWork = source.invalidate.actual(invalidation, result);
      } catch {
        invalidatedWork = undefined;
      }
      const actualInvalidation =
        invalidatedWork && withinWork(invalidatedWork, invalidationBound) ? invalidatedWork : invalidationBound;
      charged = addWork(charged, actualInvalidation);
      if (result.status !== 'committed' || !identifier(result.receiptReference))
        return changeResult('pending', id, charged);
      const verificationInput = { ...invalidation, receiptReference: result.receiptReference };
      let exactVerifyBound: KindConsentWorkDeclaration | undefined;
      try {
        exactVerifyBound = source.verify.bound(verificationInput);
      } catch {
        return changeResult('pending', id, charged);
      }
      if (!exactVerifyBound || !withinWork(exactVerifyBound, verificationBound))
        return changeResult('pending', id, charged);
      let verified: Awaited<ReturnType<typeof source.verify>>;
      try {
        verified = await source.verify(verificationInput);
      } catch {
        return changeResult('pending', id, addWork(charged, exactVerifyBound));
      }
      let verifiedWork: KindConsentWorkDeclaration | undefined;
      try {
        verifiedWork = source.verify.actual(verificationInput, verified);
      } catch {
        verifiedWork = undefined;
      }
      const actualVerification =
        verifiedWork && withinWork(verifiedWork, exactVerifyBound) ? verifiedWork : exactVerifyBound;
      charged = addWork(charged, actualVerification);
      if (verified.status !== 'verified' || verified.receiptReference !== result.receiptReference)
        return changeResult('pending', id, charged);
      try {
        await withTransaction(database, async (connection) => {
          await lockChange(connection, row.client_id, row.account_id ?? undefined);
          await connection.query("SELECT set_config('auth.kind_consent_transition_id',$1,true)", [row.transition_id]);
          const admitted = (
            await connection.query(
              `UPDATE auth_kind_consent_dependency SET active=false,fenced_transition_id=$2,
                  receipt_reference=$3,fenced_at=clock_timestamp()
               WHERE reference_id=$1 AND active AND account_id=$4 AND client_id=$5
                 AND consumer_route=$6 AND owner_account_id=$7 AND collection_id=$8
                 AND preparation_id=$9 AND origin_id=$10 RETURNING enrollment_seq`,
              [
                dependency.reference_id,
                row.transition_id,
                result.receiptReference,
                dependency.account_id,
                dependency.client_id,
                dependency.consumer_route,
                dependency.owner_account_id,
                dependency.collection_id,
                dependency.preparation_id,
                dependency.origin_id,
              ],
            )
          ).rows[0] as { enrollment_seq: string } | undefined;
          if (admitted) {
            await connection.query(
              `UPDATE auth_kind_consent_transition SET after_seq=GREATEST(after_seq,$2::bigint),updated_at=clock_timestamp()
               WHERE transition_id=$1 AND state='pending'`,
              [id, admitted.enrollment_seq],
            );
          }
        });
      } catch {
        // Source committed and verified, but Auth did not record the receipt.
        // Retry the original transition and receiving identity next time.
        return changeResult('pending', id, charged);
      }
    }
    return changeResult('pending', id, charged);
  }

  async function applyReady(change: KindConsentChange, transition: Transition): Promise<KindConsentChangeResult> {
    return withTransaction(database, async (connection) => {
      await lockChange(connection, change.clientId, change.accountId);
      const current = (
        await connection.query<Transition>(
          'SELECT * FROM auth_kind_consent_transition WHERE transition_id=$1 FOR UPDATE',
          [transition.transition_id],
        )
      ).rows[0];
      if (!current) return changeResult('pending', transition.transition_id);
      if (current.state === 'applied') return changeResult('applied', current.transition_id);
      if (current.state !== 'ready') return changeResult('pending', current.transition_id);
      const remaining = await connection.query(
        `SELECT 1 FROM auth_kind_consent_dependency WHERE active
         AND ($1::boolean OR (client_id=$2 AND ($3::text IS NULL OR account_id=$3)))
         AND enrollment_seq<=$4 LIMIT 1`,
        [current.transition_kind === 'restore', current.client_id, current.account_id, current.frontier_seq],
      );
      if (remaining.rowCount) return changeResult('pending', current.transition_id);
      await connection.query("SELECT set_config('auth.kind_consent_transition_id',$1,true)", [current.transition_id]);
      await change.apply(connection, current.transition_id);
      await connection.query(
        `UPDATE auth_kind_consent_transition SET state='applied',applied_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE transition_id=$1 AND state='ready'`,
        [current.transition_id],
      );
      return changeResult('applied', current.transition_id);
    });
  }

  const writer: KindConsentWriter = {
    async change(change) {
      const transition = await openTransition(change);
      if (!transition) return changeResult('pending', '');
      if (transition.state === 'applied') {
        const later = (
          await database.query<{ enrollment_seq: string }>(
            `SELECT min(enrollment_seq)::text AS enrollment_seq FROM auth_kind_consent_dependency
             WHERE active AND ($1::boolean OR (client_id=$2 AND ($3::text IS NULL OR account_id=$3)))
               AND enrollment_seq>$4`,
            [
              transition.transition_kind === 'restore',
              transition.client_id,
              transition.account_id,
              transition.frontier_seq,
            ],
          )
        ).rows[0]?.enrollment_seq;
        if (!later) return changeResult('applied', transition.transition_id);
        const replayKey = `kind-consent:late:${createHash('sha256')
          .update(JSON.stringify([change.transitionKey, later]))
          .digest('hex')}`;
        return writer.change({ ...change, transitionKey: replayKey });
      }
      const advanced =
        transition.state === 'pending'
          ? await transitionPage(transition.transition_id)
          : changeResult('applied', transition.transition_id);
      const current = (
        await database.query<Transition>('SELECT * FROM auth_kind_consent_transition WHERE transition_id=$1', [
          transition.transition_id,
        ])
      ).rows[0];
      if (!current) return changeResult('pending', transition.transition_id, advanced.work);
      if (current.state === 'applied') return changeResult('applied', current.transition_id, advanced.work);
      if (current.state === 'pending') return changeResult('pending', current.transition_id, advanced.work);
      const applied = await applyReady(change, current);
      return changeResult(applied.status, applied.transitionId, addWork(advanced.work, applied.work));
    },
    continueTransition: transitionPage,
    async continuePending() {
      const pending = await database.query<{ transition_id: string }>(
        `SELECT transition_id::text FROM auth_kind_consent_transition
         WHERE state='pending' ORDER BY created_at,transition_id LIMIT 1`,
      );
      const transitionId = pending.rows[0]?.transition_id;
      if (!transitionId) return null;
      return transitionPage(transitionId);
    },
    async fenceAll(input) {
      if (!identifier(input.transitionKey) || !identifier(input.identity)) return changeResult('pending', '');
      return writer.change({
        transitionKey: input.transitionKey,
        kind: 'restore',
        clientId: '*',
        target: { operation: input.operation, identity: input.identity },
        async apply() {},
      });
    },
    async current(accountId, clientId) {
      if (!identifier(accountId) || !identifier(clientId)) return false;
      const result = await database.query(
        `SELECT 1 FROM auth_kind_consent_transition WHERE state<>'applied' AND (transition_kind='restore' OR
          (client_id=$1 AND (account_id IS NULL OR account_id=$2))) LIMIT 1`,
        [clientId, accountId],
      );
      return result.rowCount === 0;
    },
  };

  return { participant, writer };
}

export { kindConsentOperationBound };
