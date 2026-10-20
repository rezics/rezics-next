import { checkedSemanticValue } from '../../../services/main/src/modules/semantic/value.ts';
import { recordedLanguageTag } from '../../../services/main/src/modules/release/languages.ts';
import { checkedRealization } from '../../../services/main/src/modules/realization/schema.ts';
import { canonical } from '../store.ts';
import type {
  DatasetCoverageKey,
  DatasetMappingContext,
  DatasetMappingReceipt,
  DatasetNativeMapper,
  DatasetNativeRecord,
  DatasetRecord,
  DatasetSourceReference,
} from '../types.ts';
import { datasetRecordDigest, datasetSourceIdentity } from './context.ts';

type Row = Record<string, unknown>;
type Completeness = 'complete' | 'partial' | 'trial' | 'unknown';
const object = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const native = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const short = (id: string) => id.slice(-36);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const completeness = (value: unknown): Completeness =>
  value === 'complete' || value === 'partial' || value === 'trial' ? value : 'unknown';

export interface DatasetReleaseGap {
  owner: 'source' | 'release' | 'realization' | 'importer';
  schema: string;
  operation: string;
  required: string;
}

export interface DatasetReleaseFact {
  occurrence: DatasetCoverageKey;
  role:
    | 'title'
    | 'status'
    | 'platform'
    | 'publication-date'
    | 'language'
    | 'translator-status'
    | 'coverage'
    | 'territory'
    | 'identifier';
  /** Exact retained value, including false, zero, null and unknown provider tokens. */
  value: unknown;
  normalized?: unknown;
  precision?: 'year' | 'month' | 'day';
  sourceWork?: string;
  gap?: DatasetReleaseGap;
}

export interface DatasetReleaseCandidate {
  /** Provider-qualified source identity; neither snapshot nor mutable bytes allocate an ID. */
  key: string;
  source: DatasetSourceReference;
  sourceUrl: string;
  grain: 'release' | 'release-group' | 'work' | 'publication-event';
  disposition: 'candidate' | 'source-only';
  facts: DatasetReleaseFact[];
  gaps: DatasetReleaseGap[];
}

/** A view of already acknowledged owner receipts, not a new adoption/support protocol.
 * Keep it separate from context.native: a descriptive PublicationEvent retains its ID.
 * release.projection lists only source values actually adopted by that producer.
 * An ordinary release PUT receipt without that source binding is insufficient. */
export interface DatasetReleaseCorrespondence {
  source: DatasetSourceReference;
  work: string;
  release: DatasetNativeRecord;
  realizations: readonly { work: string; native: DatasetNativeRecord }[];
}

export interface DatasetReleaseMapping {
  candidate: DatasetReleaseCandidate;
  mappings: Array<{ occurrence: DatasetCoverageKey; mapping: DatasetMappingReceipt }>;
  gaps: DatasetReleaseGap[];
}

const sourceGap = (): DatasetReleaseGap => ({
  owner: 'source',
  schema: 'source-native-work-adoption-v1 / source-native-child-adoption-v1',
  operation: 'postV1SourcesProposalsByProposalAdoptionNative-work',
  required:
    'Exact source release-to-native release/realization admission and independent support receipts; Work/child adoption does not admit a release',
});
const realizationGap = (required: string): DatasetReleaseGap => ({
  owner: 'realization',
  schema: 'realization-v1',
  operation: 'getV1WorksByIdRealizationsByRealization',
  required,
});
const releaseGap = (required: string): DatasetReleaseGap => ({
  owner: 'release',
  schema: 'release-v2 / release-v3',
  operation: 'getV1WorksByIdReleasesByRelease',
  required,
});

function date(
  value: unknown,
  packed: boolean,
): { normalized: string; precision: 'year' | 'month' | 'day' } | undefined {
  let lexical =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (packed) {
    if (!/^[0-9]{8}$/.test(lexical) || lexical === '99999999') return undefined;
    const year = lexical.slice(0, 4),
      month = lexical.slice(4, 6),
      day = lexical.slice(6, 8);
    if (month === '99' && day !== '99') return undefined;
    lexical = month === '99' ? year : day === '99' ? `${year}-${month}` : `${year}-${month}-${day}`;
  }
  const precision = /^[0-9]{4}$/.test(lexical)
    ? 'year'
    : /^[0-9]{4}-[0-9]{2}$/.test(lexical)
      ? 'month'
      : 'day';
  try {
    checkedSemanticValue({ kind: 'temporal', lexical, precision, calendar: 'gregorian' });
    return { normalized: lexical, precision };
  } catch {
    return undefined;
  }
}

