import { statementBytes } from '../database/statement-bytes.ts';
/** Private native Kind evidence. References are locators, never read authority. */
import type { Pool, QueryResultRow } from 'pg';
import type { Access } from '../request/access.ts';
import type { PrepareKindAudienceInput } from '../access/kind-audience.ts';
import type {
  CollectionKindWorkDefinition,
  CollectionKindPreparationLocator,
} from '../library/collection-kind-work-admission.ts';
import type { CanonicalDerivedRow, CanonicalGroupProgress } from '../library/canonical-source-store.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/contract/work-dimensions.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { CollectionKindPreparationWorkContext } from '../search/scope-work-context.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  KIND_TYPE_MAX_BYTES,
  readNativeKindTypeAnchor,
  verifyNativeKindTypeAnchor,
  kindTypeAnchorFootprint,
  kindTypeAnchorLockFootprint,
  type NativeKindTypeAnchor,
} from './scope-leaf-selection.ts';
import { ProblemError } from '../http/problem-error.ts';
import bodyWrite from './kind-type-evidence-write.sql';
import bodyRead from './kind-type-evidence-read.sql';

/** One retained owner record in the existing Source home; possession grants nothing. */
export type KindTypeEvidenceReference = Readonly<{
  locator: CollectionKindPreparationLocator;
  evidenceId: string;
}>;

/** One original/group frontier; no subject vector, permission cache or second cursor. */
export type KindTypeEvidenceProgress = Readonly<{
  settledSubjectId: string | null;
  group: CanonicalGroupProgress | null;
}>;

export type KindTypeContribution = Readonly<{
  reference: CanonicalDerivedRow;
  typeId: string;
}>;

/** Accounts resolves these original lookup refs from Library's committed input
 * before detached preparation. They carry no admission or permission themselves.
 */
export type KindTypeEvidenceAudienceInput = Readonly<Pick<PrepareKindAudienceInput, 'origin' | 'input'>>;

export type KindTypeEvidenceReadInput = Readonly<{
  /** Library resolves its committed bounded attempt. No caller-supplied subjects. */
  locator: CollectionKindPreparationLocator;
  audience?: KindTypeEvidenceAudienceInput;
  allowance: WorkAllowance;
  deadline: number;
}>;
export type KindTypeEvidenceVerifyInput = Readonly<{
  work: CollectionKindPreparationWorkContext;
  evidence: KindTypeEvidenceReference;
  allowance: WorkAllowance;
  deadline: number;
}>;
export type KindTypeEvidenceUnavailable = Readonly<{
  status: 'unavailable';
  work: WorkReceipt;
}>;
export type KindTypeEvidenceReadResult =
  | KindTypeEvidenceUnavailable
  | Readonly<{
      status: 'prepared';
      evidence: KindTypeEvidenceReference;
      progress: KindTypeEvidenceProgress;
      work: WorkReceipt;
    }>;
export type KindTypeEvidenceVerifyResult =
  | KindTypeEvidenceUnavailable
  | Readonly<{
      status: 'current';
      contributions: readonly KindTypeContribution[];
      progress: KindTypeEvidenceProgress;
      work: WorkReceipt;
    }>;
export interface NativeKindTypeEvidence {
  /** Outside a Source transaction. Native producers must admit every home with its own live T. */
  read(input: KindTypeEvidenceReadInput): Promise<KindTypeEvidenceReadResult>;
  /** SAME Source only; no checkout, callback or foreign preparation inside this invocation. */
  verify(input: KindTypeEvidenceVerifyInput): Promise<KindTypeEvidenceVerifyResult>;
}

/** Native implementations still owed by the original owners. Accounts' literal
 * KindAudienceAccess is delivered; its staged factory supplies no admitted bound.
 */
