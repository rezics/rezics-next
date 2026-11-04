import { createHash } from 'node:crypto';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import {
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
  vndbPublicTagTaxonomy,
  type VndbPublicTagCategory,
} from '../../../packages/conversion/src/support.ts';
import type { AdmittedPublicTag } from './vndb-public-tags.ts';
import { vndbTagsRatingEndpoint } from '../../../packages/conversion/src/vndb-vocabulary.ts';

export const showcaseVndbTagRatingLimits = Object.freeze({
  works: 96,
  tags: 512,
  tagsPerWork: 64,
  responseBytes: 64 * 1024,
  responseTags: 512,
  totalBytes: 6 * 1024 * 1024,
  timeoutMs: 3_500,
  totalTimeoutMs: 120_000,
});

export type VndbTagRatingBinding = Readonly<{
  tagId: string;
  category: VndbPublicTagCategory;
  conceptId: string;
  schemeId: string;
  conceptUri: string;
  schemeUri: string;
}>;

export type VndbTagRatingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type VndbTagRatingObservation = Readonly<{
  workId: string;
  state: 'available' | 'unavailable' | 'partial' | 'not-requested';
  code?: string;
  requestBody?: string;
  responseDigest?: string;
  bindings: readonly VndbTagRatingBinding[];
}>;

export type VndbTagRatingSnapshot = Readonly<{
  workId: string;
  requestBody: string;
  bytes: Uint8Array;
  digest: string;
  tagIds: readonly string[];
}>;

export type VndbTagRatingAcquisition = Readonly<{
  observations: readonly VndbTagRatingObservation[];
  snapshots: ReadonlyMap<string, VndbTagRatingSnapshot>;
  partial: boolean;
}>;

function currentBinding(
  bindings: SourceVocabularyBindings,
  row: AdmittedPublicTag,
): VndbTagRatingBinding | undefined {
  const taxonomy = vndbPublicTagTaxonomy(row.category);
  const schemeUri = vndbPublicTagScheme(row.category);
  const concept = bindings.concepts.find((item) => item.taxonomy === taxonomy && item.code === row.tag);
  if (!concept) return;
  const scheme = bindings.schemes.find((item) => item.taxonomy === taxonomy);
  if (
    !scheme ||
    concept.schemeId !== scheme.id ||
    scheme.uri !== schemeUri ||
    concept.releaseDigest !== bindings.releaseDigest ||
    scheme.releaseDigest !== bindings.releaseDigest
  )
    return;
  return {
    tagId: row.tag,
    category: row.category,
    conceptId: concept.id,
    schemeId: scheme.id,
    conceptUri: vndbPublicTagConceptUri(row.category, row.tag),
    schemeUri,
  };
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > showcaseVndbTagRatingLimits.responseBytes))
    throw new RangeError('Kana tag-rating response exceeds byte cap');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let body = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.buffer.byteLength > showcaseVndbTagRatingLimits.responseBytes)
        throw new RangeError('Kana tag-rating response exceeds byte cap');
      if (value.byteLength > showcaseVndbTagRatingLimits.responseBytes - size)
        throw new RangeError('Kana tag-rating response exceeds byte cap');
      const next = new Uint8Array(size + value.byteLength);
      next.set(body);
      next.set(value, size);
      body = next;
      size += value.byteLength;
    }
    signal.throwIfAborted();
    return body;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function authenticResponse(bytes: Uint8Array, workId: string): boolean {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      more?: unknown;
      results?: unknown;
    };
    if (value?.more !== false || !Array.isArray(value.results) || value.results.length !== 1) return false;
    const result = value.results[0];
    const tags = result !== null && typeof result === 'object' && !Array.isArray(result) ? Reflect.get(result, 'tags') : null;
    return (
      result !== null &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      Reflect.get(result, 'id') === workId &&
      Array.isArray(tags) &&
      tags.length <= showcaseVndbTagRatingLimits.responseTags
    );
  } catch {
    return false;
  }
}

