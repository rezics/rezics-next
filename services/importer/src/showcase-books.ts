import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import { convertBangumi, selectBangumiBookProfile, type BangumiBookGrain } from '@rezics/conversion/bangumi';
import { bangumiRecordUrl, isFamilyRelationTerm, mapSourceEnumeration } from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import { sourceDigest } from '@rezics/conversion/support';
import {
  bangumiStaffDraft,
  type BangumiCreatorCreditDraft,
  type BangumiCreatorCreditGap,
} from './bangumi-creator-credits.ts';
import type { GraphEdgeDraft } from './cross-media-bindings.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  type CrossMediaGap,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaReading,
  type CrossMediaTableScanLimits,
  type CrossMediaTables,
} from './showcase-contract.ts';
import type {
  seedCrossMedia,
  CrossMediaSeedResult,
} from './cross-media-seed.ts';
import type { ReviewedSubjectRead } from './import-client.ts';
import type { PublicBulkClient } from './public-bulk-client.ts';
import {
  currentBangumiCreatorCreditBindings,
  prepareBangumiCreatorCreditBindings,
  type BangumiCreditPriorPublication,
  type BangumiCreditVocabularyResolution,
} from './showcase-bangumi-credits.ts';
import type { ShowcaseJournal, ShowcaseReviewPort } from './showcase-publication.ts';
import { showcaseBookFamilies, showcaseBookFamily, type ShowcaseBookFamily } from './showcase-book-series.ts';

type Row = Record<string, unknown>;
const SERIES_RELATION = 1002;
const OFFPRINT_RELATION = 1003;
const ANIME_RELATION = 1;
const COMIC_PLATFORM = '1001';
const VOLUME_CAP = 32;
const CREATOR_CAP = 16;
const CREDIT_CAP = 64;
const BOOK_TABLE_SCAN_LIMITS = {
  'subject-relations': { maxRows: 1_000_000, maxBytes: 512 * 1024 * 1024 },
  subject: { maxRows: 1_000_000, maxBytes: 1024 * 1024 * 1024 },
  'subject-persons': { maxRows: 3_000_000, maxBytes: 256 * 1024 * 1024 },
  person: { maxRows: 150_000, maxBytes: 128 * 1024 * 1024 },
} satisfies Record<string, CrossMediaTableScanLimits>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export { showcaseBookFamily, showcaseBookFamilies };

type CreatorRole = 'author' | 'illustrator' | 'publisher';
const creatorRoles: Readonly<Record<number, { role: CreatorRole; expectedType: 1 | 2 }>> = {
  2001: { role: 'author', expectedType: 1 },
  2010: { role: 'author', expectedType: 1 },
  2002: { role: 'illustrator', expectedType: 1 },
  2003: { role: 'illustrator', expectedType: 1 },
  2004: { role: 'publisher', expectedType: 2 },
};

export type ShowcaseBookMember = Readonly<{
  key: string;
  grain?: BangumiBookGrain;
  role: 'series' | 'volume' | 'anime' | CreatorRole | 'excluded' | 'missing';
  family?: string;
  platform?: string;
  series?: boolean;
  reason?: string;
}>;

export type ShowcaseBookConversion = Readonly<{
  key: string;
  grain: BangumiBookGrain;
  digest: string;
  converterRevision: string;
}>;

export type ShowcaseBookPlan = Readonly<{
  family: ShowcaseBookFamily;
  families: readonly ShowcaseBookFamily[];
  records: SourceRecord[];
  creators: SourceRecord[];
  credits: BangumiCreatorCreditDraft[];
  edges: GraphEdgeDraft[];
  members: ShowcaseBookMember[];
  conversions: ShowcaseBookConversion[];
  selected: {
    series: string[];
    volumes: string[];
    editions: string[];
    authors: string[];
    illustrators: string[];
    publishers: string[];
    anime: string[];
  };
  gaps: CrossMediaGap[];
  relationScope: string[];
  relationSnapshotDigest: string;
}>;