export const KIND_TYPE_MISSING_OWNER_BINDINGS = Object.freeze([
  'Library collection-kind-work-admission.ts: committed bounded attempt lookup, original reference/frontier, audience origin and finite admission work receipt',
  'Accounts access/kind-audience.ts and access/permission.ts: native bodies and finite bounds for KindAudienceAccess, with all five original formula/negative/temporal/Type-disclosure/writer closures',
  'Core command/operational.ts: no installed original admission-to-NativeCollectionWork association lookup or detached per-home Kind admission; liveness does not bind a ledger',
  'Library collection-kind-work-admission.ts: installed admit/read exports take only tx and locator, throw dependency_unavailable, and declare no bounded shared-ledger invocation',
] as const);

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function validLocator(locator: CollectionKindPreparationLocator): boolean {
  return (
    !!locator &&
    isDeepStrictEqual(Object.keys(locator).sort(), ['collectionId', 'ownerAccountId', 'preparationId', 'route']) &&
    routeOf(locator.collectionId) !== null &&
    routeOf(locator.collectionId) === locator.route &&
    routeOf(locator.ownerAccountId) === locator.route &&
    uuid.test(locator.preparationId)
  );
}

/** Public authority boundary. Missing original owner admission refuses before ANY IO.
 * The independent native bodies below supply no substitute permission or lifecycle.
 */
export function createNativeKindTypeEvidence(config: Readonly<{ pool: Pool; access: Access }>): NativeKindTypeEvidence {
  return {
    async read(input) {
      const work = new NativeCollectionWork(input.allowance, input.deadline);
      if (!validLocator(input.locator) || Date.now() >= input.deadline)
        return { status: 'unavailable', work: work.receipt() };
      const audience = input.audience;
      const port = config.access.kindAudience;
      if (
        !audience ||
        !port ||
        !isDeepStrictEqual(audience.origin.locator, input.locator) ||
        !isDeepStrictEqual(audience.input.locator, input.locator)
      )
        return { status: 'unavailable', work: work.receipt() };
      const nativeInput: PrepareKindAudienceInput = {
        origin: audience.origin,
        input: audience.input,
        context: { pool: config.pool, deadline: input.deadline },
        allowance: input.allowance,
      };
      // This is the original owner's PURE declaration only. No run/actual or
      // authority follows from reference equality or a defined footprint.
      if (port.prepare.bound(nativeInput) === undefined) return { status: 'unavailable', work: work.receipt() };
      // No installed Core admission-to-ledger association or bounded Library
      // original input reader can enter captureNativeKindTypeDependency. The
      // complete independent native bodies must not be activated from these
      // caller lookup keys or a staged Accounts declaration.
      return { status: 'unavailable', work: work.receipt() };
    },
    async verify(input) {
      const work = new NativeCollectionWork(input.allowance, input.deadline);
      const context = input.work;
      if (
        context?.kind !== 'collection-kind-preparation' ||
        !validLocator(context.locator) ||
        !hasLiveOperationalTransaction(context.tx) ||
        !uuid.test(input.evidence.evidenceId) ||
        !validLocator(input.evidence.locator)
      )
        return { status: 'unavailable', work: work.receipt() };
      const resources = currentOperationalResources(context.tx);
      const time = commandTime(context.tx);
      if (
        !time ||
        resources.pool !== config.pool ||
        resources.mode !== 'work-step' ||
        resources.partition !== partitionOf(context.locator.route) ||
        resources.accounts.length !== 1 ||
        resources.accounts[0] !== context.locator.ownerAccountId ||
        input.deadline > resources.deadline ||
        Date.now() >= input.deadline ||
        !isDeepStrictEqual(context.locator, input.evidence.locator)
      )
        return { status: 'unavailable', work: work.receipt() };
      authoritativeTimeValue(time);
      // Core liveness is necessary, but cannot replace Library admission or the
      // Accounts native writer/negative/time closure. No foreign reread is legal here.
      return { status: 'unavailable', work: work.receipt() };
    },
  };
}

/** These native bodies consume the caller's EXISTING ledger and transaction.
 * They only produce/retain dependency data. In particular neither a successful
 * body write nor a local match is a prepared/current public evidence result.
 * Original admission, Accounts and whole-Kind closure remain separate operands.
 */
export const KIND_TYPE_BODY_MAX_BYTES = 16_384;
export const KIND_TYPE_BINDING_MAX_BYTES = 16_384;
export const KIND_TYPE_PROGRESS_MAX_BYTES = 4096;

