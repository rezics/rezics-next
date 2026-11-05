import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { safeSourceUrl, sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createBoundedPublicGet, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_RESPONSE_BYTES } from './import-fetch.ts';
import type { CrossMediaPlan } from './cross-media-seed.ts';

const BANGUMI_ORIGIN = 'https://api.bgm.tv';
const SUBJECT_PATH = '/v0/subjects/';
const PERSON_PATH = '/v0/persons/';
const COVER_LIMIT = 256;
const CREATOR_LIMIT = 64;
const MEDIA_SOURCE_LIMIT = COVER_LIMIT + CREATOR_LIMIT;
const REQUEST_GAP_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type BangumiMediaSource = Readonly<{
  sourceAlias: 'bangumi_cross_media';
  externalId: string;
  sourceRevision: string;
  archiveDigest: string;
  endpoint: string;
  sourceStatus: 'available' | 'absent' | 'unavailable' | 'invalid';
  responseDigest?: string;
  etag?: string;
  sourceUrl?: string;
  code?:
    | 'source-api-http'
    | 'source-api-unavailable'
    | 'source-payload-invalid'
    | 'source-limit'
    | 'cover-fence-unavailable'
    | 'media-intent-not-delivered'
    | 'media-import-refused'
    | 'media-import-unknown';
}>;

export type BangumiPersonCareerSource = Readonly<{
  sourceAlias: 'bangumi_cross_media';
  externalId: string;
  sourceRevision: string;
  archiveDigest: string;
  endpoint: string;
  sourceStatus: 'available' | 'unavailable';
  careers?: readonly string[];
  type?: number;
  birth_year?: number | null;
  birth_mon?: number | null;
  birth_day?: number | null;
  personChineseName?: string;
  personNameDiagnostics?: readonly Readonly<{ pointer: string; code: string }>[];
  responseDigest?: string;
  etag?: string;
  code?: 'source-api-http' | 'source-api-unavailable' | 'source-payload-invalid';
}>;

export type BangumiCoverSource = BangumiMediaSource;

export type CrossMediaMediaOutcome = Omit<BangumiMediaSource, 'sourceStatus'> &
  Readonly<{
    sourceStatus: BangumiMediaSource['sourceStatus'];
    status:
      | 'available'
      | 'pending'
      | 'rejected'
      | 'fenced'
      | 'absent'
      | 'unavailable'
      | 'invalid'
      | 'refused'
      | 'unknown';
    containerId: string | null;
    mediaId?: string;
    mediaKey?: string;
    credit?: MediaImportRequest['credit'];
    provenance?: MediaImportRequest['provenance'];
  }>;