export type ShowcaseBooksResult = CrossMediaSeedResult & {
  family: ShowcaseBookFamily;
  families: readonly ShowcaseBookFamily[];
  selected: ShowcaseBookPlan['selected'];
  conversions: ShowcaseBookConversion[];
  identities: Record<string, { id: string; type: string; route: string }>;
  planned: ShowcaseBookPlan;
};

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}
function asId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function platformOf(row: Row): string | undefined {
  const value = row.platform;
  if (value === undefined || value === null) return;
  return String(value);
}
function isNovelVolume(row: Row): boolean {
  return row.type === 1 && platformOf(row) !== COMIC_PLATFORM && row.series !== true;
}
function isNovelSeries(row: Row): boolean {
  return row.type === 1 && row.series === true && platformOf(row) !== COMIC_PLATFORM;
}
function grainOf(row: Row): BangumiBookGrain {
  if (row.type !== 1) return 'schema:Book';
  const platform = platformOf(row);
  return selectBangumiBookProfile({
    type: 1,
    ...(platform === undefined ? {} : { platform }),
    ...(typeof row.series === 'boolean' ? { series: row.series } : {}),
    ...(typeof row.infobox === 'string' ? { infobox: row.infobox } : {}),
  }).type;
}
function withPlatform(row: Row): { readonly platform: string } | Record<string, never> {
  const platform = platformOf(row);
  return platform === undefined ? {} : { platform };
}

function gap(table: string, record: Row, reason: string, extra: Partial<CrossMediaGap> = {}): CrossMediaGap {
  return { source: 'bangumi', fields: fieldsOf(table, record), record, reason, ...extra };
}

function relationEvidence(row: Row) {
  return {
    path: `/subject-relations/${row.subject_id}/${row.related_subject_id}`,
    code: row.relation_type as number,
    sourceSubject: String(row.subject_id),
    sourceEndpoint: String(row.related_subject_id),
    digest: sourceDigest(row),
  };
}

function relationDraft(input: {
  row: Row;
  reciprocalRows: readonly Row[];
  order?: number;
}): GraphEdgeDraft | undefined {
  const { row, reciprocalRows } = input;
  const subjectId = asId(row.subject_id);
  const endpointId = asId(row.related_subject_id);
  const code = row.relation_type;
  if (subjectId === undefined || endpointId === undefined || typeof code !== 'number' || !Number.isSafeInteger(code))
    return;
  const mapping = mapSourceEnumeration('bangumi', 'relation.1', code);
  if (!mapping?.term || mapping.status === 'omitted') return;
  const reciprocalCodes = [...new Set(reciprocalRows.map((candidate) => candidate.relation_type))];
  if (reciprocalCodes.some((candidate) => typeof candidate !== 'number' || !Number.isSafeInteger(candidate))) return;
  if (reciprocalCodes.length > 1) return;
  const reciprocalCode = reciprocalCodes[0] as number | undefined;
  const property =
    (reciprocalCode === undefined ? undefined : mapping.canonicalByReverse?.[String(reciprocalCode)]?.term) ??
    mapping.term;
  let holder = mapping.inverse ? endpointId : subjectId;
  let target = mapping.inverse ? subjectId : endpointId;
  if (bundledRelease.properties[property]?.relation?.symmetric && String(target) < String(holder))
    [holder, target] = [target, holder];
  const evidenceRows = [row, ...reciprocalRows];
  const uniqueEvidence = evidenceRows.filter(
    (item, index, all) => all.findIndex((candidate) => sourceDigest(candidate) === sourceDigest(item)) === index,
  );
  return {
    source: 'bangumi',
    alias: crossMediaAliases.bangumi,
    table: 'subject-relations',
    holder: String(holder),
    target: String(target),
    property,
    url: bangumiRecordUrl(String(holder)),
    membership: isFamilyRelationTerm(property) ? 'family' : 'referenced',
    record: row,
    fields: [...new Set(uniqueEvidence.flatMap((item) => fieldsOf('subject-relations', item)))].sort(),
    relation: {
      family: 1,
      code,
      ...(reciprocalCode === undefined ? {} : { reciprocalCode }),
      path: `/subject-relations/${subjectId}/${endpointId}`,
      sourceSubject: String(subjectId),
      sourceEndpoint: String(endpointId),
      mappingRevision: `bangumi-relation-1@2:${code}:${reciprocalCode ?? 'one-sided'}`,
      ...(input.order === undefined ? {} : { order: input.order }),
      evidence: uniqueEvidence.map(relationEvidence),
    },
  };
}

/**
 * Stream only the reviewed series seeds and their bounded 1002/1003 novel members.
 * The selected anime endpoint is admitted by its exact code-1 source relation.
 */