export type KindTypeDisclosureProjection = 'readable' | 'denied';
export type NativeKindTypeDependencyBody = Readonly<{
  dependencies: KindTypeDependencyProjection;
  originalDisclosure: KindTypeDisclosureProjection;
  terminalDisclosure: KindTypeDisclosureProjection;
  releaseDigest: string;
}>;

/** Exact owner records are retained as data, not reinterpreted as admission.
 * The original producer must resolve these records, including its private
 * admission association, before it can promote a body to public evidence.
 */
export type NativeKindTypeBodyBinding = Readonly<{
  locator: CollectionKindPreparationLocator;
  audience: KindTypeEvidenceAudienceInput;
  definition: CollectionKindWorkDefinition;
}>;
export type NativeKindTypeRetainedBody = Readonly<{
  binding: NativeKindTypeBodyBinding;
  body: NativeKindTypeDependencyBody;
  progress: KindTypeEvidenceProgress;
}>;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const jsonData = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)) ?? 'null',
  );
const sha256 = /^sha256:[0-9a-f]{64}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const drivers = ['member', 'entry', 'label', 'session', 'copy', 'output'];
const validDisclosure = (value: KindTypeDisclosureProjection): boolean => value === 'readable' || value === 'denied';

/** SQL limits are measured on jsonb::text. JSON string escaping is at most six
 * bytes per source byte; allow PostgreSQL's separators and fixed scalar keys too.
 * No result-row count refunds the native row-work declaration.
 */
function recordFootprint(sql: string, values: readonly unknown[], write: boolean): WorkDimensions {
  return {
    candidateKeys: 1,
    // INSERT/conflict or the exact retained point plus its final row lock.
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 2,
    witnessKeys: 0,
    statements: 1,
    bytes:
      Buffer.byteLength(sql) +
      bytes(values) +
      (write
        ? 256
        : 6 * (KIND_TYPE_BODY_MAX_BYTES + KIND_TYPE_BINDING_MAX_BYTES + KIND_TYPE_PROGRESS_MAX_BYTES) + 1024),
    emptySeeks: 1,
  };
}

/** Literal statement declarations only. Controls, owner admission/Access, Source
 * population/custody and the enclosing transaction are NOT included in this local
 * body quote. An unknown statement has no bound, including an empty seek.
 */
export function kindTypeEvidenceBodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  if (sql === bodyWrite.sql) return recordFootprint(sql, values, true);
  if (sql === bodyRead.sql) return recordFootprint(sql, values, false);
  return undefined;
}

/** Complete local worst case for one raw reference: original+terminal capture,
 * insert, immutable readback, final retained read and both final anchor checks.
 * Parameter bytes include each repeated SQL text and its actual encoded values.
 * This is deliberately NOT a whole-parent/transaction admission declaration.
 */
export function kindTypeEvidenceLocalFootprint(
  input: Readonly<{
    anchorInputBytes: number;
    lockInputBytes: number;
    writeValues: readonly unknown[];
    readValues: readonly unknown[];
  }>,
): WorkDimensions {
  for (const value of [input.anchorInputBytes, input.lockInputBytes])
    if (!Number.isSafeInteger(value) || value < 0 || value > 8192) throw new TypeError('Invalid Kind Type byte bound');
  const anchor = kindTypeAnchorFootprint(input.anchorInputBytes);
  const lock = kindTypeAnchorLockFootprint(input.lockInputBytes);
  const write = recordFootprint(bodyWrite.sql, input.writeValues, true);
  const read = recordFootprint(bodyRead.sql, input.readValues, false);
  return {
    candidateKeys: 4 * (anchor.candidateKeys + lock.candidateKeys) + write.candidateKeys + 2 * read.candidateKeys,
    nativeRows: 4 * (anchor.nativeRows + lock.nativeRows) + write.nativeRows + 2 * read.nativeRows,
    identityMetadataRows: 0,
    nativePoints: 4 * (anchor.nativePoints + lock.nativePoints) + write.nativePoints + 2 * read.nativePoints,
    witnessKeys: 0,
    statements: 4 * (anchor.statements + lock.statements) + write.statements + 2 * read.statements,
    bytes: 4 * (anchor.bytes + lock.bytes) + write.bytes + 2 * read.bytes,
    emptySeeks: 4 * (anchor.emptySeeks + lock.emptySeeks) + write.emptySeeks + 2 * read.emptySeeks,
  };
}