export interface BangumiCoverSourceJournal {
  coverSource(sourceAlias: string, externalId: string, archiveDigest: string): BangumiMediaSource | null;
  sealCoverSource(source: BangumiMediaSource): BangumiMediaSource;
  latestMediaStatus?(sourceAlias: string, externalId: string): CrossMediaMediaOutcome['status'] | null;
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

function endpointFor(externalId: string): string {
  const person = /^person:([1-9][0-9]*)$/u.exec(externalId);
  const subject = /^[1-9][0-9]*$/u.test(externalId) ? externalId : undefined;
  ensure(person || subject, 'Invalid selected Bangumi media identity');
  return `${BANGUMI_ORIGIN}${person ? PERSON_PATH + person[1] : SUBJECT_PATH + subject}`;
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

function cachedSource(source: BangumiMediaSource, row: SourceRecord, endpoint: string): BangumiMediaSource {
  ensure(
    source.sourceAlias === 'bangumi_cross_media' &&
      source.externalId === row.key &&
      source.sourceRevision === (row.revision ?? 'unversioned') &&
      source.archiveDigest === sourceDigest(row.payload) &&
      source.endpoint === endpoint &&
      ['available', 'absent', 'invalid'].includes(source.sourceStatus),
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
): Promise<BangumiMediaSource> {
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

async function lookupCreatorImage(
  row: SourceRecord,
  get: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<BangumiMediaSource> {
  const match = /^person:([1-9][0-9]*)$/u.exec(row.key);
  ensure(match && Number.isSafeInteger(Number(match[1])), 'Invalid selected Bangumi person identity');
  const endpoint = `${BANGUMI_ORIGIN}${PERSON_PATH}${match[1]}`;
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
  if (response.status !== 200) return { ...base, sourceStatus: 'unavailable', code: 'source-api-http' };
  let responseDigest: string | undefined;
  let responseEtag: string | undefined;
  try {
    const bytes = await readResponse(response);
    responseDigest = createHash('sha256').update(bytes).digest('hex');
    responseEtag = etagValue(response.headers.get('etag'));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const person = object(parsed);
    const expectedType = (row.payload as { type?: unknown }).type;
    ensure(
      person &&
        person.id === Number(match[1]) &&
        typeof person.name === 'string' &&
        Number.isSafeInteger(person.type) &&
        [1, 2, 3].includes(person.type as number) &&
        person.type === expectedType,
      'Bangumi PersonDetail identity or type did not match the selected archive row',
    );
    const imagesValue = person.images;
    if (imagesValue === undefined || imagesValue === null)
      return {
        ...base,
        sourceStatus: 'absent',
        responseDigest,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    const images = object(imagesValue);
    ensure(images !== null, 'Invalid Bangumi PersonDetail image schema');
    for (const size of ['large', 'medium', 'small', 'grid'])
      ensure(typeof images[size] === 'string', 'Invalid Bangumi PersonDetail image schema');
    const large = images.large as string;
    if (!large.trim())
      return {
        ...base,
        sourceStatus: 'absent',
        responseDigest,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    const sourceUrl = safeSourceUrl(large, ['lain.bgm.tv']);
    if (/\/no_icon_(?:person|subject)\./iu.test(new URL(sourceUrl).pathname))
      return {
        ...base,
        sourceStatus: 'absent',
        responseDigest,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    return {
      ...base,
      sourceStatus: 'available',
      sourceUrl,
      responseDigest,
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  } catch {
    return {
      ...base,
      sourceStatus: responseDigest ? 'invalid' : 'unavailable',
      ...(typeof responseDigest === 'string' ? { responseDigest } : {}),
      ...(responseEtag ? { etag: responseEtag } : {}),
      code: responseDigest ? 'source-payload-invalid' : 'source-limit',
    };
  }
}

function payloadWithoutArchiveImages<T extends Record<string, unknown>>(payload: T): T {
  const copy = { ...payload };
  if (Object.hasOwn(copy, 'images')) delete copy.images;
  return copy;
}

/** Enrich selected Bangumi works and finite selected creators from their pinned detail responses. */
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
  const getSubject = createBoundedPublicGet({
    origin: BANGUMI_ORIGIN,
    pathPrefix: SUBJECT_PATH,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: (ms) => options.sleep!(ms, signalForBatch) } : {}),
  });
  const getPerson = createBoundedPublicGet({
    origin: BANGUMI_ORIGIN,
    pathPrefix: PERSON_PATH,
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
  const creatorKeys = [...new Set(plan.creatorImageKeys ?? [])];
  ensure(
    creatorKeys.length <= CREATOR_LIMIT && creatorKeys.every((key) => /^person:[1-9][0-9]*$/u.test(key)),
    'Selected Bangumi creator image limit exceeded',
  );
  const selectedCreators = new Set(creatorKeys);
  const creatorRows = plan.entities.bangumi.filter((row) => selectedCreators.has(row.key));
  ensure(creatorRows.length === selectedCreators.size, 'Selected Bangumi creator image row is missing');
  ensure(workRows.length + creatorRows.length <= MEDIA_SOURCE_LIMIT, 'Selected Bangumi media source limit exceeded');
  const results = new Map<string, BangumiMediaSource>();
  const tasks = [
    ...workRows.map((row) => ({ row, creator: false })),
    ...creatorRows.map((row) => ({ row, creator: true })),
  ];
  let requests = 0;
  let pacingFailed = false;
  for (const { row, creator } of tasks) {
    const endpoint = endpointFor(row.key);
    const archiveDigest = sourceDigest(row.payload);
    const prior = options.journal?.coverSource('bangumi_cross_media', row.key, archiveDigest);
    const lastStatus = creator ? options.journal?.latestMediaStatus?.('bangumi_cross_media', row.key) : null;
    const refreshCreator =
      creator &&
      prior !== null &&
      prior !== undefined &&
      lastStatus !== null &&
      lastStatus !== undefined &&
      !['pending', 'unknown', 'fenced'].includes(lastStatus);
    if (prior && !refreshCreator) {
      results.set(row.key, cachedSource(prior, row, endpoint));
      continue;
    }
    if (pacingFailed) {
      results.set(row.key, {
        sourceAlias: 'bangumi_cross_media',
        externalId: row.key,
        sourceRevision: row.revision ?? 'unversioned',
        archiveDigest,
        endpoint,
        sourceStatus: 'unavailable',
        code: 'source-api-unavailable',
      });
      continue;
    }
    if (requests > 0) {
      try {
        await pause(REQUEST_GAP_MS, signalForBatch);
      } catch {
        pacingFailed = true;
        results.set(row.key, {
          sourceAlias: 'bangumi_cross_media',
          externalId: row.key,
          sourceRevision: row.revision ?? 'unversioned',
          archiveDigest,
          endpoint,
          sourceStatus: 'unavailable',
          code: 'source-api-unavailable',
        });
        continue;
      }
    }
    const evidence = creator
      ? await lookupCreatorImage(row, getPerson, signalForBatch)
      : await lookupCover(row, getSubject, signalForBatch);
    if (evidence.sourceStatus !== 'unavailable') options.journal?.sealCoverSource(evidence);
    results.set(row.key, evidence);
    requests++;
  }
  const coverSources = workRows.map((row) => results.get(row.key)!).filter(Boolean);
  const creatorImageSources = creatorRows.map((row) => results.get(row.key)!).filter(Boolean);
  const sources = [...coverSources, ...creatorImageSources];
  ensure(sources.length <= MEDIA_SOURCE_LIMIT, 'Selected Bangumi media evidence limit exceeded');
  ensure(
    Buffer.byteLength(JSON.stringify(sources), 'utf8') <= MAX_IMPORT_RESPONSE_BYTES,
    'Selected Bangumi media evidence exceeds its byte limit',
  );
  const byKey = new Map(sources.map((source) => [source.externalId, source]));
  const rows = plan.records.bangumi.map((row) => {
    const evidence = byKey.get(row.key);
    const payload = { ...payloadWithoutArchiveImages(row.payload as Record<string, unknown>) };
    if (evidence?.sourceStatus === 'available' && evidence.sourceUrl) payload.images = { large: evidence.sourceUrl };
    return { ...row, payload };
  });
  const entities = plan.entities.bangumi.map((row) => {
    const payload = payloadWithoutArchiveImages(row.payload as Record<string, unknown>);
    const evidence = selectedCreators.has(row.key) ? byKey.get(row.key) : undefined;
    if (evidence?.sourceStatus === 'available' && evidence.sourceUrl) payload.images = { large: evidence.sourceUrl };
    return { ...row, payload };
  });
  return {
    ...plan,
    records: { ...plan.records, bangumi: rows },
    entities: { ...plan.entities, bangumi: entities },
    coverSources,
    creatorImageSources,
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
    input.source.endpoint === endpointFor(input.recordKey)
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
