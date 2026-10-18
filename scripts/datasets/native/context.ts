import { canonical, sha256 } from '../store.ts';
import type { DatasetIntakeReference, DatasetRecord, DatasetSnapshot, DatasetSourceReference } from '../types.ts';

/** Provider-qualified identity does not include a mutable source hash or snapshot. */
export function datasetSourceIdentity(record: DatasetRecord): string {
  return canonical([record.provider, record.kind, record.externalId]);
}

export function datasetRecordDigest(record: DatasetRecord): string {
  return sha256(canonical(record));
}

export function datasetSourceReference(snapshot: DatasetSnapshot, record: DatasetRecord,
  observations: readonly string[], intakes: readonly DatasetIntakeReference[] = []): DatasetSourceReference {
  return {
    key: record.key, provider: record.provider, namespace: record.kind,
    externalId: record.externalId, snapshot: snapshot.id, snapshotDigest: snapshot.digest,
    recordDigest: datasetRecordDigest(record), observations: [...observations], intakes: [...intakes],
  };
}
