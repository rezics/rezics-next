import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Unzip, UnzipInflate, type AsyncFlateStreamHandler } from 'fflate';
import { declaredCountProperties, gamePlatformConcepts, workFormatConcepts, type GamePlatformKey, type WorkFormatKey }
  from '../dev/seed/relation-lexicon-data.ts';
import { InvalidSemanticValue, temporalParts } from '../../services/main/src/modules/semantic/value.ts';
import { DATE_PUBLISHED_PREDICATE } from '../../services/main/src/modules/statement/qualification.ts';
import type { SerialStatus } from '../../services/main/src/modules/work/metadata-schema.ts';
import { MissingRemote, type Acquisition } from './network.ts';
import { blobPath, canonical, sha256 } from './store.ts';
import type { DatasetEdge, DatasetImage, DatasetRecord, DatasetSource } from './types.ts';

type Row = Record<string, unknown>;
export type BangumiFamily = 'one-piece' | 're-zero' | 'toaru';
export const bangumiFamilies: Record<BangumiFamily, RegExp> = {
  'one-piece':
    /\bONE[\s_-]*PIECE\b|ワンピース|海[贼賊]王|航海王|食戟のサンジ|麦わらスペース|^CHOPPER[’']s\b/i,
  're-zero':
    /Re\s*[:：]\s*(?:ゼロ|プチ|Zero|[从從](?:零|迷[你妳]))|[从從]零[开開]始的[异異]世界生活|リゼロ/i,
  toaru:
    /とある(?:魔術|科学|暗部|超百科|ラジオ)|魔[法術术]禁[书書][目目录錄]|某科[学學]的(?:超[电電]磁[炮砲]|一方通行)|A Certain (?:Magical Index|Scientific (?:Railgun|Accelerator))/i,
};

/** Only title/alias fields determine the initial membership. A staff credit or
 * synopsis mentioning One Piece must not elect an unrelated series. */
export function bangumiFamily(row: Row): BangumiFamily | undefined {
  const infobox = typeof row.infobox === 'string' ? row.infobox : '';
  const aliases = [
    ...infobox.matchAll(
      /\|(?:中文名|简体中文名|繁體中文名|别名|別名)\s*=\s*(\{[\s\S]*?\}|[^\r\n]*)/g,
    ),
  ]
    .map((match) => match[1])
    .join('\n');
  const names = `${String(row.name ?? '')}\n${String(row.name_cn ?? '')}\n${aliases}`;
  return (Object.keys(bangumiFamilies) as BangumiFamily[]).find((family) =>
    bangumiFamilies[family].test(names),
  );
}

const narrativeRelations = new Set([
  1, 2, 3, 4, 5, 6, 10, 11, 12, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1010, 1015, 4002, 4003,
  4006, 4010, 4012, 4015, 4016, 4017,
]);
const soundtrackRelations = new Set([3001, 3002, 3003, 3004, 3005, 3006, 3007]);
const id = (row: Row, field = 'id'): number => {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Bangumi invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value;
};
const key = (kind: string, value: number) => `bangumi:${kind}:${value}`;

export interface BangumiSelection {
  family: Set<number>;
  narrative: Set<number>;
  references: Set<number>;
  roots: Record<BangumiFamily, number[]>;
  relations: Row[];
}

/** Named membership includes adaptations and spin-offs; hierarchy closure adds
 * every linked book volume, even when its title omits the franchise. A shared
 * opening song, crossover game or generic compilation cannot pull in unrelated
 * franchises. Every incident relation remains in the elected graph, including
 * the complete row of its reference endpoint. */
export function selectBangumiSubjects(
  subjects: Map<number, Row>,
  relations: Row[],
  roots: Record<BangumiFamily, number[]>,
): BangumiSelection {
  const confirmed = new Set(Object.values(roots).flat());
  const adjacency = new Map<number, number[]>();
  for (const relation of relations) {
    const from = id(relation, 'subject_id'),
      to = id(relation, 'related_subject_id');
    if (
      !subjects.has(from) ||
      !subjects.has(to) ||
      !narrativeRelations.has(Number(relation.relation_type)) ||
      Number(subjects.get(from)?.type) === 3 ||
      Number(subjects.get(to)?.type) === 3
    )
      continue;
    const volumeHierarchy =
      [1002, 1003].includes(Number(relation.relation_type)) &&
      Number(subjects.get(from)?.type) === 1 &&
      Number(subjects.get(to)?.type) === 1;
    // Adaptation edges also connect Jump crossover games to every contributing
    // franchise. Unknown endpoints remain complete boundary records; only an
    // actual book-volume hierarchy can promote an unnamed member recursively.
    if (!volumeHierarchy && (!confirmed.has(from) || !confirmed.has(to))) continue;
    const forward = adjacency.get(from) ?? [],
      reverse = adjacency.get(to) ?? [];
    forward.push(to);
    reverse.push(from);
    adjacency.set(from, forward);
    adjacency.set(to, reverse);
  }
  const narrative = new Set(confirmed),
    pending = [...narrative];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const related of adjacency.get(pending[cursor]!) ?? []) {
      if (!narrative.has(related)) {
        narrative.add(related);
        pending.push(related);
      }
    }
  }
  const family = new Set(narrative);
  for (const relation of relations) {
    if (!soundtrackRelations.has(Number(relation.relation_type))) continue;
    const from = id(relation, 'subject_id'),
      to = id(relation, 'related_subject_id');
    if (narrative.has(from) && Number(subjects.get(to)?.type) === 3) family.add(to);
    if (narrative.has(to) && Number(subjects.get(from)?.type) === 3) family.add(from);
  }
  const elected = relations.filter(
    (row) => family.has(id(row, 'subject_id')) || family.has(id(row, 'related_subject_id')),
  );
  const references = new Set(
    elected
      .flatMap((row) => [id(row, 'subject_id'), id(row, 'related_subject_id')])
      .filter((value) => !family.has(value)),
  );
  return { family, narrative, references, roots, relations: elected };
}

/** ZIP files are inflated incrementally and decoded across chunk boundaries.
 * Reading the official multi-million-row dump never builds a full JSON array. */
