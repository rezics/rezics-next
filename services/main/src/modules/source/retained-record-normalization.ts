import { convertProviderRecord, ProviderConversionError } from '../../../../../packages/conversion/src/index.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import type { DatasetRecord } from '../../../../../scripts/datasets/types.ts';
import type { StagedSourceObservation } from './intake.ts';
import { conversionChanged, mappingUnverified, sourceNotFound, supportUnavailable,
  type RetainedConversionRequest, type RetainedRecordInput } from './field-support-contract.ts';

export const SOURCE_NORMALIZATION = 'dataset-record-normalization-v1';
export const sourceDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const canonicalDigest = (value: unknown) => sourceDigest(canonicalJson(value));
export const sourceIri = (id: string) => `https://rezics.com/id/${id}`;
export const sourceId = (value: string) => /^(?:https:\/\/rezics\.com\/id\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value)?.[1] ?? null;
export const SHA256 = /^[0-9a-f]{64}$/;
export const rowObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Registered producer formats, not native admission policy. Unknown meanings remain in inventory. */
export const RETAINED_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  vndb: ['vn', 'release', 'character', 'staff', 'producer', 'tag', 'trait', 'language', 'platform', 'image', 'wikidata'],
  bangumi: ['subject', 'person', 'character', 'episode', 'tag'],
  musicbrainz: ['artist', 'label', 'release', 'release-group', 'recording', 'work', 'area', 'place', 'event', 'series', 'instrument', 'url'],
};
export function retainedMappingRevision(provider: string, namespace: string): string {
  if (!RETAINED_NAMESPACES[provider]?.includes(namespace)) return mappingUnverified();
  return `${provider}-${namespace}-retained-map-v${namespace === 'release' ? 2 : 1}`;
}

function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return supportUnavailable(); }
}

/** Ordered receipt bytes are checked before reconstruction; no re-encoded JSON digest is a byte digest. */
export function reconstructRetainedPayload(input: RetainedRecordInput,
  observations: readonly StagedSourceObservation[]): { bytes: Buffer; value: Record<string, unknown> } {
  if (!input.intakes.length || input.intakes.length > 512 || observations.length !== input.intakes.length) {
    return supportUnavailable();
  }
  if (input.intakes.some((part, index) => part.index !== index)
    || new Set(input.intakes.map(part => part.observation)).size !== input.intakes.length) return conversionChanged('part-order');
  const parts = observations.map((observation, index) => {
    const part = input.intakes[index]!;
    if (!observation || observation.observation !== part.observation) return sourceNotFound();
    if (observation.record !== part.record) return conversionChanged('record');
    if (observation.provider !== input.identity.provider
      || observation.sourceRevision !== input.snapshot.digest) return conversionChanged('record');
    if (observation.retention !== 'retained' || observation.rawBytesBase64 === undefined
      || !observation.byteDigest || !/^application\/(?:json|ld\+json)(?:;|$)/i.test(observation.mediaType)
      || observation.coverage.omittedFields.length) return supportUnavailable();
    const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
    if (bytes.toString('base64') !== observation.rawBytesBase64
      || sourceDigest(bytes) !== observation.byteDigest || bytes.length !== observation.byteLength) return supportUnavailable();
    if (observation.byteDigest !== part.byteDigest) return conversionChanged('byte-digest');
    return { bytes, value: rowObject(json(bytes)), observation };
  });
  let bytes: Buffer;
  if (input.payload.format === 'json') {
    if (parts.length !== 1 || parts[0]!.value?.format === 'rezics-dataset-chunk-v1') return conversionChanged('part-order');
    const observed = parts[0]!.observation;
    if (observed.namespace !== input.identity.namespace || observed.externalId !== input.identity.externalId) return conversionChanged('record');
    if (!observed.coverage.complete) return supportUnavailable();
    bytes = parts[0]!.bytes;
  } else if (input.payload.format === 'rezics-dataset-chunk-v1') {
    bytes = Buffer.concat(parts.map(({ value, observation }, index) => {
      if (!value || value.format !== 'rezics-dataset-chunk-v1' || value.index !== index
        || value.count !== parts.length) return conversionChanged('part-order');
      if (observation.namespace !== `${input.identity.namespace}-dataset-part`
        || observation.externalId !== `${input.identity.externalId}:part:${index}`) return conversionChanged('part-order');
      if (value.digest !== input.payload.byteDigest || value.byteLength !== input.payload.byteLength) return conversionChanged('byte-digest');
      if (value.encoding !== 'base64' || typeof value.bytes !== 'string') return supportUnavailable();
      const decoded = Buffer.from(value.bytes, 'base64');
      if (decoded.toString('base64') !== value.bytes) return supportUnavailable();
      return decoded;
    }));
  } else return mappingUnverified();
  if (bytes.length > 16 * 1024 * 1024) return supportUnavailable();
  if (bytes.length !== input.payload.byteLength || sourceDigest(bytes) !== input.payload.byteDigest) return conversionChanged('byte-digest');
  const value = rowObject(json(bytes));
  if (!value) return supportUnavailable();
  return { bytes, value };
}