function language(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const tag = recordedLanguageTag(value);
    return ['und', 'mul', 'zxx'].includes(tag) ? undefined : tag;
  } catch {
    return undefined;
  }
}

/** Describe one real release, without constructing a realization from a display language,
 * track, release-group, Work date, or free-text edition note. */
export function projectDatasetReleases(
  record: DatasetRecord,
  source: DatasetSourceReference,
): DatasetReleaseCandidate {
  if (
    source.key !== record.key ||
    source.provider !== record.provider ||
    source.namespace !== record.kind ||
    source.externalId !== record.externalId ||
    source.recordDigest !== datasetRecordDigest(record)
  )
    throw new Error(`Release source reference differs from retained record: ${record.key}`);
  const grain =
    record.kind === 'release-group'
      ? 'release-group'
      : record.semanticTypes?.includes('https://schema.org/PublicationEvent')
        ? 'publication-event'
        : record.kind === 'release' && record.native === 'release'
          ? 'release'
          : 'work';
  const candidate: DatasetReleaseCandidate = {
    key: datasetSourceIdentity(record),
    source,
    sourceUrl: record.sourceUrl,
    grain,
    disposition: grain === 'release' ? 'candidate' : 'source-only',
    facts: [],
    gaps: [],
  };
  if (grain !== 'release') {
    candidate.gaps.push(
      releaseGap(`${grain} identity is not an edition; retain genuine editions independently`),
    );
    return candidate;
  }
  const add = (
    path: string,
    role: DatasetReleaseFact['role'],
    value: unknown,
    extra: Partial<DatasetReleaseFact> = {},
  ) =>
    candidate.facts.push({
      occurrence: { record: record.key, kind: 'field', path },
      role,
      value,
      ...extra,
    });
  add('/title', 'title', record.title, { normalized: record.title });
  const publicationDate = (path: string, value: unknown, packed = false) => {
    const parsed = date(value, packed);
    add(
      path,
      'publication-date',
      value,
      parsed
        ? {
            ...parsed,
            ...(parsed.precision === 'year'
              ? {}
              : {
                  gap: releaseGap(
                    'publicationYear cannot acknowledge month/day precision; retain the exact temporal value with its source support',
                  ),
                }),
          }
        : {
            gap: releaseGap(
              'Unknown or invalid publication date stays unknown; no year/day is fabricated',
            ),
          },
    );
  };
  const tables = object(record.data.tables);
  if (record.provider === 'vndb') {
    if (Object.hasOwn(record.data, 'released'))
      publicationDate('/data/released', record.data.released, true);
    if (Object.hasOwn(record.data, 'official')) {
      const value = record.data.official;
      const normalized =
        value === true || value === 't'
          ? 'official'
          : value === false || value === 'f'
            ? 'unofficial'
            : undefined;
      add('/data/official', 'status', value, { normalized });
    }
    for (const table of ['releases_platforms', 'releases_titles', 'releases_vn'] as const) {
      const rows = tables?.[table];
      if (!Array.isArray(rows)) continue;
      rows.forEach((value, index) => {
        const row = object(value);
        if (!row) return;
        const path = `/data/tables/${table}/${index}`;
        if (table === 'releases_platforms' && Object.hasOwn(row, 'platform'))
          add(`${path}/platform`, 'platform', row.platform, {
            normalized: typeof row.platform === 'string' && row.platform ? row.platform : undefined,
          });
        if (table === 'releases_titles') {
          if (Object.hasOwn(row, 'lang'))
            add(`${path}/lang`, 'language', row.lang, { normalized: language(row.lang) });
          // mtl belongs to this release-language occurrence, not to all translations of the Work.
          if (Object.hasOwn(row, 'mtl'))
            add(`${path}/mtl`, 'translator-status', row.mtl, {
              gap: realizationGap(
                'realization-v1 has translators but no machine-translation status; retain the release-language qualifier',
              ),
            });
        }
        if (table === 'releases_vn' && typeof row.vid === 'string' && Object.hasOwn(row, 'rtype'))
          add(`${path}/rtype`, 'coverage', row.rtype, {
            normalized: completeness(row.rtype),
            sourceWork: `vndb:vn:${row.vid}`,
          });
      });
    }
  } else if (record.provider === 'musicbrainz') {
    if (Object.hasOwn(record.data, 'date')) publicationDate('/data/date', record.data.date);
    if (Object.hasOwn(record.data, 'status'))
      add('/data/status', 'status', record.data.status, {
        normalized:
          record.data.status === 'Official'
            ? 'official'
            : record.data.status === 'Bootleg'
              ? 'unofficial'
              : undefined,
      });
    // MusicBrainz text-representation describes titles/tracklists, not sung content.
    const text = object(record.data['text-representation']);
    if (text && Object.hasOwn(text, 'language'))
      add('/data/text-representation/language', 'language', text.language, {
        gap: realizationGap(
          'MusicBrainz text-representation is title/tracklist language, not a content realization',
        ),
      });
    if (Object.hasOwn(record.data, 'country'))
      add('/data/country', 'territory', record.data.country, { normalized: record.data.country });
    if (Object.hasOwn(record.data, 'barcode'))
      add('/data/barcode', 'identifier', record.data.barcode, {
        normalized: { provider: 'https://musicbrainz.org/doc/Barcode', value: record.data.barcode },
      });
    const events = record.data['release-events'];
    if (Array.isArray(events))
      events.forEach((value, index) => {
        const event = object(value),
          path = `/data/release-events/${index}`;
        if (event && Object.hasOwn(event, 'date')) {
          const parsed = date(event.date, false);
          add(`${path}/date`, 'publication-date', event.date, {
            ...parsed,
            gap: releaseGap(
              'A release-event date stays bound to its own area; release-v2 has no event/precision slot',
            ),
          });
        }
      });
  }
  candidate.gaps.push(sourceGap());
  return candidate;
}

