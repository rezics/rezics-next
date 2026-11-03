import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import {
  encodedBytes,
  emptyVisit,
  FILE_VISIT_CAPS,
  fileGroups,
  fileStreams,
  fileUuid,
  historicalStatement,
  isCatalogueFileType,
  isFileOrGroupType,
  recordComponent,
  relatedReadable,
  relatedTarget,
  RELEASE_ASSOCIATION_LIMIT,
  selectedStatements,
  type FileStream,
  type VisitWork,
} from './model';
import { fileProfileReleased } from '../release-fidelity/model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type InversePage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Statement = SubjectRead['subject']['statements'][string][number];

export type FileRow = {
  holder: string;
  statementId: string;
  statement?: Statement;
  summary: ForwardPage['relations'][number]['summary'];
  related: SubjectRead['related'];
  readability: 'readable' | 'concealed' | 'unreadable';
  historical: boolean;
};

export type FileFact = {
  property: string;
  label: { text: string; lang: string | null };
  statements: Statement[];
};

export type CatalogueFileRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      release: Release;
      digest: string;
      profile: 'file' | 'group' | 'unreleased';
      groups: ReturnType<typeof fileGroups>;
      facts: Record<string, FileFact[]>;
      sources: SubjectRead['subject']['sourceRecords'];
      streams: FileStream[];
      stream?: FileStream;
      rows: FileRow[];
      next: string | null;
      count?: ForwardPage['count'];
      detail?: SubjectRead;
      visit: VisitWork;
      session?: string;
    };

export type FileReadQuery = {
  id: string;
  locale: string;
  stream?: string | undefined;
  cursor?: string | undefined;
  detail?: string | undefined;
  session?: string | undefined;
};

function relatedMap(values: ForwardPage['relations'][number]['related']): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, summary]) => [
      key,
      {
        type: summary.type,
        labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
      },
    ]),
  );
}

function factRows(read: SubjectRead, release: Release, properties: string[], locale: string): FileFact[] {
  return properties.flatMap((property) => {
    const statements = selectedStatements(read.subject.statements[property]);
    if (!statements.length) return [];
    return [{ property, label: pickText(release.properties[property]?.labels ?? {}, locale), statements }];
  });
}

function listedOnPage(rows: FileRow[], detail: string, current: string): boolean {
  if (detail === current) return false;
  return rows.some((row) => {
    if (row.holder === detail) return true;
    if (row.statement && relatedTarget(row.statement) === detail) return true;
    if (row.summary?.id === detail) return true;
    return Object.hasOwn(row.related, detail);
  });
}

function pageRows(
  id: string,
  digest: string,
  page: ForwardPage | InversePage,
  direction: 'forward' | 'inverse',
): FileRow[] {
  if (direction === 'forward' && 'relations' in page) {
    return page.relations.map((row) => {
      const related = relatedMap(row.related);
      const target = relatedTarget(row.statement as Statement);
      return {
        holder: id,
        statementId: row.statement.id,
        statement: row.statement as Statement,
        summary: row.summary,
        related,
        readability: target ? relatedReadable(related, target) : 'unreadable',
        historical: historicalStatement(row.statement as Statement, digest),
      };
    });
  }
  if (direction === 'inverse' && 'links' in page) {
    return page.links.map((row) => {
      const related = relatedMap(row.related);
      return {
        holder: row.subject,
        statementId: row.statement,
        ...(row.assertion ? { statement: row.assertion as Statement } : {}),
        summary: row.summary,
        related,
        readability: relatedReadable(related, row.subject),
        historical: row.assertion ? historicalStatement(row.assertion as Statement, digest) : false,
      };
    });
  }
  return [];
}

