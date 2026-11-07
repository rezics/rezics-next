import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import type { Subject, Related, Summary } from '../../subject/read-contract';
import { pageContext, type SubjectPageData } from './page-model';
import { isRecord } from './shared';

/** A successful planned projection must name the page's already admitted Subject. */
export function subjectRead(page: SubjectPageData): { subject: Subject; body: Record<string, unknown> } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (
    result?.status !== 200 ||
    !isRecord(result.body) ||
    !isRecord(result.body.subject) ||
    result.body.subject.id !== page.subject
  )
    return;
  // Merge survivors are admitted by the outer page response and its redirect contract.
  return { subject: result.body.subject as Subject, body: result.body };
}

/** The subject read planned for this page, with the related data its body consumers require. */
export function subjectBody(page: SubjectPageData):
  | {
      subject: Subject;
      account?: SubjectRead['account'];
      related: Related;
      documents?: unknown;
      summary?: Summary | null;
    }
  | undefined {
  const read = subjectRead(page);
  if (!read || !isRecord(read.body.related)) return;
  return {
    subject: read.subject,
    related: read.body.related as Related,
    documents: read.body.documents,
    ...(Object.hasOwn(read.body, 'account') ? { account: read.body.account as SubjectRead['account'] } : {}),
    ...(Object.hasOwn(read.body, 'summary')
      ? { summary: (read.body.summary as Summary | null | undefined) ?? null }
      : {}),
  };
}