export function datasetReleaseCandidates(
  context: DatasetMappingContext,
): DatasetReleaseCandidate[] {
  const candidates: DatasetReleaseCandidate[] = [];
  for (const record of context.records.values()) {
    if (
      !context.selected.has(record.key) ||
      !(
        record.native === 'release' ||
        record.kind === 'release-group' ||
        record.semanticTypes?.includes('https://schema.org/Book') ||
        record.semanticTypes?.includes('https://schema.org/PublicationEvent')
      )
    )
      continue;
    const reference = context.source(record.key);
    if (
      reference.snapshot !== context.snapshot.id ||
      reference.snapshotDigest !== context.snapshot.digest
    )
      throw new Error(`Release source reference differs from frozen snapshot: ${record.key}`);
    const candidate = projectDatasetReleases(record, reference);
    if (candidate.grain === 'release')
      context.snapshot.sources.forEach((source, sourceIndex) => {
        source.edges.forEach((edge, index) => {
          if (edge.from !== record.key || edge.kind !== 'release-of') return;
          candidate.facts.push({
            occurrence: {
              record: edge.from,
              kind: 'edge',
              path: `/sources/${sourceIndex}/edges/${index}`,
            },
            role: 'coverage',
            value: edge,
            normalized: completeness(edge.data.rtype),
            sourceWork: edge.to,
          });
        });
      });
    candidates.push(candidate);
  }
  return candidates;
}

function receipt(
  value: DatasetNativeRecord,
  kind: 'release' | 'realization',
  work: string,
): boolean {
  const result = value.receipt,
    position = object(result.sourcePosition);
  return (
    value.kind === kind &&
    native(value.id) &&
    result[kind] === value.id &&
    result.work === work &&
    native(result.revision) &&
    typeof result.receipt === 'string' &&
    result.receipt.length > 0 &&
    typeof position?.dataEpoch === 'string' &&
    position.dataEpoch.length > 0 &&
    typeof position.sequence === 'string' &&
    /^[0-9]+$/.test(position.sequence)
  );
}