export async function readCatalogueFileProfile(
  client: KernelClient,
  authorization: string,
  query: FileReadQuery,
): Promise<CatalogueFileRead> {
  if (!fileUuid.test(query.id) || (query.detail && !fileUuid.test(query.detail)))
    return { ok: false, reason: 'invalid' };
  if (query.cursor && !query.stream) return { ok: false, reason: 'invalid' };
  const headers = { authorization, ...(query.session ? { 'rezics-session-token': query.session } : {}) };
  let visit = emptyVisit();
  try {
    const subject = await client.subjects({ id: query.id }).get({ headers });
    if (subject.status !== 200 || !subject.data) return candidateFailure(subject.status);
    if (subject.data.subject.id !== query.id || subject.data.subject.context !== candidateContext)
      return { ok: false, reason: 'stale' };
    const digest = subject.data.subject.release;
    const bundle = await client.definitions.releases({ digest }).get({ headers });
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== digest) return candidateFailure(bundle.status);
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    visit = recordComponent(visit, {
      id: 'descriptor',
      calls: 1,
      rows: Object.keys(release.types).length,
      bytes: encodedBytes(release),
      rowCap: FILE_VISIT_CAPS.descriptor.rows,
      byteCap: FILE_VISIT_CAPS.descriptor.bytes,
    });
    visit = recordComponent(visit, {
      id: 'subject',
      calls: 1,
      rows: Object.keys(subject.data.subject.statements).length,
      bytes: encodedBytes(subject.data),
      rowCap: FILE_VISIT_CAPS.subject.rows,
      byteCap: FILE_VISIT_CAPS.subject.bytes,
    });
    if (!fileProfileReleased(release) || !isFileOrGroupType(release, subject.data.subject.type)) {
      visit = recordComponent(visit, {
        id: 'association',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: FILE_VISIT_CAPS.association.rows,
        byteCap: FILE_VISIT_CAPS.association.bytes,
      });
      visit = recordComponent(visit, {
        id: 'detail',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: FILE_VISIT_CAPS.detail.rows,
        byteCap: FILE_VISIT_CAPS.detail.bytes,
      });
      return {
        ok: true,
        public: subject.data,
        release,
        digest,
        profile: 'unreleased',
        groups: fileGroups(release, subject.data.subject.type),
        facts: {},
        sources: subject.data.subject.sourceRecords,
        streams: [],
        rows: [],
        next: null,
        visit,
      };
    }
    const groups = fileGroups(release, subject.data.subject.type);
    const streams = fileStreams(release, subject.data.subject.type, query.locale);
    const stream = query.stream ? streams.find((item) => item.key === query.stream) : streams[0];
    if (query.stream && !stream) return { ok: false, reason: 'invalid' };
    let rows: FileRow[] = [];
    let next: string | null = null;
    let count: ForwardPage['count'] | undefined;
    let session: string | undefined;
    if (stream) {
      const pageQuery = {
        property: stream.property,
        context: candidateContext,
        language: query.locale,
        limit: RELEASE_ASSOCIATION_LIMIT,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      };
      const result =
        stream.direction === 'forward'
          ? await client.subjects({ id: query.id }).relations.get({ query: pageQuery, headers })
          : await client.subjects({ id: query.id }).links.get({ query: pageQuery, headers });
      if (result.status !== 200 || !result.data) return candidateFailure(result.status);
      const page = result.data;
      rows = pageRows(query.id, digest, page, stream.direction);
      next = page.next;
      if ('count' in page && page.count) count = page.count;
      session = new Headers(result.headers).get('rezics-session-token') ?? undefined;
      visit = recordComponent(visit, {
        id: 'association',
        calls: 1,
        rows: rows.length,
        bytes: encodedBytes(page),
        rowCap: FILE_VISIT_CAPS.association.rows,
        byteCap: FILE_VISIT_CAPS.association.bytes,
      });
    } else {
      visit = recordComponent(visit, {
        id: 'association',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: FILE_VISIT_CAPS.association.rows,
        byteCap: FILE_VISIT_CAPS.association.bytes,
      });
    }
    let detail: SubjectRead | undefined;
    if (query.detail) {
      const listed = listedOnPage(rows, query.detail, query.id);
      if (!listed) return { ok: false, reason: 'invalid' };
      const selected = await client.subjects({ id: query.detail }).get({ headers });
      visit = recordComponent(visit, {
        id: 'detail',
        calls: 1,
        rows: selected.status === 200 && selected.data ? 1 : 0,
        bytes: selected.data ? encodedBytes(selected.data) : 0,
        rowCap: FILE_VISIT_CAPS.detail.rows,
        byteCap: FILE_VISIT_CAPS.detail.bytes,
      });
      if (selected.status === 200 && selected.data) {
        if (selected.data.subject.id !== query.detail) return { ok: false, reason: 'stale' };
        detail = selected.data;
      }
    } else {
      visit = recordComponent(visit, {
        id: 'detail',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: FILE_VISIT_CAPS.detail.rows,
        byteCap: FILE_VISIT_CAPS.detail.bytes,
      });
    }
    return {
      ok: true,
      public: subject.data,
      release,
      digest,
      profile: isFileOrGroupType(release, subject.data.subject.type)
        ? isCatalogueFileType(release, subject.data.subject.type)
          ? 'file'
          : 'group'
        : 'unreleased',
      groups,
      facts: {
        identifiers: factRows(subject.data, release, groups.identifiers, query.locale),
        technical: factRows(subject.data, release, groups.technical, query.locale),
        language: factRows(subject.data, release, groups.language, query.locale),
        group: factRows(subject.data, release, groups.group, query.locale),
        credits: factRows(subject.data, release, groups.credits, query.locale),
        facts: factRows(subject.data, release, groups.facts, query.locale),
      },
      sources: subject.data.subject.sourceRecords,
      streams,
      ...(stream ? { stream } : {}),
      rows,
      next,
      ...(count ? { count } : {}),
      ...(detail ? { detail } : {}),
      visit,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