/** An invocation pin detects mutation/replacement across awaits. It does not
 * mint the absent private original admission or associate a new ledger with Core.
 * Only the exact native body uses this pin; it cannot be serialized as authority.
 */
class KindTypeBodyInvocation {
  readonly time: ReturnType<typeof commandTime>;
  readonly locator: CollectionKindPreparationLocator;
  readonly tx: OperationalTransaction;
  constructor(
    readonly pool: Pool,
    readonly context: CollectionKindPreparationWorkContext,
    readonly work: NativeCollectionWork,
    readonly deadline: number,
  ) {
    this.tx = context.tx;
    this.locator = Object.freeze({ ...context.locator });
    this.time = commandTime(this.tx);
    this.current();
    // This base's actual Core exports cannot authenticate the association of
    // this ledger with this invocation, and Library's installed admit/read
    // exports have neither a ledger operand nor finite declarations. Do not
    // infer the different retained branch ABI, accept a same-shaped handle, or
    // let a raw body become an unadmitted native entry point. The bodies below
    // are complete independently of that exact original-owner operation; only
    // owner delivery of the association can enable their dispatch.
    throw new ProblemError('dependency_unavailable');
  }
  current(): void {
    if (
      !(this.work instanceof NativeCollectionWork) ||
      !this.time ||
      this.context.kind !== 'collection-kind-preparation' ||
      this.context.tx !== this.tx ||
      !isDeepStrictEqual(this.context.locator, this.locator) ||
      !validLocator(this.locator) ||
      !hasLiveOperationalTransaction(this.tx) ||
      !Number.isFinite(this.deadline) ||
      Date.now() >= this.deadline ||
      commandTime(this.tx) !== this.time
    )
      throw new ProblemError('dependency_unavailable');
    const resources = currentOperationalResources(this.tx);
    if (
      resources.pool !== this.pool ||
      resources.mode !== 'work-step' ||
      resources.partition !== partitionOf(this.locator.route) ||
      resources.accounts.length !== 1 ||
      resources.accounts[0] !== this.locator.ownerAccountId ||
      resources.deadline !== this.deadline
    )
      throw new ProblemError('dependency_unavailable');
    authoritativeTimeValue(this.time);
    this.work.assertReady();
  }
  home(subjectId: string): number {
    this.current();
    const route = routeOf(subjectId);
    if (route === null || partitionOf(route) !== partitionOf(this.locator.route))
      throw new ProblemError('dependency_unavailable');
    return route;
  }
}

function validReference(reference: CanonicalDerivedRow): boolean {
  return (
    !!reference &&
    routeOf(reference.canonicalSubjectId) !== null &&
    !!reference.key &&
    drivers.includes(reference.key.driver) &&
    routeOf(reference.key.storedSubjectId) !== null &&
    uuid.test(reference.key.factId)
  );
}

/** Native data capture ONLY. Disclosure projections are decisions already made
 * by the original owner, never accepted by the public producer as authority.
 * Observe the original first, even when excluded, then retain the exact one-hop
 * terminal dependency. No terminal Type is read for an unreadable original.
 * No connection checkout, foreign home, new reservation or time is created here.
 */