export async function planShowcaseBooks(input: {
  tables: CrossMediaTables;
  bindings?: SourceVocabularyBindings;
}): Promise<ShowcaseBookPlan> {
  const familyBySeries = new Map(showcaseBookFamilies.map((family) => [Number(family.seriesId), family]));
  const seeds = new Set<number>(
    showcaseBookFamilies.flatMap((family) => [Number(family.seriesId), ...family.seedVolumeIds.map(Number)]),
  );
  const seedVolumes = new Map<number, Set<number>>(
    showcaseBookFamilies.map((family) => [Number(family.seriesId), new Set(family.seedVolumeIds.map(Number))]),
  );
  const acceptedVolumes = new Map([...seedVolumes].map(([seriesId, volumeIds]) => [seriesId, new Set(volumeIds)]));
  const wanted = new Set(seeds);
  const membership: Row[] = [];
  const selectedRelations: Row[] = [];
  const gaps: CrossMediaGap[] = [];
  const overflowedFamilies = new Set<number>();
  const relationRowCounts = new Map<string, number>();
  const duplicateRelationRows = new Set<string>();
  const animePairs = new Set(
    showcaseBookFamilies.flatMap((family) =>
      family.anime ? [`${family.anime.seriesId}:${family.anime.subjectId}`] : [],
    ),
  );
  for await (const row of input.tables.rows(
    'bangumi',
    'subject-relations',
    BOOK_TABLE_SCAN_LIMITS['subject-relations'],
  )) {
    const sid = asId(row.subject_id);
    const rid = asId(row.related_subject_id);
    const code = row.relation_type;
    if (sid === undefined || rid === undefined) continue;
    if (code === SERIES_RELATION || code === OFFPRINT_RELATION) {
      const seriesId = code === SERIES_RELATION ? rid : sid;
      const volumeId = code === SERIES_RELATION ? sid : rid;
      const family = familyBySeries.get(seriesId);
      if (family && volumeId !== seriesId) {
        const selected = acceptedVolumes.get(seriesId)!;
        if (!selected.has(volumeId) && selected.size >= VOLUME_CAP) {
          if (!overflowedFamilies.has(seriesId)) {
            overflowedFamilies.add(seriesId);
            gaps.push(
              gap('subject-relations', row, 'Selected novel volumes exceed the bounded family cap', {
                code: family.id,
              }),
            );
          }
          continue;
        }
        selected.add(volumeId);
        wanted.add(seriesId);
        wanted.add(volumeId);
        const pairKey = `${seriesId}:${volumeId}:${code}`;
        const count = relationRowCounts.get(pairKey) ?? 0;
        if (count < 2) {
          membership.push(row);
          relationRowCounts.set(pairKey, count + 1);
        } else if (!duplicateRelationRows.has(pairKey)) {
          duplicateRelationRows.add(pairKey);
          gaps.push(
            gap('subject-relations', row, 'Selected membership has excess duplicate source rows', {
              code: family.id,
              endpoint: String(volumeId),
              property: 'wdt:P179',
            }),
          );
        }
      }
    }
    if (code === ANIME_RELATION && (animePairs.has(`${sid}:${rid}`) || animePairs.has(`${rid}:${sid}`))) {
      const relationKey = `anime:${Math.min(sid, rid)}:${Math.max(sid, rid)}:${sid}:${rid}`;
      const count = relationRowCounts.get(relationKey) ?? 0;
      if (count < 2) {
        selectedRelations.push(row);
        relationRowCounts.set(relationKey, count + 1);
        wanted.add(sid);
        wanted.add(rid);
      } else if (!duplicateRelationRows.has(relationKey)) {
        duplicateRelationRows.add(relationKey);
        gaps.push(
          gap('subject-relations', row, 'Selected anime relation has excess duplicate source rows', {
            code: String(ANIME_RELATION),
            endpoint: String(Math.max(sid, rid)),
            property: 'rezics:crossMediaCounterpart',
          }),
        );
      }
    }
  }
  const relationRows = [...membership, ...selectedRelations].sort(
    (left, right) =>
      Number(left.subject_id) - Number(right.subject_id) ||
      Number(left.related_subject_id) - Number(right.related_subject_id) ||
      Number(left.relation_type) - Number(right.relation_type) ||
      String(left.order ?? '').localeCompare(String(right.order ?? '')),
  );

  const subjects = new Map<number, Row>();
  for await (const row of input.tables.rows('bangumi', 'subject', BOOK_TABLE_SCAN_LIMITS.subject)) {
    const id = asId(row.id);
    if (id === undefined || !wanted.has(id)) continue;
    subjects.set(id, row);
  }

  const members: ShowcaseBookMember[] = [];
  const volumes: { family: ShowcaseBookFamily; row: Row; sourceRows: Row[]; ordinal?: number }[] = [];
  const seriesRows = new Map<number, Row>();
  const selectedIds = new Set<number>();
  const selectedFamilyRecords: { family: ShowcaseBookFamily; row: Row; role: 'series' | 'volume' }[] = [];
  for (const [seriesId, family] of familyBySeries) {
    const seriesRow = subjects.get(seriesId);
    if (!seriesRow) {
      gaps.push(gap('subject', { id: seriesId }, 'Selected book series is missing from the dump', { code: family.id }));
      continue;
    }
    if (!isNovelSeries(seriesRow)) {
      gaps.push(
        gap(
          'subject',
          { id: seriesId, type: seriesRow.type, platform: seriesRow.platform, series: seriesRow.series },
          'Selected series is not a novel BookSeries',
          { code: family.id },
        ),
      );
      continue;
    }
    seriesRows.set(seriesId, seriesRow);
    selectedIds.add(seriesId);
    selectedFamilyRecords.push({ family, row: seriesRow, role: 'series' });
    members.push({
      key: String(seriesId),
      grain: grainOf(seriesRow),
      role: 'series',
      family: family.id,
      ...withPlatform(seriesRow),
      series: true,
    });
    const pairs = new Map<number, Row[]>();
    for (const row of membership) {
      const sid = asId(row.subject_id)!;
      const rid = asId(row.related_subject_id)!;
      const code = row.relation_type as number;
      const volumeId = code === SERIES_RELATION ? sid : rid;
      const relationSeriesId = code === SERIES_RELATION ? rid : sid;
      if (relationSeriesId !== seriesId || volumeId === seriesId) continue;
      pairs.set(volumeId, [...(pairs.get(volumeId) ?? []), row]);
    }
    const familyVolumes: typeof volumes = [];
    for (const [volumeId, sourceRows] of pairs) {
      const volume = subjects.get(volumeId);
      if (!volume) {
        gaps.push(
          gap('subject-relations', sourceRows[0]!, 'Missing source volume for a stated series membership', {
            code: String(volumeId),
            endpoint: String(volumeId),
            property: 'wdt:P179',
          }),
        );
        members.push({ key: String(volumeId), role: 'missing', family: family.id, reason: 'missing_source_volume' });
        continue;
      }
      if (!isNovelVolume(volume)) {
        members.push({
          key: String(volumeId),
          grain: grainOf(volume),
          role: 'excluded',
          family: family.id,
          ...withPlatform(volume),
          ...(typeof volume.series === 'boolean' ? { series: volume.series } : {}),
          reason: 'not_a_novel_volume',
        });
        continue;
      }
      const orderRows = sourceRows.filter(
        (row) =>
          row.subject_id === seriesId && row.related_subject_id === volumeId && row.relation_type === OFFPRINT_RELATION,
      );
      let ordinal: number | undefined;
      if (orderRows.length === 1) {
        const value = orderRows[0]!.order;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ordinal = value;
        else
          gaps.push(
            gap('subject-relations', orderRows[0]!, 'Source volume ordinal is invalid', {
              code: family.id,
              endpoint: String(volumeId),
              property: 'schema:position',
            }),
          );
      } else if (orderRows.length > 1) {
        gaps.push(
          gap('subject-relations', orderRows[0]!, 'Source volume ordinal is ambiguous', {
            code: family.id,
            endpoint: String(volumeId),
            property: 'schema:position',
          }),
        );
      } else {
        gaps.push(
          gap('subject-relations', sourceRows[0]!, 'Source volume ordinal is unknown', {
            code: family.id,
            endpoint: String(volumeId),
            property: 'schema:position',
          }),
        );
      }
      familyVolumes.push({ family, row: volume, sourceRows, ...(ordinal === undefined ? {} : { ordinal }) });
    }
    const ordinalCounts = new Map<number, number>();
    for (const volume of familyVolumes)
      if (volume.ordinal !== undefined) ordinalCounts.set(volume.ordinal, (ordinalCounts.get(volume.ordinal) ?? 0) + 1);
    for (const volume of familyVolumes) {
      if (volume.ordinal !== undefined && ordinalCounts.get(volume.ordinal)! > 1) {
        gaps.push(
          gap('subject-relations', volume.sourceRows[0]!, 'Source volume ordinal is ambiguous across volumes', {
            code: family.id,
            endpoint: String(asId(volume.row.id)),
            property: 'schema:position',
          }),
        );
        delete volume.ordinal;
      }
      volumes.push(volume);
      const id = asId(volume.row.id)!;
      selectedIds.add(id);
      selectedFamilyRecords.push({ family, row: volume.row, role: 'volume' });
      members.push({
        key: String(id),
        grain: grainOf(volume.row),
        role: 'volume',
        family: family.id,
        ...withPlatform(volume.row),
        series: false,
      });
    }
  }

  volumes.sort(
    (left, right) =>
      Number(left.family.seriesId) - Number(right.family.seriesId) ||
      (left.ordinal === undefined
        ? right.ordinal === undefined
          ? 0
          : 1
        : right.ordinal === undefined
          ? -1
          : left.ordinal - right.ordinal) ||
      asId(left.row.id)! - asId(right.row.id)!,
  );

  const creatorAssociations: {
    family: ShowcaseBookFamily;
    row: Row;
    role: CreatorRole;
    personId: number;
    expectedType: 1 | 2;
  }[] = [];
  const creatorIds = new Set<number>();
  const credits: BangumiCreatorCreditDraft[] = [];
  let selectedCreditRows = 0;
  const creditOverflowFamilies = new Set<string>();
  for await (const row of input.tables.rows('bangumi', 'subject-persons', BOOK_TABLE_SCAN_LIMITS['subject-persons'])) {
    const subjectId = asId(row.subject_id);
    const personId = asId(row.person_id);
    if (subjectId === undefined || !selectedIds.has(subjectId)) continue;
    const family = familyBySeries.get(subjectId) ?? volumes.find((volume) => asId(volume.row.id) === subjectId)?.family;
    ensure(family, 'Selected book creator owner is outside its reviewed family');
    selectedCreditRows++;
    if (selectedCreditRows > CREDIT_CAP) {
      if (!creditOverflowFamilies.has(family.id)) {
        creditOverflowFamilies.add(family.id);
        gaps.push(
          gap('subject-persons', row, 'Selected book creator credits exceed the bounded family cap', {
            code: family.id,
          }),
        );
      }
      continue;
    }
    const role = typeof row.position === 'number' ? creatorRoles[row.position] : undefined;
    if (!role) {
      gaps.push(
        gap('subject-persons', row, 'Unsupported creator role on selected book record', {
          code: String(row.position ?? 'unknown'),
          property: 'staff.1',
        }),
      );
      continue;
    }
    if (personId === undefined) {
      const property =
        role.role === 'author'
          ? 'schema:author'
          : role.role === 'illustrator'
            ? 'schema:illustrator'
            : 'schema:publisher';
      gaps.push(
        gap('subject-persons', row, 'Creator identity key is invalid on selected book record', {
          code: String(row.position),
          property,
        }),
      );
      continue;
    }
    if (!creatorIds.has(personId) && creatorIds.size >= CREATOR_CAP) {
      gaps.push(
        gap('subject-persons', row, 'Selected book creators exceed the bounded family cap', {
          code: family.id,
          endpoint: String(personId),
        }),
      );
      continue;
    }
    creatorIds.add(personId);
    creatorAssociations.push({ family, row, role: role.role, personId, expectedType: role.expectedType });
    credits.push(
      bangumiStaffDraft({ subject_id: subjectId, person_id: personId, position: row.position as number }, 1),
    );
  }

  const creatorRows = new Map<number, Row>();
  for await (const row of input.tables.rows('bangumi', 'person', BOOK_TABLE_SCAN_LIMITS.person)) {
    const id = asId(row.id);
    if (id !== undefined && creatorIds.has(id)) creatorRows.set(id, row);
  }
  const acceptedCreatorRows = new Set<Row>();
  const acceptedCreatorAssociations: typeof creatorAssociations = [];
  for (const association of creatorAssociations) {
    const person = creatorRows.get(association.personId);
    const expectedLabel = association.expectedType === 1 ? 'individual person' : 'Organization';
    const property =
      association.role === 'author'
        ? 'schema:author'
        : association.role === 'illustrator'
          ? 'schema:illustrator'
          : 'schema:publisher';
    if (!person) {
      gaps.push(
        gap('person', { id: association.personId }, `${association.role} identity is missing from the dump`, {
          code: String(association.row.position),
          endpoint: String(association.personId),
          property,
        }),
      );
      continue;
    }
    if (person.type !== association.expectedType) {
      gaps.push(
        gap('person', person, `${association.role} identity is not an ${expectedLabel}`, {
          code: String(association.row.position),
          endpoint: String(association.personId),
          property,
          requiredProfile: association.expectedType === 1 ? 'schema:Person' : 'schema:Organization',
        }),
      );
      continue;
    }
    acceptedCreatorRows.add(person);
    acceptedCreatorAssociations.push(association);
    members.push({
      key: `person:${association.personId}`,
      role: association.role,
      family: association.family.id,
    });
  }
  const creators: SourceRecord[] = [...acceptedCreatorRows].map((payload) => ({
    source: 'bangumi',
    key: `person:${asId(payload.id)}`,
    revision: null,
    payload,
  }));
  const admittedPersonKeys = new Set([...acceptedCreatorRows].map((person) => `person:${asId(person.id)}`));
  const admittedCredits = credits.filter((draft) => admittedPersonKeys.has(draft.person));

  const records: SourceRecord[] = [];
  for (const selected of selectedFamilyRecords)
    records.push({ source: 'bangumi', key: String(asId(selected.row.id)), revision: null, payload: selected.row });

  const conversions: ShowcaseBookConversion[] = records.map((record) => {
    const converted = convertBangumi(
      { external_id: record.key, record_revision: record.revision, record: record.payload },
      { source: 'bangumi' },
    );
    const grain = grainOf(record.payload as Row);
    ensure(converted.outcome === 'converted', `Book conversion failed for ${record.key}`);
    const bootstrap = converted.proposals.find((command) => command.op === 'create');
    ensure(bootstrap?.op === 'create' && bootstrap.subject.type === grain, `Book grain mismatch for ${record.key}`);
    return { key: record.key, grain, digest: converted.digest, converterRevision: converted.converter_revision };
  });

  const animeIds: string[] = [];
  const edges: GraphEdgeDraft[] = [];
  for (const family of showcaseBookFamilies) {
    if (!family.anime) continue;
    const seriesId = Number(family.anime.seriesId);
    const animeId = Number(family.anime.subjectId);
    const evidenceRows = selectedRelations.filter(
      (row) =>
        Number(row.relation_type) === ANIME_RELATION &&
        ((Number(row.subject_id) === seriesId && Number(row.related_subject_id) === animeId) ||
          (Number(row.subject_id) === animeId && Number(row.related_subject_id) === seriesId)),
    );
    if (!evidenceRows.length) {
      gaps.push(
        gap(
          'subject-relations',
          { subject_id: seriesId, related_subject_id: animeId },
          'Selected anime relation evidence is absent',
          {
            code: String(ANIME_RELATION),
            endpoint: String(animeId),
            property: 'rezics:crossMediaCounterpart',
          },
        ),
      );
      continue;
    }
    const anime = subjects.get(animeId);
    if (!anime) {
      gaps.push(
        gap('subject', { id: animeId }, 'Selected anime relation endpoint is missing from the dump', {
          code: String(ANIME_RELATION),
          endpoint: String(animeId),
          property: 'rezics:crossMediaCounterpart',
          requiredProfile: 'Bangumi anime subject',
        }),
      );
      continue;
    }
    if (anime.type !== 2) {
      gaps.push(
        gap('subject', anime, 'Selected relation endpoint is not an anime subject', {
          code: String(ANIME_RELATION),
          endpoint: String(animeId),
          property: 'rezics:crossMediaCounterpart',
          requiredProfile: 'Bangumi anime subject',
        }),
      );
      continue;
    }
    animeIds.push(String(animeId));
    records.push({ source: 'bangumi', key: String(animeId), revision: null, payload: anime });
    members.push({ key: String(animeId), role: 'anime', family: family.id });
    const primary = evidenceRows.find((row) => Number(row.subject_id) === seriesId) ?? evidenceRows[0]!;
    const primarySubject = Number(primary.subject_id);
    const primaryEndpoint = Number(primary.related_subject_id);
    const reciprocalRows = evidenceRows.filter(
      (row) => Number(row.subject_id) === primaryEndpoint && Number(row.related_subject_id) === primarySubject,
    );
    const mapped = relationDraft({ row: primary, reciprocalRows });
    if (!mapped) {
      gaps.push(
        gap('subject-relations', primary, 'Selected anime relation has ambiguous or unsupported source evidence', {
          code: String(ANIME_RELATION),
          endpoint: String(animeId),
          property: 'rezics:crossMediaCounterpart',
        }),
      );
      continue;
    }
    edges.push(mapped);
  }

  for (const volume of volumes) {
    const volumeId = asId(volume.row.id)!;
    const seriesId = Number(volume.family.seriesId);
    const volumeRows = volume.sourceRows.filter(
      (row) =>
        Number(row.subject_id) === volumeId &&
        Number(row.related_subject_id) === seriesId &&
        row.relation_type === SERIES_RELATION,
    );
    const seriesSideRows = volume.sourceRows.filter(
      (row) =>
        Number(row.subject_id) === seriesId &&
        Number(row.related_subject_id) === volumeId &&
        row.relation_type === OFFPRINT_RELATION,
    );
    const primary = volumeRows[0] ?? seriesSideRows[0];
    if (!primary) continue;
    const reciprocalRows = volumeRows.length ? seriesSideRows : volumeRows;
    const mapped = relationDraft({
      row: primary,
      reciprocalRows,
      ...(volume.ordinal === undefined ? {} : { order: volume.ordinal }),
    });
    if (!mapped) {
      gaps.push(
        gap('subject-relations', primary, 'Selected series membership has ambiguous or unsupported source evidence', {
          code: volume.family.id,
          endpoint: String(volumeId),
          property: 'wdt:P179',
        }),
      );
      continue;
    }
    edges.push(mapped);
  }
  return {
    family: showcaseBookFamily,
    families: showcaseBookFamilies,
    records,
    creators,
    credits: admittedCredits,
    edges,
    members,
    conversions,
    selected: {
      series: [...seriesRows.keys()].map(String),
      volumes: volumes.map((entry) => String(asId(entry.row.id))),
      editions: [],
      authors: [
        ...new Set(
          acceptedCreatorAssociations
            .filter((entry) => entry.role === 'author')
            .map((entry) => `person:${entry.personId}`),
        ),
      ],
      illustrators: [
        ...new Set(
          acceptedCreatorAssociations
            .filter((entry) => entry.role === 'illustrator')
            .map((entry) => `person:${entry.personId}`),
        ),
      ],
      publishers: [
        ...new Set(
          acceptedCreatorAssociations
            .filter((entry) => entry.role === 'publisher')
            .map((entry) => `person:${entry.personId}`),
        ),
      ],
      anime: animeIds,
    },
    gaps,
    relationScope: [
      ...new Set(relationRows.flatMap((row) => [String(row.subject_id), String(row.related_subject_id)])),
    ].sort(),
    relationSnapshotDigest: sourceDigest(relationRows),
  };
}