export async function scanBangumiArchive(
  path: string,
  tables: Set<string>,
  onRow: (table: string, row: Row) => void,
): Promise<Set<string>> {
  const seen = new Set<string>();
  let failure: unknown;
  class DiscardInflate {
    static compression = 8;
    ondata: AsyncFlateStreamHandler = () => {};
    push(_bytes: Uint8Array, final: boolean) {
      if (final) this.ondata(null, new Uint8Array(), true);
    }
  }
  const unzip = new Unzip((file) => {
    const table = basename(file.name).replace(/\.jsonlines$/, '');
    // Starting skipped entries with a discard decoder is essential: leaving a
    // file unopened makes fflate retain all its compressed bytes for later.
    unzip.register(tables.has(table) ? UnzipInflate : DiscardInflate);
    if (!tables.has(table)) {
      file.ondata = () => {};
      file.start();
      return;
    }
    if (seen.has(table)) {
      failure = new Error(`Duplicate Bangumi archive table: ${table}`);
      return;
    }
    seen.add(table);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '',
      completed = false;
    const readRow = (line: string) => {
      if (!line.trim()) return;
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`Bangumi ${table}: expected object row`);
      onRow(table, parsed as Row);
    };
    file.ondata = (error, bytes, final) => {
      if (failure) return;
      try {
        if (error) throw error;
        pending += decoder.decode(bytes, { stream: !final });
        let start = 0,
          end = pending.indexOf('\n');
        while (end >= 0) {
          readRow(pending.slice(start, end));
          start = end + 1;
          end = pending.indexOf('\n', start);
        }
        pending = pending.slice(start);
        if (pending.length > 32 * 1024 * 1024) throw new Error(`Bangumi ${table}: oversized row`);
        if (final) {
          readRow(pending);
          completed = true;
        }
      } catch (error) {
        failure = error;
      }
    };
    file.start();
    // Track completion via a callback checked after the ZIP final marker.
    completions.push(() => completed);
  });
  const completions: (() => boolean)[] = [];
  unzip.register(UnzipInflate);
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    unzip.push(chunk);
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(), true);
  if (failure) throw failure;
  if (completions.some((done) => !done())) throw new Error('Truncated Bangumi archive');
  for (const table of tables)
    if (!seen.has(table)) throw new Error(`Bangumi archive lacks table: ${table}`);
  return seen;
}

/** Free-text fields the copyright page leaves with their authors. Numeric scores and
 * collection counts are not in this list; a text field under one of these names is. */
export const BANGUMI_USER_POST_FIELDS = [
  'blog', 'blogs', 'comment', 'comments', 'review', 'reviews', 'tsukkomi',
  'rating_text', 'score_comment', 'collection_comment', 'collection_text',
  'user_comment', 'short_comment', 'comment_box',
] as const;

/** Covers and other images. Publishers own the art, so an uploader's licence does not cover it. */
export const BANGUMI_IMAGE_FIELDS = ['images', 'image', 'cover', 'avatar'] as const;

const bangumiOmittedFields = new Set<string>([...BANGUMI_USER_POST_FIELDS, ...BANGUMI_IMAGE_FIELDS]);

export function bangumiSkipReason(field: string): string | null {
  if ((BANGUMI_USER_POST_FIELDS as readonly string[]).includes(field))
    return 'Bangumi leaves users\' blogs, posts (吐槽), reviews, comments and collection text with their authors';
  if ((BANGUMI_IMAGE_FIELDS as readonly string[]).includes(field))
    return 'Publishers own the art; the uploader\'s licence does not cover covers or images';
  return null;
}

/** Drop user-post and image fields at every object level. Infobox wiki text stays;
 * it is subject information (titles, staff, dates), not a cover field. */
export function bangumiMappedData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => bangumiMappedData(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (bangumiOmittedFields.has(key)) continue;
    out[key] = bangumiMappedData(child);
  }
  return out as T;
}

export function bangumiFieldDisposition(value: unknown, prefix = ''): {
  kept: string[];
  skipped: { field: string; reason: string }[];
} {
  const kept: string[] = [];
  const skipped: { field: string; reason: string }[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const field = path ? `${path}.${key}` : key;
      const reason = bangumiSkipReason(key);
      if (reason) skipped.push({ field, reason });
      else {
        kept.push(field);
        walk(child, field);
      }
    }
  };
  walk(value, prefix);
  return { kept, skipped };
}

export function bangumiSourceUrl(kind: 'subject' | 'character', id: string | number): string {
  return `https://bgm.tv/${kind}/${id}`;
}

/** Roles come from the official endpoint's entity, never an image path or extension. */
export function bangumiImageCandidate(
  row: Row,
  kind: 'subject' | 'character',
  captureUrl: string,
  recordDigest: string | undefined,
): DatasetImage | undefined {
  const canonicalId = id(row);
  const role = kind === 'subject' ? 'cover' : 'portrait';
  const endpoint = kind === 'subject' ? 'subjects' : 'characters';
  if (!new RegExp(`^https://api\\.bgm\\.tv/v0/${endpoint}/[1-9]\\d*$`).test(captureUrl))
    throw new Error(`Bangumi ${role} requires its captured ${kind} endpoint`);
  const imageSet = row.images;
  if (!imageSet || typeof imageSet !== 'object' || Array.isArray(imageSet)) return undefined;
  const url = (imageSet as Row).large;
  if (url === undefined || url === null || url === '') return undefined;
  if (typeof url !== 'string' || url !== url.trim() || !url.startsWith('https://'))
    throw new Error(`Bangumi ${kind} ${canonicalId} has an invalid large ${role} URL`);
  if (!recordDigest || !/^[a-f0-9]{64}$/.test(recordDigest))
    throw new Error(`Bangumi ${kind} ${canonicalId} ${role} lacks captured source evidence`);
  return {
    record: key(kind, canonicalId),
    role,
    url,
    sourceEvidence: {
      provider: 'bangumi',
      namespace: kind,
      externalId: String(canonicalId),
      revision: null,
      captureUrl,
      recordDigest,
      field: '/images/large',
      sourceName: 'Bangumi',
      sourceUrl: bangumiSourceUrl(kind, canonicalId),
      holder: null,
    },
  };
}

/** Page URL stored on a statement as rv:evidence. Licence and credit are not Bangumi fields. */
export function bangumiStatementEvidence(kind: 'subject' | 'character', id: string | number): string[] {
  return [bangumiSourceUrl(kind, id)];
}

function record(
  kind: 'subject' | 'person' | 'character' | 'episode',
  row: Row,
  reference = false,
): DatasetRecord {
  const externalId = String(id(row));
  const title = String(
    row.name ||
      row.name_cn ||
      (kind === 'episode' ? `Episode ${row.sort}` : `${kind} ${externalId}`),
  );
  return {
    key: key(kind, Number(externalId)),
    provider: 'bangumi',
    kind,
    externalId,
    title,
    language: 'ja',
    sourceUrl: `https://bgm.tv/${kind === 'episode' ? 'ep' : kind}/${externalId}`,
    data: bangumiMappedData(row),
    native: reference
      ? 'source-only'
      : kind === 'subject'
        ? 'work'
        : kind === 'person'
          ? Number(row.type) === 1
            ? 'person'
            : 'organization'
          : kind,
  };
}

/** The archive intentionally contains a tag subset. Acquire every elected
 * subject's current public API response to retain API-exposed tags while
 * preserving the archive fields. Extract only the elected large cover before
 * recursive image and user-post omission. This accepts an already captured
 * source so resumptions need not rescan the dump. */