/** Read only selected VN identities and the exact current tag bindings the importer may propose. */
export async function acquireShowcaseVndbTagRatings(input: {
  selectedVids: readonly string[];
  admitted: readonly AdmittedPublicTag[];
  bindings: SourceVocabularyBindings;
  fetch?: VndbTagRatingFetch;
}): Promise<VndbTagRatingAcquisition> {
  const fetcher: VndbTagRatingFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const selected = [...new Set(input.selectedVids.filter((id) => /^v[1-9][0-9]{0,9}$/u.test(id)))].sort();
  if (selected.length !== input.selectedVids.length) throw new TypeError('Invalid selected VNDB work set');
  const rowsByWork = new Map<string, AdmittedPublicTag[]>();
  for (const row of input.admitted) {
    if (!selected.includes(row.vid)) continue;
    const rows = rowsByWork.get(row.vid) ?? [];
    rows.push(row);
    rowsByWork.set(row.vid, rows);
  }
  for (const rows of rowsByWork.values()) rows.sort((left, right) => left.tag.localeCompare(right.tag));

  const observations: VndbTagRatingObservation[] = [];
  const snapshots = new Map<string, VndbTagRatingSnapshot>();
  const batchSignal = AbortSignal.timeout(showcaseVndbTagRatingLimits.totalTimeoutMs);
  let totalBytes = 0;
  let selectedTagCount = 0;
  let requestedWorks = 0;
  let partial = false;
  for (const workId of selected) {
    const admitted = rowsByWork.get(workId) ?? [];
    const bindings: VndbTagRatingBinding[] = [];
    for (const row of admitted.slice(0, showcaseVndbTagRatingLimits.tagsPerWork)) {
      const binding = currentBinding(input.bindings, row);
      if (binding) bindings.push(binding);
    }
    const localOverflow = admitted.length > showcaseVndbTagRatingLimits.tagsPerWork;
    const globalOverflow = selectedTagCount + bindings.length > showcaseVndbTagRatingLimits.tags;
    const boundedBindings = globalOverflow
      ? bindings.slice(0, Math.max(0, showcaseVndbTagRatingLimits.tags - selectedTagCount))
      : bindings;
    selectedTagCount += boundedBindings.length;
    if (localOverflow || globalOverflow) partial = true;
    if (!boundedBindings.length) {
      observations.push({
        workId,
        state: admitted.length ? 'unavailable' : 'not-requested',
        ...(admitted.length ? { code: 'current-tag-binding-unavailable' } : {}),
        bindings: boundedBindings,
      });
      continue;
    }
    if (requestedWorks >= showcaseVndbTagRatingLimits.works || batchSignal.aborted) {
      partial = true;
      observations.push({ workId, state: 'partial', code: 'selected-work-limit', bindings: boundedBindings });
      continue;
    }
    requestedWorks += 1;
    const requestBody = JSON.stringify({
      filters: ['id', '=', workId],
      fields: 'id,tags{id,rating,spoiler,lie}',
      results: 1,
    });
    try {
      const signal = AbortSignal.any([batchSignal, AbortSignal.timeout(showcaseVndbTagRatingLimits.timeoutMs)]);
      const response = await fetcher(vndbTagsRatingEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: requestBody,
        redirect: 'error',
        signal,
      });
      if (response.status !== 200) {
        observations.push({ workId, state: 'unavailable', code: 'kana-http', requestBody, bindings: boundedBindings });
        continue;
      }
      const bytes = await responseBytes(response, signal);
      if (bytes.byteLength > showcaseVndbTagRatingLimits.totalBytes - totalBytes) {
        partial = true;
        observations.push({ workId, state: 'partial', code: 'total-response-byte-cap', requestBody, bindings: boundedBindings });
        continue;
      }
      totalBytes += bytes.byteLength;
      if (!authenticResponse(bytes, workId)) {
        observations.push({ workId, state: 'unavailable', code: 'kana-response-invalid', requestBody, bindings: boundedBindings });
        continue;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      snapshots.set(workId, {
        workId,
        requestBody,
        bytes,
        digest,
        tagIds: boundedBindings.map((item) => item.tagId),
      });
      observations.push({
        workId,
        state: localOverflow || globalOverflow ? 'partial' : 'available',
        ...(localOverflow || globalOverflow ? { code: 'tag-binding-limit' } : {}),
        requestBody,
        responseDigest: digest,
        bindings: boundedBindings,
      });
    } catch (error) {
      const timeout = error instanceof Error && /timeout|aborted/iu.test(error.name + error.message);
      observations.push({
        workId,
        state: 'unavailable',
        code: timeout ? 'kana-timeout' : 'kana-unavailable',
        requestBody,
        bindings: boundedBindings,
      });
    }
  }
  if (selected.length > observations.length) partial = true;
  return { observations, snapshots, partial };
}
