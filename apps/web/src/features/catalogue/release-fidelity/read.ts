import { releaseVisit, type ReleaseVisit } from './navigation';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import {
  encodedBytes,
  admitVisitComponent,
  emptyVisit,
  historicalStatement,
  isReleaseType,
  recordComponent,
  relatedReadable,
  relatedTarget,
  RELEASE_ASSOCIATION_LIMIT,
  RELEASE_VISIT_CAPS,
  releaseGroups,
  releaseStreams,
  releaseUuid,
  dateReading,
  regionProperty,
  selectedStatements,
  statusProperty,
  unknownProvenance,
  workCompletenessQualifier,
  WORK_PROPERTY,
  type DateReading,
  type ReleaseStream,
  type VisitWork,
} from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type InversePage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Statement = SubjectRead['subject']['statements'][string][number];

export type ReleaseRow = {
  holder: string;
  statementId: string;
  statement?: Statement;
  summary: ForwardPage['relations'][number]['summary'];
  related: SubjectRead['related'];
  readability: 'readable' | 'concealed' | 'unreadable';
  provenance: string[];
  historical: boolean;
};

export type ReleaseFact = {
  property: string;
  label: { text: string; lang: string | null };
  statements: Statement[];
};

export type WorkIdentity = {
  id?: string;
  label?: { text: string; lang: string | null };
  readability: 'readable' | 'concealed' | 'unreadable' | 'absent';
  historical: boolean;
  completeness?: { id: string; label?: { text: string; lang: string | null }; historical: boolean };
};

export type ReleaseFidelityRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      release: Release;
      digest: string;
      groups: ReturnType<typeof releaseGroups>;
      work: WorkIdentity;
      date: DateReading;
      statusProperty?: string;
      regionProperty?: string;
      facts: Record<string, ReleaseFact[]>;
      sources: SubjectRead['subject']['sourceRecords'];
      streams: ReleaseStream[];
      stream?: ReleaseStream;
      streamState: 'complete' | 'empty' | 'withheld' | 'unsupported' | 'unavailable' | 'denied';
      rows: ReleaseRow[];
      next: string | null;
      count?: ForwardPage['count'];
      detail?: SubjectRead;
      visit: VisitWork;
      session?: string;
      returned?: 'restored' | 'changed';
    };

export type ReleaseReadQuery = {
  id: string;
  context?: string | undefined;
  locale: string;
  stream?: string | undefined;
  cursor?: string | undefined;
  detail?: string | undefined;
  session?: string | undefined;
  returning?: ReleaseVisit | undefined;
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

function workIdentity(read: SubjectRead, locale: string, digest: string): WorkIdentity {
  const selected = selectedStatements(read.subject.statements[WORK_PROPERTY]);
  if (!selected.length) return { readability: 'absent', historical: false };
  const statement = selected[0]!;
  const id = relatedTarget(statement);
  const historical = historicalStatement(statement, digest);
  const completenessPart = workCompletenessQualifier(statement);
  const completenessId =
    completenessPart && completenessPart.value.type === 'value' && typeof completenessPart.value.content === 'string'
      ? completenessPart.value.content
      : undefined;
  const completeness =
    completenessId === undefined
      ? undefined
      : {
          id: completenessId,
          historical,
          ...(relatedReadable(read.related, completenessId) === 'readable'
            ? { label: pickText(read.related[completenessId]?.labels ?? {}, locale) }
            : {}),
        };
  if (!id) return { readability: 'unreadable', historical, ...(completeness ? { completeness } : {}) };
  const readability = relatedReadable(read.related, id);
  const labels = read.related[id]?.labels ?? {};
  const label = pickText(labels, locale);
  return {
    id,
    readability: readability === 'readable' && !label.text.trim() ? 'unreadable' : readability,
    historical,
    ...(readability === 'readable' ? { label: pickText(labels, locale) } : {}),
    ...(completeness ? { completeness } : {}),
  };
}

function factRows(read: SubjectRead, release: Release, properties: string[], locale: string): ReleaseFact[] {
  return properties.flatMap((property) => {
    const statements = selectedStatements(read.subject.statements[property]);
    if (!statements.length) return [];
    return [{ property, label: pickText(release.properties[property]?.labels ?? {}, locale), statements }];
  });
}

function listedOnPage(rows: ReleaseRow[], detail: string, current: string): boolean {
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
): ReleaseRow[] {
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
        provenance: unknownProvenance(row.statement as Statement),
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
        provenance: row.assertion ? unknownProvenance(row.assertion as Statement) : [],
        historical: row.assertion ? historicalStatement(row.assertion as Statement, digest) : false,
      };
    });
  }
  return [];
}