export async function enrichBangumiSubjects(
  acquisition: Acquisition,
  source: DatasetSource,
): Promise<DatasetSource> {
  if (source.provider !== 'bangumi')
    throw new Error('Expected Bangumi dataset for subject enrichment');
  const records = source.records.map((item) => ({ ...item, data: { ...item.data } }));
  const recordsByKey = new Map(records.map((item) => [item.key, item]));
  const edges = source.edges.map((edge) => ({ ...edge }));
  const edgeIndex = new Map(
    edges.map((edge, index) => [canonical([edge.from, edge.to, edge.kind]), index]),
  );
  const membership = source.scope.familySubjectIds;
  if (
    !Array.isArray(membership) ||
    membership.some(
      (value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error('Bangumi enrichment requires the exact elected family roster');
  }
  const observations: Row[] = [],
    timestamps: string[] = [];
  const coverCandidates = new Map<string, DatasetImage>();
  const apiRedirects: { from: string; to: string; url: string }[] = [];
  const priorCoverage = source.scope.subjectApiCoverage as Row | undefined;
  const apiBoundary: string[] = Array.isArray(priorCoverage?.boundaryRecords)
    ? [...(priorCoverage.boundaryRecords as string[])]
    : [];
  let successful = 0,
    unavailable = 0,
    addedTags = 0;
  for (const externalId of membership as number[]) {
    const subjectKey = key('subject', externalId),
      subject = recordsByKey.get(subjectKey);
    if (!subject || subject.kind !== 'subject')
      throw new Error(`Bangumi family roster lacks subject row: ${subjectKey}`);
    const url = `https://api.bgm.tv/v0/subjects/${externalId}`;
    let row: Row;
    try {
      row = (await acquisition.json(url)) as Row;
    } catch (error) {
      if (!(error instanceof MissingRemote)) throw error;
      unavailable++;
      const evidence = {
        record: subjectKey,
        url,
        status: 'unavailable',
        httpStatus: 404,
        reason:
          'Official API returned 404; this may mean deleted, merged without a public redirect, or restricted. Archive content remains intact.',
      };
      observations.push(evidence);
      subject.data.api_subject_acquisition = evidence;
      continue;
    }
    const canonicalId = id(row);
    if (!Array.isArray(row.tags) || !Array.isArray(row.meta_tags))
      throw new Error(`Bangumi API subject lacks exposed tag arrays: ${url}`);
    const captured = acquisition.captures?.get(sha256(canonical([url, null])));
    if (captured) timestamps.push(captured.fetchedAt);
    const observation = {
      record: subjectKey,
      url,
      status: canonicalId === externalId ? 'ok' : 'merged',
      requestedId: externalId,
      returnedId: canonicalId,
      responseDigest: captured?.digest ?? null,
      fetchedAt: captured?.fetchedAt ?? null,
    };
    observations.push(observation);
    subject.data.api_subject = bangumiMappedData(row);
    subject.data.api_subject_acquisition = observation;
    successful++;
    if (canonicalId !== externalId) {
      const canonicalKey = key('subject', canonicalId);
      if (!recordsByKey.has(canonicalKey)) {
        const endpoint = record('subject', row, true);
        records.push(endpoint);
        recordsByKey.set(canonicalKey, endpoint);
        apiBoundary.push(canonicalKey);
      }
      const redirect = { from: subjectKey, to: canonicalKey, url };
      apiRedirects.push(redirect);
      const signature = canonical([subjectKey, canonicalKey, 'redirect']);
      if (!edgeIndex.has(signature)) {
        edgeIndex.set(signature, edges.length);
        edges.push({
          from: subjectKey,
          to: canonicalKey,
          kind: 'redirect',
          data: { requestedUrl: url, stage: 'subject-api-enrichment' },
        });
      }
    }
    const cover = bangumiImageCandidate(row, 'subject', url, captured?.digest);
    if (cover) {
      const prior = coverCandidates.get(cover.record);
      const currentCapture = cover.sourceEvidence!.captureUrl;
      const priorCapture = prior?.sourceEvidence?.captureUrl;
      const currentIsCanonical = canonicalId === externalId;
      const priorIsCanonical = priorCapture === `https://api.bgm.tv/v0/subjects/${canonicalId}`;
      if (
        !prior ||
        (currentIsCanonical && !priorIsCanonical) ||
        (currentIsCanonical === priorIsCanonical && currentCapture < priorCapture!)
      )
        coverCandidates.set(cover.record, cover);
    }
    for (const field of ['tags', 'meta_tags'] as const) {
      for (const entry of row[field] as unknown[]) {
        const item: Row =
          typeof entry === 'string'
            ? { name: entry }
            : entry && typeof entry === 'object' && !Array.isArray(entry)
              ? (entry as Row)
              : {};
        const name = item.name;
        if (typeof name !== 'string' || !name.trim())
          throw new Error(`Bangumi API returned an invalid ${field}: ${url}`);
        if (
          field === 'tags' &&
          (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0)
        ) {
          throw new Error(`Bangumi API tag lacks its count: ${url}`);
        }
        const tagKey = `bangumi:tag:${sha256(name)}`;
        if (!recordsByKey.has(tagKey)) {
          const tag: DatasetRecord = {
            key: tagKey,
            provider: 'bangumi',
            kind: 'tag',
            externalId: name,
            title: name,
            language: 'und',
            sourceUrl: `https://bgm.tv/subject_search/${encodeURIComponent(name)}?cat=all`,
            data: { name },
            native: 'concept',
          };
          records.push(tag);
          recordsByKey.set(tagKey, tag);
          addedTags++;
        }
        const kind = field === 'tags' ? 'tag' : 'meta-tag',
          signature = canonical([subjectKey, tagKey, kind]);
        const index = edgeIndex.get(signature),
          prior = index === undefined ? undefined : edges[index];
        // Current API counts qualify the native edge. The archive's historical
        // count and the exact API row remain separately available as evidence.
        const archiveTag = prior?.data.api_tag === undefined ? prior?.data : prior.data.archive_tag;
        const edge: DatasetEdge = {
          from: subjectKey,
          to: tagKey,
          kind,
          data: {
            ...item,
            api_tag: item,
            ...(archiveTag === undefined ? {} : { archive_tag: archiveTag }),
          },
        };
        if (index === undefined) {
          edgeIndex.set(signature, edges.length);
          edges.push(edge);
        } else edges[index] = edge;
      }
    }
  }
  const sorted = timestamps.sort();
  const sourceLimitations = Array.isArray(source.scope.sourceLimitations)
    ? (source.scope.sourceLimitations as string[])
    : [];
  console.log(
    `Bangumi subject API: ${successful}/${membership.length} public responses, ${addedTags} additional tag entities, ${unavailable} unavailable endpoints`,
  );
  return {
    ...source,
    records,
    edges,
    images: [
      ...source.images.filter(
        (image) => image.role !== 'cover' || !coverCandidates.has(image.record),
      ),
      ...coverCandidates.values(),
    ].sort((left, right) =>
      canonical([left.record, left.role, left.url, left.sourceEvidence]).localeCompare(
        canonical([right.record, right.role, right.url, right.sourceEvidence]),
      ),
    ),
    scope: {
      ...source.scope,
      surfaces: [
        ...new Set([
          ...(Array.isArray(source.scope.surfaces) ? (source.scope.surfaces as string[]) : []),
          'public v0 subject JSON for every elected family subject; its large cover is extracted separately, while other images and user posts are omitted',
          'all API-exposed tags and counts',
        ]),
      ],
      subjectApiCoverage: {
        requested: membership.length,
        successful,
        unavailable,
        responseInterval: { from: sorted[0] ?? null, to: sorted.at(-1) ?? null },
        observations,
        redirects: apiRedirects,
        boundaryRecords: apiBoundary,
        fields:
          'Every public v0 subject response is retained in data.api_subject except image and user-post fields; the elected large cover is retained separately with its captured record digest and field locator. Every API-exposed community tag, its full counts and managed tags are represented.',
        tagCoverage:
          'Union of archive tags and every tag exposed by the official subject API. API exposure is not a claim to unexposed private or deleted tag assignments.',
      },
      sourceLimitations: [
        ...sourceLimitations.filter(
          (item) =>
            !item.startsWith('Archive exports only a subset of community tags') &&
            !item.startsWith('Covers and other images are not imported'),
        ),
        'Archive community tag subsets are supplemented with all tags exposed by the official subject API; tags unexposed by both sources remain outside observable coverage.',
        'Only elected subject covers and portraits witnessed by an already captured character API response are retained as image candidates. Screenshots, other images and user posts are not acquired. Image rights holders remain unknown.',
      ],
    },
  };
}

export async function fetchBangumi(acquisition: Acquisition): Promise<DatasetSource> {
  const latest = (await acquisition.json(
    'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json',
  )) as Row;
  if (
    typeof latest.browser_download_url !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(String(latest.digest))
  )
    throw new Error('Bangumi archive manifest lacks SHA-256');
  const archive = await acquisition.capture(latest.browser_download_url, {
    limit: 1024 * 1024 * 1024,
    expectedDigest: String(latest.digest).slice(7),
  });
  const path = blobPath(acquisition.root, archive.digest);
  const subjects = new Map<number, Row>(),
    subjectRelations: Row[] = [];
  const roots: Record<BangumiFamily, number[]> = { 'one-piece': [], 're-zero': [], toaru: [] };
  await scanBangumiArchive(path, new Set(['subject', 'subject-relations']), (table, row) => {
    if (table === 'subject-relations') {
      subjectRelations.push(row);
      return;
    }
    const value = id(row),
      family = bangumiFamily(row);
    if (subjects.has(value)) throw new Error(`Duplicate Bangumi subject: ${value}`);
    subjects.set(value, { id: value, type: row.type });
    if (family) roots[family].push(value);
  });
  for (const [family, ids] of Object.entries(roots))
    if (!ids.length) throw new Error(`Bangumi archive has no ${family} subjects`);
  const selected = selectBangumiSubjects(subjects, subjectRelations, roots);
  console.log(
    `Bangumi archive scope: ${selected.family.size} family subjects and ${selected.references.size} reference subjects`,
  );
  const persons = new Set<number>(),
    characters = new Set<number>(),
    corePersons = new Set<number>(),
    coreCharacters = new Set<number>();
  const sourceAnomalies: { table: string; row: Row; reason: string }[] = [];
  const edges: DatasetEdge[] = selected.relations.map((row) => ({
    from: key('subject', id(row, 'subject_id')),
    to: key('subject', id(row, 'related_subject_id')),
    kind: `subject-relation:${row.relation_type}`,
    data: row,
  }));
  const tables = new Set([
    'subject-persons',
    'subject-characters',
    'person-characters',
    'person-relations',
  ]);
  await scanBangumiArchive(path, tables, (table, row) => {
    if (table !== 'person-relations' && !selected.family.has(id(row, 'subject_id'))) return;
    if (table === 'subject-persons') {
      const person = id(row, 'person_id');
      persons.add(person);
      corePersons.add(person);
      edges.push({
        from: key('subject', id(row, 'subject_id')),
        to: key('person', person),
        kind: `staff:${row.position}`,
        data: row,
      });
    } else if (table === 'subject-characters') {
      const character = id(row, 'character_id');
      characters.add(character);
      coreCharacters.add(character);
      edges.push({
        from: key('subject', id(row, 'subject_id')),
        to: key('character', character),
        kind: `cast:${row.type}`,
        data: row,
      });
    } else if (table === 'person-characters') {
      const person = id(row, 'person_id'),
        character = id(row, 'character_id');
      persons.add(person);
      corePersons.add(person);
      characters.add(character);
      coreCharacters.add(character);
      edges.push({
        from: key('person', person),
        to: key('character', character),
        kind: 'voice',
        data: row,
      });
    } else {
      const kind =
        row.person_type === 'prsn' ? 'person' : row.person_type === 'crt' ? 'character' : undefined;
      if (!kind) throw new Error(`Unknown Bangumi person_type: ${row.person_type}`);
      const core = kind === 'person' ? corePersons : coreCharacters,
        all = kind === 'person' ? persons : characters;
      if (!core.has(Number(row.person_id)) && !core.has(Number(row.related_person_id))) return;
      if (Number(row.person_id) <= 0 || Number(row.related_person_id) <= 0) {
        sourceAnomalies.push({
          table,
          row,
          reason: 'Upstream relationship has a zero or invalid endpoint.',
        });
        return;
      }
      const from = id(row, 'person_id'),
        to = id(row, 'related_person_id');
      if (!core.has(from) && !core.has(to)) return;
      all.add(from);
      all.add(to);
      edges.push({
        from: key(kind, from),
        to: key(kind, to),
        kind: `person-relation:${row.relation_type}`,
        data: row,
      });
    }
  });
  const records: DatasetRecord[] = [];
  const images: DatasetImage[] = [];
  const subjectIds = new Set([...selected.family, ...selected.references]);
  await scanBangumiArchive(
    path,
    new Set(['subject', 'person', 'character', 'episode']),
    (table, row) => {
      const value = id(row);
      if (table === 'episode') {
        if (!selected.family.has(id(row, 'subject_id'))) return;
        records.push(record('episode', row));
        edges.push({
          from: key('subject', id(row, 'subject_id')),
          to: key('episode', value),
          kind: 'episode',
          data: { sort: row.sort, type: row.type, disc: row.disc },
        });
      } else if (table === 'subject' && subjectIds.has(value))
        records.push(record('subject', row, selected.references.has(value)));
      else if (table === 'person' && persons.has(value))
        records.push(record('person', row, !corePersons.has(value)));
      else if (table === 'character' && characters.has(value))
        records.push(record('character', row, !coreCharacters.has(value)));
    },
  );
  const recordKeys = new Set(records.map((item) => item.key));
  if (recordKeys.size !== records.length) throw new Error('Duplicate Bangumi dataset record');
  const unavailableEntities: { key: string; url: string; reason: string }[] = [];
  const supplements: { key: string; url: string }[] = [];
  const redirects: { from: string; to: string; url: string }[] = [];
  // The upstream export includes links to removed or inaccessible rows. Consult
  // the official API for those IDs only; preserve a tombstone when it also 404s.
  for (const edge of edges)
    for (const endpoint of [edge.from, edge.to]) {
      if (recordKeys.has(endpoint)) continue;
      const [, rawKind, externalId] = endpoint.split(':');
      if (!['subject', 'person', 'character'].includes(rawKind!))
        throw new Error(`Bangumi missing row: ${endpoint}`);
      const kind = rawKind as 'subject' | 'person' | 'character';
      const url = `https://api.bgm.tv/v0/${kind === 'person' ? 'persons' : kind === 'character' ? 'characters' : 'subjects'}/${externalId}`;
      try {
        const row = (await acquisition.json(url)) as Row;
        const canonicalId = id(row),
          canonicalKey = key(kind, canonicalId);
        if (kind === 'character') {
          const captured = acquisition.captures.get(sha256(canonical([url, null])));
          const portrait = bangumiImageCandidate(row, kind, url, captured?.digest);
          if (portrait) images.push(portrait);
        }
        if (canonicalId !== Number(externalId)) {
          // Bangumi transparently redirects merged IDs. Retain the requested
          // identity and the canonical entity without relabeling the source row.
          records.push(
            record(
              kind,
              { id: Number(externalId), name: row.name, redirectTo: canonicalKey },
              true,
            ),
          );
          if (!recordKeys.has(canonicalKey)) {
            records.push(record(kind, row, true));
            recordKeys.add(canonicalKey);
          }
          edges.push({
            from: endpoint,
            to: canonicalKey,
            kind: 'redirect',
            data: { requestedUrl: url },
          });
          redirects.push({ from: endpoint, to: canonicalKey, url });
        } else
          records.push(
            record(
              kind,
              row,
              kind === 'subject'
                ? selected.references.has(Number(externalId))
                : !(kind === 'person' ? corePersons : coreCharacters).has(Number(externalId)),
            ),
          );
        supplements.push({ key: endpoint, url });
      } catch (error) {
        if (!(error instanceof MissingRemote)) throw error;
        const reason =
          'Referenced by archive, absent from its entity table, and official API returned 404 (deleted or inaccessible).';
        unavailableEntities.push({ key: endpoint, url, reason });
        records.push(
          record(
            kind,
            {
              id: Number(externalId),
              name: `Unavailable Bangumi ${kind} ${externalId}`,
              unavailable: true,
              reason,
            },
            true,
          ),
        );
      }
      recordKeys.add(endpoint);
    }
  const tags = new Map<string, DatasetRecord>();
  for (const subject of records.filter(
    (item) => item.kind === 'subject' && item.native !== 'source-only',
  )) {
    for (const field of ['tags', 'meta_tags'] as const) {
      const entries = subject.data[field];
      if (!Array.isArray(entries)) throw new Error(`Bangumi ${subject.key} lacks ${field}`);
      for (const entry of entries) {
        const name =
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object'
              ? (entry as Row).name
              : undefined;
        if (typeof name !== 'string' || !name.trim()) throw new Error(`Invalid Bangumi ${field}`);
        const tagKey = `bangumi:tag:${sha256(name)}`;
        tags.set(tagKey, {
          key: tagKey,
          provider: 'bangumi',
          kind: 'tag',
          externalId: name,
          title: name,
          language: 'und',
          sourceUrl: `https://bgm.tv/subject_search/${encodeURIComponent(name)}?cat=all`,
          data: { name },
          native: 'concept',
        });
        edges.push({
          from: subject.key,
          to: tagKey,
          kind: field === 'tags' ? 'tag' : 'meta-tag',
          data: typeof entry === 'string' ? { name } : (entry as Row),
        });
      }
    }
  }
  records.push(...tags.values());
  // Preserve the official interpretation dictionaries alongside the elected data.
  const constants: Record<string, string> = {};
  for (const name of [
    'subject_relations',
    'person_relations',
    'subject_staffs',
    'subject_platforms',
  ]) {
    const capture = await acquisition.capture(
      `https://raw.githubusercontent.com/bangumi/common/master/${name}.yml`,
    );
    constants[name] = capture.digest;
  }
  console.log(
    `Bangumi: ${selected.family.size} family subjects, ${selected.references.size} reference subjects, ${records.length} records, ${edges.length} relations`,
  );
  return enrichBangumiSubjects(acquisition, {
    provider: 'bangumi',
    roots: Object.values(roots)
      .flat()
      .map((value) => key('subject', value)),
    records,
    edges,
    images,
    scope: {
      archive: latest,
      archiveDigest: archive.digest,
      constants,
      families: roots,
      narrativeSubjectIds: [...selected.narrative],
      familySubjectIds: [...selected.family],
      referenceSubjectIds: [...selected.references],
      surfaces: [
        'full archive subject rows and raw infobox',
        'every archived episode of family subjects',
        'all subject staff/cast/voice relations',
        'incident subject relations with full reference rows',
        'one-hop incident person/character relations',
        'all exported tags and managed tags',
      ],
      frontier: {
        subjects: [...selected.references].map((value) => key('subject', value)),
        persons: [...persons]
          .filter((value) => !corePersons.has(value))
          .map((value) => key('person', value)),
        characters: [...characters]
          .filter((value) => !coreCharacters.has(value))
          .map((value) => key('character', value)),
      },
      selection:
        'Title and alias discovery with explicit spin-off names; recursive book series/volume hierarchy; narrative relations between confirmed family subjects; direct soundtrack closure; unmatched narrative endpoints, shared music, crossovers, compilations and other relations remain full reference records.',
      sourceAnomalies,
      unavailableEntities,
      supplements,
      redirects,
      consistency:
        'Base wiki and relationship rows share one official archive snapshot; dangling endpoint supplements and redirects are captured later through current official API endpoints. Subject cover bytes are captured later by the image snapshot phase.',
      sourceLimitations: [
        'Archive exports only a subset of community tags, as documented upstream.',
        'Comments, reviews, user posts and collection text are not imported; the copyright page leaves them with their authors.',
        'Covers and other images in the archive are not retained; the current public subject API supplies the elected cover candidate separately.',
      ],
    },
  });
}

const animePlatform: Record<string, WorkFormatKey> = {
  '1': 'tv', TV: 'tv',
  '2': 'ova', OVA: 'ova',
  '3': 'movie', '剧场版': 'movie',
  '4': 'special', '短片': 'special',
  '5': 'ona', WEB: 'ona',
};
const bookPlatform: Record<string, WorkFormatKey> = { '1001': 'manga', '漫画': 'manga' };
const statusTags: Record<string, SerialStatus> = {
  '已完结': 'completed', '完结': 'completed',
  '连载中': 'ongoing', '放送中': 'ongoing',
  '停播': 'hiatus', '休止': 'hiatus', '休载': 'hiatus',
  '未放送': 'upcoming', '未发售': 'upcoming', '未开播': 'upcoming',
  '取消': 'cancelled', '腰斩': 'cancelled', '作废': 'cancelled',
};
const formatKeys = new Set<string>(workFormatConcepts.map((item) => item.key));
const integerDatatype = 'http://www.w3.org/2001/XMLSchema#integer';
const dateDatatype = 'http://www.w3.org/2001/XMLSchema#date';
const yearDatatype = 'http://www.w3.org/2001/XMLSchema#gYear';
/** First air or first publication. A later key is read only when every earlier field is blank. */
const publicationDateKeys = ['放送开始', '发售日', '发行日期', '上映年度', '开始'] as const;

/** A captured subject row or a dataset record whose `data` is that row. */
export interface BangumiFactSource {
  externalId?: unknown;
  id?: unknown;
  data?: unknown;
  type?: unknown;
  platform?: unknown;
  eps?: unknown;
  volumes?: unknown;
  infobox?: unknown;
  meta_tags?: unknown;
  api_subject?: unknown;
  /** Archive subject row air or publication date. The API subject's `date` lives on `api_subject`. */
  date?: unknown;
}
export interface BangumiDeclaredCount { notation: 'episode-count' | 'volume-count'; lexical: string }
/** A day or a year. Month precision and unparseable text are absent, not a guessed day. */
export interface BangumiPublicationDate {
  lexical: string;
  datatype: typeof dateDatatype | typeof yearDatatype;
}
export interface BangumiWorkFacts {
  subjectId: string;
  format: WorkFormatKey | null;
  count: BangumiDeclaredCount | null;
  status: SerialStatus | null;
  platforms: GamePlatformKey[];
  date: BangumiPublicationDate | null;
}
export interface BangumiGameFacts {
  subjectId: string;
  platforms: GamePlatformKey[];
  date: BangumiPublicationDate | null;
}
export interface BangumiFactsClient {
  post<T>(path: string, body: object, key: string): Promise<T>;
  put<T>(path: string, body: object, key: string): Promise<T>;
  authorizeDefinition(receipt: { component: string; revision: string }): Promise<void>;
}

/**
 * The scheme cannot say "at most one". The importer admits a single known format
 * and leaves a second, different format or an unknown token refused.
 */
export function admitWorkFormat(current: WorkFormatKey | null, next: string | null): WorkFormatKey | null {
  if (next === null) return current;
  if (!formatKeys.has(next)) throw new Error('unknown work format');
  if (current !== null && current !== next) throw new Error('a Work admits one format');
  return next as WorkFormatKey;
}

/** Official subject type plus platform. A numeric platform without a type is refused
 * rather than guessed. Other subject types stay unclassified even when a platform
 * string looks familiar. One-shot has no Bangumi field. */
function bangumiFormat(type: unknown, platform: unknown): WorkFormatKey | null {
  if (typeof platform !== 'number' && typeof platform !== 'string') return null;
  if (typeof platform === 'number' && typeof type !== 'number') {
    throw new Error('Bangumi numeric platform needs a subject type');
  }
  const token = String(platform);
  if (type === 2) return animePlatform[token] ?? null;
  if (type === 1) return bookPlatform[token] ?? null;
  if (typeof type === 'number') return null;
  if (typeof platform === 'number') return null;
  return animePlatform[token] ?? bookPlatform[token] ?? null;
}

function positiveInteger(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value.trim())) return String(Number(value.trim()));
  return null;
}