export async function captureNativeKindTypeDependency(
  pool: Pool,
  context: CollectionKindPreparationWorkContext,
  input: Readonly<{
    reference: CanonicalDerivedRow;
    originalDisclosure: KindTypeDisclosureProjection;
    terminalDisclosure: KindTypeDisclosureProjection;
    releaseDigest: string;
  }>,
  work: NativeCollectionWork,
  deadline: number,
): Promise<NativeKindTypeDependencyBody> {
  const invocation = new KindTypeBodyInvocation(pool, context, work, deadline);
  const snapshot = structuredClone(input);
  if (
    context.kind !== 'collection-kind-preparation' ||
    !validReference(snapshot.reference) ||
    !sha256.test(snapshot.releaseDigest) ||
    !validDisclosure(snapshot.originalDisclosure) ||
    !validDisclosure(snapshot.terminalDisclosure)
  )
    throw new ProblemError('dependency_unavailable');
  // Preflight BOTH homes before the first lock or observation. An excluded
  // original cannot silently drop a foreign/unsupported terminal dependency.
  const originalRoute = invocation.home(snapshot.reference.key.storedSubjectId);
  const terminalRoute = invocation.home(snapshot.reference.canonicalSubjectId);
  const original = await readNativeKindTypeAnchor(
    invocation.tx,
    {
      route: originalRoute,
      subjectId: snapshot.reference.key.storedSubjectId,
      includeType: false,
    },
    work,
    deadline,
  );
  invocation.current();
  const includeType =
    snapshot.originalDisclosure === 'readable' &&
    original.present &&
    original.visibility === 'visible' &&
    snapshot.terminalDisclosure === 'readable';
  const terminal = await readNativeKindTypeAnchor(
    invocation.tx,
    {
      route: terminalRoute,
      subjectId: snapshot.reference.canonicalSubjectId,
      includeType,
    },
    work,
    deadline,
  );
  invocation.current();
  const body: NativeKindTypeDependencyBody = {
    dependencies: { reference: snapshot.reference, original, terminal },
    originalDisclosure: snapshot.originalDisclosure,
    terminalDisclosure: snapshot.terminalDisclosure,
    releaseDigest: snapshot.releaseDigest,
  };
  if (bytes(body) > KIND_TYPE_BODY_MAX_BYTES) throw new ProblemError('dependency_unavailable');
  return body;
}

function bodySelection(body: NativeKindTypeDependencyBody): KindTypeSelection {
  const dependencies = body.dependencies;
  if (
    !completeProvenance(dependencies.original) ||
    !dependencies.terminal ||
    !completeProvenance(dependencies.terminal)
  )
    return { state: 'unavailable', dependencies };
  if (body.originalDisclosure === 'denied' || body.terminalDisclosure === 'denied')
    return { state: 'excluded', dependencies };
  return selectNativeKindTypeDependency(dependencies);
}

function validateRetainedBody(value: NativeKindTypeRetainedBody): void {
  const { binding, body, progress } = value;
  const locator = binding.locator;
  const source = binding.definition.sourceIdentity;
  if (
    !validLocator(locator) ||
    !validReference(body.dependencies.reference) ||
    !validDisclosure(body.originalDisclosure) ||
    !validDisclosure(body.terminalDisclosure) ||
    !isDeepStrictEqual(binding.audience.origin.locator, locator) ||
    !isDeepStrictEqual(binding.audience.input.locator, locator) ||
    binding.audience.origin.kind !== 'collection-kind-audience-origin' ||
    !uuid.test(binding.audience.origin.id) ||
    binding.audience.input.kind !== 'collection-kind-audience-input' ||
    !uuid.test(binding.audience.input.id) ||
    !sha256.test(body.releaseDigest) ||
    binding.definition.releaseDigest !== body.releaseDigest ||
    source.route !== locator.route ||
    source.collectionId !== locator.collectionId ||
    (source.scope !== 'public_output' && source.accountId !== locator.ownerAccountId) ||
    !isDeepStrictEqual(source, binding.definition.custody.identity) ||
    binding.definition.observation.incarnation !== source.incarnation ||
    !isDeepStrictEqual(binding.definition.identityObservation.key.source, { kind: 'library', identity: source }) ||
    bytes(jsonData(binding)) > KIND_TYPE_BINDING_MAX_BYTES ||
    bytes(body) > KIND_TYPE_BODY_MAX_BYTES ||
    bytes(progress) > KIND_TYPE_PROGRESS_MAX_BYTES ||
    (progress.settledSubjectId !== null && routeOf(progress.settledSubjectId) === null) ||
    (progress.group !== null && routeOf(progress.group.pendingSubjectId) === null) ||
    body.dependencies.original.subject_id !== body.dependencies.reference.key.storedSubjectId ||
    !body.dependencies.terminal ||
    body.dependencies.terminal.subject_id !== body.dependencies.reference.canonicalSubjectId ||
    !decimal.test(body.dependencies.original.writer_version) ||
    !decimal.test(body.dependencies.terminal.writer_version)
  )
    throw new ProblemError('dependency_unavailable');
  const selection = bodySelection(body);
  const contributions =
    selection.state === 'candidate' ? [{ reference: body.dependencies.reference, typeId: selection.typeId }] : [];
  if (bytes({ contributions, progress }) > KIND_TYPE_PROGRESS_MAX_BYTES)
    throw new ProblemError('dependency_unavailable');
  // Even denied originals retain only structural headers; terminal Type cannot
  // leak into durable data for an excluded/hidden/missing original.
  if (
    body.dependencies.original.type !== null ||
    ((body.originalDisclosure === 'denied' ||
      body.terminalDisclosure === 'denied' ||
      !body.dependencies.original.present ||
      body.dependencies.original.visibility !== 'visible') &&
      (body.dependencies.terminal.type !== null || body.dependencies.terminal.type_oversized))
  )
    throw new ProblemError('dependency_unavailable');
}

