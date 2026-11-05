import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { safeSourceUrl, sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createBoundedPublicGet, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_RESPONSE_BYTES } from './import-fetch.ts';
import type { CrossMediaPlan } from './cross-media-seed.ts';

const BANGUMI_ORIGIN = 'https://api.bgm.tv';
const SUBJECT_PATH = '/v0/subjects/';
const CHARACTER_PATH = '/v0/characters/';
const WORK_MEDIA_LIMIT = 256;
const CHARACTER_MEDIA_LIMIT = 256;
export const BANGUMI_MEDIA_BATCH_LIMIT = WORK_MEDIA_LIMIT + CHARACTER_MEDIA_LIMIT;
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
  type?: number;
  birth_year?: number | null;
  birth_mon?: number | null;
  birth_day?: number | null;
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

function detailEndpoint(externalId: string, kind: 'work' | 'character'): string {
  const numericId = kind === 'character' ? externalId.slice('character:'.length) : externalId;
  return `${BANGUMI_ORIGIN}${kind === 'character' ? CHARACTER_PATH : SUBJECT_PATH}${numericId}`;
}

function etagValue(value: string | null): string | undefined {
  return value !== null && value.length <= 256 && /^[\x20-\x7e]*$/u.test(value) ? value : undefined;
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let output = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let aborted: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), interrupted]);
      } finally {
        if (aborted) signal.removeEventListener('abort', aborted);
      }
      const { done, value } = chunk;
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