/** `|话数=` and `|册数=` only. Edition notes such as `[册数|6卷既刊]` are not the declared count. */
function infoboxCount(infobox: unknown, key: '话数' | '册数'): string | null {
  if (typeof infobox === 'string') {
    const match = infobox.match(new RegExp(`\\|${key}=([^\\r\\n]*)`));
    return match ? positiveInteger(match[1]) : null;
  }
  if (!Array.isArray(infobox)) return null;
  const row = infobox.find((item) => !!item && typeof item === 'object' && (item as Row).key === key) as
    | Row
    | undefined;
  return row ? positiveInteger(row.value) : null;
}

function tagName(tag: unknown): string | null {
  if (typeof tag === 'string') return tag;
  if (tag && typeof tag === 'object' && typeof (tag as Row).name === 'string') return (tag as Row).name as string;
  return null;
}

/** Exact meta-tag match. `完结` is not read out of `已完结`. Two different statuses are unknown. */
function statusFromTags(tags: unknown): SerialStatus | null {
  if (!Array.isArray(tags)) return null;
  const found = new Set<SerialStatus>();
  for (const tag of tags) {
    const name = tagName(tag);
    const status = name ? statusTags[name] : undefined;
    if (status) found.add(status);
  }
  return found.size === 1 ? [...found][0]! : null;
}

