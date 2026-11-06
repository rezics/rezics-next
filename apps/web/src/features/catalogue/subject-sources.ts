import { selectedSynopsisQuery, selectedSynopsisResponse } from './selected-synopsis-source';
import { synopsisVisit } from '../pages/subject-summary-reading/visit';
import { actionState, type ConceptViewerActions } from './source-concept-explorer';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, pickLanguage } from '@rezics/composition';
import {
  bestRank,
  fieldLabel,
  isRecord,
  pageText,
  spoilerLevel,
  webUrl,
  type Snak,
  type Sources,
  type Stmt,
} from '../pages/shared';
import { originalLanguage } from '../../subject/language';
import { defaultReader } from '../../subject/reader';
import { subjectHref, subjectViewHref } from '../../subject/subject-href';
import type { Related } from '../../subject/types';

export { synopsisVisit };

export type SourceDefinitions = {
  types: Record<string, { labels?: Record<string, string>; properties?: readonly string[] }>;
  properties: Record<string, { labels?: Record<string, string>; relation?: { group?: string } }>;
};
export type SourcePart = { label: ReturnType<typeof pageText>; snak: Snak };
export type SourceFact = {
  statement?: string;
  correctionHref?: string;
  snak: Snak;
  display?: 'document' | 'media';
  qualifiers: SourcePart[];
  citations: SourcePart[][];
};
export type SourceField = {
  property: string;
  label: ReturnType<typeof pageText>;
  facts: SourceFact[];
  compareHref?: string;
};
export type SourcesPageData = {
  selectedSynopsis?: 'matched' | 'changed' | 'missing' | 'unsupported' | 'unavailable';
  realm?: string | undefined;
  context?: import('@rezics/composition').SelectedContext | undefined;
  viewer?: { state: 'public' | 'signed-in' | 'signed-out'; actions: ConceptViewerActions };
  id: string;
  title: ReturnType<typeof pageText>;
  typeLabel: ReturnType<typeof pageText>;
  href: string;
  sourcesHref: string;
  fields: SourceField[];
  related: Related;
  sources: Sources;
};
export type SourcesFailure = { kind: 'denied' | 'missing' | 'invalid' | 'conflict' | 'unsupported' | 'unavailable' };
export type SourcesResult = SourcesFailure | { kind: 'ready'; page: SourcesPageData };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literalTypes = new Set(['string', 'external-id', 'url', 'monolingualtext', 'time', 'quantity', 'wikibase-item']);
/** Never turn a document/media locator or an undisclosed target into a human value or a browser image. */
function presentable(snak: Snak, related: Related): boolean {
  if (snak.value.type !== 'value') return true;
  if (!literalTypes.has(snak.property.data_type)) return false;
  const content = snak.value.content;
  if (snak.property.data_type === 'wikibase-item')
    return (
      typeof content === 'string' &&
      Object.hasOwn(related, content) &&
      !!Object.keys(related[content]?.labels ?? {}).length
    );
  if (snak.property.data_type === 'url') return typeof content === 'string' && webUrl(content);
  return typeof content === 'string' || isRecord(content);
}

