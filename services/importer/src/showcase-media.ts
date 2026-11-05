import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { safeSourceUrl, sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createBoundedPublicGet, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_RESPONSE_BYTES } from './import-fetch.ts';
import type { CrossMediaPlan } from './cross-media-seed.ts';

const BANGUMI_ORIGIN = 'https://api.bgm.tv';
const SUBJECT_PATH = '/v0/subjects/';
const COVER_LIMIT = 256;
const REQUEST_GAP_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type BangumiCoverSource = Readonly<{
  sourceAlias: 'bangumi_cross_media';
  externalId: string;
  sourceRevision: string;
  archiveDigest: string;
  endpoint: string;
  sourceStatus: 'available' | 'absent' | 'unavailable';
  responseDigest?: string;
  etag?: string;
  sourceUrl?: string;
  code?:
    | 'source-api-http'
    | 'source-api-unavailable'
    | 'source-payload-invalid'
    | 'source-limit'
    | 'cover-fence-unavailable'
    | 'media-intent-not-delivered';
}>;

export type BangumiPersonCareerSource = Readonly<{
  sourceAlias: 'bangumi_cross_media';
  externalId: string;
  sourceRevision: string;
  archiveDigest: string;
  endpoint: string;
  sourceStatus: 'available' | 'unavailable';
  careers?: readonly string[];
  personChineseName?: string;
  personNameDiagnostics?: readonly Readonly<{ pointer: string; code: string }>[];
  responseDigest?: string;
  etag?: string;
  code?: 'source-api-http' | 'source-api-unavailable' | 'source-payload-invalid';
}>;

export type CrossMediaMediaOutcome = Omit<BangumiCoverSource, 'sourceStatus'> &
  Readonly<{
    sourceStatus: BangumiCoverSource['sourceStatus'];
    status: 'available' | 'pending' | 'rejected' | 'fenced' | 'absent' | 'unavailable';
    containerId: string | null;
    mediaId?: string;
    mediaKey?: string;
    credit?: MediaImportRequest['credit'];
    provenance?: MediaImportRequest['provenance'];
  }>;

