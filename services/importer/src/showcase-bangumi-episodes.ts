import { BATCH_LIMIT } from '@rezics/definitions/bulk';
import type { SourceRecord, SourceVocabularyBindings, SourceVocabularyRequest } from '@rezics/conversion';
import { bundledDigest } from '@rezics/definitions/bundled';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import {
  episodeTypeSchemeUri,
  episodeTypeTaxonomy,
  episodeVocabularyAdmission,
  readEpisodeTypeBindings,
} from './bangumi-episode-fidelity.ts';
import {
  type CrossMediaGap,
  type CrossMediaMember,
  type CrossMediaTables,
  type Franchise,
} from './showcase-contract.ts';
import {
  type CrossMediaPort,
} from './showcase-contract.ts';
import type { GraphEdgeDraft } from './cross-media-bindings.ts';
import type { Owner } from './record-bindings.ts';
import type { ImportConversion } from './import-contract.ts';
import type { ImporterOptions } from './importer.ts';

type SourceVocabularyAdmission = NonNullable<ImporterOptions['vocabularyAdmission']>;

export const SHOWCASE_EPISODE_WINDOW = BATCH_LIMIT;
const MAX_EPISODE_OMISSION_GAPS = 4096;
const CATALOGUE_SCHEME_KEY = 'bangumi-episode-types-scheme';
const catalogueConceptKey = (code: string) => `bangumi-episode-type-${code}`;

export type ShowcaseEpisodeDiagnostic = {
  sourceKey: string;
  path: string;
  reason: string;
  code?: string;
  property?: string;
};

export type ShowcaseEpisodeSelection = {
  entities: SourceRecord[];
  members: CrossMediaMember[];
  edges: GraphEdgeDraft[];
  gaps: CrossMediaGap[];
};

function positiveId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/u.test(value)) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeDiagnosticValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length <= 32 && /^[\x20-\x7e]*$/u.test(value)) return value;
  return null;
}

function recordFields(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .filter((field) => /^[a-z][a-z0-9_]{0,63}$/u.test(field))
    .slice(0, 64)
    .sort()
    .map((field) => `episode.${field}`);
}

/** Select only episodes whose exact source parent is a selected type-2 family member. */
export async function discoverShowcaseBangumiEpisodes(input: {
  tables: CrossMediaTables;
  selectedAnime: ReadonlyMap<number, Franchise>;
  alias: string;
}): Promise<ShowcaseEpisodeSelection> {
  const result: ShowcaseEpisodeSelection = { entities: [], members: [], edges: [], gaps: [] };
  const counts = new Map<Franchise, number>();
  const seen = new Set<string>();
  const addGap = (gap: CrossMediaGap) => {
    if (result.gaps.length >= MAX_EPISODE_OMISSION_GAPS)
      throw new TypeError(
        `Selected Bangumi episode omissions exceed the bounded diagnostic limit at ${gap.externalId ?? 'unknown source key'}`,
      );
    result.gaps.push(gap);
  };

  for await (const row of input.tables.rows('bangumi', 'episode')) {
    const parentId = positiveId(row.subject_id);
    const family = parentId === undefined ? undefined : input.selectedAnime.get(parentId);
    if (!family) continue;
    const parentIsWellFormed =
      typeof row.subject_id === 'number' && Number.isSafeInteger(row.subject_id) && row.subject_id > 0;
    const id = positiveId(row.id);
    const record = {
      id: id ?? safeDiagnosticValue(row.id),
      subject_id: safeDiagnosticValue(row.subject_id) ?? parentId,
    };
    if (id === undefined) {
      addGap({
        source: 'bangumi',
        fields: ['episode.id'],
        record,
        reason: 'Episode identity is malformed; no source Episode can be created',
      });
      continue;
    }
    const sourceKey = `episode:${id}`;
    if (seen.has(sourceKey)) {
      addGap({
        source: 'bangumi',
        fields: ['episode.id'],
        record,
        externalId: sourceKey,
        reason: 'Duplicate selected Bangumi episode source key',
      });
      continue;
    }
    seen.add(sourceKey);

    const count = counts.get(family) ?? 0;
    if (count >= SHOWCASE_EPISODE_WINDOW) {
      addGap({
        source: 'bangumi',
        fields: ['episode.id', 'episode.subject_id'],
        record,
        externalId: sourceKey,
        reason: 'Selected episode exceeds the bounded family delivery window',
      });
      continue;
    }
    counts.set(family, count + 1);

    const sourceRecord: SourceRecord = {
      source: 'bangumi',
      key: sourceKey,
      revision: null,
      payload: row,
    };
    result.entities.push(sourceRecord);
    result.members.push({
      source: 'bangumi',
      key: sourceKey,
      kind: 'episode',
      membership: 'referenced',
      franchise: family,
    });
    if (parentIsWellFormed) {
      result.edges.push({
        source: 'bangumi',
        alias: input.alias,
        table: 'episode',
        holder: sourceKey,
        target: String(parentId),
        property: 'schema:isPartOf',
        url: bangumiRecordUrl(sourceKey),
        membership: 'referenced',
        record: row,
        fields: recordFields(row),
      });
    } else {
      addGap({
        source: 'bangumi',
        fields: ['episode.subject_id'],
        record,
        externalId: sourceKey,
        reason: 'Episode parent key is malformed; only the parent statement is withheld',
      });
    }
  }
  return result;
}

export async function readShowcaseEpisodeTypeBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  subjects: Readonly<Record<string, string>>,
): Promise<SourceVocabularyBindings> {
  const schemeId = subjects[CATALOGUE_SCHEME_KEY];
  if (!schemeId) return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  const concepts = Array.from({ length: 7 }, (_, index) => {
    const code = String(index);
    const id = subjects[catalogueConceptKey(code)];
    return id ? { code, id } : undefined;
  }).filter((entry): entry is { code: string; id: string } => entry !== undefined);
  return readEpisodeTypeBindings(port, { schemeId, concepts });
}

export function composeVocabularyAdmissions(
  ...admissions: readonly (SourceVocabularyAdmission | undefined)[]
): SourceVocabularyAdmission | undefined {
  const hooks = admissions.filter((item): item is SourceVocabularyAdmission => !!item?.request);
  if (!hooks.length) return;
  return {
    request(input: {
      owner: Owner;
      conversion: ImportConversion;
      subject?: string;
    }): SourceVocabularyRequest | undefined {
      const requests = hooks
        .map((hook) => hook.request?.(input))
        .filter((request): request is SourceVocabularyRequest => request !== undefined);
      if (!requests.length) return;
      const releaseDigest = requests[0]!.bindings.releaseDigest;
      if (requests.some((request) => request.bindings.releaseDigest !== releaseDigest))
        throw new TypeError('Vocabulary admissions use different definition releases');
      const unique = <T>(values: readonly T[]) => {
        const result = new Map<string, T>();
        for (const value of values) {
          const key = JSON.stringify(value);
          if (key !== undefined) result.set(key, value);
        }
        return [...result.values()];
      };
      return {
        bindings: {
          releaseDigest,
          schemes: unique(requests.flatMap((request) => request.bindings.schemes)),
          concepts: unique(requests.flatMap((request) => request.bindings.concepts)),
        },
        rows: requests.flatMap((request) => request.rows),
      };
    },
  };
}

export function showcaseEpisodeAdmissionDiagnostics(
  entities: readonly SourceRecord[],
  bindings: SourceVocabularyBindings,
): ShowcaseEpisodeDiagnostic[] {
  const scheme = bindings.schemes.some(
    (item) =>
      item.taxonomy === episodeTypeTaxonomy &&
      item.uri === episodeTypeSchemeUri &&
      item.type === 'skos:ConceptScheme' &&
      item.releaseDigest === bundledDigest,
  );
  const diagnostics: ShowcaseEpisodeDiagnostic[] = [];
  for (const entity of entities) {
    if (!entity.key.startsWith('episode:') || !entity.payload || typeof entity.payload !== 'object') continue;
    const payload = entity.payload as Record<string, unknown>;
    if (payload.type === undefined) continue;
    const sourceKey = entity.key;
    const id = sourceKey.slice('episode:'.length);
    const path = `/episode/${id}/type`;
    const code = typeof payload.type === 'string' || typeof payload.type === 'number' ? String(payload.type) : '';
    if (!/^[0-6]$/u.test(code)) {
      diagnostics.push({
        sourceKey,
        path,
        ...(/^[0-9]{1,4}$/u.test(code) ? { code } : {}),
        reason: 'unknown_code',
        property: 'episode.type',
      });
      continue;
    }
    if (!scheme) {
      diagnostics.push({ sourceKey, path, code, reason: 'missing_scheme', property: 'episode.type' });
      continue;
    }
    const conceptId = bindings.concepts.find(
      (item) =>
        item.taxonomy === episodeTypeTaxonomy &&
        item.code === code &&
        item.type === 'skos:Concept' &&
        item.schemeId === bindings.schemes.find((candidate) => candidate.taxonomy === episodeTypeTaxonomy)?.id &&
        item.releaseDigest === bundledDigest,
    );
    if (!conceptId) diagnostics.push({ sourceKey, path, code, reason: 'unbound_concept', property: 'episode.type' });
  }
  return diagnostics;
}

export function showcaseEpisodeVocabularyAdmission(bindings: SourceVocabularyBindings): SourceVocabularyAdmission {
  return episodeVocabularyAdmission(bindings);
}
