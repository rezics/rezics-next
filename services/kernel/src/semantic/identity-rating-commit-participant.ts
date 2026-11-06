import { memoizedValue } from '../memoized.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { currentCommand, currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { ratingReviewOf, VoteReviewUnavailableError } from './adapters/rating-review.ts';
import {
  IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS,
  IDENTITY_RATING_REVIEW_MAX_KEYS,
  IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES,
} from './identity-core/rating-review-bounds.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  classifyIdentityRatingReviewEvidence,
  identityRatingReviewEvidence,
  readIdentityRatingEvidenceInTransaction,
  type IdentityRatingControlLocator,
  type IdentityRatingNativeEvidence,
  type IdentityRatingReviewOperand,
  type IdentityRatingReviewResult,
} from './identity-adapters/identity-epoch-read.ts';
import lockOwner from './identity-rating-commit-participant-lock-owner.sql';

const MAX_REVIEW_KEYS = IDENTITY_RATING_REVIEW_MAX_KEYS;
const MAX_REVIEW_CONTROL_LOCATORS = IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS;
const MAX_REVIEW_OPERAND_BYTES = IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES;
const U64_MAX = 18_446_744_073_709_551_615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

declare const preparation: unique symbol;

/** Factory-local immutable input only; it conveys neither authorization nor a held lock. */
export type IdentityRatingCommitPreparation = Readonly<{ [preparation]: true }>;
export type IdentityRatingCommitHeld = Readonly<{
  ownerId: string;
  ownerEpoch: number;
  partition: number;
  subjectId: string;
  publishedHeads: readonly Readonly<{
    partition: number;
    group: string;
    epoch: string;
  }>[];
}>;
export type IdentityRatingCommitParticipant = Readonly<{
  prepare(operand: IdentityRatingReviewOperand): IdentityRatingCommitPreparation;
  /** Fresh command body only, after receipt lookup and before no-op, cleanup or effects. */
  admit(tx: CommandTransaction, prepared: IdentityRatingCommitPreparation): Promise<IdentityRatingCommitHeld>;
}>;

type EvidenceRecord = Record<string, unknown>;
type ParsedRatingEvidence = Readonly<{
  mapping: Readonly<{
    sourceOwners: readonly EvidenceRecord[];
    sourceRows: readonly EvidenceRecord[];
    controlOwners: readonly EvidenceRecord[];
    pendingRows: readonly EvidenceRecord[];
    currentRows: readonly EvidenceRecord[];
  }>;
  subjects: readonly EvidenceRecord[];
  controlLocators: readonly IdentityRatingControlLocator[];
}>;

