import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { SOURCE_OBSERVATION_MAX_BYTES, type SourceFigures } from './source-figures.ts';

/** Admission is provider policy; a configured fence alias never selects a profile. */
export const SOURCE_PROVIDERS = {
  // Existing VNDB callers carry their own scale and record keys. Keep that wire contract.
  vndb: {
    record: (id: string) => id.length > 0,
    scale: (min: number, max: number) => min >= 0 && max <= 4096 && max > min,
  },
  // Bangumi converters use String(positive safe integer), never URLs, prefixes or padded IDs.
  bangumi: {
    record: (id: string) => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)),
    scale: (min: number, max: number) => min === 0 && max === 10,
  },
} as const;
export type SourceProvider = keyof typeof SOURCE_PROVIDERS;
export const SOURCE_PROVIDER_IDS = Object.freeze(Object.keys(SOURCE_PROVIDERS) as SourceProvider[]);
export const SOURCE_OBSERVATION_PAYLOAD_VERSION = 1 as const;
export function sourceProvider(value: string) {
  return Object.hasOwn(SOURCE_PROVIDERS, value) ? SOURCE_PROVIDERS[value as SourceProvider] : null;
}

export type SourceObservation = Readonly<{
  sourceAlias?: string;
  sourceRecordId: string;
  count: number;
  figures?: SourceFigures;
  asOf: string;
  scale?: { min: number; max: number };
  mean?: number;
  licence?: string | null;
  attribution?: string;
  expectedObservation?: string | null;
}>;

/** An observation has no provider revision inferred from its date or digest.
 * Optional figures carry their own native encoding version; scalar digests stay unchanged.
 * CAS provenance is command input, not part of the immutable observed payload.
 * Explicit default aliases and omitted aliases identify the same source observation.
 */
export function sourceObservation(subjectId: string, source: string, value: SourceObservation) {
  const { expectedObservation: _expected, sourceAlias, ...fields } = value;
  const payload = { ...fields, sourceAlias: sourceAlias ?? source };
  const canonical = canonicalize(['source-statistic-observation.v1', subjectId, source, payload]);
  if (typeof canonical !== 'string' || Buffer.byteLength(canonical, 'utf8') > SOURCE_OBSERVATION_MAX_BYTES)
    throw new TypeError('Source observation must be canonical JSON');
  return { digest: createHash('sha256').update(canonical, 'utf8').digest('hex'), payload };
}