function subjectRow(record: BangumiFactSource): Row {
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && ('type' in data || 'platform' in data)) {
    return data as Row;
  }
  return record as Row;
}

function textField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Top-level `|key=` or an infobox array entry. Edition notes such as `[发售日|…]` are not this field. */
function infoboxField(infobox: unknown, key: string): string | null {
  if (typeof infobox === 'string') {
    const match = infobox.match(new RegExp(`\\|${key}=([^\\r\\n]*)`));
    return match ? textField(match[1]) : null;
  }
  if (!Array.isArray(infobox)) return null;
  const row = infobox.find((item) => !!item && typeof item === 'object' && (item as Row).key === key) as
    | Row
    | undefined;
  if (!row) return null;
  return textField(row.value);
}

function infoboxValues(infobox: unknown, key: string): unknown[] {
  if (typeof infobox === 'string') {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\r?\\n)\\|${escaped}\\s*=([\\s\\S]*?)(?=\\r?\\n\\||$)`, 'g');
    return [...infobox.matchAll(pattern)].map(match => match[1] ?? '');
  }
  if (!Array.isArray(infobox)) return [];
  return infobox.filter(item => !!item && typeof item === 'object' && !Array.isArray(item)
    && (item as Row).key === key).map(item => (item as Row).value);
}

function sourceTextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(sourceTextValues);
  if (!value || typeof value !== 'object') return [];
  const row = value as Row;
  if (typeof row.v === 'string') return [row.v];
  if (typeof row.value === 'string') return [row.value];
  return [];
}

function gamePlatformTokens(infobox: unknown): string[] {
  const found: string[] = [];
  for (const value of infoboxValues(infobox, '平台')) {
    for (const raw of sourceTextValues(value)) {
      const cleaned = raw.trim().replace(/^\{([\s\S]*)\}$/, '$1');
      found.push(...cleaned.split(/\r?\n|<br\s*\/?\s*>|[、，,;；]/i)
        .map(token => token.trim().replace(/^\[|\]$/g, '').trim()).filter(Boolean));
    }
  }
  return found;
}

function gameDateCandidates(value: unknown): BangumiPublicationDate[] {
  const dates: BangumiPublicationDate[] = [];
  for (const raw of sourceTextValues(value)) {
    const dayPattern = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)|(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})日(?!\d)/g;
    const consumed: { start: number; end: number }[] = [];
    for (const match of raw.matchAll(dayPattern)) {
      consumed.push({ start: match.index!, end: match.index! + match[0].length });
      const lexical = match[1]
        ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`
        : `${match[4]}-${match[5]!.padStart(2, '0')}-${match[6]!.padStart(2, '0')}`;
      const parsed = daysOrYear(lexical, 'day', dateDatatype);
      if (parsed) dates.push(parsed);
    }
    let remainder = raw;
    for (const range of [...consumed].reverse()) {
      remainder = `${remainder.slice(0, range.start)}${' '.repeat(range.end - range.start)}${remainder.slice(range.end)}`;
    }
    const yearPattern = /(?<!\d)(\d{4})年(?!\d{1,2}月)|(?<!\d)(\d{4})(?![-/.]\d|年)/g;
    for (const match of remainder.matchAll(yearPattern)) {
      const parsed = daysOrYear(match[1] ?? match[2]!, 'year', yearDatatype);
      if (parsed) dates.push(parsed);
    }
  }
  return dates;
}