function invalid(): never {
  throw new TypeError('Invalid identity rating review operand');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isPartition(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 4095;
}

function isU64(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

function unique<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

function sortLocators(locators: readonly IdentityRatingControlLocator[]): IdentityRatingControlLocator[] {
  return [...locators].sort((left, right) => left.partition - right.partition || left.group.localeCompare(right.group));
}

function validateEvidenceString(
  encoded: string,
  sourceIdentities: readonly string[],
  sourceHomes: readonly number[],
  controlLocators: readonly IdentityRatingControlLocator[],
): ParsedRatingEvidence {
  let evidence: unknown;
  try {
    evidence = JSON.parse(encoded);
  } catch {
    return invalid();
  }
  if (!record(evidence) || !exactKeys(evidence, ['mapping', 'subjects']) || typeof evidence.mapping !== 'string')
    return invalid();
  if (JSON.stringify(evidence) !== encoded || Buffer.byteLength(encoded, 'utf8') > MAX_REVIEW_OPERAND_BYTES)
    return invalid();
  let mapping: unknown;
  try {
    mapping = JSON.parse(evidence.mapping);
  } catch {
    return invalid();
  }
  if (
    !record(mapping) ||
    !exactKeys(mapping, ['sourceOwners', 'sourceRows', 'controlOwners', 'pendingRows', 'currentRows']) ||
    JSON.stringify(mapping) !== evidence.mapping
  )
    return invalid();
  const arrays = ['sourceOwners', 'sourceRows', 'controlOwners', 'pendingRows', 'currentRows'] as const;
  if (arrays.some((name) => !Array.isArray(mapping[name]))) return invalid();
  const mappingArrays = Object.fromEntries(arrays.map((name) => [name, mapping[name] as unknown[]])) as Record<
    (typeof arrays)[number],
    unknown[]
  >;
  if (
    mappingArrays.sourceOwners.length > MAX_REVIEW_KEYS ||
    mappingArrays.sourceRows.length !== sourceIdentities.length ||
    mappingArrays.controlOwners.length > MAX_REVIEW_CONTROL_LOCATORS ||
    mappingArrays.pendingRows.length > MAX_REVIEW_CONTROL_LOCATORS ||
    mappingArrays.currentRows.length > MAX_REVIEW_KEYS * MAX_REVIEW_CONTROL_LOCATORS
  )
    return invalid();

  const sourceOwnerKeys = ['partition_no', 'epoch', 'write_state'];
  const sourceRowKeys = [
    'subject_id',
    'original',
    'control_partition',
    'control_group',
    'epoch',
    'owner_epoch',
    'dirty_revision',
    'captured_revision',
    'terminal',
    'closure_state',
    'closure_immediate',
    'current_target',
    'source_revision',
    'closure_enrollment',
    'closure_generation',
    'closure_incarnation',
    'closure_install_transaction',
    'closure_registration_transaction',
    'closure_export_transaction',
  ];
  const pendingKeys = ['partition_no', 'terminal', 'pending_job', 'pending_epoch'];
  const currentRowKeys = [
    'partition_no',
    'terminal',
    'published_epoch',
    'owner_epoch',
    'generation',
    'closure_state',
    'closure_incarnation',
    'requested_original',
    'directory_state',
    'directory_enrollment',
    'directory_incarnation',
    'directory_install',
    'directory_export',
    'directory_revision',
    'directory_owner',
    'registration_transaction',
    'redirected',
  ];
  const validOwner = (row: unknown) =>
    record(row) &&
    exactKeys(row, sourceOwnerKeys) &&
    isPartition(row.partition_no) &&
    Number.isSafeInteger(row.epoch) &&
    Number(row.epoch) >= 1 &&
    typeof row.write_state === 'string' &&
    row.write_state.length > 0 &&
    row.write_state.length <= 32;
  const validSource = (row: unknown) =>
    record(row) &&
    exactKeys(row, sourceRowKeys) &&
    isUuid(row.subject_id) &&
    isUuid(row.original) &&
    isPartition(row.control_partition) &&
    isUuid(row.control_group) &&
    isU64(row.epoch) &&
    Number.isSafeInteger(row.owner_epoch) &&
    Number(row.owner_epoch) >= 1 &&
    isU64(row.dirty_revision) &&
    isU64(row.captured_revision) &&
    isUuid(row.terminal) &&
    typeof row.closure_state === 'string' &&
    row.closure_state.length > 0 &&
    row.closure_state.length <= 32 &&
    (row.closure_immediate === null || isUuid(row.closure_immediate)) &&
    (row.current_target === null || isUuid(row.current_target)) &&
    isU64(row.source_revision) &&
    (row.closure_enrollment === null || isUuid(row.closure_enrollment)) &&
    (row.closure_generation === null || isUuid(row.closure_generation)) &&
    (row.closure_incarnation === null || isUuid(row.closure_incarnation)) &&
    (row.closure_install_transaction === null || isUuid(row.closure_install_transaction)) &&
    (row.closure_registration_transaction === null || isUuid(row.closure_registration_transaction)) &&
    (row.closure_export_transaction === null || isUuid(row.closure_export_transaction));
  const validPending = (row: unknown) =>
    record(row) &&
    exactKeys(row, pendingKeys) &&
    isPartition(row.partition_no) &&
    isUuid(row.terminal) &&
    (row.pending_job === null ? row.pending_epoch === null : isUuid(row.pending_job) && isU64(row.pending_epoch));
  const validCurrent = (row: unknown) =>
    record(row) &&
    exactKeys(row, currentRowKeys) &&
    isPartition(row.partition_no) &&
    isUuid(row.terminal) &&
    isU64(row.published_epoch) &&
    Number.isSafeInteger(row.owner_epoch) &&
    Number(row.owner_epoch) >= 1 &&
    isUuid(row.generation) &&
    typeof row.closure_state === 'string' &&
    row.closure_state.length > 0 &&
    row.closure_state.length <= 32 &&
    (row.closure_incarnation === null || isUuid(row.closure_incarnation)) &&
    isUuid(row.requested_original) &&
    (row.directory_state === null || (typeof row.directory_state === 'string' && row.directory_state.length <= 32)) &&
    (row.directory_enrollment === null || isUuid(row.directory_enrollment)) &&
    (row.directory_incarnation === null || isUuid(row.directory_incarnation)) &&
    (row.directory_install === null || isUuid(row.directory_install)) &&
    (row.directory_export === null || isUuid(row.directory_export)) &&
    (row.directory_revision === null || isU64(row.directory_revision)) &&
    (row.directory_owner === null || (Number.isSafeInteger(row.directory_owner) && Number(row.directory_owner) >= 1)) &&
    (row.registration_transaction === null || isUuid(row.registration_transaction)) &&
    typeof row.redirected === 'boolean';
  const subjects = evidence.subjects;
  if (
    !Array.isArray(subjects) ||
    subjects.length !== sourceIdentities.length ||
    !subjects.every(
      (row) =>
        record(row) &&
        exactKeys(row, ['subject_id', 'visibility']) &&
        isUuid(row.subject_id) &&
        typeof row.visibility === 'string' &&
        row.visibility.length > 0 &&
        row.visibility.length <= 32,
    )
  )
    return invalid();
  if (
    !mappingArrays.sourceOwners.every(validOwner) ||
    !mappingArrays.sourceRows.every(validSource) ||
    !mappingArrays.controlOwners.every(validOwner) ||
    !mappingArrays.pendingRows.every(validPending) ||
    !mappingArrays.currentRows.every(validCurrent)
  )
    return invalid();

  const sources = mappingArrays.sourceRows as EvidenceRecord[];
  const owners = mappingArrays.sourceOwners as EvidenceRecord[];
  const controls = mappingArrays.controlOwners as EvidenceRecord[];
  const pendingRows = mappingArrays.pendingRows as EvidenceRecord[];
  const currentRows = mappingArrays.currentRows as EvidenceRecord[];
  const disclosureRows = subjects as EvidenceRecord[];
  const sourceIds = [...sourceIdentities].sort();
  const sourceOwnerHomes = [...sourceHomes].sort((a, b) => a - b);
  const locatorKeys = sortLocators(controlLocators).map((row) => `${row.partition}:${row.group}`);
  const sourceLocators = sources
    .map((row) => `${row.control_partition as number}:${row.control_group as string}`)
    .filter((key, index, all) => all.indexOf(key) === index)
    .sort();
  const expectedOwnerHomes = sourceOwnerHomes;
  const expectedControlHomes = [...new Set(controlLocators.map((row) => row.partition))].sort((a, b) => a - b);
  const currentKeys = currentRows.map(
    (row) => `${row.partition_no as number}:${row.terminal as string}:${row.requested_original as string}`,
  );
  const expectedCurrentKeys = sources
    .map((row) => `${row.control_partition as number}:${row.control_group as string}:${row.original as string}`)
    .sort();
  const sortedCurrentKeys = [...currentKeys].sort();
  const pendingKeysActual = pendingRows.map((row) => `${row.partition_no}:${row.terminal}`).sort();
  if (
    sources
      .map((row) => row.subject_id as string)
      .sort()
      .some((id, index) => id !== sourceIds[index]) ||
    disclosureRows
      .map((row) => row.subject_id as string)
      .sort()
      .some((id, index) => id !== sourceIds[index]) ||
    owners
      .map((row) => row.partition_no as number)
      .sort((a, b) => a - b)
      .some((home, index) => home !== expectedOwnerHomes[index]) ||
    owners.length !== expectedOwnerHomes.length ||
    controls
      .map((row) => row.partition_no as number)
      .sort((a, b) => a - b)
      .some((home, index) => home !== expectedControlHomes[index]) ||
    controls.length !== expectedControlHomes.length ||
    sourceLocators.length !== locatorKeys.length ||
    sourceLocators.some((key, index) => key !== locatorKeys[index]) ||
    !unique(sources, (row) => row.subject_id as string) ||
    !unique(owners, (row) => String(row.partition_no)) ||
    !unique(controls, (row) => String(row.partition_no)) ||
    !unique(pendingRows, (row) => `${row.partition_no}:${row.terminal}`) ||
    !unique(currentRows, (row) => `${row.partition_no}:${row.terminal}:${row.requested_original}`) ||
    !unique(disclosureRows, (row) => row.subject_id as string) ||
    pendingKeysActual.length !== locatorKeys.length ||
    pendingKeysActual.some((key, index) => key !== locatorKeys[index]) ||
    sortedCurrentKeys.length !== expectedCurrentKeys.length ||
    sortedCurrentKeys.some((key, index) => key !== expectedCurrentKeys[index])
  )
    return invalid();

  return {
    mapping: {
      sourceOwners: owners,
      sourceRows: sources,
      controlOwners: controls,
      pendingRows,
      currentRows,
    },
    subjects: disclosureRows,
    controlLocators: sortLocators(controlLocators),
  };
}

function normalizeOperand(value: unknown): IdentityRatingReviewOperand {
  const keys = [
    'version',
    'requestedOriginalId',
    'canonicalTerminalId',
    'sourceIdentities',
    'sourceHomes',
    'controlLocators',
    'evidence',
  ];
  if (
    !record(value) ||
    !exactKeys(value, keys) ||
    value.version !== 1 ||
    !isUuid(value.requestedOriginalId) ||
    !isUuid(value.canonicalTerminalId) ||
    !Array.isArray(value.sourceIdentities) ||
    !Array.isArray(value.sourceHomes) ||
    !Array.isArray(value.controlLocators) ||
    typeof value.evidence !== 'string'
  )
    return invalid();
  const sourceIdentities = value.sourceIdentities as unknown[];
  const sourceHomes = value.sourceHomes as unknown[];
  const rawLocators = value.controlLocators as unknown[];
  if (
    sourceIdentities.length < 1 ||
    sourceIdentities.length > MAX_REVIEW_KEYS ||
    sourceHomes.length < 1 ||
    sourceHomes.length > MAX_REVIEW_KEYS ||
    rawLocators.length < 1 ||
    rawLocators.length > MAX_REVIEW_CONTROL_LOCATORS ||
    !sourceIdentities.every(isUuid) ||
    !sourceHomes.every(isPartition)
  )
    return invalid();
  const expectedIds =
    value.requestedOriginalId === value.canonicalTerminalId
      ? [value.requestedOriginalId]
      : [value.requestedOriginalId, value.canonicalTerminalId];
  if (
    sourceIdentities.length !== expectedIds.length ||
    sourceIdentities.some((id, index) => id !== expectedIds[index]) ||
    !unique(sourceHomes as number[], (home) => String(home))
  )
    return invalid();
  const expectedHomes = [...new Set(expectedIds.map((id) => partitionOf(routeOf(id)!)))].sort((a, b) => a - b);
  if (sourceHomes.length !== expectedHomes.length || sourceHomes.some((home, index) => home !== expectedHomes[index]))
    return invalid();
  const locators: IdentityRatingControlLocator[] = rawLocators.map((candidate) => {
    if (
      !record(candidate) ||
      !exactKeys(candidate, ['partition', 'group']) ||
      !isPartition(candidate.partition) ||
      !isUuid(candidate.group)
    )
      return invalid();
    return { partition: candidate.partition, group: candidate.group };
  });
  const sortedLocators = sortLocators(locators);
  if (
    !unique(sortedLocators, (row) => `${row.partition}:${row.group}`) ||
    locators.some(
      (row, index) => row.partition !== sortedLocators[index]?.partition || row.group !== sortedLocators[index]?.group,
    )
  )
    return invalid();
  const parsed = validateEvidenceString(value.evidence, expectedIds, expectedHomes, sortedLocators);
  const sourceRows = parsed.mapping.sourceRows;
  const classified = classifyIdentityRatingReviewEvidence(
    value.requestedOriginalId,
    value.canonicalTerminalId,
    expectedIds,
    expectedHomes,
    parsed as unknown as IdentityRatingNativeEvidence,
  );
  if (
    sourceRows.some(
      (row) =>
        row.control_partition !==
          sortedLocators.find(
            (locator) => locator.partition === row.control_partition && locator.group === row.control_group,
          )?.partition || row.control_group !== row.terminal,
    ) ||
    sourceRows.some((row) => row.subject_id !== row.original) ||
    classified.state !== 'reviewed'
  )
    return invalid();
  // PostgreSQL JSONB sorts object keys. Nested locator key order and top-level key order are not
  // identity; exactKeys already rejected extras. Evidence must still be canonical serialized JSON.
  const normalized: IdentityRatingReviewOperand = Object.freeze({
    version: 1,
    requestedOriginalId: value.requestedOriginalId,
    canonicalTerminalId: value.canonicalTerminalId,
    sourceIdentities: Object.freeze([...expectedIds]),
    sourceHomes: Object.freeze([...expectedHomes]),
    controlLocators: Object.freeze(sortedLocators.map((row) => Object.freeze({ ...row }))),
    evidence: classified.operand.evidence,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_REVIEW_OPERAND_BYTES ||
    JSON.stringify(classified.operand) !== JSON.stringify(normalized)
  )
    return invalid();
  return normalized;
}

export function IdentityRatingCommitUnavailableError() {
  return memoizedValue(
    IdentityRatingCommitUnavailableError,
    () =>
      class IdentityRatingCommitUnavailableError extends VoteReviewUnavailableError {
        readonly identityState: 'pending' | 'moved' | 'absent' | 'undisclosed' | 'unavailable' | 'foreign-control';

        constructor(
          identityState: IdentityRatingCommitUnavailableError['identityState'],
          readonly home?: number,
        ) {
          super(
            identityState === 'foreign-control'
              ? 'atomic_guard_unavailable'
              : identityState === 'pending'
                ? 'identity_pending'
                : 'identity_observation_unavailable',
          );
          this.identityState = identityState;
          this.name = 'IdentityRatingCommitUnavailableError';
        }
      },
  );
}
export type IdentityRatingCommitUnavailableError = InstanceType<
  ReturnType<typeof IdentityRatingCommitUnavailableError>
>;

function throwUnavailable(
  result: Exclude<IdentityRatingReviewResult, { state: 'reviewed' } | { state: 'changed' }>,
): never {
  if (result.state === 'pending') throw new (IdentityRatingCommitUnavailableError())('pending');
  if (result.state === 'moved') throw new (IdentityRatingCommitUnavailableError())('moved', result.home);
  if (result.state === 'absent') throw new (IdentityRatingCommitUnavailableError())('absent');
  if (result.state === 'undisclosed') throw new (IdentityRatingCommitUnavailableError())('undisclosed');
  throw new (IdentityRatingCommitUnavailableError())('unavailable');
}

/** Native same-home mapping participant. Its stable core owner lock lasts to executor COMMIT/ROLLBACK. */
export function createIdentityRatingCommitParticipant(): IdentityRatingCommitParticipant {
  const inputs = new WeakMap<IdentityRatingCommitPreparation, IdentityRatingReviewOperand>();
  return Object.freeze({
    prepare(input: IdentityRatingReviewOperand) {
      const operand = normalizeOperand(input);
      const prepared = Object.freeze({}) as IdentityRatingCommitPreparation;
      inputs.set(prepared, operand);
      return prepared;
    },
    async admit(tx: CommandTransaction, prepared: IdentityRatingCommitPreparation): Promise<IdentityRatingCommitHeld> {
      const operand = inputs.get(prepared);
      if (!operand) throw new TypeError('Unknown identity rating commit preparation');
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      requireAccessDeadline(deadline);
      if (
        operand.sourceHomes.some((home) => home !== command.partition) ||
        operand.controlLocators.some((locator) => locator.partition !== command.partition)
      )
        throw new (IdentityRatingCommitUnavailableError())('foreign-control');

      const client = deadlineClient(tx, deadline);
      const owner = await lockOwner.run(client, { partition_no: command.partition });
      if (!owner || owner.writeState !== 'active')
        throw new (IdentityRatingCommitUnavailableError())(
          owner?.writeState === 'moved' ? 'moved' : 'unavailable',
          command.partition,
        );
      const native = await readIdentityRatingEvidenceInTransaction(client, {
        sourceIdentities: operand.sourceIdentities,
        commandHome: command.partition,
      });
      if (native.state === 'foreign-control') throw new (IdentityRatingCommitUnavailableError())('foreign-control');
      const reviewed = classifyIdentityRatingReviewEvidence(
        operand.requestedOriginalId,
        operand.canonicalTerminalId,
        operand.sourceIdentities,
        operand.sourceHomes,
        native.evidence,
      );
      if (reviewed.state === 'changed') throw ratingReviewOf().subjectChanged();
      // A withdrawn/replaced directory can make the new cut unclassifiable while
      // its source epoch stays unchanged. It still invalidates this exact review.
      if (
        reviewed.state === 'unavailable' &&
        reviewed.reason !== 'missing-owner' &&
        identityRatingReviewEvidence(native.evidence) !== operand.evidence
      )
        throw ratingReviewOf().identityEpochChanged();
      if (reviewed.state !== 'reviewed') throwUnavailable(reviewed);
      if (
        reviewed.operand.evidence !== operand.evidence ||
        reviewed.operand.sourceHomes.length !== operand.sourceHomes.length ||
        reviewed.operand.sourceHomes.some((home, index) => home !== operand.sourceHomes[index]) ||
        reviewed.operand.controlLocators.length !== operand.controlLocators.length ||
        reviewed.operand.controlLocators.some(
          (locator, index) =>
            locator.partition !== operand.controlLocators[index]?.partition ||
            locator.group !== operand.controlLocators[index]?.group,
        )
      )
        throw ratingReviewOf().identityEpochChanged();
      requireAccessDeadline(deadline);
      const publishedHeads = operand.controlLocators.map((locator) => {
        const row = native.evidence.mapping.currentRows.find(
          (candidate) => candidate.partition_no === locator.partition && candidate.terminal === locator.group,
        );
        if (!row) throw new TypeError('Reviewed identity control row disappeared under its native owner fence');
        return Object.freeze({
          partition: locator.partition,
          group: locator.group,
          epoch: String(row.published_epoch),
        });
      });
      return Object.freeze({
        ownerId: String(owner.ownerId),
        ownerEpoch: Number(owner.epoch),
        partition: command.partition,
        subjectId: operand.canonicalTerminalId,
        publishedHeads: Object.freeze(publishedHeads),
      });
    },
  });
}