async function lookupCover(
  row: SourceRecord,
  externalId: string,
  kind: 'work' | 'character',
  get: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<BangumiCoverSource> {
  const numericId = kind === 'character' ? /^character:([1-9][0-9]*)$/u.exec(externalId)?.[1] : externalId;
  ensure(
    numericId !== undefined && /^[1-9][0-9]*$/u.test(numericId) && Number.isSafeInteger(Number(numericId)),
    'Invalid selected Bangumi identity',
  );
  const endpoint = detailEndpoint(externalId, kind);
  const base = {
    sourceAlias: 'bangumi_cross_media' as const,
    externalId,
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
  let responseDigest: string | undefined;
  const responseEtag = etagValue(response.headers.get('etag'));
  if (response.status !== 200) {
    try {
      const bytes = await readResponse(response, signal);
      responseDigest = createHash('sha256').update(bytes).digest('hex');
    } catch {
      return {
        ...base,
        sourceStatus: 'unavailable',
        code: signal.aborted ? 'source-api-unavailable' : 'source-api-http',
      };
    }
    return {
      ...base,
      sourceStatus: 'unavailable',
      code: 'source-api-http',
      responseDigest,
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
  try {
    const bytes = await readResponse(response, signal);
    responseDigest = createHash('sha256').update(bytes).digest('hex');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const subject = object(parsed);
    ensure(
      subject &&
        subject.id === Number(numericId) &&
        typeof subject.name === 'string' &&
        typeof subject.type === 'number' &&
        Number.isSafeInteger(subject.type) &&
        subject.type === Number((row.payload as { type?: unknown }).type),
      'Bangumi record identity did not match',
    );
    const imagesPayload = subject.images;
    if (imagesPayload === undefined || imagesPayload === null)
      return {
        ...base,
        sourceStatus: 'absent',
        responseDigest,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    const images = object(imagesPayload);
    ensure(images !== null, 'Invalid Bangumi image schema');
    const requiredSizes =
      kind === 'character'
        ? ['large', 'medium', 'small', 'grid']
        : ['large', 'common', 'medium', 'small', 'grid'];
    for (const size of requiredSizes)
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
    return {
      ...base,
      sourceStatus: 'unavailable',
      code: signal.aborted ? 'source-api-unavailable' : 'source-payload-invalid',
      ...(responseDigest ? { responseDigest } : {}),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
}

function payloadWithoutArchiveImages<T extends Record<string, unknown>>(payload: T): T {
  if (!Object.hasOwn(payload, 'images')) return payload;
  const copy = { ...payload };
  delete copy.images;
  return copy;
}

/** Enrich selected Bangumi works and direct selected Characters from their pinned detail responses. */
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
    pathPrefix: '/v0/',
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
  const selectedCharacterIds = [
    ...new Set(
      [...(plan.characterAppearances ?? []), ...(plan.gameCharacterAppearances ?? [])].map(
        (appearance) => appearance.characterId,
      ),
    ),
  ].sort((left, right) => left - right);
  const characterRows = new Map(plan.entities.bangumi.map((row) => [row.key, row]));
  const workCandidates = workRows
    .slice(0, WORK_MEDIA_LIMIT)
    .map((row) => ({ row, externalId: row.key, kind: 'work' as const }));
  const characterCandidates = selectedCharacterIds.slice(0, CHARACTER_MEDIA_LIMIT).map((id) => {
    const externalId = `character:${id}`;
    return { row: characterRows.get(externalId)!, externalId, kind: 'character' as const };
  });
  const candidates = [...workCandidates, ...characterCandidates];
  if (workRows.length > WORK_MEDIA_LIMIT)
    plan.gaps.push({
      source: 'bangumi',
      fields: [],
      record: { limit: WORK_MEDIA_LIMIT, omitted: workRows.length - WORK_MEDIA_LIMIT },
      reason: 'Selected Bangumi work image lookup limit exceeded',
      code: 'source-limit',
    });
  if (selectedCharacterIds.length > CHARACTER_MEDIA_LIMIT)
    plan.gaps.push({
      source: 'bangumi',
      fields: [],
      record: { limit: CHARACTER_MEDIA_LIMIT, omitted: selectedCharacterIds.length - CHARACTER_MEDIA_LIMIT },
      reason: 'Direct selected Bangumi Character image lookup limit exceeded',
      code: 'source-limit',
    });
  const results = new Map<string, BangumiCoverSource>();
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const evidence = await lookupCover(
      candidate.row,
      candidate.externalId,
      candidate.kind,
      get,
      signalForBatch,
    );
    if (evidence.responseDigest) options.journal?.sealCoverSource(evidence);
    results.set(candidate.externalId, evidence);
    if (index + 1 < candidates.length) {
      try {
        await pause(REQUEST_GAP_MS, signalForBatch);
      } catch (error) {
        if (!signalForBatch.aborted) throw error;
        for (const remaining of candidates.slice(index + 1))
          results.set(remaining.externalId, {
            sourceAlias: 'bangumi_cross_media',
            externalId: remaining.externalId,
            sourceRevision: remaining.row.revision ?? 'unversioned',
            archiveDigest: sourceDigest(remaining.row.payload),
            endpoint: detailEndpoint(remaining.externalId, remaining.kind),
            sourceStatus: 'unavailable',
            code: 'source-api-unavailable',
          });
        break;
      }
    }
  }
  const sources = [...results.values()];
  const byKey = new Map(sources.map((source) => [source.externalId, source]));
  const rows = plan.records.bangumi.map((row) => {
    const evidence = byKey.get(row.key);
    const payload = { ...payloadWithoutArchiveImages(row.payload as Record<string, unknown>) };
    if (evidence?.sourceStatus === 'available' && evidence.sourceUrl) payload.images = { large: evidence.sourceUrl };
    return { ...row, payload };
  });
  const selectedCharacters = new Set(selectedCharacterIds.map((id) => `character:${id}`));
  const entities = plan.entities.bangumi.map((row) => {
    const evidence = selectedCharacters.has(row.key) ? byKey.get(row.key) : undefined;
    const payload = payloadWithoutArchiveImages(row.payload as Record<string, unknown>);
    if (evidence?.sourceStatus === 'available' && evidence.sourceUrl)
      return { ...row, payload: { ...payload, images: { large: evidence.sourceUrl } } };
    return { ...row, payload };
  });
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
    input.source.endpoint ===
      `https://api.bgm.tv/v0/${input.recordKey.startsWith('character:') ? `characters/${input.recordKey.slice('character:'.length)}` : `subjects/${input.recordKey}`}`
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