/** One visit: descriptor, subject, one association page, optional selected detail on that page. */
export async function readReleaseFidelity(
  client: KernelClient,
  authorization: string,
  query: ReleaseReadQuery,
): Promise<ReleaseFidelityRead> {
  if (!releaseUuid.test(query.id) || (query.detail && !releaseUuid.test(query.detail)))
    return { ok: false, reason: 'invalid' };
  const context = query.context ?? candidateContext;
  if (!releaseUuid.test(context)) return { ok: false, reason: 'invalid' };
  if (
    query.returning &&
    (!releaseVisit(query.returning) || query.returning.id !== query.id || query.returning.context !== context)
  )
    return { ok: false, reason: 'invalid' };
  if (query.cursor && !query.stream) return { ok: false, reason: 'invalid' };
  const headers = { authorization, ...(query.session ? { 'rezics-session-token': query.session } : {}) };
  let work = emptyVisit();
  try {
    const subject = await client
      .subjects({ id: query.id })
      .get({ query: { context, language: query.locale }, headers });
    if (subject.status !== 200 || !subject.data) return candidateFailure(subject.status);
    if (subject.data.subject.id !== query.id || subject.data.subject.context !== context)
      return { ok: false, reason: 'stale' };
    const digest = subject.data.subject.release;
    const sameVisit =
      !query.returning ||
      (query.returning.digest === digest && query.returning.revision === subject.data.subject.revision);
    const cursor = sameVisit ? query.cursor : undefined;
    const bundle = await client.definitions.releases({ digest }).get({ headers });
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== digest) return candidateFailure(bundle.status);
    const release = bundle.data.release as Release;
    if (
      !release.types ||
      !release.properties ||
      !admitVisitComponent('descriptor', release, Object.keys(release.types).length) ||
      !admitVisitComponent('subject', subject.data, Object.keys(subject.data.subject.statements).length)
    )
      return { ok: false, reason: 'unavailable' };
    work = recordComponent(work, {
      id: 'descriptor',
      calls: 1,
      rows: Object.keys(release.types).length,
      bytes: encodedBytes(release),
      rowCap: RELEASE_VISIT_CAPS.descriptor.rows,
      byteCap: RELEASE_VISIT_CAPS.descriptor.bytes,
    });
    work = recordComponent(work, {
      id: 'subject',
      calls: 1,
      rows: Object.keys(subject.data.subject.statements).length,
      bytes: encodedBytes(subject.data),
      rowCap: RELEASE_VISIT_CAPS.subject.rows,
      byteCap: RELEASE_VISIT_CAPS.subject.bytes,
    });
    if (!isReleaseType(release, subject.data.subject.type)) return { ok: false, reason: 'invalid' };
    const groups = releaseGroups(release, subject.data.subject.type);
    const streams = releaseStreams(release, subject.data.subject.type, query.locale);
    const stream =
      (query.stream ? streams.find((item) => item.key === query.stream) : streams[0]) ??
      (query.returning ? streams[0] : undefined);
    if (query.stream && !stream && !query.returning) return { ok: false, reason: 'invalid' };
    let rows: ReleaseRow[] = [];
    let next: string | null = null;
    let count: ForwardPage['count'] | undefined;
    let session: string | undefined;
    let streamState: 'complete' | 'empty' | 'withheld' | 'unsupported' | 'unavailable' | 'denied' = stream
      ? 'complete'
      : streams.length
        ? 'empty'
        : 'unsupported';
    if (stream) {
      const pageQuery = {
        property: stream.property,
        context,
        language: query.locale,
        limit: RELEASE_ASSOCIATION_LIMIT,
        ...(cursor ? { cursor } : {}),
      };
      const result =
        stream.direction === 'forward'
          ? await client.subjects({ id: query.id }).relations.get({ query: pageQuery, headers })
          : await client.subjects({ id: query.id }).links.get({ query: pageQuery, headers });
      if (result.status !== 200 || !result.data) {
        streamState =
          result.status === 401 || result.status === 403
            ? 'denied'
            : result.status === 404
              ? 'withheld'
              : result.status === 400 || result.status === 422
                ? 'unsupported'
                : 'unavailable';
      } else {
        const page = result.data;
        const admittedRows = 'relations' in page ? page.relations.length : page.links.length;
        if (!admitVisitComponent('association', page, admittedRows)) return { ok: false, reason: 'unavailable' };
        rows = pageRows(query.id, digest, page, stream.direction);
        next = page.next;
        if ('count' in page && page.count) count = page.count;
        session = new Headers(result.headers).get('rezics-session-token') ?? undefined;
        if (!rows.length && !next) streamState = 'empty';
      }
      work = recordComponent(work, {
        id: 'association',
        calls: 1,
        rows: rows.length,
        bytes: result.data ? encodedBytes(result.data) : 0,
        rowCap: RELEASE_VISIT_CAPS.association.rows,
        byteCap: RELEASE_VISIT_CAPS.association.bytes,
      });
    } else {
      work = recordComponent(work, {
        id: 'association',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: RELEASE_VISIT_CAPS.association.rows,
        byteCap: RELEASE_VISIT_CAPS.association.bytes,
      });
    }
    let detail: SubjectRead | undefined;
    const returnedOccurrence = query.returning?.occurrence;
    const exactReturn =
      !query.returning ||
      (sameVisit &&
        (!returnedOccurrence ||
          rows.some(
            (row) =>
              row.readability === 'readable' &&
              row.holder === returnedOccurrence.holder &&
              row.statementId === returnedOccurrence.statementId &&
              row.statement?.rezics.revision === returnedOccurrence.revision &&
              stream?.key === returnedOccurrence.stream &&
              stream.property === returnedOccurrence.relation &&
              stream.direction === returnedOccurrence.direction &&
              (stream.direction === 'inverse' ? row.holder : row.statement && relatedTarget(row.statement)) ===
                returnedOccurrence.target,
          )));
    if (query.detail && exactReturn) {
      const listed = listedOnPage(rows, query.detail, query.id);
      if (!listed) return { ok: false, reason: 'invalid' };
      const selected = await client.subjects({ id: query.detail }).get({
        query: { context, language: query.locale },
        headers,
      });
      work = recordComponent(work, {
        id: 'detail',
        calls: 1,
        rows: selected.status === 200 && selected.data ? 1 : 0,
        bytes: selected.data ? encodedBytes(selected.data) : 0,
        rowCap: RELEASE_VISIT_CAPS.detail.rows,
        byteCap: RELEASE_VISIT_CAPS.detail.bytes,
      });
      if (selected.status === 200 && selected.data && admitVisitComponent('detail', selected.data, 1)) {
        if (selected.data.subject.id !== query.detail || selected.data.subject.context !== context)
          return { ok: false, reason: 'stale' };
        detail = selected.data;
      }
    } else {
      work = recordComponent(work, {
        id: 'detail',
        calls: 0,
        rows: 0,
        bytes: 0,
        rowCap: RELEASE_VISIT_CAPS.detail.rows,
        byteCap: RELEASE_VISIT_CAPS.detail.bytes,
      });
    }
    const type = subject.data.subject.type;
    const status = statusProperty(release, type);
    const region = regionProperty(release, type);
    return {
      ok: true,
      public: subject.data,
      release,
      digest,
      groups,
      work: workIdentity(subject.data, query.locale, digest),
      date: dateReading(
        subject.data.subject.statements['schema:datePublished'],
        'schema:datePublished',
        digest,
        query.locale,
      ),
      ...(status ? { statusProperty: status } : {}),
      ...(region ? { regionProperty: region } : {}),
      facts: {
        classification: factRows(subject.data, release, groups.classification, query.locale),
        credits: factRows(subject.data, release, groups.credits, query.locale),
        identifiers: factRows(subject.data, release, groups.identifiers, query.locale),
        facts: factRows(subject.data, release, groups.facts, query.locale),
      },
      sources: subject.data.subject.sourceRecords,
      streams,
      ...(stream ? { stream } : {}),
      streamState,
      rows,
      next,
      ...(count ? { count } : {}),
      ...(detail ? { detail } : {}),
      visit: work,
      ...(session ? { session } : {}),
      ...(query.returning ? { returned: exactReturn ? ('restored' as const) : ('changed' as const) } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