/** Compatibility boundary: Source owns refusal semantics; the external library
 * owns only the existing pure provider transformation. */
function normalizedBareRecord(identity: RetainedRecordInput['identity'], data: Record<string, unknown>): DatasetRecord {
  try { return convertProviderRecord(identity,data); }
  catch (error) {
    if (error instanceof ProviderConversionError) {
      return error.basis === 'record' ? conversionChanged('record') : mappingUnverified();
    }
    throw error;
  }
}

function retainedBasis(request: RetainedConversionRequest,
  observations: readonly StagedSourceObservation[]) {
  const input = request.retained, identity = input.identity;
  if (request.profile !== 'source-retained-record-conversion-v1'
    || ![retainedMappingRevision(identity.provider, identity.namespace),
      `${identity.provider}-${identity.namespace}-retained-map-v1`].includes(request.mappingRevision)) return mappingUnverified();
  if (!rowObject(input.record) || !rowObject(input.record.data)
    || identity.key !== `${identity.provider}:${identity.namespace}:${identity.externalId}`
    || input.record.key !== identity.key || input.record.provider !== identity.provider
    || input.record.kind !== identity.namespace || input.record.externalId !== identity.externalId) return conversionChanged('record');
  if (!SHA256.test(input.recordDigest) || canonicalDigest(input.record) !== input.recordDigest) return conversionChanged('record-digest');
  if (!input.snapshot.id || !SHA256.test(input.snapshot.digest) || !SHA256.test(input.snapshot.fileSha256)
    || !SHA256.test(input.payload.byteDigest) || !Number.isSafeInteger(input.payload.byteLength)
    || input.payload.byteLength < 1) return supportUnavailable();
  const payload = reconstructRetainedPayload(input, observations);
  return { input, identity, payload };
}

export function verifyRetainedRecord(request: RetainedConversionRequest,
  observations: readonly StagedSourceObservation[]) {
  const { input,identity,payload } = retainedBasis(request,observations);
  let record: DatasetRecord;
  let rule: string;
  if (payload.value.format === 'rezics-dataset-record-v1') {
    if (payload.value.snapshot !== input.snapshot.id || payload.value.digest !== input.snapshot.digest) return conversionChanged('record');
    record = payload.value.record as DatasetRecord;
    rule = 'dataset-record-envelope-v1';
  } else {
    record = normalizedBareRecord(identity, payload.value);
    rule = `${identity.provider}-bare-record-v1`;
  }
  if (!record || canonicalJson(record) !== canonicalJson(input.record)) return conversionChanged('record');
  return { record, payload: payload.value, normalizationRevision: SOURCE_NORMALIZATION, rule };
}

/** Validate current custody against an already accepted explicit conversion.
 * The accepted rule comes from immutable Source storage, never this request.
 * Provider transformations belong only to the explicit conversion command. */
export function verifyRetainedEvidence(request: RetainedConversionRequest,
  observations: readonly StagedSourceObservation[], acceptedRule: string) {
  const { input,identity,payload } = retainedBasis(request,observations);
  if (acceptedRule === 'dataset-record-envelope-v1') {
    if (payload.value.format !== 'rezics-dataset-record-v1'
      || payload.value.snapshot !== input.snapshot.id || payload.value.digest !== input.snapshot.digest
      || canonicalJson(payload.value.record) !== canonicalJson(input.record)) return conversionChanged('record');
  } else if (acceptedRule === `${identity.provider}-bare-record-v1`) {
    if (canonicalJson(payload.value) !== canonicalJson(input.record.data)) return conversionChanged('record');
  } else return mappingUnverified();
  return { record: input.record,payload: payload.value,normalizationRevision: SOURCE_NORMALIZATION,rule: acceptedRule };
}