function linkedWork(context: DatasetMappingContext, record: DatasetRecord, work: string): boolean {
  const rows = object(record.data.tables)?.releases_vn;
  if (
    record.provider === 'vndb' &&
    Array.isArray(rows) &&
    rows.some(
      (row) =>
        object(row)?.vid === context.records.get(work)?.externalId &&
        context.records.get(work)?.provider === 'vndb' &&
        context.records.get(work)?.kind === 'vn',
    )
  )
    return true;
  return context.snapshot.sources.some((source) =>
    source.edges.some(
      (edge) =>
        (edge.kind === 'release-of' && edge.from === record.key && edge.to === work) ||
        (record.provider === 'musicbrainz' &&
          edge.kind === 'release' &&
          edge.to === record.key &&
          edge.from === work),
    ),
  );
}

async function verifiedCorrespondence(
  context: DatasetMappingContext,
  candidate: DatasetReleaseCandidate,
  binding: DatasetReleaseCorrespondence,
): Promise<{ view: Row; realizations: Row[]; path: string } | DatasetReleaseGap> {
  const record = context.records.get(candidate.source.key)!,
    work = context.native.get(binding.work);
  if (
    !same(binding.source, candidate.source) ||
    !binding.source.observations.length ||
    binding.source.intakes.length !== 1 ||
    !same(
      binding.source.observations,
      binding.source.intakes.map((item) => item.observation),
    ) ||
    binding.source.intakes.some(
      (item) =>
        !native(item.record) ||
        !native(item.observation) ||
        !/^[0-9a-f]{64}$/.test(item.byteDigest),
    )
  )
    return sourceGap();
  if (
    !work ||
    work.kind !== 'work' ||
    !native(work.id) ||
    !linkedWork(context, record, binding.work)
  )
    return releaseGap(
      'Correspondence needs the exact acknowledged native Work of this source release, not a neighbor/title match',
    );
  if (
    !receipt(binding.release, 'release', work.id) ||
    binding.release.sourceIdentity !== candidate.key ||
    binding.release.projection?.recordDigest !== candidate.source.recordDigest
  )
    return sourceGap();
  const path = `/v1/works/${short(work.id)}/releases/${short(binding.release.id)}`;
  let view: Row;
  try {
    view = await context.read(path);
  } catch {
    return releaseGap(
      'Acknowledged release read is unavailable or denied; no replacement identity or publication is permitted',
    );
  }
  if (
    view.profile !== 'release-v2' ||
    view.id !== binding.release.id ||
    view.revision !== binding.release.receipt.revision ||
    !['formal', 'web', 'fixed'].includes(String(view.kind)) ||
    !Array.isArray(view.coverage)
  )
    return releaseGap(
      'Exact acknowledged release revision must be publicly readable; current release reads cannot prove a historical head',
    );
  const realizations: Row[] = [];
  const coverage = view.coverage.map(object);
  if (
    !coverage.length ||
    coverage.some(
      (entry) =>
        !entry || !native(entry.realization) || !native(entry.revision) || !native(entry.work),
    ) ||
    new Set(coverage.map((entry) => entry?.realization)).size !== coverage.length
  )
    return realizationGap(
      'Every coverage entry needs a distinct exact realization and revision; legacy/unknown coverage cannot be invented',
    );
  for (const entry of coverage) {
    const exact = binding.realizations.filter(
      (item) =>
        item.native.id === entry!.realization &&
        item.native.receipt.revision === entry!.revision &&
        context.native.get(item.work)?.id === entry!.work,
    );
    if (exact.length !== 1 || !receipt(exact[0]!.native, 'realization', String(entry!.work)))
      return realizationGap(
        'Each covered revision requires its own acknowledged realization receipt; another release/text head is insufficient',
      );
    let realization: Row;
    try {
      realization = await context.read(
        `/v1/works/${short(String(entry!.work))}/realizations/${short(String(entry!.realization))}` +
          `?revision=${encodeURIComponent(String(entry!.revision))}`,
      );
    } catch {
      return realizationGap(
        'The exact covered realization read is unavailable or denied; its current head is not a substitute',
      );
    }
    try {
      checkedRealization(
        {
          profile: realization.profile,
          expectedHead: null,
          actingSubject: context.actingSubject,
          id: realization.id,
          language: realization.language,
          kind: realization.kind,
          translators: realization.translators,
          publishers: realization.publishers,
          source: realization.source,
          status: realization.status,
          verification: realization.verification,
          evidence: realization.evidence,
        },
        String(entry!.work),
      );
    } catch {
      return realizationGap(
        'Exact covered realization does not satisfy realization-v1 provenance and contributor rules',
      );
    }
    if (
      realization.profile !== 'realization-v1' ||
      realization.id !== entry!.realization ||
      realization.revision !== entry!.revision ||
      realization.work !== entry!.work ||
      realization.language !== entry!.language ||
      !language(realization.language) ||
      (view.status === 'official' && realization.status !== 'official')
    )
      return realizationGap(
        'Language, translator identities and official status must belong to this exact covered revision',
      );
    realizations.push(realization);
  }
  if (!coverage.some((entry) => entry!.work === work.id))
    return realizationGap(
      'The release must cover its editing Work at an exact realization revision',
    );
  return { view, realizations, path };
}

