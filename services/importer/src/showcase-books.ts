import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import { convertBangumi } from '@rezics/conversion/bangumi';
import {
  selectBangumiBookProfile,
  type BangumiBookGrain,
} from '../../../packages/conversion/src/bangumi-book-profile.ts';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import {
  bangumiStaffDraft,
  type BangumiCreatorCreditDraft,
  type BangumiCreatorCreditGap,
} from './bangumi-creator-credits.ts';
import type { GraphEdgeDraft } from './cross-media-bindings.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaGap,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaReading,
  type CrossMediaSeedResult,
  type CrossMediaTables,
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

type Row = Record<string, unknown>;
const SERIES_ID = 499;
const SEED_VOLUME_ID = 26;
const AUTHOR_ROLE = 2001;
const SERIES_RELATION = 1002;
const OFFPRINT_RELATION = 1003;
const COMIC_PLATFORM = '1001';
const VOLUME_CAP = 32;
const AUTHOR_CAP = 16;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Documented Book Girl family from the pinned dump relation.1/1002 record check. */
export const showcaseBookFamily = {
  id: 'book-girl',
  seriesId: String(SERIES_ID),
  seedVolumeIds: [String(SEED_VOLUME_ID)] as const,
  provenance: {
    archive: 'dump-2026-10-20.210332Z.zip',
    digest: '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93',
    citation: 'subject-relations.jsonlines/26/499',
  },
} as const;

export type ShowcaseBookMember = Readonly<{
  key: string;
  grain?: BangumiBookGrain;
  role: 'series' | 'volume' | 'author' | 'excluded' | 'missing';
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
  family: typeof showcaseBookFamily;
  records: SourceRecord[];
  people: SourceRecord[];
  credits: BangumiCreatorCreditDraft[];
  edges: GraphEdgeDraft[];
  members: ShowcaseBookMember[];
  conversions: ShowcaseBookConversion[];
  selected: { series: string[]; volumes: string[]; editions: string[]; authors: string[] };
  gaps: CrossMediaGap[];
  relationScope: string[];
  relationSnapshotDigest: string;
}>;

