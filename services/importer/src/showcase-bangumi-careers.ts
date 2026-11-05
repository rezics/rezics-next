import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createBoundedPublicGet, MAX_IMPORT_DEADLINE_MS } from './import-fetch.ts';
import type { CrossMediaPlan } from './cross-media-seed.ts';
import type { BangumiPersonCareerSource } from './showcase-media.ts';

const origin = 'https://api.bgm.tv';
const pathPrefix = '/v0/persons/';
const peopleLimit = 64;
const responseLimit = 64 * 1024;
const requestGapMs = 250;

export interface BangumiPersonCareerSourceJournal {
  personCareerSource(alias: string, externalId: string, archiveDigest: string): BangumiPersonCareerSource | null;
  sealPersonCareerSource(source: BangumiPersonCareerSource): BangumiPersonCareerSource;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function etag(value: string | null): string | undefined {
  return value !== null && value.length > 0 && value.length <= 64 && /^[\x20-\x7e]*$/u.test(value) ? value : undefined;
}

function selectedPeople(plan: CrossMediaPlan): SourceRecord[] {
  const selected = new Set(
    plan.members
      .filter((member) => member.source === 'bangumi' && member.kind === 'person')
      .map((member) => member.key),
  );
  const rows = plan.entities.bangumi.filter(
    (row) =>
      selected.has(row.key) && /^person:[1-9][0-9]*$/u.test(row.key) && Number.isSafeInteger(Number(row.key.slice(7))),
  );
  if (rows.length > peopleLimit) throw new RangeError('Selected Bangumi Person career limit exceeded');
  return rows;
}

function receipt(source: BangumiPersonCareerSource, row: SourceRecord): BangumiPersonCareerSource {
  const endpoint = `${origin}${pathPrefix}${row.key.slice('person:'.length)}`;
  if (
    source.sourceAlias !== 'bangumi_cross_media' ||
    source.externalId !== row.key ||
    source.archiveDigest !== sourceDigest(row.payload) ||
    source.endpoint !== endpoint ||
    source.sourceRevision !== (row.revision ?? 'unversioned') ||
    source.sourceStatus !== 'available' ||
    !/^[0-9a-f]{64}$/u.test(source.responseDigest ?? '') ||
    !Array.isArray(source.careers) ||
    source.careers.length > 7 ||
    source.careers.some(
      (career) => typeof career !== 'string' || !career.isWellFormed() || Buffer.byteLength(career, 'utf8') > 64,
    )
  )
    throw new TypeError('Invalid sealed Bangumi Person career source');
  return source;
}

async function readCareers(
  row: SourceRecord,
  get: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<BangumiPersonCareerSource> {
  const externalId = row.key;
  const id = Number(externalId.slice('person:'.length));
  const endpoint = `${origin}${pathPrefix}${id}`;
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
  if (response.status !== 200) return { ...base, sourceStatus: 'unavailable', code: 'source-api-http' };
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > responseLimit) throw new TypeError('Oversized Person response');
    const responseDigest = createHash('sha256').update(bytes).digest('hex');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const person = object(parsed);
    const careers = person?.career;
    if (
      !person ||
      person.id !== id ||
      !Array.isArray(careers) ||
      careers.length > 7 ||
      careers.some(
        (value) =>
          typeof value !== 'string' ||
          !value.isWellFormed() ||
          Buffer.byteLength(value, 'utf8') > 64 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(value),
      )
    )
      throw new TypeError('Invalid Bangumi Person career response');
    const etagHeader = response.headers.get('etag');
    const responseEtag = etag(etagHeader);
    if (etagHeader !== null && responseEtag === undefined) throw new TypeError('Invalid Bangumi Person ETag');
    return {
      ...base,
      sourceStatus: 'available',
      careers: [...new Set(careers as string[])],
      responseDigest,
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  } catch {
    return { ...base, sourceStatus: 'unavailable', code: 'source-payload-invalid' };
  }
}

/** Fill only absent archive careers for selected actual Person rows through the bounded public API. */
export async function acquireBangumiPersonCareerSources(
  plan: CrossMediaPlan,
  options: {
    journal?: BangumiPersonCareerSourceJournal;
    fetch?: typeof fetch;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<CrossMediaPlan> {
  const signal = AbortSignal.timeout(MAX_IMPORT_DEADLINE_MS);
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
    origin,
    pathPrefix,
    maxResponseBytes: responseLimit,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: (ms) => options.sleep!(ms, signal) } : {}),
  });
  const sources: BangumiPersonCareerSource[] = [];
  const failures = new Set<string>();
  const people = selectedPeople(plan).filter((row) => {
    const payload = object(row.payload);
    return payload?.type === 1 && !Object.hasOwn(payload, 'career');
  });
  for (let index = 0; index < people.length; index++) {
    const row = people[index]!;
    const archiveDigest = sourceDigest(row.payload);
    const cached = options.journal?.personCareerSource('bangumi_cross_media', row.key, archiveDigest);
    let evidence: BangumiPersonCareerSource;
    if (cached) {
      evidence = receipt(cached, row);
    } else {
      evidence = await readCareers(row, get, signal);
      if (evidence.sourceStatus === 'available') options.journal?.sealPersonCareerSource(evidence);
    }
    if (evidence.sourceStatus !== 'available') failures.add(row.key);
    else sources.push(evidence);
    if (index + 1 < people.length) {
      try {
        await pause(requestGapMs, signal);
      } catch {
        for (const remaining of people.slice(index + 1)) failures.add(remaining.key);
        break;
      }
    }
  }
  const sourceByPerson = new Map(sources.map((source) => [source.externalId, source]));
  const entities = plan.entities.bangumi.map((row) => {
    const source = sourceByPerson.get(row.key);
    if (!source || !source.careers) return row;
    return { ...row, payload: { ...row.payload, career: [...source.careers] } };
  });
  const gaps = [...plan.gaps];
  for (const key of failures)
    gaps.push({
      source: 'bangumi',
      externalId: key,
      fields: ['person.career'],
      record: { id: Number(key.slice('person:'.length)) },
      reason: 'Bangumi Person career source unavailable; dependent occupations withheld',
      property: 'wdt:P106',
    });
  return { ...plan, entities: { ...plan.entities, bangumi: entities }, personCareerSources: sources, gaps };
}