function factMatches(
  fact: DatasetReleaseFact,
  view: Row,
  realizations: Row[],
  context: DatasetMappingContext,
  candidate: DatasetReleaseCandidate,
  binding: DatasetReleaseCorrespondence,
): boolean {
  if (fact.gap || fact.normalized === undefined) return false;
  const correlated = (item: Row) => {
    const nativeRecord = binding.realizations.find(
      (row) => row.native.id === item.id && row.native.receipt.revision === item.revision,
    );
    if (!nativeRecord) return false;
    const projection = nativeRecord.native.projection;
    if (
      !projection ||
      projection.recordDigest !== candidate.source.recordDigest ||
      nativeRecord.native.sourceIdentity !== candidate.key ||
      !Object.hasOwn(projection.fields, fact.occurrence.path) ||
      !same(projection.fields[fact.occurrence.path], fact.value)
    )
      return false;
    const languages = candidate.facts.filter(
      (row) => row.role === 'language' && !row.gap && row.normalized !== undefined,
    );
    const coverages = candidate.facts.filter(
      (row) => row.role === 'coverage' && row.sourceWork === nativeRecord.work,
    );
    return (
      languages.some(
        (row) =>
          row.normalized === item.language &&
          Object.hasOwn(projection.fields, row.occurrence.path) &&
          same(projection.fields[row.occurrence.path], row.value),
      ) &&
      coverages.some(
        (row) =>
          Object.hasOwn(projection.fields, row.occurrence.path) &&
          same(projection.fields[row.occurrence.path], row.value) &&
          Array.isArray(view.coverage) &&
          view.coverage.some((value) => {
            const entry = object(value);
            return (
              entry !== undefined &&
              entry.realization === item.id &&
              entry.revision === item.revision &&
              entry.work === item.work &&
              entry.completeness === row.normalized
            );
          }),
      )
    );
  };
  switch (fact.role) {
    case 'title':
      return object(view.title)?.value === fact.normalized;
    case 'status':
      return view.status === fact.normalized;
    case 'platform':
      return view.platform === fact.normalized;
    case 'publication-date':
      return fact.precision === 'year' && view.publicationYear === Number(fact.normalized);
    case 'language':
      return realizations.some((item) => item.language === fact.normalized && correlated(item));
    case 'territory':
      return view.territory === fact.normalized;
    case 'identifier':
      return (
        Array.isArray(view.identifiers) &&
        view.identifiers.some((item) => same(item, fact.normalized))
      );
    case 'coverage':
      return (
        Array.isArray(view.coverage) &&
        view.coverage.some((value) => {
          const entry = object(value);
          return (
            entry !== undefined &&
            entry.work === context.native.get(fact.sourceWork!)?.id &&
            entry.completeness === fact.normalized &&
            realizations.some(
              (item) =>
                item.id === entry.realization &&
                item.revision === entry.revision &&
                correlated(item),
            )
          );
        })
      );
    case 'translator-status':
      return false;
  }
}

/** Reconcile only source-bound, acknowledged native releases. There is deliberately no
 * speculative PUT or support creation: current Source adoption admits Works/children,
 * not releases. Its missing admission is returned to that owner with the source case.
 * Replaying this adapter neither changes owner receipts nor rewrites any saved pin. */
