import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import type { NativeIdentity, SourceVocabularyBindings, SourceVocabularyRequest } from '@rezics/conversion';
import { bangumiRecordUrl, converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import type { ImportConversion } from './import-contract.ts';
import type { Owner } from './record-bindings.ts';
import { type GraphEdgeDraft } from './cross-media-bindings.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  type CrossMediaGap,
  type CrossMediaMember,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaReading,
  type CrossMediaTables,
} from './showcase-contract.ts';
import type { seedCrossMedia, CrossMediaSeedResult } from './cross-media-seed.ts';
import type { ImporterOptions } from './importer.ts';

export const episodeTypeSchemeUri = 'https://rezics.com/schemes/bangumi/episode-types';
export const episodeTypeTaxonomy = 'bangumi.episode.type';
export const episodeTypeConceptUri = (code: string) => `${episodeTypeSchemeUri}/${code}`;

type Row = Record<string, unknown>;
const EPISODE_CAP = 64;
const EPISODE_ORDINAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function number(row: Row, field: string): number {
  const value = row[field];
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `Invalid Bangumi ${field}`);
  return value;
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}

function episodeOrdinal(value: unknown): { integer: string; fraction: string } | undefined {
  const rendered = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof rendered !== 'string' || !EPISODE_ORDINAL_PATTERN.test(rendered)) return;
  const [integer, fraction = ''] = rendered.split('.');
  return { integer: integer!, fraction: fraction.replace(/0+$/u, '') };
}

function compareEpisodeOrdinals(
  left: { integer: string; fraction: string },
  right: { integer: string; fraction: string },
): number {
  if (left.integer.length !== right.integer.length) return left.integer.length - right.integer.length;
  const integerOrder = left.integer.localeCompare(right.integer);
  if (integerOrder !== 0) return integerOrder;
  const width = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < width; index++) {
    const leftDigit = left.fraction.charCodeAt(index) || 48;
    const rightDigit = right.fraction.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit - rightDigit;
  }
  return 0;
}

/** Give source-ordered episodes dense, one-based display positions within each exact parent. */
export function bangumiEpisodeDisplayPositions(rows: readonly Row[]): Map<string, string> {
  const byParent = new Map<number, { id: number; ordinal: { integer: string; fraction: string } }[]>();
  for (const row of rows) {
    const id = positiveBangumiId(row.id);
    const parent = positiveBangumiId(row.subject_id);
    const ordinal = episodeOrdinal(row.sort);
    if (id === undefined || parent === undefined || !ordinal) continue;
    const siblings = byParent.get(parent) ?? [];
    siblings.push({ id, ordinal });
    byParent.set(parent, siblings);
  }
  const positions = new Map<string, string>();
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => compareEpisodeOrdinals(left.ordinal, right.ordinal) || left.id - right.id);
    siblings.forEach((episode, index) => positions.set(`episode:${episode.id}`, String(index + 1)));
  }
  return positions;
}

function positiveBangumiId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/u.test(value)) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function episodeTypeConceptCode(uri: string): string | undefined {
  if (!uri.startsWith(`${episodeTypeSchemeUri}/`)) return;
  const code = uri.slice(episodeTypeSchemeUri.length + 1);
  return /^[0-6]$/u.test(code) ? code : undefined;
}

function hasCurrentPublicValue(read: unknown, property: string, expected: string): boolean {
  const statements = (
    read as {
      subject?: { statements?: Record<string, { value?: { type?: string; content?: unknown } }[]> };
    }
  ).subject?.statements?.[property];
  return (
    Array.isArray(statements) &&
    statements.some((statement) => statement?.value?.type === 'value' && statement.value.content === expected)
  );
}

