import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import type {
  NativeIdentity,
  SourceVocabularyBindings,
  SourceVocabularyRequest,
  VndbVocabularyRow,
} from '@rezics/conversion';
import {
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
  vndbPublicTagTaxonomy,
  type VndbPublicTagCategory,
} from '../../../packages/conversion/src/support.ts';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { vndbTagsRatingEndpoint, vndbVocabularyRevision } from '@rezics/conversion/vndb-vocabulary';
import type { Owner } from './record-bindings.ts';
import {
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaGap,
  type CrossMediaMember,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaReading,
  type CrossMediaSeedResult,
  type CrossMediaTables,
} from './cross-media-seed.ts';
import type { ImporterOptions } from './importer.ts';
import type { VndbTagRatingSnapshot } from './showcase-vndb-tag-ratings.ts';
import {
  parseVndbCopyHeader,
  parseVndbCopyLine,
  projectVndbPublicTag,
  projectVndbPublicTagAssociation,
  vndbPublicTagLimits,
  type VndbPublicTagAssociationRow,
  type VndbPublicTagDictionaryRow,
  type VndbPublicTagTable,
} from './vndb-tables.ts';

type Row = Record<string, unknown>;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function text(row: Row, field: string): string {
  const value = row[field];
  ensure(typeof value === 'string' && value.length > 0, `Missing source field: ${field}`);
  return value;
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}

function copyCells(row: Row): Record<string, string | null> {
  const cells: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) cells[key] = null;
    else if (value === true) cells[key] = 't';
    else if (value === false) cells[key] = 'f';
    else if (typeof value === 'string' || typeof value === 'number') cells[key] = String(value);
  }
  return cells;
}

function adoptedContent(read: unknown, property: string): string | undefined {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.[property];
  const content = statements?.[0]?.value?.content;
  return typeof content === 'string' ? content : undefined;
}

export function vndbPublicTagConceptCode(category: VndbPublicTagCategory, uri: string): string | undefined {
  const prefix = `${vndbPublicTagScheme(category)}/`;
  if (!uri.startsWith(prefix)) return;
  const code = uri.slice(prefix.length);
  return /^g[1-9][0-9]{0,9}$/u.test(code) ? code : undefined;
}

export type VndbPublicTagKnownBindings = {
  schemes: readonly { category: VndbPublicTagCategory; id: string }[];
  concepts: readonly { category: VndbPublicTagCategory; code: string; id: string }[];
};

/** Current disclosed/adopted VNDB tag schemes and concepts. Retracted or hidden identities are withheld. */
export async function readVndbPublicTagBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: VndbPublicTagKnownBindings,
): Promise<SourceVocabularyBindings> {
  const empty: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  const schemes: SourceVocabularyBindings['schemes'][number][] = [];
  const schemeIds = new Map<VndbPublicTagCategory, string>();
  for (const item of known.schemes) {
    let schemeRead;
    try {
      schemeRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    const scheme = schemeRead as { subject?: { id?: string; type?: string } };
    if (scheme.subject?.id !== item.id || scheme.subject.type !== 'skos:ConceptScheme') continue;
    if (adoptedContent(schemeRead, 'schema:url') !== vndbPublicTagScheme(item.category)) continue;
    schemeIds.set(item.category, item.id);
    schemes.push({
      taxonomy: vndbPublicTagTaxonomy(item.category),
      id: item.id,
      uri: vndbPublicTagScheme(item.category),
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    });
  }
  if (!schemes.length) return empty;
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    const schemeId = schemeIds.get(item.category);
    if (!schemeId) continue;
    let conceptRead;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    const concept = conceptRead as { subject?: { id?: string; type?: string } };
    if (concept.subject?.id !== item.id || concept.subject.type !== 'skos:Concept') continue;
    if (adoptedContent(conceptRead, 'schema:url') !== vndbPublicTagConceptUri(item.category, item.code)) continue;
    if (adoptedContent(conceptRead, 'skos:inScheme') !== schemeId) continue;
    concepts.push({
      taxonomy: vndbPublicTagTaxonomy(item.category),
      code: item.code,
      id: item.id,
      type: 'skos:Concept',
      schemeId,
      releaseDigest: bundledDigest,
    });
  }
  return { releaseDigest: bundledDigest, schemes, concepts };
}

export type AdmittedPublicTag = Readonly<{
  vid: string;
  tag: string;
  category: VndbPublicTagCategory;
  spoiler: number;
  path: string;
}>;

