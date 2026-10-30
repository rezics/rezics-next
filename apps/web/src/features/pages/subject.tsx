import { SubjectChangesLink } from '../catalogue/subject-changes-link';
import type { PublicFigure } from './subject-ratings';
import { CreateSubjectEntry } from '../catalogue/create-subject-entry';
import { SubjectTermsEntry } from '../catalogue/subject-terms-entry';
import { PublicationEditorEntry } from '../catalogue/publication-editor-entry';
import type { SubjectRead, KernelClient } from '@rezics/client';
import {
  planReads,
  documentRead,
  platformRegistry,
  type CompositionDocument,
  type View,
  type SelectedContext,
  type PageContinuation,
} from '@rezics/composition';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import type { ComponentProps, ReactNode } from 'react';
import { requestLanguages } from '../../kernel/languages.ts';
import { originalLanguage } from '../../subject/language';
import { accountOf } from './account-read';
import type { Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject, Summary } from '../../subject/types';
import { accountHref, canonicalRedirect, subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { dataComponents, PageData, pageText, SubjectSources, SubjectSourcesLink, type PageMessages } from './data';
import { publicSubjectReference, serializeJsonLd, subjectJsonLd } from './jsonld';
import { holderItems } from './overview';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender, type PageDocument } from './render';
import { linkClass, linkColor } from './shared';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import type { ViewTab } from './views';
import type { SubjectCommunity } from './subject-community';
import { SubjectCommunityContext } from './subject-community-view';
import { subjectUrlForView } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SubjectPageData = {
  /** The subject the page is for; an agent page always has one, a route page none. */
  subject: string | null;
  /** The account an agent page is for, as the page read named it. */
  account?: { id: string; handle: string };
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  community?: SubjectCommunity;
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: PageDocument;
  /** The views the subject's templates define; absent when the kernel did not say. */
  views?: string[];
  reads: Record<string, { status: number; body: unknown }>;
};

export type SubjectPageLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData };

export type SubjectActionsInput = { id: string; type: string; locale: string };

/** The canonical document redirect for a verified agent's subject address. */
export function subjectAccountRedirect(locale: string, handle: string, view?: View, search = '') {
  // Retain the native redirect adapter's exported shape; website routes use canonicalRedirect's 301.
  const { href, statusCode } = canonicalRedirect(accountHref(locale, handle, view), search, '', 308);
  return { href, statusCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the template places a node of this type anywhere, including inside slots. */
function placesType(content: readonly unknown[], type: string): boolean {
  return content.some(
    (node) =>
      isRecord(node) &&
      (node.type === type ||
        (isRecord(node.props) &&
          Object.values(node.props).some((value) => Array.isArray(value) && placesType(value, type)))),
  );
}

export class PageReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function problemError(value: unknown, status: number): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  return new PageReadError(code, status);
}

/** The context the page's reads are planned in. */
export function pageContext(page: Pick<SubjectPageData, 'subject' | 'account' | 'context' | 'continuation'>) {
  return {
    subject: page.subject,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  };
}

/** The subject read planned for this page, when that read succeeded. */
export function subjectBody(page: SubjectPageData):
  | {
      subject: Subject;
      account?: SubjectRead['account'];
      related: Related;
      documents?: unknown;
      summary?: Summary | null;
    }
  | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (
    result?.status !== 200 ||
    !isRecord(result.body) ||
    !isRecord(result.body.subject) ||
    !isRecord(result.body.related)
  )
    return;
  return {
    subject: result.body.subject as Subject,
    related: result.body.related as Related,
    documents: result.body.documents,
    ...(Object.hasOwn(result.body, 'account') ? { account: result.body.account as SubjectRead['account'] } : {}),
    ...(Object.hasOwn(result.body, 'summary')
      ? { summary: (result.body.summary as Summary | null | undefined) ?? null }
      : {}),
  };
}

