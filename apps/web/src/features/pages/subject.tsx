import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { ComponentProps } from 'react';
import type { Related, Subject } from '../../subject/types';
import { dataComponents, PageData, pageText, type PageMessages } from './data';
import { serializeJsonLd, subjectJsonLd } from './jsonld';
import { layoutComponents, PageRoot, pageDefinitions } from './layout';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read ? pageText(read.subject.labels, locale).text : '';
}

/** The template document, then schema.org JSON-LD when the subject read succeeded. */
export function SubjectPage({
  page,
  locale,
  messages,
  link,
}: {
  page: SubjectPageData;
  locale: string;
  messages: PageMessages;
  link?: ComponentProps<typeof PageData>['link'];
}) {
  const read = subjectBody(page);
  const jsonLd = read
    ? serializeJsonLd(
        subjectJsonLd({
          subject: read.subject,
          related: read.related,
          locale,
          url: `https://rezics.com/${locale}/subjects/${read.subject.id}`,
        }),
      )
    : undefined;
  return (
    <>
      <PageData
        locale={locale}
        subject={page.subject}
        document={page.document}
        reads={page.reads}
        messages={messages}
        {...(link ? { link } : {})}
      >
        <CompositionRender
          document={page.document}
          definitions={pageDefinitions}
          components={{ ...layoutComponents, ...dataComponents }}
          root={PageRoot}
        />
      </PageData>
      {jsonLd !== undefined && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />}
    </>
  );
}
