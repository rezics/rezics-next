import {
  documentRead,
  planReads,
  platformRegistry,
  type CompositionDocument,
} from '@rezics/composition';
import type { PublicFigure } from './subject-ratings';
import { originalLanguage } from '../../subject/language';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { contextHref } from './context-navigation';
import { statementDocument } from './documents';
import { publicSubjectReference, serializeJsonLd, subjectJsonLd } from './jsonld';
import { holderItems } from './overview-holder-items';
import { pageContext, type SubjectPageData } from './page-model';
import { subjectBody } from './subject-read';
import { isRecord, pageText } from './shared';

/** Composition relation reads plus admitted item statements, preserving the values visible on this page. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  const planned = Object.values(reads).flatMap((read) =>
    read.kind === 'links' || read.kind === 'relations' ? [read.property] : [],
  );
  const statements = subjectBody(page)?.subject.statements ?? {};
  const disclosed = Object.entries(statements).flatMap(([property, rows]) =>
    (rows ?? []).some(
      (statement) =>
        isRecord(statement) && isRecord(statement.property) && statement.property.data_type === 'wikibase-item',
    )
      ? [property]
      : [],
  );
  return [...new Set([...planned, ...disclosed])];
}

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read ? subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject)) : '';
}

/** The same localized display label used by a rendered subject page. */
export function subjectDisplayLabel(labels: Record<string, string>, locale: string, original?: string): string {
  return pageText(labels, locale, original).text || m.subject_value_unlabelled({}, { locale: locale as never });
}

/** The subject's type CURIE, when its read succeeded. */
export function subjectPageType(page: SubjectPageData): string | undefined {
  return subjectBody(page)?.subject.type;
}

export function subjectPageRealm(page: SubjectPageData): string | undefined {
  return page.requestedRealm ?? (page.context?.population.kind === 'realm' ? page.context.population.id : undefined);
}

export function subjectPageJsonLd(
  page: SubjectPageData,
  locale: string,
  options: {
    origin?: string;
    typeLabel?: string;
    schemaOrgType?: string;
    ratings?: { figure: PublicFigure };
  } = {},
): string | undefined {
  const read = subjectBody(page);
  if (!read) return;
  const documents = documentRead(
    page.document as CompositionDocument,
    read.subject.id,
    Object.keys(read.subject.statements),
    page.context?.id,
  );
  const origin = (options.origin ?? 'https://rezics.com').replace(/\/+$/, '');
  const subjectLabel = subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject));
  const href = contextHref(
    subjectHref({ id: read.subject.id, label: subjectLabel }, locale).href,
    subjectPageRealm(page),
  );
  const json = subjectJsonLd({
    subject: {
      ...read.subject,
      statements: Object.fromEntries(
        Object.entries(read.subject.statements).filter(([property, statements]) => {
          if (!statements.some((statement) => statement.property.data_type === 'document')) return true;
          if (documents?.properties.includes(property)) return true;
          return statements.some((statement) => statementDocument(read.subject.id, statement, read.documents));
        }),
      ),
    },
    documents: read.documents,
    related: read.related,
    ...(read.summary === undefined ? {} : { summary: read.summary }),
    locale,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.typeLabel ? { typeLabel: options.typeLabel } : {}),
    subjectLabel,
    ...(options.schemaOrgType ? { schemaOrgType: options.schemaOrgType } : {}),
    ...(options.ratings && page.context?.population.kind !== 'realm' ? { ratings: options.ratings } : {}),
    url: `${origin}${href}`,
  });
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  // These are inverse properties of visible SubjectLists, never a second lookup or a complete edition inventory.
  const inverse = new Map([
    ['schema:exampleOfWork', 'workExample'],
    ['schema:isPartOf', 'hasPart'],
  ]);
  const inverseItems = new Map<string, Map<string, ReturnType<typeof publicSubjectReference>>>();
  const components = new Map(platformRegistry.components.map((component) => [component.type, component]));
  const visit = (content: readonly unknown[]): void => {
    for (const node of content) {
      if (!isRecord(node) || !isRecord(node.props)) continue;
      const key = typeof node.props.id === 'string' ? plan.nodes[node.props.id] : undefined;
      const planned = key ? plan.reads[key] : undefined;
      const result = key ? page.reads[key] : undefined;
      if (node.type === 'SubjectList' && planned?.kind === 'links' && planned.id === read.subject.id) {
        const property = inverse.get(planned.property);
        if (property && result?.status === 200 && isRecord(result.body)) {
          const limit =
            node.props.paged === true
              ? Number.POSITIVE_INFINITY
              : typeof node.props.limit === 'number' && node.props.limit >= 1
                ? Math.min(node.props.limit, 12)
                : 12;
          const found = holderItems(result.body, limit, locale, 0);
          let items = found?.items ?? [];
          if (node.props.paged === true) {
            const pageItems = new Map<string, (typeof items)[number]>();
            for (const item of items) pageItems.set(item.statement ?? item.id, item);
            items = [...pageItems.values()];
          }
          const propertyItems = inverseItems.get(property) ?? new Map();
          for (const item of items) {
            if (item.gated || propertyItems.has(item.id)) continue;
            propertyItems.set(
              item.id,
              publicSubjectReference(item.id, item.label.text || undefined, item.type, locale, origin),
            );
          }
          if (propertyItems.size) inverseItems.set(property, propertyItems);
        }
      }
      for (const slot of components.get(String(node.type))?.slots ?? []) {
        const children = node.props[slot];
        if (Array.isArray(children)) visit(children);
      }
    }
  };
  visit(page.document.content);
  for (const [property, references] of inverseItems) {
    const existing = Object.hasOwn(json, property)
      ? Array.isArray(json[property])
        ? json[property]
        : [json[property]!]
      : [];
    const seen = new Set(
      existing.flatMap((entry) => (isRecord(entry) && typeof entry['@id'] === 'string' ? [entry['@id']] : [])),
    );
    const values = [...existing];
    let added = false;
    for (const reference of references.values()) {
      const identity = reference['@id'];
      if (typeof identity === 'string' && seen.has(identity)) continue;
      if (typeof identity === 'string') seen.add(identity);
      values.push(reference);
      added = true;
    }
    if (added) json[property] = values;
  }
  return serializeJsonLd(json);
}

export type { SubjectPageData } from './page-model';
