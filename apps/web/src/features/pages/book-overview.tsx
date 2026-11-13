import { createContext, type ReactNode } from 'react';
import { platformRegistry } from '@rezics/composition';
import { literaryDetailedNodes } from '../catalogue/page-data-binding';
import type { PageDocument } from './render';

/** Presentation only: admission and all source reads remain with the ordinary Subject page. */
export const BookOverviewContext = createContext(false);
export const BOOK_REVIEW_PREVIEW_LIMIT = 3;

// Keep the existing composition mount and controls for every admitted literary grain.
export function isBookOverview(type: string | undefined, view: string, account: boolean, literary = false): boolean {
  return !account && (literary || type === 'schema:Book') && view === 'overview';
}

/**
 * Distill the installed template for Book presentation without changing its planned reads, node identities,
 * navigation counts or reader authority. A native pages.read owns the bundled relation reads; Web starts none.
 */
function projectDocument(
  document: PageDocument,
  omit: (node: PageDocument['content'][number]) => boolean,
): PageDocument {
  const distill = (content: PageDocument['content']): PageDocument['content'] =>
    content.flatMap((node) => {
      if (omit(node)) return [];
      const props = { ...node.props };
      // The installed layout components own these composition slots.
      const slots = platformRegistry.components.find(({ type }) => type === node.type)?.slots ?? [];
      for (const slot of slots) {
        const children = props[slot] as PageDocument['content'] | undefined;
        if (children) props[slot] = distill(children);
      }
      if (
        slots.length &&
        slots.every((slot) => !(props[slot] as PageDocument['content'] | undefined)?.length) &&
        node.type !== 'Slot'
      )
        return [];
      return [{ ...node, props }];
    });
  return {
    ...document,
    content: distill(document.content),
  };
}

export function bookOverviewDocument(document: PageDocument): PageDocument {
  return projectDocument(document, (node) => literaryDetailedNodes.has(node.type));
}

/** The mounted reader owns these exact native nodes; unrelated composition stays in its original order. */
export function literaryDetailDocument(document: PageDocument, ownedNodes: ReadonlySet<string>): PageDocument {
  return projectDocument(document, (node) => typeof node.props.id === 'string' && ownedNodes.has(node.props.id));
}

/** Open sections use the existing foreground/background tokens in both themes and the ordinary page shell. */
export function BookOverviewRoot({ children }: { children?: ReactNode }) {
  return (
    <div
      data-slot="book-overview"
      className="flex min-w-0 w-full flex-col gap-8 font-sans text-foreground sm:gap-10 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-8"
    >
      {children}
    </div>
  );
}

export function BookOverviewSections({ children }: { children?: ReactNode }) {
  return (
    <div data-slot="book-overview-sections" className="min-w-0 space-y-8 border-t border-border pt-8 sm:space-y-10">
      {children}
    </div>
  );
}