/** Only the current native subject read is input. Definition labels never confer disclosure or authority. */
export function explainSubjectSources(
  read: Pick<SubjectRead, 'subject' | 'related'> & {
    summary?: SubjectRead['summary'] | undefined;
    account?: SubjectRead['account'];
    selectedSynopsis?: SubjectRead['selectedSynopsis'];
  },
  locale: string,
  definitions?: SourceDefinitions,
): SourcesPageData {
  const exact = read.selectedSynopsis;
  const admittedExact = exact?.kind === 'matched' && spoilerLevel(exact.fact) <= defaultReader.spoilerLevel;
  const subject = exact
    ? {
        ...read.subject,
        statements: exact.kind === 'matched' ? { 'schema:abstract': [exact.fact] } : {},
        sourceRecords: [],
      }
    : read.subject;
  const actions = actionState({ ...read, account: read.account ?? null });
  const original = originalLanguage(read.subject);
  const title = pageText(subject.labels, locale, original);
  const identity = { id: subject.id, label: title.text };
  const exactIds = admittedExact
    ? new Set(
        [
          exact.fact,
          ...exact.fact.qualifiers,
          ...exact.fact.references.flatMap((reference) => reference.parts),
        ].flatMap((snak) => [
          snak.property.id,
          ...(snak.property.data_type === 'wikibase-item' &&
          snak.value.type === 'value' &&
          typeof snak.value.content === 'string'
            ? [snak.value.content]
            : []),
        ]),
      )
    : new Set<string>();
  const related: Related = exact
    ? Object.fromEntries(
        Object.entries(read.related)
          .filter(([id]) => exactIds.has(id))
          .map(([id, entry]) => [id, { labels: entry.labels }]),
      )
    : (read.related as Related);
  const labelFor = (id: string) =>
    fieldLabel(
      pageText(
        (Object.hasOwn(related, id) ? related[id]?.labels : undefined) ?? definitions?.properties[id]?.labels,
        locale,
      ),
      locale,
    );
  const parts = (snaks: Snak[]): SourcePart[] =>
    snaks.flatMap((snak) =>
      presentable(snak, related)
        ? [{ label: labelFor(snak.property.id), snak: { property: snak.property, value: snak.value } }]
        : [],
    );
  const fields: SourceField[] = [];
  for (const [property, statements] of Object.entries(subject.statements)) {
    let selected = bestRank(statements as Stmt[]).filter(
      (statement) => spoilerLevel(statement) <= defaultReader.spoilerLevel,
    );
    const languages = selected.flatMap(({ property, value }) =>
      property.data_type === 'document' &&
      value.type === 'value' &&
      isRecord(value.content) &&
      typeof value.content.language === 'string'
        ? [value.content.language]
        : [],
    );
    const language = exact?.kind === 'matched' ? undefined : pickLanguage(languages, locale, original);
    selected = selected.filter(
      ({ property, value }) =>
        exact?.kind === 'matched' ||
        property.data_type !== 'document' ||
        !isRecord(value.content) ||
        value.content.language === language,
    );
    const facts = selected.flatMap((statement): SourceFact[] => {
      const locator = statement.property.data_type === 'document' || statement.property.data_type === 'media';
      if (!locator && !presentable(statement, related)) return [];
      return [
        {
          statement: statement.id,
          // Locators and digests do not cross the presentation boundary.
          snak: {
            property: statement.property,
            value: locator && statement.value.type === 'value' ? { type: 'somevalue' } : statement.value,
          },
          ...(locator
            ? { display: statement.property.data_type === 'document' ? ('document' as const) : ('media' as const) }
            : {}),
          qualifiers: parts(statement.qualifiers.filter((snak) => snak.property.id !== 'rezics:spoilerLevel')),
          citations: statement.references
            .map(({ parts: citation }) => parts(citation))
            .filter((citation) => citation.length > 0),
        },
      ];
    });
    if (!facts.length) continue;
    const relation = definitions?.properties[property]?.relation;
    // Reuse the existing descriptive-slot candidate picker. Edge slots need a separate target address.
    const comparable =
      definitions?.types[subject.type]?.properties?.includes(property) &&
      definitions.properties[property] &&
      (!relation || relation.group === 'classification');
    const allowed =
      actions.state === 'available' &&
      actions.actions.some(
        (entry) => entry.action === 'statement:propose' && entry.operations.includes('subject.propose'),
      );
    const returnTo = `${subjectViewHref(identity, locale, 'sources')}#subject-sources-heading`;
    if (
      allowed &&
      comparable &&
      !relation &&
      !['schema:name', 'schema:description', 'schema:alternateName'].includes(property) &&
      ['string', 'external-id', 'url', 'monolingualtext', 'time', 'quantity'].includes(
        selected[0]?.property.data_type ?? '',
      )
    )
      for (const fact of facts) {
        const query = new URLSearchParams({ property, statement: fact.statement!, returnTo: 'sources' });
        fact.correctionHref = `${subjectHref(identity, locale).href}/edit?${query}`;
      }
    fields.push({
      property,
      label: labelFor(property),
      facts,
      ...(comparable && allowed
        ? {
            compareHref: `${subjectViewHref(identity, locale, 'details')}?${new URLSearchParams({ candidateField: property, via: returnTo, ...(facts.length === 1 && facts[0]?.correctionHref && facts[0].statement ? { sourceStatement: facts[0].statement } : {}) })}#candidate-review`,
          }
        : {}),
    });
  }
  return {
    ...(exact && (exact.kind !== 'matched' || admittedExact) ? { selectedSynopsis: exact.kind } : {}),
    viewer: { state: 'public', actions },
    id: subject.id,
    title,
    typeLabel: pageText(definitions?.types[subject.type]?.labels, locale),
    href: subjectHref(identity, locale).href,
    sourcesHref: subjectViewHref(identity, locale, 'sources'),
    fields,
    related,
    sources: {
      credit: exact ? null : (read.summary?.cover?.credit ?? null),
      // Native selected support owns this list. Citations above remain per field;
      // a record in this list grants neither field support nor prose/cover rights.
      records: subject.sourceRecords
        .filter((record) => record.name.trim() && webUrl(record.url))
        .map((record) => ({
          ...record,
          ...(record.licence
            ? {
                licence: {
                  id: record.licence.id,
                  ...(record.licence.url && webUrl(record.licence.url) ? { url: record.licence.url } : {}),
                },
              }
            : {}),
        })),
      urls: [],
      identifiers: [],
    },
  };
}

