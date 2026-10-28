import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import type { ComponentProps, ReactNode } from 'react';
import { requestLanguages } from '../../kernel/languages.ts';
import { originalLanguage } from '../../subject/language';
import type { Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject } from '../../subject/types';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { dataComponents, PageData, pageText, SubjectSources, type PageMessages } from './data';
import { serializeJsonLd, subjectJsonLd } from './jsonld';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender, type PageDocument } from './render';
import { linkClass, linkColor } from './shared';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import type { ViewTab } from './views';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SubjectPageData = {
  /** The subject the page is for; an agent page always has one, a route page none. */
  subject: string | null;
  /** The account an agent page is for, as the page read named it. */
  account?: { id: string; handle: string };
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: PageDocument;
  /** The views the subject's templates define; absent when the kernel did not say. */
  views?: string[];
  reads: Record<string, { status: number; body: unknown }>;
};

export type SubjectPageLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string }
  | { kind: 'page'; page: SubjectPageData };

export type SubjectActionsInput = { id: string; type: string; locale: string };

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

function problemError(value: unknown): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  return new Error(code);
}

/** The context the page's reads are planned in. */
export function pageContext(page: Pick<SubjectPageData, 'subject' | 'account'>) {
  return { subject: page.subject, account: page.account ?? null };
}

/** The subject read planned for this page, when that read succeeded. */
function subjectBody(page: SubjectPageData): { subject: Subject; related: Related } | undefined {
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
  return { subject: result.body.subject as Subject, related: result.body.related as Related };
}

/** One `pages.read` of the overview, or of the named view. A merged subject names its survivor; an unknown one is missing. */
export async function loadSubjectPage(
  client: KernelClient,
  id: string,
  view?: View,
  locale = 'en',
): Promise<SubjectPageLoad> {
  if (!subjectIdPattern.test(id)) return { kind: 'missing' };
  const result = await client.pages.$read.post({
    target: { subject: id, ...(view ? { view } : {}) },
    languages: requestLanguages(locale),
  });
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 200 && result.data) {
    const survivor = result.data.subject;
    if (typeof survivor === 'string' && survivor !== id) return { kind: 'redirect', id: survivor };
    return { kind: 'page', page: result.data as unknown as SubjectPageData };
  }
  throw problemError(result.error?.value);
}

/** The properties the page's inverse reads follow, for the definitions that label them. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  return [...new Set(Object.values(reads).flatMap((read) => (read.kind === 'links' ? [read.property] : [])))];
}

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read
    ? pageText(read.subject.labels, locale, originalLanguage(read.subject)).text ||
        m.subject_value_unlabelled({}, { locale: locale as never })
    : '';
}

/** The subject's type CURIE, when its read succeeded. */
export function subjectPageType(page: SubjectPageData): string | undefined {
  return subjectBody(page)?.subject.type;
}

export function subjectPageJsonLd(page: SubjectPageData, locale: string): string | undefined {
  const read = subjectBody(page);
  return read
    ? serializeJsonLd(
        subjectJsonLd({
          subject: read.subject,
          related: read.related,
          locale,
          url: `https://rezics.com${
            subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale).href
          }`,
        }),
      )
    : undefined;
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
}) {
  const overview = view === 'overview';
  const read = subjectBody(page);
  const renderedActions = read && actions ? actions({ id: read.subject.id, type: read.subject.type, locale }) : null;
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
      <PageHost actions={renderedActions} afterHeader={header ? afterHeader : null}>
        <PageData
          locale={locale}
          subject={page.subject}
          {...(read ? { subjectLabel: subjectPageTitle(page, locale) } : {})}
          {...(page.account ? { account: page.account } : {})}
          {...(base ? { base } : {})}
          document={page.document}
          reads={page.reads}
          messages={messages}
          {...(link ? { link } : {})}
          {...(reader ? { reader } : {})}
          {...(typeLabel ? { typeLabel } : {})}
          {...(ratio ? { ratio } : {})}
          {...(relations ? { relations } : {})}
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
            {!overview && bar}
            {overview && !header && afterHeader}
            <CompositionRender
              document={page.document}
              definitions={pageDefinitions}
              components={{ ...layoutComponents, ...dataComponents }}
              root={PageRoot}
            />
            {overview && !placesType(page.document.content, 'Sources') && <SubjectSources />}
          </div>
        </PageData>
      </PageHost>
      {renderJsonLd && jsonLd !== undefined && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      )}
    </>
  );
}