function publicAssociation(
  dictionary: VndbPublicTagDictionaryRow,
  association: VndbPublicTagAssociationRow,
  path: string,
): AdmittedPublicTag | null {
  if (association.ignore || association.lie) return null;
  if (!Number.isInteger(association.vote) || association.vote < 1 || association.vote > 3) return null;
  if (!dictionary.applicable) return null;
  const spoiler = association.spoiler ?? dictionary.defaultSpoiler;
  if (!Number.isInteger(spoiler) || spoiler < 0 || spoiler > 2) return null;
  return { vid: association.vid, tag: association.tag, category: dictionary.category, spoiler, path };
}

export function vndbPublicTagVocabulary(
  owner: Owner,
  subject: string,
  admitted: readonly AdmittedPublicTag[],
): SourceVocabularyRequest['rows'] {
  if (!/^v[1-9][0-9]*$/u.test(owner.external_id)) return [];
  const work: NativeIdentity = { id: subject, type: 'wd:Q689445', releaseDigest: bundledDigest };
  const rows: VndbVocabularyRow[] = [];
  for (const row of admitted) {
    if (row.vid !== owner.external_id) continue;
    if (rows.length >= vndbPublicTagLimits.perWork) break;
    rows.push({
      kind: 'tag',
      path: row.path,
      subject: work,
      category: row.category,
      code: row.tag,
      spoiler: row.spoiler,
    });
  }
  return rows;
}

export function vndbPublicTagVocabularyAdmission(
  bindings: SourceVocabularyBindings,
  admitted: readonly AdmittedPublicTag[],
  ratings: ReadonlyMap<string, VndbTagRatingSnapshot> = new Map(),
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    request({ owner, subject }) {
      if (!subject) return;
      const rows = [...vndbPublicTagVocabulary(owner, subject, admitted)];
      const snapshot = ratings.get(owner.external_id);
      if (snapshot) {
        const work: NativeIdentity = { id: subject, type: 'wd:Q689445', releaseDigest: bundledDigest };
        const selected = admitted.filter((row) => row.vid === owner.external_id);
        for (const row of selected) {
          const taxonomy = vndbPublicTagTaxonomy(row.category);
          const concept = bindings.concepts.find((item) => item.taxonomy === taxonomy && item.code === row.tag);
          const scheme = bindings.schemes.find((item) => item.taxonomy === taxonomy);
          if (!snapshot.tagIds.includes(row.tag) || !concept || !scheme || concept.schemeId !== scheme.id) continue;
          rows.push({
            kind: 'tag-weight',
            path: `/tags/${row.tag}/rating`,
            subject: work,
            category: row.category,
            tagId: row.tag,
            subjectRecordId: owner.external_id,
            contextId: '00000000-0000-8000-8000-000000000000',
            endpoint: vndbTagsRatingEndpoint,
            requestBody: snapshot.requestBody,
            snapshot: snapshot.bytes,
            origin: {
              externalId: owner.external_id,
              revision: null,
              digest: snapshot.digest,
              url: vndbTagsRatingEndpoint,
              converterRevision: vndbVocabularyRevision,
            },
          });
          if (rows.length >= 128) break;
        }
      }
      if (!rows.length) return;
      return { bindings, rows };
    },
  };
}

function tryProjectTag(row: Row): VndbPublicTagDictionaryRow | null {
  try {
    return projectVndbPublicTag(copyCells(row));
  } catch {
    return null;
  }
}

function tryProjectAssociation(row: Row): VndbPublicTagAssociationRow | null {
  try {
    return projectVndbPublicTagAssociation(copyCells(row));
  } catch {
    return null;
  }
}

function associationPath(vid: string, tag: string): string {
  return `/tags_vn/${vid}/${tag}/tag`;
}

export type VndbPublicTagPlan = CrossMediaPlan & { admitted: AdmittedPublicTag[] };