type RetainedRow = QueryResultRow & {
  binding: unknown;
  body: NativeKindTypeDependencyBody;
  progress: KindTypeEvidenceProgress;
  producer_transaction: string;
};

async function bodyQuery<R extends QueryResultRow>(
  invocation: KindTypeBodyInvocation,
  statement: Readonly<{ sql: string; params: readonly string[] }>,
  parameters: Readonly<Record<string, unknown>>,
): Promise<readonly R[]> {
  invocation.current();
  const values = statement.params.map((name) => parameters[name]);
  const footprint = kindTypeEvidenceBodyFootprint(statement.sql, values);
  const reservation = invocation.work.reserve(footprint);
  reservation.dispatch();
  try {
    const query = {
      text: statement.sql,
      values,
      query_timeout: Math.max(1, invocation.deadline - Date.now()),
    };
    const result = await reservation.query(() => invocation.tx.query<R>(query));
    invocation.current();
    if (result.rows.length > 1) throw new ProblemError('dependency_unavailable');
    reservation.settle({
      bytes: statementBytes(statement) + bytes(values) + bytes(result.rows),
      emptySeeks: result.rows.length ? 0 : 1,
    });
    return result.rows;
  } catch (error) {
    reservation.settle();
    if (error instanceof Error)
      Object.defineProperty(error, 'work', { get: () => invocation.work.receipt(), configurable: true });
    throw error;
  }
}

const recordKey = (reference: KindTypeEvidenceReference) => ({
  route: reference.locator.route,
  owner_account_id: reference.locator.ownerAccountId,
  collection_id: reference.locator.collectionId,
  preparation_id: reference.locator.preparationId,
  evidence_id: reference.evidenceId,
});

/** Immutable retained dependency registration. Its result is deliberately void:
 * a body registered here supplies no successful read, admission, custody or root
 * closure. The authentic original admission association is not installed on this
 * base, so the public producer cannot promote these raw records to evidence.
 * Collision readback must match EVERY byte of the episode/body/frontier data.
 */
export async function retainNativeKindTypeDependencyBody(
  pool: Pool,
  context: CollectionKindPreparationWorkContext,
  reference: KindTypeEvidenceReference,
  value: NativeKindTypeRetainedBody,
  work: NativeCollectionWork,
  deadline: number,
): Promise<void> {
  const invocation = new KindTypeBodyInvocation(pool, context, work, deadline);
  const snapshot = structuredClone(value);
  const key = Object.freeze(recordKey(reference));
  if (
    context.kind !== 'collection-kind-preparation' ||
    !uuid.test(reference.evidenceId) ||
    !isDeepStrictEqual(reference.locator, invocation.locator) ||
    !isDeepStrictEqual(snapshot.binding.locator, invocation.locator)
  )
    throw new ProblemError('dependency_unavailable');
  validateRetainedBody(snapshot);
  invocation.home(snapshot.body.dependencies.original.subject_id);
  invocation.home(snapshot.body.dependencies.terminal!.subject_id);
  await bodyQuery(invocation, bodyWrite, {
    ...key,
    binding: JSON.stringify(jsonData(snapshot.binding)),
    body: JSON.stringify(snapshot.body),
    progress: JSON.stringify(snapshot.progress),
  });
  const rows = await bodyQuery<RetainedRow>(invocation, bodyRead, key);
  const row = rows[0];
  if (
    !row ||
    !row.producer_transaction ||
    !isDeepStrictEqual(row.binding, jsonData(snapshot.binding)) ||
    !isDeepStrictEqual(row.body, snapshot.body) ||
    !isDeepStrictEqual(row.progress, snapshot.progress)
  )
    throw new ProblemError('dependency_unavailable');
}

