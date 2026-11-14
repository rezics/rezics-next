import { createContext, useContext, type ReactNode } from 'react';
import { platformRegistry } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type { PageDocument } from './render';

export type ReadingDomain = 'book' | 'game' | 'screen';
export const ReadingOverviewContext = createContext(false);
export const ReadingDomainContext = createContext<ReadingDomain | undefined>(undefined);
export const READING_REVIEW_PREVIEW_LIMIT = 3;

/** Select presentation from already admitted readers; this is never Type or authority discovery. */
export function readingOverviewDomain({
  type,
  view,
  account,
  literary = false,
  game = false,
  screen = false,
}: {
  type?: string | undefined;
  view: string;
  account: boolean;
  literary?: boolean;
  game?: boolean;
  screen?: boolean;
}): ReadingDomain | undefined {
  if (account || view !== 'overview') return;
  if (literary || type === 'schema:Book') return 'book';
  if (game) return 'game';
  if (screen) return 'screen';
}

const destinationNodes = new Set([
  'SubjectList',
  'RelationGroups',
  'OutgoingRelations',
  'Appearances',
  'Credits',
  'CollectionList',
  'ThreadList',
  'RatingSummary',
  'Sources',
]);
const reviewNodes = new Set(['ReviewList']);

/**
 * Project only installed composition slots. Reads, ids, props, counts and native order are untouched.
 * A selected detail view always receives the original document, with its complete native capabilities.
 */
export function projectReadingDocument(
  document: PageDocument,
  omit: (node: PageDocument['content'][number]) => boolean,
): PageDocument {
  const project = (content: PageDocument['content']): PageDocument['content'] =>
    content.flatMap((node) => {
      if (omit(node)) return [];
      const props = { ...node.props };
      const slots = platformRegistry.components.find(({ type }) => type === node.type)?.slots ?? [];
      for (const slot of slots) {
        const children = props[slot] as PageDocument['content'] | undefined;
        if (children) props[slot] = project(children);
      }
      if (
        node.type !== 'Slot' &&
        slots.length &&
        slots.every((slot) => !(props[slot] as PageDocument['content'] | undefined)?.length)
      )
        return [];
      return [{ ...node, props }];
    });
  return { ...document, content: project(document.content) };
}

export function readingOverviewDocument(document: PageDocument, domain: ReadingDomain = 'book'): PageDocument {
  return projectReadingDocument(
    document,
    (node) => destinationNodes.has(node.type) || (domain !== 'book' && node.type === 'Statements'),
  );
}

/** Split at leaves, retaining nested layout and exact node identities in each reading region. */
export function readingOverviewParts(document: PageDocument) {
  const isLayout = (type: string) => !!platformRegistry.components.find((entry) => entry.type === type)?.slots?.length;
  return {
    lead: projectReadingDocument(document, (node) => reviewNodes.has(node.type)),
    reviews: projectReadingDocument(document, (node) => !isLayout(node.type) && !reviewNodes.has(node.type)),
  };
}

export function ReadingOverviewRoot({ children }: { children?: ReactNode }) {
  const domain = useContext(ReadingDomainContext);
  return (
    <div
      data-slot={domain === 'book' ? 'book-overview' : 'reading-overview'}
      data-reading-domain={domain}
      className="flex min-w-0 w-full flex-col gap-8 font-sans text-foreground sm:gap-10"
    >
      {children}
    </div>
  );
}

export function ReadingOverviewSections({ children }: { children?: ReactNode }) {
  return (
    <div data-slot="reading-overview-sections" className="min-w-0 space-y-8 border-t border-border pt-8 sm:space-y-10">
      {children}
    </div>
  );
}

/** Secondary controls remain mounted so currentness, focus and native command ownership survive disclosure. */
export function ReadingOverviewTools({ children, locale }: { children?: ReactNode; locale: string }) {
  return (
    <details data-slot="reading-overview-tools" className="group min-w-0 border-t border-border pt-5">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.subject_details({}, { locale: locale as never })}
      </summary>
      <div className="min-w-0 space-y-6 pt-5 [overflow-wrap:anywhere]">{children}</div>
    </details>
  );
}