/** One `pages.read` of the overview, or of the named view. A merged subject names its survivor; an unknown one is missing. */
export async function loadSubjectPage(
  client: KernelClient,
  id: string,
  view?: View,
  locale = 'en',
  options: {
    realm?: string | undefined;
    continuation?: PageContinuation | undefined;
    authorization?: string | undefined;
  } = {},
): Promise<SubjectPageLoad> {
  if (!subjectIdPattern.test(id)) return { kind: 'missing' };
  const result = await client.pages.$read.post(
    {
      target: { subject: id, ...(view ? { view } : {}), ...(options.realm ? { realm: options.realm } : {}) },
      ...(options.continuation ? { continuation: options.continuation } : {}),
      languages: requestLanguages(locale),
    },
    {
      fetch: { redirect: 'manual' },
      ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
    },
  );
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 308) {
    const body = result.data ?? result.error?.value;
    if (isRecord(body) && 'redirect' in body && isRecord(body.redirect) && typeof body.redirect.to === 'string')
      return { kind: 'redirect', id: body.redirect.to, target: 'account' };
  }
  if (result.status === 200 && result.data) {
    if (typeof result.data.account === 'string') {
      const raw = {
        ...result.data,
        account: { id: result.data.account, handle: '' },
      } as SubjectPageData;
      const reads = planReads(platformRegistry, raw.document as CompositionDocument, pageContext(raw)).reads;
      for (const [key, read] of Object.entries(reads)) {
        if (read.kind !== 'account' || raw.reads[key]?.status !== 200) continue;
        const handle = accountOf(raw.reads[key]?.body)?.handle;
        if (handle) return { kind: 'redirect', id: handle, target: 'account' };
      }
      // A handleless account supplies no public @ address. Retain the valid catalogue identity.
      const { account: _account, ...catalogue } = result.data;
      if (catalogue.subject === id) return { kind: 'page', page: { ...catalogue, subject: id } };
    }
    const survivor = result.data.subject;
    if (typeof survivor === 'string' && survivor !== id) return { kind: 'redirect', id: survivor };
    const { account: _account, ...page } = result.data;
    return { kind: 'page', page: { ...page, subject: page.subject ?? null } };
  }
  throw problemError(result.error?.value, result.status);
}

/** The properties the page's inverse reads follow, for the definitions that label them. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  return [
    ...new Set(
      Object.values(reads).flatMap((read) =>
        read.kind === 'links' || read.kind === 'relations' ? [read.property] : [],
      ),
    ),
  ];
}

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read ? subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject)) : '';
}

/** The same localized display label used by a rendered subject page, from its labels and original language. */
export function subjectDisplayLabel(labels: Record<string, string>, locale: string, original?: string): string {
  return pageText(labels, locale, original).text || m.subject_value_unlabelled({}, { locale: locale as never });
}

/** The subject's type CURIE, when its read succeeded. */
export function subjectPageType(page: SubjectPageData): string | undefined {
  return subjectBody(page)?.subject.type;
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
    page.subject,
    Object.keys(read.subject.statements),
  );
  const origin = (options.origin ?? 'https://rezics.com').replace(/\/+$/, '');
  const json = subjectJsonLd({
    subject: {
      ...read.subject,
      statements: Object.fromEntries(
        Object.entries(read.subject.statements).filter(
          ([property, statements]) =>
            !statements.some((statement) => statement.property.data_type === 'document') ||
            documents?.properties.includes(property),
        ),
      ),
    },
    documents: read.documents,
    related: read.related,
    ...(read.summary === undefined ? {} : { summary: read.summary }),
    locale,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.typeLabel ? { typeLabel: options.typeLabel } : {}),
    subjectLabel: subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject)),
    ...(options.schemaOrgType ? { schemaOrgType: options.schemaOrgType } : {}),
    ...(options.ratings ? { ratings: options.ratings } : {}),
    url: `${origin}${subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale).href}`,
  });
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  // These are inverse properties of visible SubjectLists, never a second lookup or a complete edition inventory.
  const inverse = new Map([
    ['schema:exampleOfWork', 'workExample'],
    ['schema:isPartOf', 'hasPart'],
  ]);
  const visit = (content: readonly unknown[]): void => {
    for (const node of content) {
      if (!isRecord(node) || !isRecord(node.props)) continue;
      const key = typeof node.props.id === 'string' ? plan.nodes[node.props.id] : undefined;
      const planned = key ? plan.reads[key] : undefined;
      const result = key ? page.reads[key] : undefined;
      if (node.type === 'SubjectList' && planned?.kind === 'links' && planned.id === page.subject) {
        const property = inverse.get(planned.property);
        if (property && result?.status === 200 && isRecord(result.body)) {
          const limit = node.props.paged === true ? planned.limit : Math.min(planned.limit, 12);
          const found = holderItems(result.body, limit);
          const items = found?.items.map((item) =>
            publicSubjectReference(item.id, item.label.text || undefined, item.type, locale, origin),
          );
          if (items?.length) json[property] = items;
        }
      }
      for (const value of Object.values(node.props)) if (Array.isArray(value)) visit(value);
    }
  };
  visit(page.document.content);
  return serializeJsonLd(json);
}

