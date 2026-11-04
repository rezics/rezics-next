import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { changePageHistoryLimit } from '../../catalogue/subject-changes-navigation';
import { validConceptCursor, type ConceptHierarchyRow } from '../../catalogue/source-concept-explorer';
import type { ConceptVisit } from './visit';

export const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
export const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function HierarchyLinks({
  rows,
  locale,
  returnTo,
}: {
  rows: ConceptHierarchyRow[];
  locale: string;
  returnTo?: string | undefined;
}) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {rows.map((row) => {
        const base = row.conceptPage
          ? catalogueEntries.concepts({ id: row.id, label: row.label, locale }).href
          : subjectHref({ id: row.id, label: row.label }, locale).href;
        return (
          <li key={`${row.direction}:${row.id}`}>
            <a
              className={linkClass}
              href={returnTo ? `${base}?${new URLSearchParams({ returnTo })}` : base}
              lang={row.lang ?? undefined}
            >
              {row.label}
            </a>
            <p className="text-sm text-muted-foreground">{m.concept_visit_inverse_evidence({}, { locale: locale as never })}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function visitAnnouncement(visit: ConceptVisit, locale: string) {
  const o = { locale: locale as never };
  if (visit.loading || visit.busy) return m.concept_explore_loading({}, o);
  if (visit.error)
    return visit.error.reason === 'denied' ? m.concept_explore_denied({}, o) : m.concept_explore_unreadable({}, o);
  if (!visit.read?.admitted) return m.concept_explore_unsupported({}, o);
  if (visit.retained) return m.concept_explore_retained_page({ page: visit.index + 1 }, o);
  switch (visit.read.narrower.state) {
    case 'preparing':
      return m.concept_explore_hierarchy_preparing({}, o);
    case 'unavailable':
      return m.concept_explore_hierarchy_unavailable({}, o);
    case 'unsupported':
      return m.concept_explore_inverse_unsupported({}, o);
    case 'lagging':
      return m.concept_explore_hierarchy_lagging({}, o);
    case 'available':
      return visit.read.narrower.exactEmpty
        ? m.concept_explore_no_narrower({}, o)
        : m.concept_explore_page_ready({}, o);
  }
}

export function ConceptHierarchy({
  visit,
  locale,
  returnTo,
}: {
  visit: ConceptVisit;
  locale: string;
  returnTo?: string | undefined;
}) {
  const o = { locale: locale as never };
  const hierarchy = visit.hierarchy;
  const oversizedCursor = hierarchy?.next !== null && !validConceptCursor(hierarchy?.next ?? undefined);
  const canPage = hierarchy?.state === 'available' || hierarchy?.state === 'lagging';
  return (
    <section className="space-y-3" aria-labelledby="concept-narrower-heading" aria-busy={visit.busy}>
      <h2 id="concept-narrower-heading" className="font-sans text-lg font-semibold">
        {m.concept_explore_narrower({}, o)}
      </h2>
      {visit.failed ? (
        <p role="alert">
          {visit.failed.state === 'preparing'
            ? m.concept_explore_hierarchy_preparing({}, o)
            : m.concept_explore_hierarchy_unavailable({}, o)}
        </p>
      ) : hierarchy?.state === 'unsupported' ? (
        <p>{m.concept_explore_inverse_unsupported({}, o)}</p>
      ) : hierarchy?.state === 'lagging' ? (
        <p>{m.concept_explore_hierarchy_lagging({}, o)}</p>
      ) : null}
      {visit.retained && (
        <p className="rounded-md border border-border p-3" data-slot="retained-hierarchy">
          {m.concept_explore_retained_page({ page: visit.index + 1 }, o)}
        </p>
      )}
      {hierarchy?.rows.length ? (
        <HierarchyLinks rows={hierarchy.rows} locale={locale} returnTo={returnTo} />
      ) : hierarchy?.state === 'available' && hierarchy.exactEmpty ? (
        <p>{m.concept_explore_no_narrower({}, o)}</p>
      ) : hierarchy?.state === 'available' ? (
        <p>{m.concept_explore_page_empty({}, o)}</p>
      ) : null}
      {visit.failed && (
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={visit.busy}
          onClick={() => void visit.retry()}
        >
          {m.concept_explore_retry({}, o)}
        </Button>
      )}
      {canPage && (
        <nav className="flex flex-wrap items-center gap-2" aria-label={m.concept_explore_hierarchy_navigation({}, o)}>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={visit.index === 0 || visit.busy}
            onClick={() => void visit.previous()}
          >
            {m.concept_explore_previous({}, o)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={!hierarchy?.next || oversizedCursor || visit.busy || !!visit.failed}
            onClick={() => void visit.next()}
          >
            {m.concept_explore_more({}, o)}
          </Button>
          <span className="text-sm text-muted-foreground">
            {m.concept_explore_page_position({ current: visit.index + 1, retained: visit.history.addresses.length }, o)}
          </span>
        </nav>
      )}
      {oversizedCursor && <p>{m.concept_explore_cursor_too_large({}, o)}</p>}
      {visit.history.truncated && <p>{m.concept_explore_history_truncated({ limit: changePageHistoryLimit }, o)}</p>}
    </section>
  );
}
