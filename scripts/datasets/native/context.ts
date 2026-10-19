import { canonical, sha256 } from '../store.ts';
import type {
  DatasetFrozenIdentity, DatasetIntakeCommand, DatasetIntakeReceipt, DatasetIntakeReference,
  DatasetIntakeRequest, DatasetRecord, DatasetRecordEnvelope, DatasetRetainedRecord, DatasetSnapshot,
  DatasetSourceReference,
} from '../types.ts';

export class DatasetIntakeCustodyError extends Error {
  readonly owner = 'dataset-importer';
  readonly stage = 'import-intake-receipts';
  constructor(readonly basis: 'coordinate' | 'request' | 'envelope' | 'receipt' | 'snapshot', detail: string) {
    super(`dataset-importer [import-intake-receipts/${basis}]: ${detail}`);
  }
}

export function datasetFrozenIdentity(record: DatasetRecord): DatasetFrozenIdentity {
  return { key: record.key, provider: record.provider, namespace: record.kind, externalId: record.externalId };
}

/** Provider-qualified identity does not include a mutable source hash or snapshot. */
export function datasetSourceIdentity(record: DatasetRecord): string {
  return canonical([record.provider, record.kind, record.externalId]);
}

export function datasetRecordDigest(record: DatasetRecord): string {
  return sha256(canonical(record));
}

/** Existing importer rights evidence; database attribution grants no image rights. */
export function datasetSourceRightsEvidence(record: DatasetRecord): DatasetIntakeRequest['rightsEvidence'] {
  if (record.provider === 'bangumi') return { basis: 'license',
    note: `Bangumi contributors, ${record.sourceUrl}; CC BY-SA 3.0 https://creativecommons.org/licenses/by-sa/3.0/. Covers have separate rights; user posts are excluded.` };
  if (record.provider === 'vndb') return { basis: 'license',
    note: `VNDB contributors, ${record.sourceUrl}; ODbL https://opendatacommons.org/licenses/odbl/1-0/ and DbCL https://opendatacommons.org/licenses/dbcl/1-0/. Field exceptions retained; descriptions and user posts are not published.` };
  return { basis: 'unknown',
    note: `Frozen local development evidence from ${record.sourceUrl}; raw provider data and images retain their original rights. No redistribution permission is asserted.` };
}

/** Reuse the original multipart naming and request bytes, including incomplete coverage. */
export function datasetIntakeRequest(record: DatasetRecord, snapshotDigest: string,
  part: Uint8Array, index: number, count: number): DatasetIntakeRequest {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count)
    throw new DatasetIntakeCustodyError('coordinate', 'invalid ordered intake part');
  return {
    profile: 'source-manual-intake-v1', provider: record.provider,
    namespace: count > 1 ? `${record.kind}-dataset-part` : record.kind,
    externalId: count > 1 ? `${record.externalId}:part:${index}` : record.externalId,
    sourceRevision: snapshotDigest, mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: Buffer.from(part).toString('base64'),
    coverage: { scope: count > 1 ? 'complete-json-part-of-frozen-dataset-record'
      : 'exact-frozen-dataset-record-with-outgoing-relations', complete: count === 1, omittedFields: [] },
    rightsEvidence: datasetSourceRightsEvidence(record),
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);

export function assertDatasetIntakeRequest(actual: unknown, expected: DatasetIntakeRequest,
  bytes = true): asserts actual is DatasetIntakeRequest {
  if (!object(actual)) throw new DatasetIntakeCustodyError('request', 'missing submitted intake');
  for (const field of ['provider', 'namespace', 'externalId', 'sourceRevision'] as const)
    if (actual[field] !== expected[field])
      throw new DatasetIntakeCustodyError('coordinate', `submitted ${field} differs from frozen ordered input`);
  for (const field of ['profile', 'mediaType', 'retention', 'coverage', 'rightsEvidence'] as const)
    if (!equal(actual[field], expected[field]))
      throw new DatasetIntakeCustodyError('request', `submitted ${field} differs from importer evidence`);
  if (bytes && actual.rawBytesBase64 !== expected.rawBytesBase64)
    throw new DatasetIntakeCustodyError('envelope', 'submitted part bytes differ from the frozen envelope');
  if (Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(','))
    throw new DatasetIntakeCustodyError('request', 'submitted intake fields differ from importer request');
}

/** All envelope fields are custody, including images and edges outside record.data. */
export function assertDatasetRecordEnvelope(actual: unknown, expected: DatasetRecordEnvelope): void {
  if (!object(actual)) throw new DatasetIntakeCustodyError('envelope', 'missing actual record envelope');
  for (const field of ['format', 'snapshot', 'digest', 'record', 'edges', 'images'] as const)
    if (!equal(actual[field], expected[field]))
      throw new DatasetIntakeCustodyError('envelope', `retained envelope ${field} differs from frozen input`);
  if (Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(','))
    throw new DatasetIntakeCustodyError('envelope', 'retained envelope fields differ from importer input');
}

/** Checks a real owner acknowledgement; never synthesizes an observation or canonical Source record. */
export function datasetIntakeReceipt(command: DatasetIntakeCommand,
  expected: DatasetIntakeRequest): DatasetIntakeReceipt {
  assertDatasetIntakeRequest(command.request, expected);
  const result = command.result, observation = result?.observation;
  if (!result || !object(observation)) throw new DatasetIntakeCustodyError('receipt', 'missing acknowledged observation');
  for (const field of ['profile', 'provider', 'namespace', 'externalId', 'sourceRevision',
    'mediaType', 'retention', 'coverage', 'rightsEvidence'] as const)
    if (!equal(observation[field], expected[field]))
      throw new DatasetIntakeCustodyError('receipt', `acknowledged ${field} differs from submitted intake`);
  const bytes = Buffer.from(expected.rawBytesBase64, 'base64');
  if (observation.byteDigest !== sha256(bytes))
    throw new DatasetIntakeCustodyError('receipt', 'Retained source receipt digest differs from frozen bytes');
  if (observation.byteLength !== bytes.length || observation.state !== 'staged'
    || typeof observation.submittedAt !== 'string' || typeof result.replayed !== 'boolean'
    || (observation.rawBytesBase64 !== undefined && observation.rawBytesBase64 !== expected.rawBytesBase64))
    throw new DatasetIntakeCustodyError('receipt', 'acknowledged bytes or observation state differ from submitted intake');
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (typeof observation.record !== 'string' || !native.test(observation.record)
    || typeof observation.observation !== 'string' || !native.test(observation.observation))
    throw new DatasetIntakeCustodyError('receipt', 'acknowledged observation or part-record identity is invalid');
  return { index: command.coordinate.index, record: observation.record, observation: observation.observation,
    byteDigest: observation.byteDigest, byteLength: bytes.length,
    command: structuredClone({ ...command, result }) };
}

export function datasetSourceReference(snapshot: DatasetSnapshot, record: DatasetRecord,
  observations: readonly string[], intakes: readonly DatasetIntakeReference[] = [],
  retained?: DatasetRetainedRecord): DatasetSourceReference {
  return {
    key: record.key, provider: record.provider, namespace: record.kind,
    externalId: record.externalId, snapshot: snapshot.id, snapshotDigest: snapshot.digest,
    recordDigest: datasetRecordDigest(record), observations: [...observations], intakes: structuredClone([...intakes]),
    ...(retained ? { retained: structuredClone(retained) } : {}),
  };
}
