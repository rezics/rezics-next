import { pickText } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { useLocation } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import type { RelationDefinition } from '../../subject/relations';
import type { PageDocument } from './render';

export type SubjectStreams = {
  entries: { node: string; property: string; direction: 'forward' | 'inverse' }[];
  selected?: string;
};

/** Keep the original document for planning. Only its selected stream participates in rendering. */
export function selectedStreamDocument(document: PageDocument, streams: SubjectStreams | undefined): PageDocument {
  if (!streams?.selected) return document;
  const other = new Set(streams.entries.filter(({ node }) => node !== streams.selected).map(({ node }) => node));
  const visit = (nodes: PageDocument['content']): PageDocument['content'] =>
    nodes.flatMap((node) => {
      if (other.has(node.props.id)) return [];
      const props = { ...node.props };
      for (const [name, value] of Object.entries(props))
        if (Array.isArray(value) && value.length && typeof value[0]?.type === 'string') props[name] = visit(value);
      return [{ ...node, props }];
    });
  return { ...document, content: visit(document.content) };
}

/** Select a native node's first window while retaining the current Subject, locale and population. */
export function subjectStreamHref(href: string, node: string): string {
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set('node', node);
  for (const key of ['cursor', 'streamProperty', 'streamDirection', 'history', 'focus']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}#${node}`;
}

/** A URL-backed role directory works with keyboard navigation and without JavaScript. */
export function SubjectStreamDirectory({
  streams,
  document,
  locale,
  relations,
}: {
  streams: SubjectStreams | undefined;
  document: PageDocument;
  locale: string;
  relations?: Record<string, RelationDefinition> | undefined;
}) {
  const location = useLocation();
  if (!streams || streams.entries.length < 2) return null;
  const titles = new Map<string, string>();
  const visit = (nodes: PageDocument['content']) => {
    for (const node of nodes) {
      const title = node.props.title;
      if (typeof title === 'string') titles.set(node.props.id, title);
      else if (title && typeof title === 'object' && !Array.isArray(title))
        titles.set(node.props.id, pickText(title as Record<string, string>, locale).text);
      for (const value of Object.values(node.props))
        if (Array.isArray(value) && value.length && typeof value[0]?.type === 'string') visit(value);
    }
  };
  visit(document.content);
  return (
    <nav
      data-slot="subject-streams"
      aria-label={m.subject_relations({}, { locale: locale as never })}
      className="flex min-w-0 flex-wrap gap-2"
    >
      {streams.entries.map((entry) => {
        const relation = relations?.[entry.property];
        const label =
          titles.get(entry.node) ||
          (entry.direction === 'forward' ? relation?.forwardLabel : relation?.label) ||
          m.subject_value_unlabelled({}, { locale: locale as never });
        return (
          <a
            key={entry.node}
            href={subjectStreamHref(location.publicHref, entry.node)}
            aria-current={entry.node === streams.selected ? 'page' : undefined}
            className={cn(
              buttonVariants({ variant: entry.node === streams.selected ? 'secondary' : 'outline' }),
              'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
