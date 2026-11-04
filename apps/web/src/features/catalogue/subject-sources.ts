import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickLanguage } from '@rezics/composition';
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
  realm?: string | undefined;
  context?: import('@rezics/composition').SelectedContext | undefined;
  viewer?: { account: SubjectRead['account']; actions: NonNullable<SubjectRead['viewerActions']> };
  id: string;
  title: ReturnType<typeof pageText>;
  typeLabel: ReturnType<typeof pageText>;
  href: string;
  sourcesHref: string;
  fields: SourceField[];
  related: Related;
  sources: Sources;
};
export type SourcesFailure = { kind: 'denied' | 'missing' | 'invalid' | 'conflict' | 'unavailable' };
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

/** Only the CURRENT anonymous subject read is input. Definition labels never confer disclosure. */
export function explainSubjectSources(
  read: Pick<SubjectRead, 'subject' | 'related'> & { summary?: SubjectRead['summary'] | undefined },
  locale: string,
  definitions?: SourceDefinitions,
): SourcesPageData {
  const { subject } = read;
  const original = originalLanguage(subject);
  const title = pageText(subject.labels, locale, original);
  const identity = { id: subject.id, label: title.text };
  const related = read.related as Related;
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
    const language = pickLanguage(languages, locale, original);
    selected = selected.filter(
      ({ property, value }) =>
        property.data_type !== 'document' || !isRecord(value.content) || value.content.language === language,
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
          ...(locator && statement.value.type === 'value'
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
      read.viewerActions?.state === 'available' &&
      read.viewerActions.actions.some(
        (entry) => entry.action === 'statement:propose' && entry.operations.includes('subject.propose'),
      );
    const returnTo = `${subjectViewHref(identity, locale, 'sources')}#subject-sources-heading`;
    if (allowed && comparable && !relation && literalTypes.has(selected[0]?.property.data_type ?? ''))
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
            compareHref: `${subjectViewHref(identity, locale, 'details')}?${new URLSearchParams({ candidateField: property, via: returnTo, ...(facts.length === 1 && facts[0]?.statement ? { sourceStatement: facts[0].statement } : {}) })}#candidate-review`,
          }
        : {}),
    });
  }
  return {
    viewer: { account: read.account, actions: read.viewerActions ?? { state: 'unavailable' } },
    id: subject.id,
    title,
    typeLabel: pageText(definitions?.types[subject.type]?.labels, locale),
    href: subjectHref(identity, locale).href,
    sourcesHref: subjectViewHref(identity, locale, 'sources'),
    fields,
    related,
    sources: {
      credit: read.summary?.cover?.credit ?? null,
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
): Promise<SourcesResult> {
  if (!uuid.test(id)) return { kind: 'missing' };
  try {
    let current = await client
      .subjects({ id })
      .get({ query: { includeViewerActions }, fetch: { redirect: 'manual', cache: 'no-store' } });
    let expected = id;
    if (current.status === 308) {
      const body = current.data ?? current.error?.value;
      const moved = body && 'redirect' in body ? body.redirect : undefined;
      if (!moved || moved.from !== id || !uuid.test(moved.to) || moved.to === id) return { kind: 'unavailable' };
      expected = moved.to;
      current = await client
        .subjects({ id: expected })
        .get({ query: { includeViewerActions }, fetch: { redirect: 'manual', cache: 'no-store' } });
    }
    if (current.status !== 200 || !current.data) return failure(current.status);
    if (current.data.subject.id !== expected) return { kind: 'unavailable' };
    return { kind: 'ready', page: explainSubjectSources(current.data, locale, await definitions) };
  } catch {
    return { kind: 'unavailable' };
  }
}