/** Durable native lookup. Compare against original owner data supplied by the
 * actual original resolver, not a restored definition/principal from this table.
 * The returned projection deliberately carries no admission/current status.
 */
export async function readNativeKindTypeDependencyBody(
  pool: Pool,
  context: CollectionKindPreparationWorkContext,
  reference: KindTypeEvidenceReference,
  binding: NativeKindTypeBodyBinding,
  work: NativeCollectionWork,
  deadline: number,
): Promise<Readonly<{
  body: NativeKindTypeDependencyBody;
  progress: KindTypeEvidenceProgress;
  producerTransaction: string;
}> | null> {
  const invocation = new KindTypeBodyInvocation(pool, context, work, deadline);
  const snapshot = structuredClone(binding);
  const key = Object.freeze(recordKey(reference));
  if (
    context.kind !== 'collection-kind-preparation' ||
    !uuid.test(reference.evidenceId) ||
    !isDeepStrictEqual(reference.locator, invocation.locator) ||
    !isDeepStrictEqual(snapshot.locator, invocation.locator)
  )
    throw new ProblemError('dependency_unavailable');
  const rows = await bodyQuery<RetainedRow>(invocation, bodyRead, key);
  const row = rows[0];
  if (!row || !isDeepStrictEqual(row.binding, jsonData(snapshot))) return null;
  validateRetainedBody({ binding: snapshot, body: row.body, progress: row.progress });
  invocation.home(row.body.dependencies.original.subject_id);
  invocation.home(row.body.dependencies.terminal!.subject_id);
  return { body: row.body, progress: row.progress, producerTransaction: row.producer_transaction };
}

/** Final SAME-home native data comparison. It retains the original AND terminal
 * writer locks in the caller's actual transaction until its commit/rollback.
 * It never opens another home or claims Accounts/Source/root authority. The
 * caller must separately verify the original admission association and all foreign
 * closures before exposing a public `current` result or adopting a contribution.
 */
export async function compareNativeKindTypeDependencyBody(
  pool: Pool,
  context: CollectionKindPreparationWorkContext,
  reference: KindTypeEvidenceReference,
  expected: NativeKindTypeRetainedBody,
  work: NativeCollectionWork,
  deadline: number,
): Promise<KindTypeSelection | null> {
  const invocation = new KindTypeBodyInvocation(pool, context, work, deadline);
  const snapshot = structuredClone(expected);
  const key = Object.freeze(recordKey(reference));
  if (
    context.kind !== 'collection-kind-preparation' ||
    !uuid.test(reference.evidenceId) ||
    !isDeepStrictEqual(reference.locator, invocation.locator) ||
    !isDeepStrictEqual(snapshot.binding.locator, invocation.locator)
  )
    throw new ProblemError('dependency_unavailable');
  validateRetainedBody(snapshot);
  const { original, terminal } = snapshot.body.dependencies;
  // Reject all foreign homes before dispatch, even on excluded branches.
  const originalRoute = invocation.home(original.subject_id);
  const terminalRoute = invocation.home(terminal!.subject_id);
  const rows = await bodyQuery<RetainedRow>(invocation, bodyRead, key);
  const row = rows[0];
  if (
    !row ||
    !isDeepStrictEqual(row.binding, jsonData(snapshot.binding)) ||
    !isDeepStrictEqual(row.body, snapshot.body) ||
    !isDeepStrictEqual(row.progress, snapshot.progress)
  )
    return null;
  const originalCurrent = await verifyNativeKindTypeAnchor(
    invocation.tx,
    {
      route: originalRoute,
      expected: original,
      includeType: false,
    },
    work,
    deadline,
  );
  invocation.current();
  // Always verify both, even after a stale/denied original, with the same paid
  // plan. A failed original cannot choose a cheaper unaccounted terminal branch.
  const terminalCurrent = await verifyNativeKindTypeAnchor(
    invocation.tx,
    {
      route: terminalRoute,
      expected: terminal!,
      includeType:
        snapshot.body.originalDisclosure === 'readable' &&
        original.present &&
        original.visibility === 'visible' &&
        snapshot.body.terminalDisclosure === 'readable',
    },
    work,
    deadline,
  );
  invocation.current();
  return originalCurrent && terminalCurrent ? bodySelection(snapshot.body) : null;
}