export function showcaseBooksToCrossMediaPlan(plan: ShowcaseBookPlan): CrossMediaPlan {
  const next = emptyCrossMediaPlan();
  next.records.bangumi = [...plan.records];
  next.entities.bangumi = [...plan.creators];
  next.edges = [...plan.edges];
  next.credits = [...plan.credits];
  next.gaps = [...plan.gaps];
  next.relationScope = [...plan.relationScope];
  next.relationSnapshotDigest = plan.relationSnapshotDigest;
  next.members = [
    ...plan.records.map((record) => ({
      source: 'bangumi' as const,
      key: record.key,
      kind: 'work' as const,
      membership:
        plan.members.find((member) => member.key === record.key)?.role === 'anime'
          ? ('referenced' as const)
          : ('family' as const),
    })),
    ...plan.creators.map((record) => ({
      source: 'bangumi' as const,
      key: record.key,
      kind: (record.payload as Row).type === 2 ? ('organization' as const) : ('person' as const),
      membership: 'referenced' as const,
    })),
  ];
  return next;
}

function readingIdentity(reading: CrossMediaReading): { id: string; type: string } | undefined {
  const subject =
    (reading.subject as { subject?: { id?: string; type?: string }; id?: string; type?: string }).subject ??
    (reading.subject as { id?: string; type?: string });
  if (!subject?.id || !uuid.test(subject.id)) return;
  return { id: subject.id, type: typeof subject.type === 'string' ? subject.type : '' };
}