/** Current disclosed/adopted episode-type scheme and concepts. Retracted or hidden identities are withheld. */
export async function readEpisodeTypeBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: { schemeId: string; concepts: readonly { code: string; id: string }[] },
): Promise<SourceVocabularyBindings> {
  const empty: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  let schemeRead;
  try {
    schemeRead = await port.readReviewedSubject(known.schemeId);
  } catch {
    return empty;
  }
  const scheme = schemeRead as { subject?: { id?: string; type?: string } };
  if (scheme.subject?.id !== known.schemeId || scheme.subject.type !== 'skos:ConceptScheme') return empty;
  // readReviewedSubject is the ordinary public reader, so its statement set contains only current disclosed heads.
  if (!hasCurrentPublicValue(schemeRead, 'schema:url', episodeTypeSchemeUri)) return empty;
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    let conceptRead;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    const concept = conceptRead as { subject?: { id?: string; type?: string } };
    if (concept.subject?.id !== item.id || concept.subject.type !== 'skos:Concept') continue;
    if (!hasCurrentPublicValue(conceptRead, 'schema:url', episodeTypeConceptUri(item.code))) continue;
    if (!hasCurrentPublicValue(conceptRead, 'skos:inScheme', known.schemeId)) continue;
    concepts.push({
      taxonomy: episodeTypeTaxonomy,
      code: item.code,
      id: item.id,
      type: 'skos:Concept',
      schemeId: known.schemeId,
      releaseDigest: bundledDigest,
    });
  }
  return {
    releaseDigest: bundledDigest,
    schemes: [
      {
        taxonomy: episodeTypeTaxonomy,
        id: known.schemeId,
        uri: episodeTypeSchemeUri,
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts,
  };
}

export function episodeKindVocabulary(
  owner: Owner,
  conversion: ImportConversion,
  subject: string,
): SourceVocabularyRequest['rows'] {
  if (!owner.external_id.startsWith('episode:')) return [];
  const record = conversion.normalized as Row;
  if (record.type === undefined) return [];
  const id = owner.external_id.slice('episode:'.length);
  const episode: NativeIdentity = { id: subject, type: 'schema:Episode', releaseDigest: bundledDigest };
  return [
    {
      kind: 'episode-kind',
      path: `/episode/${id}/type`,
      episode,
      code: record.type as string | number,
    },
  ];
}

export function episodeVocabularyAdmission(
  bindings: SourceVocabularyBindings,
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    request({ owner, conversion, subject }) {
      if (!subject) return;
      const rows = episodeKindVocabulary(owner, conversion, subject);
      if (!rows.length) return;
      return { bindings, rows };
    },
  };
}

/** Select admitted episode members and their parent works from a bounded authored dump. */
export async function planBangumiEpisodeFidelity(input: CrossMediaTables): Promise<CrossMediaPlan> {
  const plan: CrossMediaPlan = emptyCrossMediaPlan();
  const gap = (record: Row, reason: string) => {
    plan.gaps.push({ source: 'bangumi', fields: fieldsOf('episode', record), record, reason });
  };
  const episodes: Row[] = [];
  for await (const row of input.rows('bangumi', 'episode')) {
    if (episodes.length >= EPISODE_CAP) {
      gap(row, 'Episode membership exceeds the bounded import cap');
      continue;
    }
    try {
      number(row, 'id');
      number(row, 'subject_id');
    } catch {
      gap(row, 'Invalid Bangumi episode identity');
      continue;
    }
    episodes.push(row);
  }
  const parents = new Set(episodes.map((row) => number(row, 'subject_id')));
  const positions = bangumiEpisodeDisplayPositions(episodes);
  const subjects = new Map<number, Row>();
  for await (const row of input.rows('bangumi', 'subject')) {
    if (!parents.has(number(row, 'id'))) continue;
    subjects.set(number(row, 'id'), row);
  }
  for (const parent of parents) {
    const row = subjects.get(parent);
    if (!row) {
      plan.gaps.push({
        source: 'bangumi',
        fields: ['episode.subject_id'],
        record: { subject_id: parent },
        reason: 'Missing parent subject for admitted episode',
      });
      continue;
    }
    plan.records.bangumi.push({ source: 'bangumi', key: String(parent), revision: null, payload: row });
    plan.members.push({ source: 'bangumi', key: String(parent), kind: 'work', membership: 'referenced' });
  }
  for (const row of episodes) {
    const parent = number(row, 'subject_id');
    if (!subjects.has(parent)) continue;
    const key = `episode:${row.id}`;
    plan.entities.bangumi.push({ source: 'bangumi', key, revision: null, payload: row });
    plan.members.push({ source: 'bangumi', key, kind: 'episode', membership: 'referenced' });
    const edge: GraphEdgeDraft = {
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'episode',
      holder: key,
      target: String(parent),
      property: 'schema:isPartOf',
      url: bangumiRecordUrl(key),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('episode', row),
      ...(positions.has(key) ? { qualifiers: [{ property: 'schema:position', content: positions.get(key)! }] } : {}),
    };
    plan.edges.push(edge);
  }
  plan.records.bangumi.sort((a, b) => a.key.localeCompare(b.key));
  plan.entities.bangumi.sort((a, b) => a.key.localeCompare(b.key));
  return plan;
}

export type BangumiEpisodeFidelityResult = CrossMediaSeedResult & {
  converterRevision: typeof entityRevision;
};

/** Production operator: import admitted episode members through the existing seed/importer caller. Disc is omitted from identity. */
export async function importBangumiEpisodeFidelity(input: {
  seed: typeof seedCrossMedia;

  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  destination?: { origin: string };
}): Promise<BangumiEpisodeFidelityResult> {
  const plan = await planBangumiEpisodeFidelity(input.tables);
  const result = await input.seed(plan, input.path, input.port, input.destination, {
    vocabularyAdmission: episodeVocabularyAdmission(input.bindings),
  });
  return { ...result, converterRevision: entityRevision };
}

export type { CrossMediaGap, CrossMediaMember, CrossMediaReading, SourceRecord };