/** Internal structural dependencies. An excluded original is retained even when
 * it contributes nothing. These values deliberately cannot be passed to verify
 * as evidence: native records, original admissions and Accounts are still owed.
 */
export type KindTypeDependencyProjection = Readonly<{
  reference: CanonicalDerivedRow;
  original: NativeKindTypeAnchor;
  terminal: NativeKindTypeAnchor | null;
}>;
export type KindTypeSelection =
  | Readonly<{ state: 'unavailable'; dependencies: KindTypeDependencyProjection }>
  | Readonly<{ state: 'excluded'; dependencies: KindTypeDependencyProjection }>
  | Readonly<{
      state: 'candidate';
      typeId: string;
      dependencies: KindTypeDependencyProjection;
    }>;

function completeProvenance(anchor: NativeKindTypeAnchor): boolean {
  if (
    !anchor.writer_enrolled ||
    !decimal.test(anchor.writer_version) ||
    BigInt(anchor.writer_version) > 9_223_372_036_854_775_807n
  )
    return false;
  if (!anchor.present) return true;
  return (
    (anchor.visibility === 'visible' || anchor.visibility === 'hidden' || anchor.visibility === 'taken_down') &&
    anchor.revision !== null &&
    anchor.revision_transaction !== null &&
    anchor.revision_epoch !== null &&
    anchor.revision_position !== null &&
    anchor.current_release !== null &&
    sha256.test(anchor.current_release) &&
    (anchor.redirect === null ||
      (anchor.redirect_sequence !== null &&
        anchor.redirect_transaction !== null &&
        anchor.redirect_epoch !== null &&
        anchor.redirect_position !== null))
  );
}

/** Select only the native field dependency. This is NOT an audience decision or
 * vote, and the public producer never accepts a caller's projection as proof.
 * Library's existing terminal uniqueness/count CAS consumes admitted support,
 * so every duplicate raw reference remains a dependency without a seen vector.
 */
export function selectNativeKindTypeDependency(dependencies: KindTypeDependencyProjection): KindTypeSelection {
  const { reference, original, terminal } = dependencies;
  const result = (state: 'excluded' | 'unavailable'): KindTypeSelection => ({ state, dependencies });
  if (original.subject_id !== reference.key.storedSubjectId) return result('unavailable');
  if (!completeProvenance(original)) return result('unavailable');
  if (!original.present || original.visibility !== 'visible') return result('excluded');
  if ((original.redirect ?? original.subject_id) !== reference.canonicalSubjectId) return result('unavailable');
  if (!terminal || terminal.subject_id !== reference.canonicalSubjectId || !completeProvenance(terminal))
    return result('unavailable');
  if (!terminal.present || terminal.visibility !== 'visible') return result('excluded');
  if (terminal.redirect !== null || terminal.type_oversized || terminal.type === null) return result('unavailable');
  if (Buffer.byteLength(terminal.type) > KIND_TYPE_MAX_BYTES) return result('unavailable');
  // The native Kind contribution/progress envelope is still 4096 bytes. A Type
  // that fits its guarded field read can nevertheless exceed the whole envelope.
  if (Buffer.byteLength(JSON.stringify({ reference, typeId: terminal.type })) > KIND_TYPE_MAX_BYTES)
    return result('unavailable');
  return { state: 'candidate', typeId: terminal.type, dependencies };
}