/** Select admitted VNDB works and public tag associations from extracted COPY tables. */
export async function planVndbPublicTags(input: CrossMediaTables): Promise<VndbPublicTagPlan> {
  const plan: VndbPublicTagPlan = { ...emptyCrossMediaPlan(), admitted: [] };
  const gap = (table: string, record: Row, reason: string) => {
    const safe: Row = {};
    for (const field of ['id', 'tag', 'vid', 'cat', 'spoiler', 'applicable']) {
      if (field in record) safe[field] = record[field];
    }
    plan.gaps.push({ source: 'vndb', fields: fieldsOf(table, safe), record: safe, reason });
  };

  const dictionary = new Map<string, VndbPublicTagDictionaryRow>();
  for await (const row of input.rows('vndb', 'tags')) {
    if (dictionary.size >= vndbPublicTagLimits.dictionary) {
      gap('tags', row, 'Tag dictionary exceeds the bounded import cap');
      continue;
    }
    const projected = tryProjectTag(row);
    if (!projected) {
      gap('tags', row, 'Invalid VNDB tag dictionary row');
      continue;
    }
    if (dictionary.has(projected.id)) {
      gap('tags', { id: projected.id }, 'Duplicate selected VNDB tag');
      continue;
    }
    dictionary.set(projected.id, projected);
  }

  const seen = new Map<string, string>();
  let associations = 0;
  for await (const row of input.rows('vndb', 'tags_vn')) {
    if (associations >= vndbPublicTagLimits.associations) {
      gap('tags_vn', row, 'Tag associations exceed the bounded import cap');
      continue;
    }
    associations += 1;
    const projected = tryProjectAssociation(row);
    if (!projected) {
      gap('tags_vn', row, 'Invalid VNDB tag association row');
      continue;
    }
    const path = associationPath(projected.vid, projected.tag);
    const tag = dictionary.get(projected.tag);
    if (!tag) {
      gap('tags_vn', { tag: projected.tag, vid: projected.vid }, 'Unresolved VNDB tag code');
      continue;
    }
    const admitted = publicAssociation(tag, projected, path);
    if (!admitted) {
      gap('tags_vn', { tag: projected.tag, vid: projected.vid }, 'Excluded false or confidence tag association');
      continue;
    }
    const key = `${projected.vid}\0${projected.tag}`;
    if (seen.has(key)) {
      gap('tags_vn', { tag: projected.tag, vid: projected.vid }, 'Duplicate tag association is not aggregated');
      continue;
    }
    seen.set(key, path);
    plan.admitted.push(admitted);
  }

  const vids = new Set(plan.admitted.map((row) => row.vid));
  for (const gapRow of plan.gaps) {
    const vid = gapRow.record.vid;
    if (typeof vid === 'string' && /^v[1-9][0-9]*$/u.test(vid)) vids.add(vid);
  }

  const titles = new Map<string, Row[]>();
  const vns = new Map<string, Row>();
  const revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = text(row, 'id');
    if (!vids.has(id)) continue;
    ensure(
      row.official === true || row.official === false || row.official === 't' || row.official === 'f',
      'Invalid VNDB official title flag',
    );
    const official = row.official === true || row.official === 't';
    titles.set(id, [...(titles.get(id) ?? []), { ...row, official }]);
  }
  for await (const row of input.rows('vndb', 'vn')) {
    const id = text(row, 'id');
    if (!vids.has(id)) continue;
    ensure(!vns.has(id), 'Duplicate selected VNDB work');
    vns.set(id, row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = text(row, 'id');
    if (!vids.has(id)) continue;
    ensure(!revisions.has(id), 'Duplicate selected VNDB revision');
    const revision = typeof row.revision === 'number' ? row.revision : Number(text(row, 'revision'));
    ensure(Number.isSafeInteger(revision) && revision >= 1, 'Invalid VNDB revision');
    revisions.set(id, { id, revision, lastmod: row.lastmod });
  }
  for (const id of vids) {
    const row = vns.get(id);
    const entry_meta = revisions.get(id);
    const named = titles.get(id);
    if (!row || !entry_meta || !named?.length) {
      gap('vn', { id }, 'Missing selected VNDB record');
      continue;
    }
    const vn: Row = { id, ...(row.olang === undefined ? {} : { olang: row.olang }) };
    if (row.alias !== undefined && row.alias !== null) vn.alias = row.alias;
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: named },
    });
    plan.members.push({ source: 'vndb', key: id, kind: 'work', membership: 'referenced' });
  }
  plan.records.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.admitted.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

export type VndbPublicTagsResult = CrossMediaSeedResult & {
  converterRevision: typeof entityRevision;
  admitted: AdmittedPublicTag[];
};

/** Production operator: import admitted VNDB public tag associations through the existing seed/importer caller. */
export async function importVndbPublicTags(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  ratings?: ReadonlyMap<string, VndbTagRatingSnapshot>;
  destination?: { origin: string };
}): Promise<VndbPublicTagsResult> {
  const plan = await planVndbPublicTags(input.tables);
  const result = await seedCrossMedia(plan, input.path, input.port, input.destination, {
    vocabularyAdmission: vndbPublicTagVocabularyAdmission(input.bindings, plan.admitted, input.ratings),
    providers: ['vndb'],
  });
  return { ...result, converterRevision: entityRevision, admitted: plan.admitted };
}

export function parseAuthoredVndbCopy(table: VndbPublicTagTable, header: string, lines: readonly string[]): Row[] {
  const names = parseVndbCopyHeader(header, table);
  return lines.filter((line) => line.length > 0).map((line) => parseVndbCopyLine(names, line));
}

export type { CrossMediaGap, CrossMediaMember, CrossMediaReading, SourceRecord, VndbPublicTagCategory };