/** Build ordinary source-vocabulary rows from the current selected binding and exact API receipt. */
export function bangumiPersonCareerAdmission(
  sourceAlias: string,
  bindings: import('@rezics/conversion').SourceVocabularyBindings,
  sources: readonly BangumiPersonCareerSource[] = [],
) {
  const byPerson = new Map(sources.map((source) => [source.externalId, source]));
  return {
    request({
      owner,
      conversion,
      subject,
    }: {
      owner: { source: string; external_id: string };
      conversion: { normalized?: unknown; converter_revision?: string };
      subject?: string;
    }) {
      if (owner.source !== sourceAlias || !owner.external_id.startsWith('person:') || !subject) return undefined;
      const normalized = object(conversion.normalized);
      if (!normalized || !Array.isArray(normalized.career)) return undefined;
      const identityType =
        normalized.type === 1
          ? 'schema:Person'
          : normalized.type === 2 || normalized.type === 3
            ? 'schema:Organization'
            : undefined;
      if (!identityType) return undefined;
      const source = byPerson.get(owner.external_id);
      const origin =
        source?.sourceStatus === 'available'
          ? {
              externalId: owner.external_id,
              revision: source.etag ?? null,
              digest: source.responseDigest!,
              url: source.endpoint,
              converterRevision: conversion.converter_revision!,
            }
          : undefined;
      const rows = normalized.career.flatMap((code) =>
        typeof code === 'string'
          ? [
              {
                kind: 'person-career' as const,
                person: { id: subject, type: identityType, releaseDigest: bindings.releaseDigest },
                code,
                path: '/career',
                ...(origin ? { origin } : {}),
              },
            ]
          : [],
      );
      return { bindings, rows };
    },
  };
}
