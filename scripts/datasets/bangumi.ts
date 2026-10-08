import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Unzip, UnzipInflate, type AsyncFlateStreamHandler } from 'fflate';
import { declaredCountProperties, workFormatConcepts, type WorkFormatKey }
  from '../dev/seed/relation-lexicon-data.ts';
import type { SerialStatus } from '../../services/main/src/modules/work/metadata-schema.ts';
import { MissingRemote, type Acquisition } from './network.ts';
import { blobPath, canonical, sha256 } from './store.ts';
import type { DatasetEdge, DatasetRecord, DatasetSource } from './types.ts';

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
    data: row,
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
 * subject's current public API response to retain all API-exposed tags and
 * image variants while preserving the exact original archive fields. This
 * accepts an already captured source so resumptions need not rescan the dump. */
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
  const images = source.images.map((image) => ({ ...image }));
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
    subject.data.api_subject = row;
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
    const apiImages = row.images;
    if (apiImages && typeof apiImages === 'object' && !Array.isArray(apiImages)) {
      const entries = Object.entries(apiImages as Row).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1],
      );
      for (const [, imageUrl] of entries)
        if (!imageUrl.startsWith('https://'))
          throw new Error(`Bangumi API returned a non-HTTPS image: ${imageUrl}`);
      const primary =
        entries.find(([variant]) => variant === 'large') ??
        entries.find(([variant]) => variant === 'common') ??
        entries[0];
      if (primary) {
        const coverIndex = images.findIndex(
          (image) => image.record === subjectKey && image.role === 'cover',
        );
        const cover = { record: subjectKey, role: 'cover', url: primary[1] };
        if (coverIndex < 0) images.push(cover);
        else images[coverIndex] = cover;
        for (const [variant, imageUrl] of entries) {
          if (imageUrl === primary[1]) continue;
          const image = { record: subjectKey, role: `image-variant:${variant}`, url: imageUrl };
          if (
            !images.some(
              (prior) =>
                prior.record === image.record &&
                prior.role === image.role &&
                prior.url === image.url,
            )
          )
            images.push(image);
        }
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
    images,
    scope: {
      ...source.scope,
      surfaces: [
        ...new Set([
          ...(Array.isArray(source.scope.surfaces) ? (source.scope.surfaces as string[]) : []),
          'complete public v0 subject JSON for every elected family subject',
          'all API-exposed tags, counts and image variants',
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
          'Every public v0 subject response is retained exactly in data.api_subject; every API-exposed community tag, its full counts, managed tags and image variants are represented.',
        tagCoverage:
          'Union of archive tags and every tag exposed by the official subject API. API exposure is not a claim to unexposed private or deleted tag assignments.',
      },
      sourceLimitations: [
        ...sourceLimitations.filter(
          (item) => !item.startsWith('Archive exports only a subset of community tags'),
        ),
        'Archive community tag subsets are supplemented with all tags exposed by the official subject API; tags unexposed by both sources remain outside observable coverage.',
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
  const images = records
    .filter(
      (item) => ['subject', 'person', 'character'].includes(item.kind) && !item.data.unavailable,
    )
    .map((item) => ({
      record: item.key,
      role: item.kind === 'subject' ? 'cover' : 'portrait',
      url: `https://api.bgm.tv/v0/${item.kind === 'person' ? 'persons' : item.kind === 'character' ? 'characters' : 'subjects'}/${item.externalId}/image?type=large`,
    }));
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
        'large image endpoints',
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
        'Base wiki and relationship rows share one official archive snapshot; dangling endpoint supplements, redirects and image bytes are captured later through current official API endpoints.',
      sourceLimitations: [
        'Archive exports only a subset of community tags, as documented upstream.',
        'Comments, reviews, user collections and deleted/private content are outside the elected public wiki dataset.',
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
}
export interface BangumiDeclaredCount { notation: 'episode-count' | 'volume-count'; lexical: string }
export interface BangumiWorkFacts {
  subjectId: string;
  format: WorkFormatKey | null;
  count: BangumiDeclaredCount | null;
  status: SerialStatus | null;
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

function subjectId(record: BangumiFactSource, data: Row): string {
  for (const value of [record.externalId, data.id, record.id]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  }
  throw new Error('Bangumi subject id is missing');
}

/**
 * Format, declared count and completion for one subject. Year and season are not
 * stored; they are read from the first-publication date. An unclassified subject
 * has no count. Anime counts episodes; manga counts volumes.
 */
export function bangumiWorkFacts(record: BangumiFactSource): BangumiWorkFacts {
  const data = subjectRow(record);
  const archiveFormat = bangumiFormat(data.type, data.platform);
  const api = data.api_subject;
  const apiRow = api && typeof api === 'object' && !Array.isArray(api) ? api as Row : null;
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
  return { subjectId: subjectId(record, data), format, count, status };
}

/**
 * Write one subject's facts through the public API: one classified format on the
 * Main version, one integer count on the Work, and completion when a tag maps.
 * Keys stay fixed so a replay writes the same scheme the bootstrap seed created.
 */
export async function importBangumiWorkFacts(client: BangumiFactsClient, actingSubject: string,
  work: { work: string; mainVersion: string }, record: BangumiFactSource): Promise<{
  facts: BangumiWorkFacts; concept: string | null; countPredicate: string | null;
}> {
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
  let concept: string | null = null;
  if (format) {
    concept = seeded.concepts[format].concept;
    const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements',
      helpers.classifiedStatementBody(actingSubject, work.mainVersion, concept, context), `${prefix}:format`);
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
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject,
    }, `${prefix}:${facts.count.notation}`);
    await client.post('/v1/statement-decisions', helpers.statementDecisionBody(
      actingSubject, statement, { kind: 'global' }, 'accepted', null),
    `${prefix}:${facts.count.notation}:decision`);
  }
  if (facts.status) {
    await client.put(`/v1/works/${work.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject,
      state: { kind: 'header', originalTitle: null, completionStatus: facts.status, localized: [] },
    }, `${prefix}:status`);
  }
  return { facts, concept, countPredicate };
}