/** Whether the template places a slot of this name anywhere in the document. */
function placesSlot(content: readonly unknown[], name: string): boolean {
  return content.some(
    (node) =>
      isRecord(node) &&
      isRecord(node.props) &&
      ((node.type === 'Slot' && node.props.name === name) ||
        Object.values(node.props).some((value) => Array.isArray(value) && placesSlot(value, name))),
  );
}

/** A subject with nothing but its title: the read succeeded and holds no statement. */
function hasOnlyTitle(page: SubjectPageData): boolean {
  const read = subjectBody(page);
  return !!read && Object.values(read.subject.statements).every((statements) => !statements?.length);
}

/** The view's name and a way back to the subject, above the tabs of every view but the overview. */
export type ViewHeading = { title: string; label: string; href: string };

/**
 * The template document for one view of a subject, then schema.org JSON-LD for the overview. The host places the
 * view tabs right after the overview's header, or under the view's own heading, and invites the first facts when the
 * subject has only a title.
 */
export function SubjectPage({
  page,
  locale,
  messages,
  link,
  actions,
  nonce,
  renderJsonLd = true,
  reader,
  typeLabel,
  ratio,
  relations,
  view = 'overview',
  tabs,
  tabLabels,
  heading,
  invitation,
  base,
  operator,
  curation,
}: {
  page: SubjectPageData;
  locale: string;
  messages: PageMessages;
  link?: ComponentProps<typeof PageData>['link'];
  actions?: (subject: SubjectActionsInput) => ReactNode;
  nonce?: string;
  renderJsonLd?: boolean;
  /** The reader's spoiler and suitability settings; anonymous readers get the defaults. */
  reader?: Reader;
  /** The subject type's name in the reader's language, from the definitions release. */
  typeLabel?: string;
  /** The cover frame the definitions release declares for the subject's type. */
  ratio?: ComponentProps<typeof PageData>['ratio'];
  /** How each relation property reads on this page, from the definitions release. */
  relations?: Record<string, RelationDefinition>;
  /** The view this document is. */
  view?: View;
  /** The views to offer, from `subjectTabs` of the subject's overview. */
  tabs?: readonly ViewTab[];
  tabLabels?: ViewTabLabels;
  /** Required for a view other than the overview. */
  heading?: ViewHeading;
  /** The sentence that invites the first facts of a subject with only a title. */
  invitation?: string;
  /** The address of the overview when it is not the subject's own: an agent's `/@handle`. */
  base?: string;
  operator?: { id: string; handle: string | null; displayName: string | null };
  curation?: ReactNode;
}) {
  const overview = view === 'overview';
  const read = subjectBody(page);
  const existingActions = read && actions ? actions({ id: read.subject.id, type: read.subject.type, locale }) : null;
  const renderedActions =
    read && !page.account ? (
      <>
        {existingActions}
        {page.views?.includes('editions') && <PublicationEditorEntry work={read.subject.id} locale={locale} />}
        <CreateSubjectEntry locale={locale} />
        <SubjectTermsEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
        <SubjectChangesLink id={read.subject.id} title={subjectPageTitle(page, locale)} locale={locale} />
      </>
    ) : (
      existingActions
    );
  const jsonLd = overview ? subjectPageJsonLd(page, locale) : undefined;
  const bar =
    tabs && tabLabels && tabs.length > 0 ? (
      <ViewTabs
        tabs={tabs}
        active={view}
        locale={locale}
        base={
          base ??
          heading?.href ??
          subjectHref(
            { id: read?.subject.id ?? page.subject ?? '', label: read ? subjectPageTitle(page, locale) : '' },
            locale,
          ).href
        }
        realm={page.context?.population.kind === 'realm' ? page.context.population.id : undefined}
        labels={tabLabels}
      />
    ) : null;
  const invite =
    overview && invitation && hasOnlyTitle(page) ? (
      <Empty data-slot="invitation" className="border p-6">
        <EmptyHeader>
          <EmptyTitle className="sr-only">{invitation}</EmptyTitle>
          <EmptyDescription>{invitation}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : null;
  const header = placesSlot(page.document.content, 'header');
  const afterHeader = overview ? (
    <>
      {bar}
      {invite}
    </>
  ) : null;
  return (
    <>
      <PageHost actions={page.account ? renderedActions : null} afterHeader={header ? afterHeader : null}>
        <PageData
          locale={locale}
          subject={page.subject}
          {...(read ? { subjectLabel: subjectPageTitle(page, locale) } : {})}
          {...(page.account ? { account: page.account } : {})}
          {...(operator ? { operator } : {})}
          {...(base ? { base } : {})}
          document={page.document}
          reads={page.reads}
          context={page.context}
          continuation={page.continuation}
          messages={messages}
          {...(link ? { link } : {})}
          {...(reader ? { reader } : {})}
          {...(typeLabel ? { typeLabel } : {})}
          {...(ratio ? { ratio } : {})}
          {...(relations ? { relations } : {})}
          {...(!page.account && renderedActions ? { headerActions: renderedActions } : {})}
        >
          <div className="flex w-full flex-col gap-8">
            {!overview && heading && (
              <header className="min-w-0 space-y-1" data-slot="view-heading">
                <p className="text-sm break-words">
                  <a className={`${linkClass} ${linkColor}`} href={heading.href}>
                    {heading.title}
                  </a>
                </p>
                <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                  {heading.label}
                </h1>
              </header>
            )}
            {page.context?.population.kind === 'realm' && (
              <p data-slot="page-context">{page.context.population.title}</p>
            )}
            {!overview && bar}
            {overview && !header && afterHeader}
            <SubjectCommunityContext.Provider value={page.community}>
              <CompositionRender
                document={page.document}
                definitions={pageDefinitions}
                components={{ ...layoutComponents, ...dataComponents }}
                root={PageRoot}
              />
            </SubjectCommunityContext.Provider>
            {overview && !placesType(page.document.content, 'Sources') && <SubjectSources />}
            {overview && <SubjectSourcesLink />}
            {curation}
            {overview && read && !page.account && (
              <a
                className={`${linkClass} ${linkColor}`}
                href={`${subjectUrlForView(subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale), 'context-review')}?${new URLSearchParams({ context: page.context?.id ?? read.subject.context })}`}
              >
                {m.context_title({}, { locale: locale as never })}
              </a>
            )}
            {overview &&
              read &&
              !page.account &&
              read.subject.context === candidateContext &&
              page.context?.population.kind !== 'realm' && (
                <a
                  className={`${linkClass} ${linkColor}`}
                  href={subjectUrlForView(
                    subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale),
                    'relation-edit',
                  )}
                >
                  {m.relation_title({}, { locale: locale as never })}
                </a>
              )}
          </div>
        </PageData>
      </PageHost>
      {renderJsonLd && jsonLd !== undefined && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      )}
    </>
  );
}
