import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createBoundedPublicGet, MAX_IMPORT_DEADLINE_MS } from './import-fetch.ts';
import type { CrossMediaPlan } from './cross-media-seed.ts';

const BANGUMI_ORIGIN = 'https://api.bgm.tv';
const PERSON_PATH = '/v0/persons/';
const PERSON_LIMIT = 64;
const RECORD_BYTES = 65_536;
const REQUEST_GAP_MS = 250;

export type BangumiPersonSource = Readonly<{
  sourceAlias: 'bangumi_cross_media';
  externalId: string;
  sourceRevision: string;
  archiveDigest: string;
  endpoint: string;
  sourceStatus: 'available' | 'absent' | 'unavailable';
  responseDigest?: string;
  etag?: string;
  type?: number;
  birth_year?: number | null;
  birth_mon?: number | null;
  birth_day?: number | null;
  code?: 'source-api-http' | 'source-api-unavailable' | 'source-payload-invalid' | 'source-limit';
}>;

export interface BangumiPersonSourceJournal {
  personSource(sourceAlias: string, externalId: string, archiveDigest: string): BangumiPersonSource | null;
  sealPersonSource(source: BangumiPersonSource): BangumiPersonSource;
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

function integerOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

function personId(row: SourceRecord): string | undefined {
  if (!row.key.startsWith('person:')) return;
  const id = row.key.slice('person:'.length);
  return /^[1-9][0-9]*$/u.test(id) && Number.isSafeInteger(Number(id)) ? id : undefined;
}

function cachedSource(source: BangumiPersonSource, row: SourceRecord, endpoint: string): BangumiPersonSource {
  ensure(
    source.sourceAlias === 'bangumi_cross_media' &&
      source.externalId === row.key &&
      source.sourceRevision === (row.revision ?? 'unversioned') &&
      source.archiveDigest === sourceDigest(row.payload) &&
      source.endpoint === endpoint &&
      ['available', 'absent'].includes(source.sourceStatus),
    'Invalid sealed Bangumi person source',
  );
  ensure(
    typeof source.responseDigest === 'string' && /^[0-9a-f]{64}$/u.test(source.responseDigest),
    'Invalid sealed Bangumi person response digest',
  );
  ensure(
    source.etag === undefined || (source.etag.length <= 256 && /^[\x20-\x7e]*$/u.test(source.etag)),
    'Invalid sealed Bangumi person ETag',
  );
  return source;
}

async function lookupPerson(
  row: SourceRecord,
  get: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<BangumiPersonSource> {
  const id = personId(row);
  ensure(id, 'Invalid selected Bangumi person identity');
  const endpoint = `${BANGUMI_ORIGIN}${PERSON_PATH}${id}`;
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
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    ensure(bytes.byteLength <= RECORD_BYTES, 'Bangumi person response exceeds its byte limit');
    const responseDigest = createHash('sha256').update(bytes).digest('hex');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const person = object(parsed);
    ensure(
      person &&
        person.id === Number(id) &&
        typeof person.name === 'string' &&
        typeof person.type === 'number' &&
        Number.isSafeInteger(person.type) &&
        person.type === Number((row.payload as { type?: unknown }).type),
      'Bangumi person identity did not match',
    );
    const responseEtag = etagValue(response.headers.get('etag'));
    const birth_year = integerOrNull(person.birth_year);
    const birth_mon = integerOrNull(person.birth_mon);
    const birth_day = integerOrNull(person.birth_day);
    const complete =
      typeof birth_year === 'number' && typeof birth_mon === 'number' && typeof birth_day === 'number';
    return {
      ...base,
      sourceStatus: complete ? 'available' : 'absent',
      responseDigest,
      type: person.type,
      ...(birth_year === undefined ? {} : { birth_year }),
      ...(birth_mon === undefined ? {} : { birth_mon }),
      ...(birth_day === undefined ? {} : { birth_day }),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  } catch {
    return { ...base, sourceStatus: 'unavailable', code: 'source-payload-invalid' };
  }
}

function mergeBirth(payload: Record<string, unknown>, source: BangumiPersonSource): Record<string, unknown> {
  if (source.sourceStatus === 'unavailable') return payload;
  const next = { ...payload };
  if ('birth_year' in source) next.birth_year = source.birth_year;
  if ('birth_mon' in source) next.birth_mon = source.birth_mon;
  if ('birth_day' in source) next.birth_day = source.birth_day;
  return next;
}

/** One shared PersonDetail read per selected person, reused by date and later career/image consumers. */
export async function acquireBangumiPersonSources(
  plan: CrossMediaPlan,
  options: {
    journal?: BangumiPersonSourceJournal;
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
    pathPrefix: PERSON_PATH,
    maxResponseBytes: RECORD_BYTES,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: (ms) => options.sleep!(ms, signalForBatch) } : {}),
  });
  const rows = plan.entities.bangumi.filter((row) => personId(row));
  ensure(rows.length <= PERSON_LIMIT, 'Selected Bangumi person limit exceeded');
  const results = new Map<string, BangumiPersonSource>();
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    const payload = row.payload as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(payload, 'birth_year') &&
      Object.prototype.hasOwnProperty.call(payload, 'birth_mon') &&
      Object.prototype.hasOwnProperty.call(payload, 'birth_day')
    )
      continue;
    const id = personId(row)!;
    const endpoint = `${BANGUMI_ORIGIN}${PERSON_PATH}${id}`;
    const archiveDigest = sourceDigest(row.payload);
    const prior = options.journal?.personSource('bangumi_cross_media', row.key, archiveDigest);
    if (prior) {
      results.set(row.key, cachedSource(prior, row, endpoint));
      continue;
    }
    const evidence = await lookupPerson(row, get, signalForBatch);
    if (evidence.sourceStatus !== 'unavailable') options.journal?.sealPersonSource(evidence);
    results.set(row.key, evidence);
    if (index + 1 < rows.length) {
      try {
        await pause(REQUEST_GAP_MS, signalForBatch);
      } catch {
        for (const remaining of rows.slice(index + 1)) {
          if (seen.has(remaining.key) || results.has(remaining.key)) continue;
          results.set(remaining.key, {
            sourceAlias: 'bangumi_cross_media',
            externalId: remaining.key,
            sourceRevision: remaining.revision ?? 'unversioned',
            archiveDigest: sourceDigest(remaining.payload),
            endpoint: `${BANGUMI_ORIGIN}${PERSON_PATH}${personId(remaining)}`,
            sourceStatus: 'unavailable',
            code: 'source-api-unavailable',
          });
        }
        break;
      }
    }
  }
  const sources = [...results.values()];
  const byKey = new Map(sources.map((source) => [source.externalId, source]));
  return {
    ...plan,
    entities: {
      ...plan.entities,
      bangumi: plan.entities.bangumi.map((row) => {
        const evidence = byKey.get(row.key);
        return evidence ? { ...row, payload: mergeBirth(row.payload as Record<string, unknown>, evidence) } : row;
      }),
    },
    personSources: sources,
  };
}
