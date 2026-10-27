import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { ComponentProps, ReactNode } from 'react';
import { originalLanguage } from '../../subject/language';
import type { Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject } from '../../subject/types';
import { dataComponents, PageData, pageText, SubjectSources, type PageMessages } from './data';
import { serializeJsonLd, subjectJsonLd } from './jsonld';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender, type PageDocument } from './render';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SubjectPageData = {
  subject: string;
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: PageDocument;
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

/** The subject read planned for this page, when that read succeeded. */
function subjectBody(page: SubjectPageData): { subject: Subject; related: Related } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, { subject: page.subject }).reads,
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

/** One `pages.read`. A merged subject names its survivor; an unknown subject is missing. */
export async function loadSubjectPage(client: KernelClient, id: string): Promise<SubjectPageLoad> {
  if (!subjectIdPattern.test(id)) return { kind: 'missing' };
  const result = await client.pages.$read.post({ target: { subject: id } });
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 200 && result.data) {
    const survivor = result.data.subject;
    if (typeof survivor === 'string' && survivor !== id) return { kind: 'redirect', id: survivor };
    return { kind: 'page', page: result.data as SubjectPageData };
  }
  throw problemError(result.error?.value);
}

/** The properties the page's inverse reads follow, for the definitions that label them. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, { subject: page.subject }).reads;
  return [...new Set(Object.values(reads).flatMap((read) => (read.kind === 'links' ? [read.property] : [])))];
}

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read ? pageText(read.subject.labels, locale, originalLanguage(read.subject)).text : '';
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
          url: `https://rezics.com/${locale}/subjects/${read.subject.id}`,
        }),
      )
    : undefined;
}

/** The template document, then schema.org JSON-LD when the subject read succeeded. */
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
}) {
  const read = subjectBody(page);
  const renderedActions = read && actions ? actions({ id: page.subject, type: read.subject.type, locale }) : null;
  const jsonLd = subjectPageJsonLd(page, locale);
  return (
    <>
      <PageHost actions={renderedActions}>
        <PageData
          locale={locale}
          subject={page.subject}
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
            <CompositionRender
              document={page.document}
              definitions={pageDefinitions}
              components={{ ...layoutComponents, ...dataComponents }}
              root={PageRoot}
            />
            {!placesType(page.document.content, 'Sources') && <SubjectSources />}
          </div>
        </PageData>
      </PageHost>
      {renderJsonLd && jsonLd !== undefined && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      )}
    </>
  );
}