export async function mapDatasetReleases(
  context: DatasetMappingContext,
  correspondences: readonly DatasetReleaseCorrespondence[] = [],
): Promise<DatasetReleaseMapping[]> {
  const results: DatasetReleaseMapping[] = [];
  for (const candidate of datasetReleaseCandidates(context)) {
    const result: DatasetReleaseMapping = { candidate, mappings: [], gaps: [] };
    results.push(result);
    if (candidate.grain !== 'release') {
      result.gaps.push(...candidate.gaps);
      continue;
    }
    const bindings = correspondences.filter(
      (binding) => binding.source.key === candidate.source.key,
    );
    const verified: Array<{
      binding: DatasetReleaseCorrespondence;
      view: Row;
      realizations: Row[];
      path: string;
    }> = [];
    // Separate supports may acknowledge the same identity; a source occurrence cannot
    // silently switch its native release identity during refresh or recovery.
    if (new Set(bindings.map((binding) => binding.release.id)).size > 1) {
      result.gaps.push(sourceGap());
    } else
      for (const binding of bindings) {
        const evidence = await verifiedCorrespondence(context, candidate, binding);
        if ('owner' in evidence) result.gaps.push(evidence);
        else verified.push({ binding, ...evidence });
      }
    if (!bindings.length) result.gaps.push(sourceGap());
    for (const fact of candidate.facts) {
      let mapped = false;
      for (const evidence of verified) {
        const projection = evidence.binding.release.projection!;
        if (
          !Object.hasOwn(projection.fields, fact.occurrence.path) ||
          !same(projection.fields[fact.occurrence.path], fact.value) ||
          !factMatches(
            fact,
            evidence.view,
            evidence.realizations,
            context,
            candidate,
            evidence.binding,
          )
        )
          continue;
        const mapping: DatasetMappingReceipt = {
          target: evidence.binding.release.id,
          readPath: evidence.path,
          receipt: {
            source: evidence.binding.source,
            release: evidence.binding.release.receipt,
            realizations: evidence.binding.realizations.map((item) => item.native.receipt),
          },
        };
        result.mappings.push({ occurrence: fact.occurrence, mapping });
        mapped = true;
      }
      const prior = context.native.get(candidate.source.key);
      // The shared coverage owner currently protects one target per occurrence. Keep
      // its acknowledged descriptive projection and return the second-grain mapping.
      if (prior?.projection && Object.hasOwn(prior.projection.fields, fact.occurrence.path)) {
        if (
          result.mappings.some(
            (item) => same(item.occurrence, fact.occurrence) && item.mapping.target !== prior.id,
          )
        )
          result.gaps.push({
            owner: 'importer',
            schema: 'DatasetCoverageEntry / DatasetMappingContext',
            operation: 'datasetCoverage.disposition',
            required: `Preserve independent descriptive and release mappings for ${fact.occurrence.path}; the acknowledged target cannot be replaced`,
          });
        continue;
      }
      if (
        fact.value === null ||
        fact.value === '' ||
        (Array.isArray(fact.value) && !fact.value.length)
      )
        continue;
      if (mapped)
        for (const item of result.mappings.filter((item) => same(item.occurrence, fact.occurrence)))
          context.disposition(item.occurrence, {
            status: 'mapped',
            reason: 'acknowledged-exact-release-correspondence',
            mapping: item.mapping,
          });
      else {
        const gap =
          fact.gap ??
          result.gaps[0] ??
          releaseGap('Source value has no exact acknowledged native field/correspondence');
        result.gaps.push(gap);
        context.disposition(fact.occurrence, {
          status: 'unmapped',
          reason: `${gap.owner}:${gap.schema}:${gap.operation}: ${gap.required}`,
        });
      }
    }
  }
  return results;
}

export function datasetReleaseMapper(
  correspondences: readonly DatasetReleaseCorrespondence[] = [],
): DatasetNativeMapper {
  return {
    id: 'releases',
    revision: 'source-release-correspondence-v1',
    async map(context) {
      await mapDatasetReleases(context, correspondences);
    },
  };
}