function earliestGameReleaseDate(candidates: readonly BangumiPublicationDate[]): BangumiPublicationDate | null {
  if (!candidates.length) return null;
  const unique = [...new Map(candidates.map(date => [`${date.datatype}:${date.lexical}`, date])).values()];
  const year = Math.min(...unique.map(date => Number(date.lexical.slice(0, 4))));
  const inEarliestYear = unique.filter(date => Number(date.lexical.slice(0, 4)) === year);
  const yearOnly = inEarliestYear.find(date => date.datatype === yearDatatype);
  if (yearOnly) return yearOnly;
  return inEarliestYear.sort((left, right) => left.lexical.localeCompare(right.lexical))[0] ?? null;
}

function daysOrYear(lexical: string, precision: 'day' | 'year',
  datatype: BangumiPublicationDate['datatype']): BangumiPublicationDate | null {
  try { temporalParts(lexical, precision); }
  catch (error) {
    if (error instanceof InvalidSemanticValue) return null;
    throw error;
  }
  return { lexical, datatype };
}

/**
 * `YYYY-MM-DD` or `YYYY年M月D日` is a day. `YYYY` or `YYYY年` is a year.
 * A month, a range, or any other text is not a date.
 */
function publicationDate(raw: string): BangumiPublicationDate | null {
  const value = raw.trim();
  const chineseDay = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
  if (chineseDay) {
    return daysOrYear(`${chineseDay[1]}-${chineseDay[2]!.padStart(2, '0')}-${chineseDay[3]!.padStart(2, '0')}`,
      'day', dateDatatype);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return daysOrYear(value, 'day', dateDatatype);
  const chineseYear = /^(\d{4})年$/.exec(value);
  if (chineseYear) return daysOrYear(chineseYear[1]!, 'year', yearDatatype);
  if (/^\d{4}$/.test(value)) return daysOrYear(value, 'year', yearDatatype);
  return null;
}

/**
 * The first non-blank candidate wins. A blank field is absent and the next
 * candidate is read. A present value that is not exactly a day or a year
 * states nothing: a later field must not supply a day this one withheld.
 */
function firstPublicationDate(candidates: readonly (string | null)[]): BangumiPublicationDate | null {
  for (const candidate of candidates) {
    if (candidate === null) continue;
    return publicationDate(candidate);
  }
  return null;
}

function subjectId(record: BangumiFactSource, data: Row): string {
  for (const value of [record.externalId, data.id, record.id]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  }
  throw new Error('Bangumi subject id is missing');
}

/**
 * Format, declared count, completion and first publication for one subject.
 * The date is the API subject's `date`, then the archive row `date`, then the
 * infobox keys in `publicationDateKeys`. The infobox is the API box when that
 * subject sent one, otherwise the archive box, as for the declared count.
 * An unclassified subject has no count. Anime counts episodes; manga counts volumes.
 */
export function bangumiWorkFacts(record: BangumiFactSource): BangumiWorkFacts {
  const data = subjectRow(record);
  const api = data.api_subject;
  const apiRow = api && typeof api === 'object' && !Array.isArray(api) ? api as Row : null;
  if (data.type === 4 || apiRow?.type === 4) {
    const game = bangumiGameFacts(record);
    return { subjectId: game.subjectId, format: null, count: null, status: null,
      platforms: game.platforms, date: game.date };
  }
  const archiveFormat = bangumiFormat(data.type, data.platform);
  let format = archiveFormat;
  if (apiRow && apiRow.platform !== undefined && apiRow.platform !== null) {
    const apiFormat = bangumiFormat(apiRow.type ?? data.type, apiRow.platform);
    if (apiFormat !== archiveFormat) throw new Error('Bangumi archive and API disagree on format');
    format = apiFormat;
  }
  const archiveStatus = statusFromTags(data.meta_tags);
  const apiStatus = apiRow ? statusFromTags(apiRow.meta_tags) : null;
  const status = archiveStatus && apiStatus && archiveStatus !== apiStatus ? null : apiStatus ?? archiveStatus;
  const chosen = format;
  const notation = chosen
    ? declaredCountProperties.find((item) => (item.formats as readonly WorkFormatKey[]).includes(chosen))?.notation
    : undefined;
  let count: BangumiDeclaredCount | null = null;
  if (chosen && notation) {
    const field = notation === 'episode-count' ? 'eps' : 'volumes';
    const boxKey = notation === 'episode-count' ? '话数' : '册数';
    const box = apiRow && (typeof apiRow.infobox === 'string' || Array.isArray(apiRow.infobox))
      ? apiRow.infobox : data.infobox;
    const lexical = (apiRow ? positiveInteger(apiRow[field]) : null)
      ?? positiveInteger(data[field]) ?? infoboxCount(box, boxKey);
    if (lexical) count = { notation, lexical };
  }
  const box = apiRow && (typeof apiRow.infobox === 'string' || Array.isArray(apiRow.infobox))
    ? apiRow.infobox : data.infobox;
  const date = firstPublicationDate([
    apiRow ? textField(apiRow.date) : null,
    textField(data.date),
    ...publicationDateKeys.map((key) => infoboxField(box, key)),
  ]);
  return { subjectId: subjectId(record, data), format, count, status, platforms: [], date };
}

/** Game hardware comes only from explicit platform values; an unknown token is never inferred. */
export function bangumiGameFacts(record: BangumiFactSource): BangumiGameFacts {
  const data = subjectRow(record);
  const api = data.api_subject;
  const apiRow = api && typeof api === 'object' && !Array.isArray(api) ? api as Row : null;
  if (data.type !== 4 && apiRow?.type !== 4) throw new Error('Bangumi subject is not a game');
  const apiInfobox = apiRow && (typeof apiRow.infobox === 'string' || Array.isArray(apiRow.infobox))
    ? apiRow.infobox : null;
  const archiveInfobox = data.infobox;
  const apiHasPlatform = apiInfobox !== null && infoboxValues(apiInfobox, '平台').length > 0;
  const platformSource = apiHasPlatform ? apiInfobox : archiveInfobox;
  const platformKeys = new Map<string, GamePlatformKey>(gamePlatformConcepts.map(item => [item.token, item.key]));
  const platforms = [...new Set(gamePlatformTokens(platformSource)
    .map(token => platformKeys.get(token)).filter((key): key is GamePlatformKey => key !== undefined))];
  const dates = [
    ...gameDateCandidates(apiRow?.date),
    ...gameDateCandidates(data.date),
    ...gameDateCandidates(infoboxValues(apiInfobox, '发行日期')),
    ...gameDateCandidates(infoboxValues(apiInfobox, '发售日')),
    ...gameDateCandidates(infoboxValues(archiveInfobox, '发行日期')),
    ...gameDateCandidates(infoboxValues(archiveInfobox, '发售日')),
  ];
  return { subjectId: subjectId(record, data), platforms, date: earliestGameReleaseDate(dates) };
}

/**
 * Write one subject's facts through the public API: one classified format on the
 * Main version, one integer count on the Work, the first publication date when
 * the subject has one, and completion when a tag maps. Each statement's evidence
 * is the subject page. Keys stay fixed so a replay writes the same scheme the
 * bootstrap seed created.
 */
export async function importBangumiWorkFacts(client: BangumiFactsClient, actingSubject: string,
  work: { work: string; mainVersion: string }, record: BangumiFactSource): Promise<{
  facts: BangumiWorkFacts; concept: string | null; countPredicate: string | null;
  platformConcepts: Partial<Record<GamePlatformKey, string>>; datePredicate: string | null;
}> {
  const data = subjectRow(record);
  const api = data.api_subject;
  const apiRow = api && typeof api === 'object' && !Array.isArray(api) ? api as Row : null;
  if (data.type === 4 || apiRow?.type === 4) {
    const imported = await importBangumiGameFacts(client, actingSubject, work, record);
    return { facts: bangumiWorkFacts(record), concept: null, countPredicate: null,
      platformConcepts: imported.concepts, datePredicate: imported.datePredicate };
  }
  const { seedWorkFormat } = await import('../dev/seed/relation-lexicon.ts');
  const helpers = await import('../dev/seed/classified-statement.ts');
  const facts = bangumiWorkFacts(record);
  const format = admitWorkFormat(null, facts.format);
  const seeded = await seedWorkFormat(client, actingSubject);
  const post: <T>(path: string, body: unknown, token: string, key: string) => Promise<T> =
    (path, body, _token, key) => client.post(path, body as object, key);
  const context = await helpers.shareClassificationContext(
    post, '', actingSubject,
    workFormatConcepts.map((item) => seeded.concepts[item.key]), 'work-format:v1:context');
  // An unknown spoiler hint hides the concept from search. A format is not a spoiler.
  for (const item of workFormatConcepts) {
    await helpers.discloseClassificationConcept(post, '', actingSubject, seeded.concepts[item.key].concept,
      `work-format:v1:hint:${item.key}`);
  }
  const prefix = `work-format:v1:${work.work.slice(-36)}:${facts.subjectId}`;
  const evidence = bangumiStatementEvidence('subject', facts.subjectId);
  let concept: string | null = null;
  if (format) {
    concept = seeded.concepts[format].concept;
    const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements',
      { ...helpers.classifiedStatementBody(actingSubject, work.mainVersion, concept, context), evidence },
      `${prefix}:format`);
    await client.post('/v1/statement-decisions', helpers.statementDecisionBody(
      actingSubject, statement, { kind: 'global' }, 'accepted', null), `${prefix}:format-decision`);
  }
  let countPredicate: string | null = null;
  if (facts.count) {
    const definition = seeded.counts[facts.count.notation];
    countPredicate = definition.component;
    const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
      predicate: definition.component, relationDefinition: definition.revision,
      value: { kind: 'literal', lexical: facts.count.lexical, datatype: integerDatatype, language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence, actingSubject,
    }, `${prefix}:${facts.count.notation}`);
    await client.post('/v1/statement-decisions', helpers.statementDecisionBody(
      actingSubject, statement, { kind: 'global' }, 'accepted', null),
    `${prefix}:${facts.count.notation}:decision`);
  }
  let datePredicate: string | null = null;
  if (facts.date) {
    const definition = seeded.firstPublication;
    datePredicate = DATE_PUBLISHED_PREDICATE;
    const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
      predicate: definition.component, relationDefinition: definition.revision,
      value: { kind: 'literal', lexical: facts.date.lexical, datatype: facts.date.datatype, language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence, actingSubject,
    }, `${prefix}:first-publication-date`);
    // The year template joins a Statement target. A qualified-fact decision,
    // which is what a count uses, does not name this statement.
    await client.post('/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject,
    }, `${prefix}:first-publication-date:decision`);
  }
  if (facts.status) {
    await client.put(`/v1/works/${work.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject,
      state: { kind: 'header', originalTitle: null, completionStatus: facts.status, localized: [] },
    }, `${prefix}:status`);
  }
  return { facts, concept, countPredicate, platformConcepts: {}, datePredicate };
}

/** Write a game's known hardware platforms as accepted Concepts and its single earliest publication date. */
export async function importBangumiGameFacts(client: BangumiFactsClient, actingSubject: string,
  work: { work: string; mainVersion: string }, record: BangumiFactSource): Promise<{
  facts: BangumiGameFacts; concepts: Partial<Record<GamePlatformKey, string>>; datePredicate: string | null;
}> {
  const { seedGamePlatforms, seedFirstPublicationDate } = await import('../dev/seed/relation-lexicon.ts');
  const helpers = await import('../dev/seed/classified-statement.ts');
  const facts = bangumiGameFacts(record);
  const prefix = `game-platform:v1:${work.work.slice(-36)}:${facts.subjectId}`;
  const evidence = bangumiStatementEvidence('subject', facts.subjectId);
  const concepts: Partial<Record<GamePlatformKey, string>> = {};
  if (facts.platforms.length) {
    const seeded = await seedGamePlatforms(client, actingSubject);
    for (const platform of gamePlatformConcepts) {
      concepts[platform.key] = seeded.concepts[platform.key].concept;
    }
    const post: <T>(path: string, body: unknown, token: string, key: string) => Promise<T> =
      (path, body, _token, key) => client.post(path, body as object, key);
    const context = await helpers.shareClassificationContext(post, '', actingSubject,
      gamePlatformConcepts.map(platform => seeded.concepts[platform.key]), 'game-platform:v1:context');
    for (const platform of gamePlatformConcepts) {
      await helpers.discloseClassificationConcept(post, '', actingSubject, seeded.concepts[platform.key].concept,
        `game-platform:v1:hint:${platform.key}`);
    }
    for (const key of facts.platforms) {
      const concept = seeded.concepts[key].concept;
      const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements', {
        ...helpers.classifiedStatementBody(actingSubject, work.mainVersion, concept, context), evidence,
      }, `${prefix}:platform:${key}`);
      await client.post('/v1/statement-decisions', helpers.statementDecisionBody(
        actingSubject, statement, { kind: 'global' }, 'accepted', null), `${prefix}:platform:${key}:decision`);
    }
  }
  let datePredicate: string | null = null;
  if (facts.date) {
    const definition = await seedFirstPublicationDate(client, actingSubject);
    datePredicate = DATE_PUBLISHED_PREDICATE;
    const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
      predicate: definition.component, relationDefinition: definition.revision,
      value: { kind: 'literal', lexical: facts.date.lexical, datatype: facts.date.datatype, language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence, actingSubject,
    }, `${prefix}:first-publication-date`);
    await client.post('/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject,
    }, `${prefix}:first-publication-date:decision`);
  }
  return { facts, concepts, datePredicate };
}
