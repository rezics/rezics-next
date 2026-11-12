import type { KernelClient } from '@rezics/client';
import {
  planReads,
  platformRegistry,
  type CompositionDocument,
  type View,
} from '@rezics/composition';
import { originalLanguage, originalTitle } from '../../subject/language';
import { timePresentation } from '../../subject/reader';
import type { Subject } from '../../subject/types';
import type { SubjectSummary } from '../../media/summary';
import { assertSamePageContext } from './context-subject';
import { pageContext, type SubjectPageData } from './page-model';
import { assertSubjectPageReadActive, type SubjectPageReadLifetime } from './subject-page-read-lifetime';
import { loadSubjectPage, PageReadError } from './subject-page-load';
import { bestRank, isRecord, pageText, spoilerLevel, type Stmt } from './shared';

const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];

export type SubjectFrameData = {
  id: string;
  type: string;
  /** Exact current Context from the same native subject/page read. */
  context?: string | undefined;
  /** The title in the reader's language; empty for a subject with no label at all. */
  title: { text: string; lang?: string | undefined };
  /** The title the subject was first written under, when it differs from the one shown. */
  original?: { text: string; lang: string };
  date?: string;
  summary: SubjectSummary | null;
};

function subjectRead(page: SubjectPageData): { subject: Subject; summary: SubjectSummary | null } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (result?.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) return;
  const summary = isRecord(result.body.summary) ? (result.body.summary as unknown as SubjectSummary) : null;
  return { subject: result.body.subject as unknown as Subject, summary };
}

/** The first date the subject states, at its own precision, in the reader's language. */
function dateOf(subject: Subject, locale: string): string | undefined {
  const statements = subject.statements as unknown as Record<string, Stmt[]>;
  for (const property of DATE_PROPERTIES) {
    const eligible = Object.hasOwn(statements, property) ? (statements[property] ?? []) : [];
    for (const statement of bestRank(eligible.filter((value) => spoilerLevel(value) === 0))) {
      if (statement.property.data_type !== 'time') continue;
      const presented = timePresentation(statement.value, locale);
      if (presented.state === 'supported' && presented.structuredDate) return presented.text;
    }
  }
}

/** The frame of a view page, from the overview read the view already makes. */
export function subjectFrame(overview: SubjectPageData, locale: string): SubjectFrameData | undefined {
  const read = subjectRead(overview);
  if (!read) return;
  const { subject, summary } = read;
  const label = pageText(subject.labels, locale, originalLanguage(subject));
  const first = originalTitle(subject);
  const date = dateOf(subject, locale);
  return {
    id: subject.id,
    type: subject.type,
    context: overview.context?.id ?? subject.context,
    title: label,
    ...(first && label.text && first.text !== label.text ? { original: first } : {}),
    ...(date ? { date } : {}),
    summary,
  };
}

export type ViewPagesLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData; overview: SubjectPageData; next?: string; node?: string };

/** One view read and one overview read, whose previews give the tab bar its counts and the frame its subject. */
export async function loadViewPages(
  client: KernelClient,
  id: string,
  view: View,
  locale = 'en',
  cursor?: string,
  options: {
    realm?: string | undefined;
    board?: string | undefined;
    node?: string | undefined;
    authorization?: string | undefined;
    signal?: SubjectPageReadLifetime | undefined;
  } = {},
): Promise<ViewPagesLoad> {
  assertSubjectPageReadActive(options.signal);
  // Resolve a node from the current template; the continued request independently resolves and guards it again.
  const first = await loadSubjectPage(client, id, view, locale, {
    ...options,
    ...(options.node ? { stream: options.node } : {}),
    ...(cursor !== undefined && options.node ? { continuation: { node: options.node, cursor } } : {}),
  });
  assertSubjectPageReadActive(options.signal);
  if (first.kind !== 'page') return first;
  const plan = planReads(platformRegistry, first.page.document as CompositionDocument, pageContext(first.page));
  const selectedNode = options.node ?? first.page.streams?.selected;
  const primary = Object.entries(plan.nodes).find(([node, key]) => {
    const read = plan.reads[key];
    return (
      (!selectedNode || selectedNode === node) &&
      (read?.kind === 'links' ||
        read?.kind === 'relations' ||
        read?.kind === 'subjectThreads' ||
        read?.kind === 'collections')
    );
  });
  let result = first;
  if (cursor !== undefined && !options.node) {
    if (!primary) return { kind: 'missing' };
    const primaryRead = plan.reads[primary[1]];
    if (primaryRead?.kind === 'collections') {
      if (first.page.context?.population.kind === 'realm') throw new PageReadError('dependency_unavailable', 503);
      assertSubjectPageReadActive(options.signal);
      const response = await client.subjects({ id }).collections.get({
        query: { limit: primaryRead.limit, cursor },
        ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
        ...(options.signal ? { fetch: { signal: options.signal } } : {}),
      });
      assertSubjectPageReadActive(options.signal);
      if (response.status === 400) return { kind: 'missing' };
      first.page.reads[primary[1]] = { status: response.status, body: response.error ? {} : response.data };
    } else {
      let continued: Awaited<ReturnType<typeof loadSubjectPage>>;
      try {
        continued = await loadSubjectPage(client, id, view, locale, {
          ...options,
          stream: primary[0],
          continuation: { node: primary[0], cursor },
        });
      } catch (error) {
        if (error instanceof PageReadError && error.status === 400) return { kind: 'missing' };
        throw error;
      }
      assertSubjectPageReadActive(options.signal);
      if (continued.kind !== 'page') return continued;
      assertSamePageContext(first.page, continued.page);
      result = continued;
    }
  }
  assertSubjectPageReadActive(options.signal);
  const overview = await loadSubjectPage(client, id, undefined, locale, options);
  assertSubjectPageReadActive(options.signal);
  if (overview.kind !== 'page') return overview;
  assertSamePageContext(result.page, overview.page);
  const currentPlan = planReads(platformRegistry, result.page.document as CompositionDocument, pageContext(result.page));
  const key = primary ? currentPlan.nodes[primary[0]] : undefined;
  const body = key ? result.page.reads[key]?.body : undefined;
  const groupCount = Object.values(currentPlan.reads).filter(
    (read) => read.kind === 'links' || read.kind === 'relations' || read.kind === 'subjectThreads',
  ).length;
  const next =
    key &&
    currentPlan.reads[key]?.kind !== 'subjectThreads' &&
    groupCount <= 1 &&
    isRecord(body) &&
    typeof body.next === 'string'
      ? body.next
      : undefined;
  return {
    kind: 'page',
    page: result.page,
    overview: overview.page,
    ...(next ? { next } : {}),
    ...(primary && currentPlan.reads[primary[1]]?.kind !== 'collections' ? { node: primary[0] } : {}),
  };
}