function failure(status: number): SourcesFailure {
  return {
    kind:
      status === 404
        ? 'missing'
        : status === 401 || status === 403
          ? 'denied'
          : status === 400 || status === 422
            ? 'invalid'
            : status === 409
              ? 'conflict'
              : 'unavailable',
  };
}

/** The generated client retains Kernel session tokens. No bearer, candidate overlay or history is requested. */
export async function readSubjectSources(
  client: KernelClient,
  id: string,
  locale: string,
  definitions?: SourceDefinitions | Promise<SourceDefinitions | undefined>,
  includeViewerActions = false,
  returnTo?: string,
): Promise<SourcesResult> {
  if (!uuid.test(id)) return { kind: 'missing' };
  const visit = synopsisVisit(returnTo, id, locale);
  if (visit.kind === 'invalid') return { kind: 'invalid' };
  const selection = visit.kind === 'selected' ? visit.selection : undefined;
  if (selection && (!selection.subjectRelease || selection.realm || selection.context !== PAGE_GLOBAL_CONTEXT))
    return { kind: 'unsupported' };
  const selectedSynopsis = selection ? selectedSynopsisQuery(selection) : undefined;
  if (selection && !selectedSynopsis) return { kind: 'invalid' };
  try {
    const query = { language: locale, includeViewerActions, ...(selectedSynopsis ? { selectedSynopsis } : {}) };
    let current = await client.subjects({ id }).get({ query, fetch: { redirect: 'manual', cache: 'no-store' } });
    let expected = id;
    if (current.status === 308 && selection) return { kind: 'conflict' };
    if (current.status === 308) {
      const body = current.data ?? current.error?.value;
      const moved = body && 'redirect' in body ? body.redirect : undefined;
      if (!moved || moved.from !== id || !uuid.test(moved.to) || moved.to === id) return { kind: 'unavailable' };
      expected = moved.to;
      current = await client
        .subjects({ id: expected })
        .get({ query, fetch: { redirect: 'manual', cache: 'no-store' } });
    }
    if (current.status !== 200 || !current.data) return failure(current.status);
    if (current.data.subject.id !== expected) return { kind: 'unavailable' };
    if (selection) {
      const exact: unknown = current.data.selectedSynopsis;
      if (!selectedSynopsisResponse(exact)) return { kind: 'unavailable' };
      if (
        exact.kind === 'matched' &&
        (exact.fact.id !== selection.candidateId ||
          exact.context !== selection.context ||
          exact.release !== selection.subjectRelease)
      )
        return { kind: 'unavailable' };
    }
    const page = explainSubjectSources(current.data, locale, await definitions);
    if (selection && new TextEncoder().encode(JSON.stringify({ returnTo, page })).byteLength > 262144)
      return { kind: 'unavailable' };
    if (includeViewerActions && page.viewer) page.viewer.state = 'signed-in';
    return { kind: 'ready', page };
  } catch {
    return { kind: 'unavailable' };
  }
}