async function rereadBookCreatorBindings(input: {
  planned: ShowcaseBookPlan;
  seeded: CrossMediaSeedResult;
  resolution: BangumiCreditVocabularyResolution;
  journal: ShowcaseJournal;
  read(subjectId: string): Promise<ReviewedSubjectRead | null>;
}): Promise<Pick<CrossMediaSeedResult, 'creditGaps' | 'creditRoles' | 'creditVocabularyRequirements' | 'status'>> {
  const current = await currentBangumiCreatorCreditBindings({
    resolution: input.resolution,
    acknowledgements: input.journal.acknowledgedCommands(),
    read: input.read,
  });
  const currentCodes = new Set(current.roles.map((role) => role.code));
  const creditGaps = [...input.seeded.creditGaps];
  for (const role of input.resolution.roles) {
    if (currentCodes.has(role.code)) continue;
    for (const draft of input.planned.credits) {
      if (draft.kind !== 'staff' || String(draft.roleCode) !== role.code) continue;
      creditGaps.push({
        provider: 'bangumi',
        path: draft.path,
        code: role.code,
        reason: 'missing_concept',
        property: role.property,
      });
    }
  }
  return {
    creditGaps,
    creditRoles: current.roles,
    creditVocabularyRequirements: current.requirements,
    status:
      creditGaps.length || input.seeded.status === 'imported-with-gaps' ? 'imported-with-gaps' : input.seeded.status,
  };
}