export interface BangumiCoverSourceJournal {
  coverSource(sourceAlias: string, externalId: string, archiveDigest: string): BangumiCoverSource | null;
  sealCoverSource(source: BangumiCoverSource): BangumiCoverSource;
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function etagValue(value: string | null): string | undefined {
  return value !== null && value.length <= 256 && /^[\x20-\x7e]*$/u.test(value) ? value : undefined;
}

async function readResponse(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let output = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output.subarray(0, size);
      ensure(value instanceof Uint8Array, 'Invalid Bangumi API response body');
      ensure(
        value.buffer.byteLength <= MAX_IMPORT_RESPONSE_BYTES && value.byteLength <= MAX_IMPORT_RESPONSE_BYTES - size,
        'Bangumi API response exceeds its byte limit',
      );
      if (size + value.byteLength > output.byteLength) {
        const expanded = new Uint8Array(
          Math.min(MAX_IMPORT_RESPONSE_BYTES, Math.max(size + value.byteLength, output.byteLength * 2)),
        );
        expanded.set(output);
        output = expanded;
      }
      output.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function cachedSource(source: BangumiCoverSource, row: SourceRecord, endpoint: string): BangumiCoverSource {
  ensure(
    source.sourceAlias === 'bangumi_cross_media' &&
      source.externalId === row.key &&
      source.sourceRevision === (row.revision ?? 'unversioned') &&
      source.archiveDigest === sourceDigest(row.payload) &&
      source.endpoint === endpoint &&
      ['available', 'absent'].includes(source.sourceStatus),
    'Invalid sealed Bangumi cover source',
  );
  ensure(
    typeof source.responseDigest === 'string' && /^[0-9a-f]{64}$/u.test(source.responseDigest),
    'Invalid sealed Bangumi response digest',
  );
  ensure(
    source.etag === undefined || (source.etag.length <= 256 && /^[\x20-\x7e]*$/u.test(source.etag)),
    'Invalid sealed Bangumi ETag',
  );
  if (source.sourceStatus === 'available') {
    ensure(typeof source.sourceUrl === 'string', 'Missing sealed Bangumi cover URL');
    safeSourceUrl(source.sourceUrl, ['lain.bgm.tv']);
  }
  return source;
}

async function lookupCover(
  row: SourceRecord,
  get: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<BangumiCoverSource> {
  ensure(/^[1-9][0-9]*$/u.test(row.key) && Number.isSafeInteger(Number(row.key)), 'Invalid selected Bangumi identity');
  const endpoint = `${BANGUMI_ORIGIN}${SUBJECT_PATH}${row.key}`;
  const base = {
    sourceAlias: 'bangumi_cross_media' as const,
    externalId: row.key,
    sourceRevision: row.revision ?? 'unversioned',
    archiveDigest: sourceDigest(row.payload),
    endpoint,
  };
  let response: Response;
  try {
    response = await get(endpoint, signal);
  } catch {
    return { ...base, sourceStatus: 'unavailable', code: 'source-api-unavailable' };
  }
  if (response.status !== 200) {
    return { ...base, sourceStatus: 'unavailable', code: 'source-api-http' };
  }
  try {
    const bytes = await readResponse(response);
    const responseDigest = createHash('sha256').update(bytes).digest('hex');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const subject = object(parsed);
    ensure(
      subject &&
        subject.id === Number(row.key) &&
        typeof subject.name === 'string' &&
        typeof subject.type === 'number' &&
        Number.isSafeInteger(subject.type) &&
        subject.type === Number((row.payload as { type?: unknown }).type),
      'Bangumi subject identity did not match',
    );
    const imagesPayload = subject.images;
    const responseEtag = etagValue(response.headers.get('etag'));
    if (imagesPayload === undefined || imagesPayload === null)
      return {
        ...base,
        sourceStatus: 'absent',
        responseDigest,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    const images = object(imagesPayload);
    ensure(images !== null, 'Invalid Bangumi image schema');
    for (const size of ['large', 'common', 'medium', 'small', 'grid'])
      ensure(typeof images[size] === 'string', 'Invalid Bangumi image schema');
    const sourceUrl = safeSourceUrl(images.large, ['lain.bgm.tv']);
    return {
      ...base,
      sourceStatus: 'available',
      sourceUrl,
      responseDigest,
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  } catch {
    return { ...base, sourceStatus: 'unavailable', code: 'source-payload-invalid' };
  }
}

function payloadWithoutArchiveImages<T extends Record<string, unknown>>(payload: T): T {
  if (!Object.hasOwn(payload, 'images')) return payload;
  const copy = { ...payload };
  delete copy.images;
  return copy;
}

/** Enrich only selected Bangumi work rows from the pinned subject detail response. */
export async function acquireBangumiCoverSources(
  plan: CrossMediaPlan,
  options: {
    journal?: BangumiCoverSourceJournal;
    fetch?: typeof fetch;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<CrossMediaPlan> {
  const signalForBatch = AbortSignal.timeout(MAX_IMPORT_DEADLINE_MS);
  const pause =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', aborted);
          resolve();
        }, ms);
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        signal.addEventListener('abort', aborted, { once: true });
      }));
  const get = createBoundedPublicGet({
    origin: BANGUMI_ORIGIN,
    pathPrefix: SUBJECT_PATH,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: (ms) => options.sleep!(ms, signalForBatch) } : {}),
  });
  const selectedWorks = new Set(
    plan.members
      .filter((member) => member.source === 'bangumi' && member.kind === 'work' && member.membership === 'family')
      .map((member) => member.key),
  );
  const workRows = plan.records.bangumi.filter(
    (row) => selectedWorks.has(row.key) && [1, 2].includes(Number(row.payload.type)),
  );
  ensure(workRows.length <= COVER_LIMIT, 'Selected Bangumi cover limit exceeded');
  const results = new Map<string, BangumiCoverSource>();
  const endpointless = new Map<string, BangumiCoverSource>();
  for (let index = 0; index < workRows.length; index++) {
    const row = workRows[index]!;
    const endpoint = `${BANGUMI_ORIGIN}${SUBJECT_PATH}${row.key}`;
    const archiveDigest = sourceDigest(row.payload);
    const prior = options.journal?.coverSource('bangumi_cross_media', row.key, archiveDigest);
    if (prior) {
      results.set(row.key, cachedSource(prior, row, endpoint));
      continue;
    }
    const evidence = await lookupCover(row, get, signalForBatch);
    if (evidence.sourceStatus !== 'unavailable') options.journal?.sealCoverSource(evidence);
    results.set(row.key, evidence);
    if (index + 1 < workRows.length) {
      try {
        await pause(REQUEST_GAP_MS, signalForBatch);
      } catch {
        for (const remaining of workRows.slice(index + 1))
          endpointless.set(remaining.key, {
            sourceAlias: 'bangumi_cross_media',
            externalId: remaining.key,
            sourceRevision: remaining.revision ?? 'unversioned',
            archiveDigest: sourceDigest(remaining.payload),
            endpoint: `${BANGUMI_ORIGIN}${SUBJECT_PATH}${remaining.key}`,
            sourceStatus: 'unavailable',
            code: 'source-api-unavailable',
          });
        break;
      }
    }
  }
  for (const [key, value] of endpointless) results.set(key, value);
  const sources = [...results.values()];
  const byKey = new Map(sources.map((source) => [source.externalId, source]));
  const rows = plan.records.bangumi.map((row) => {
    const evidence = byKey.get(row.key);
    const payload = { ...payloadWithoutArchiveImages(row.payload as Record<string, unknown>) };
    if (evidence?.sourceStatus === 'available' && evidence.sourceUrl) payload.images = { large: evidence.sourceUrl };
    return { ...row, payload };
  });
  const entities = plan.entities.bangumi.map((row) => ({
    ...row,
    payload: payloadWithoutArchiveImages(row.payload as Record<string, unknown>),
  }));
  return {
    ...plan,
    records: { ...plan.records, bangumi: rows },
    entities: { ...plan.entities, bangumi: entities },
    coverSources: sources,
  };
}

export function validAvailableCover(input: {
  source: BangumiCoverSource;
  recordKey: string;
  sourceAlias: string;
  sourceRevision: string;
  archiveDigest: string;
  containerId: string | null;
  mediaId?: string;
  sourceUrl?: string;
}): boolean {
  if (
    input.source.sourceStatus === 'available' &&
    input.source.sourceAlias === input.sourceAlias &&
    input.source.externalId === input.recordKey &&
    input.source.sourceRevision === input.sourceRevision &&
    input.source.archiveDigest === input.archiveDigest &&
    input.containerId !== null &&
    UUID.test(input.containerId) &&
    typeof input.mediaId === 'string' &&
    UUID.test(input.mediaId) &&
    input.source.sourceUrl === input.sourceUrl &&
    typeof input.source.responseDigest === 'string' &&
    /^[0-9a-f]{64}$/u.test(input.source.responseDigest) &&
    input.source.endpoint === `https://api.bgm.tv/v0/subjects/${input.recordKey}`
  ) {
    try {
      safeSourceUrl(input.source.sourceUrl!, ['lain.bgm.tv']);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