export type ShowcaseBooksResult = CrossMediaSeedResult & {
  family: typeof showcaseBookFamily;
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

/**
 * Stream only the documented Book Girl seeds and their 1002/1003 novel members.
 * Titles never select; manga, adaptations and same-title extras stay out.
 */
export async function planShowcaseBooks(input: {
  tables: CrossMediaTables;
  bindings?: SourceVocabularyBindings;
}): Promise<ShowcaseBookPlan> {
  const seeds = new Set<number>([SERIES_ID, SEED_VOLUME_ID]);
  const wanted = new Set(seeds);
  const membership: Row[] = [];
  const gaps: CrossMediaGap[] = [];
  for await (const row of input.tables.rows('bangumi', 'subject-relations')) {
    const sid = asId(row.subject_id);
    const rid = asId(row.related_subject_id);
    const code = row.relation_type;
    if (sid === undefined || rid === undefined) continue;
    if (code !== SERIES_RELATION && code !== OFFPRINT_RELATION) continue;
    if (!seeds.has(sid) && !seeds.has(rid)) continue;
    membership.push(row);
    wanted.add(sid);
    wanted.add(rid);
  }

  const subjects = new Map<number, Row>();
  for await (const row of input.tables.rows('bangumi', 'subject')) {
    const id = asId(row.id);
    if (id === undefined || !wanted.has(id)) continue;
    subjects.set(id, row);
  }

  const seriesRow = subjects.get(SERIES_ID);
  if (!seriesRow) gaps.push(gap('subject', { id: SERIES_ID }, 'Selected book series is missing from the dump'));
  else if (!isNovelSeries(seriesRow))
    gaps.push(
      gap(
        'subject',
        { id: SERIES_ID, type: seriesRow.type, platform: seriesRow.platform, series: seriesRow.series },
        'Selected series is not a novel BookSeries',
      ),
    );

  const members: ShowcaseBookMember[] = [];
  const volumes: Row[] = [];
  if (seriesRow && isNovelSeries(seriesRow))
    members.push({
      key: String(SERIES_ID),
      grain: grainOf(seriesRow),
      role: 'series',
      ...withPlatform(seriesRow),
      series: true,
    });

  const seenVolumes = new Set<number>();
  for (const row of membership) {
    const sid = asId(row.subject_id)!;
    const rid = asId(row.related_subject_id)!;
    const code = row.relation_type as number;
    const volumeId = code === SERIES_RELATION ? sid : rid;
    const seriesId = code === SERIES_RELATION ? rid : sid;
    if (seriesId !== SERIES_ID || volumeId === SERIES_ID) continue;
    if (seenVolumes.has(volumeId)) continue;
    const volume = subjects.get(volumeId);
    if (!volume) {
      gaps.push(
        gap('subject-relations', row, 'Missing source volume for a stated series membership', {
          code: String(volumeId),
          property: 'wdt:P179',
        }),
      );
      members.push({ key: String(volumeId), role: 'missing', reason: 'missing_source_volume' });
      continue;
    }
    if (!isNovelVolume(volume)) {
      members.push({
        key: String(volumeId),
        grain: grainOf(volume),
        role: 'excluded',
        ...withPlatform(volume),
        ...(typeof volume.series === 'boolean' ? { series: volume.series } : {}),
        reason: 'not_a_novel_volume',
      });
      continue;
    }
    if (volumes.length >= VOLUME_CAP) {
      gaps.push(gap('subject-relations', row, 'Selected novel volumes exceed the bounded family cap'));
      continue;
    }
    seenVolumes.add(volumeId);
    volumes.push(volume);
    members.push({
      key: String(volumeId),
      grain: grainOf(volume),
      role: 'volume',
      ...withPlatform(volume),
      series: false,
    });
  }

  const selectedIds = new Set<number>([
    ...(seriesRow && isNovelSeries(seriesRow) ? [SERIES_ID] : []),
    ...volumes.map((row) => asId(row.id)!),
  ]);
  const authorIds = new Set<number>();
  const credits: BangumiCreatorCreditDraft[] = [];
  for await (const row of input.tables.rows('bangumi', 'subject-persons')) {
    const subjectId = asId(row.subject_id);
    const personId = asId(row.person_id);
    if (subjectId === undefined || personId === undefined || !selectedIds.has(subjectId)) continue;
    if (row.position !== AUTHOR_ROLE) continue;
    if (authorIds.size >= AUTHOR_CAP && !authorIds.has(personId)) {
      gaps.push(gap('subject-persons', row, 'Selected book authors exceed the bounded family cap'));
      continue;
    }
    authorIds.add(personId);
    credits.push(bangumiStaffDraft({ subject_id: subjectId, person_id: personId, position: AUTHOR_ROLE }, 1));
  }

  const people: SourceRecord[] = [];
  const rejectedAuthors = new Set<string>();
  for await (const row of input.tables.rows('bangumi', 'person')) {
    const id = asId(row.id);
    if (id === undefined || !authorIds.has(id)) continue;
    if (row.type !== 1) {
      rejectedAuthors.add(`person:${id}`);
      authorIds.delete(id);
      gaps.push(gap('person', row, 'Author identity is not an individual person', { property: 'schema:author' }));
      continue;
    }
    people.push({ source: 'bangumi', key: `person:${id}`, revision: null, payload: row });
    members.push({ key: `person:${id}`, role: 'author' });
  }
  for (const id of authorIds) {
    if (!people.some((row) => row.key === `person:${id}`))
      gaps.push(gap('person', { id }, 'Author identity is missing from the dump', { property: 'schema:author' }));
  }
  const admittedCredits = credits.filter((draft) => !rejectedAuthors.has(draft.person));

  const records: SourceRecord[] = [];
  if (seriesRow && isNovelSeries(seriesRow))
    records.push({ source: 'bangumi', key: String(SERIES_ID), revision: null, payload: seriesRow });
  for (const volume of volumes)
    records.push({ source: 'bangumi', key: String(asId(volume.id)), revision: null, payload: volume });

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

  const edges: GraphEdgeDraft[] = [];
  const usedPairs = new Set<string>();
  for (const row of membership) {
    const sid = asId(row.subject_id)!;
    const rid = asId(row.related_subject_id)!;
    if (row.relation_type !== SERIES_RELATION) continue;
    if (!selectedIds.has(sid) || rid !== SERIES_ID) continue;
    const key = `${sid}:${rid}`;
    if (usedPairs.has(key)) continue;
    usedPairs.add(key);
    const reciprocal = membership.find(
      (candidate) =>
        candidate.subject_id === rid &&
        candidate.related_subject_id === sid &&
        candidate.relation_type === OFFPRINT_RELATION,
    );
    const evidence = [row, ...(reciprocal ? [reciprocal] : [])].map((item) => ({
      path: `/subject-relations/${item.subject_id}/${item.related_subject_id}`,
      code: item.relation_type as number,
      sourceSubject: String(item.subject_id),
      sourceEndpoint: String(item.related_subject_id),
      digest: sourceDigest(item),
    }));
    edges.push({
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'subject-relations',
      holder: String(sid),
      target: String(rid),
      property: 'wdt:P179',
      url: bangumiRecordUrl(String(sid)),
      membership: 'family',
      record: row,
      fields: fieldsOf('subject-relations', row),
      relation: {
        family: 1,
        code: SERIES_RELATION,
        ...(reciprocal ? { reciprocalCode: OFFPRINT_RELATION } : {}),
        path: `/subject-relations/${sid}/${rid}`,
        sourceSubject: String(sid),
        sourceEndpoint: String(rid),
        mappingRevision: `bangumi-relation-1@2:${SERIES_RELATION}:${reciprocal ? OFFPRINT_RELATION : 'one-sided'}`,
        ...(typeof row.order === 'number' && Number.isSafeInteger(row.order) ? { order: row.order } : {}),
        evidence,
      },
    });
  }

  const relationRows = membership.filter((row) => {
    const sid = asId(row.subject_id);
    const rid = asId(row.related_subject_id);
    return sid !== undefined && rid !== undefined && (selectedIds.has(sid) || selectedIds.has(rid));
  });
  return {
    family: showcaseBookFamily,
    records,
    people,
    credits: admittedCredits,
    edges,
    members,
    conversions,
    selected: {
      series: seriesRow && isNovelSeries(seriesRow) ? [String(SERIES_ID)] : [],
      volumes: volumes.map((row) => String(asId(row.id))),
      editions: [],
      authors: people.map((row) => row.key),
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
  next.entities.bangumi = [...plan.people];
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
      membership: 'family' as const,
    })),
    ...plan.people.map((record) => ({
      source: 'bangumi' as const,
      key: record.key,
      kind: 'person' as const,
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

async function rereadBookAuthorBindings(input: {
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

/** Default book adapter: documented family, ordinary conversion, then the shared seed/credit/graph path. */
export async function importShowcaseBooks(input: {
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
      family: typeof showcaseBookFamily;
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
      members: planned.members.map((member) => ({
        source: 'bangumi' as const,
        key: member.key,
        kind: member.role === 'author' ? ('person' as const) : ('work' as const),
        membership: 'family' as const,
      })),
      runs: {},
      readings: [],
      mediaOutcomes: [],
      workLinks: [],
      family: planned.family,
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
  const seeded = await seedCrossMedia(plan, input.path, input.port, input.destination, {
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
      ? await rereadBookAuthorBindings({
          planned,
          seeded,
          resolution,
          journal: showcase.journal,
          read: async (subjectId) => {
            try {
              return await readPublic(subjectId);
            } catch {
              return null;
            }
          },
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
    selected: planned.selected,
    conversions: planned.conversions,
    identities,
    planned,
    gaps: [...planned.gaps, ...seeded.gaps],
  };
}

export type { BangumiCreatorCreditGap, CrossMediaGap };