/** Default book adapter: documented families, ordinary conversion, then the shared seed/credit/graph path. */
export async function importShowcaseBooks(input: {
  seed: typeof seedCrossMedia;

  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings?: SourceVocabularyBindings;
  destination?: { origin: string };
  journal?: ShowcaseJournal;
  review?: ShowcaseReviewPort;
  publicClient?: PublicBulkClient;
  prior?: BangumiCreditPriorPublication;
  readPublicSubject?(subjectId: string): Promise<ReviewedSubjectRead>;
  manifest?: {
    recordBooks?(input: {
      family: ShowcaseBookFamily;
      families: readonly ShowcaseBookFamily[];
      selected: ShowcaseBookPlan['selected'];
      conversions: readonly ShowcaseBookConversion[];
    }): void;
  };
}): Promise<ShowcaseBooksResult> {
  const planned = await planShowcaseBooks({
    tables: input.tables,
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
  if (!planned.selected.series.length || !planned.selected.volumes.length) {
    return {
      status: 'imported-with-gaps',
      franchises: emptyCrossMediaPlan().franchises,
      members: showcaseBooksToCrossMediaPlan(planned).members,
      runs: {},
      readings: [],
      personIdentities: [],
      mediaOutcomes: [],
      workLinks: [],
      vndbWorkRelations: [],
      family: planned.family,
      families: planned.families,
      selected: planned.selected,
      conversions: planned.conversions,
      identities: {},
      planned,
      gaps: [
        ...planned.gaps,
        {
          source: 'bangumi',
          fields: ['subject.id'],
          record: { series: planned.selected.series, volumes: planned.selected.volumes },
          reason: 'Selected book family is incomplete',
        },
      ],
      creditGaps: [],
      vndbCreditDiagnostics: [],
      vndbCreditVocabularyRequirements: [],
      vndbCreditVocabularyUnavailable: [],
      vndbCharacterProfileRequirements: [],
      vndbCharacterProfileOmissions: [],
      characterDiagnostics: [],
      episodeDiagnostics: [],
      unresolved: [],
    };
  }
  input.manifest?.recordBooks?.({
    family: planned.family,
    families: planned.families,
    selected: planned.selected,
    conversions: planned.conversions,
  });
  const plan = showcaseBooksToCrossMediaPlan(planned);
  const showcase =
    input.journal && input.review && input.publicClient
      ? { journal: input.journal, review: input.review, publicClient: input.publicClient }
      : undefined;
  let resolution: BangumiCreditVocabularyResolution | undefined;
  const readPublic = (subjectId: string) =>
    input.readPublicSubject
      ? input.readPublicSubject(subjectId)
      : showcase
        ? showcase.publicClient.readSubject(subjectId)
        : input.port.readReviewedSubject(subjectId);
  const seeded = await input.seed(plan, input.path, input.port, input.destination, {
    providers: ['bangumi'],
    entitiesFirst: true,
    mediaDeadlineMs: 120_000,
    sourceVocabulary: input.bindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    ...(showcase
      ? {
          readPublicSubject: readPublic,
          prepareBangumiCreatorCreditBindings: async ({ result, drafts, read }) => {
            resolution = await prepareBangumiCreatorCreditBindings({
              plan,
              result,
              drafts,
              port: input.port,
              journal: showcase.journal,
              review: showcase.review,
              publicClient: showcase.publicClient,
              ...(input.prior ? { prior: input.prior } : {}),
              subjectTypes: [1],
              read,
            });
            return resolution;
          },
        }
      : {}),
  });
  const current =
    resolution && showcase
      ? await rereadBookCreatorBindings({
          planned,
          seeded,
          resolution,
          journal: showcase.journal,
          read: readPublic,
        })
      : undefined;
  const identities: Record<string, { id: string; type: string; route: string }> = {};
  for (const reading of seeded.readings) {
    const identity = readingIdentity(reading);
    if (!identity) continue;
    identities[reading.externalId] = { ...identity, route: reading.route };
  }
  return {
    ...seeded,
    ...(current ?? {}),
    family: planned.family,
    families: planned.families,
    selected: planned.selected,
    conversions: planned.conversions,
    identities,
    planned,
    status: planned.gaps.length && seeded.status === 'imported' ? 'imported-with-gaps' : seeded.status,
    gaps: [...planned.gaps, ...seeded.gaps],
  };
}

export type { BangumiCreatorCreditGap, CrossMediaGap };
