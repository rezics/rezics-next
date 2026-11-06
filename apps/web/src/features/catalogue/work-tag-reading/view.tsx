import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import type { Related } from '../../../subject/types';
import { catalogueEntries } from '../catalogue-entry';
import { SourceTagWeight } from '../source-tag-weight';
import { m } from '../../../paraglide/messages.js';
import type { WorkTagReturnSelection } from './entry';
import { conceptLabel, WORK_TAG_PAGE_SIZE, type WorkTagAssertion, type WorkTagProjection } from './model';

function queryHref(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

function TagDetails({
  row,
  related,
  definitions,
  locale,
  workHref,
  spoilerThreshold,
  returnToFor,
}: {
  row: WorkTagAssertion;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  workHref: string;
  spoilerThreshold: number;
  returnToFor?: ((selection: WorkTagReturnSelection) => string) | undefined;
}) {
  const o = { locale: locale as never };
  const label = definitions ? conceptLabel(row.targetId, related, definitions, locale) : undefined;
  if (!label) {
    return (
      <p data-state="unavailable" role="status" className="text-sm text-muted-foreground">
        {m.subject_work_tag_unavailable({}, o)}
      </p>
    );
  }

  const concept = catalogueEntries.concepts({ id: row.targetId, label: label.text, locale });
  const selection = (focus: WorkTagReturnSelection['focus']): WorkTagReturnSelection => ({
    property: row.property,
    statement: row.statement.id,
    spoiler: spoilerThreshold === 1 || spoilerThreshold === 2 ? spoilerThreshold : 0,
    focus,
  });
  const conceptQuery = new URLSearchParams({
    role: row.property,
    returnTo: returnToFor?.(selection('browse')) ?? workHref,
  });
  const evidenceQuery = new URLSearchParams({
    role: row.property,
    returnTo: returnToFor?.(selection('evidence')) ?? workHref,
  });
  if (row.spoilerQualifiers.length) {
    const qualifiers = JSON.stringify(row.spoilerQualifiers);
    conceptQuery.set('tagQualifiers', qualifiers);
    evidenceQuery.set('tagQualifiers', qualifiers);
  }
  if (spoilerThreshold === 1 || spoilerThreshold === 2) {
    conceptQuery.set('spoiler', String(spoilerThreshold));
    evidenceQuery.set('spoiler', String(spoilerThreshold));
  }

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/70 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <a
          data-tag-action="browse"
          href={queryHref(concept.href, conceptQuery)}
          lang={label.lang ?? undefined}
          dir="auto"
          className={`${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]`}
        >
          {label.text}
        </a>
        <a
          data-tag-action="evidence"
          href={queryHref(concept.href, evidenceQuery)}
          className={`${buttonVariants({ variant: 'link', size: 'sm' })} min-h-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]`}
        >
          {m.subject_work_tag_why({}, o)}
        </a>
      </div>
      {row.hasSpoilerQualifier ? (
        <p className="text-xs text-muted-foreground">
          {m.subject_work_tag_spoiler_level({ level: row.spoilerLevel }, o)}
        </p>
      ) : null}
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <SourceTagWeight statement={row.statement} locale={locale} showAbsent />
      </div>
    </div>
  );
}

export function WorkTagReadingView({
  model,
  related,
  definitions,
  locale,
  spoilerThreshold,
  workHref,
  returnToFor,
  returnIntent,
}: {
  model: WorkTagProjection;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  spoilerThreshold: number;
  workHref?: string | undefined;
  returnToFor?: ((selection: WorkTagReturnSelection) => string) | undefined;
  returnIntent?: { selection: WorkTagReturnSelection | undefined; consume: () => void } | undefined;
}) {
  const heading = useId();
  const root = useRef<HTMLElement>(null);
  const selection = returnIntent?.selection;
  const selectedIndex =
    selection?.spoiler === spoilerThreshold
      ? model.rows.findIndex((row) => row.statement.id === selection.statement && row.property === selection.property)
      : -1;
  const [page, setPage] = useState(() => (selectedIndex < 0 ? 0 : Math.floor(selectedIndex / WORK_TAG_PAGE_SIZE)));
  useLayoutEffect(() => {
    if (!returnIntent) return;
    returnIntent.consume();
    const target =
      selectedIndex < 0
        ? undefined
        : root.current?.querySelector<HTMLElement>(
            `[data-tag-index="${selectedIndex}"] [data-tag-action="${selection!.focus}"]`,
          );
    if (document.activeElement === document.body || document.activeElement === root.current) {
      (target ?? root.current?.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [returnIntent]);
  const o = { locale: locale as never };
  const returnHref = workHref ?? model.workHref;
  const start = page * WORK_TAG_PAGE_SIZE;
  const visible = model.rows.slice(start, start + WORK_TAG_PAGE_SIZE);
  const facets = new Map<string, { label: WorkTagAssertion['facetLabel']; rows: WorkTagAssertion[] }>();
  for (const row of visible) {
    const facet = facets.get(row.property) ?? { label: row.facetLabel, rows: [] };
    facet.rows.push(row);
    facets.set(row.property, facet);
  }

  if (model.state === 'unsupported' || model.state === 'empty' || model.state === 'unavailable') {
    const message =
      model.state === 'unsupported'
        ? m.subject_work_tags_unsupported({}, o)
        : model.state === 'empty'
          ? m.subject_work_tags_empty({}, o)
          : m.subject_work_tags_unavailable({}, o);
    return (
      <section
        ref={root}
        id="work-tags"
        aria-labelledby={heading}
        data-slot="subject-concept-tags"
        className="min-w-0 space-y-2"
      >
        <h2 id={heading} tabIndex={-1} className="font-sans text-lg font-semibold">
          {m.subject_tags({}, o)}
        </h2>
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      </section>
    );
  }

  const lastPage = Math.max(0, Math.ceil(model.rows.length / WORK_TAG_PAGE_SIZE) - 1);
  return (
    <section
      ref={root}
      id="work-tags"
      aria-labelledby={heading}
      data-slot="subject-concept-tags"
      className="min-w-0 space-y-3"
    >
      <h2 id={heading} tabIndex={-1} className="font-sans text-lg font-semibold">
        {m.subject_tags({}, o)}
      </h2>
      <p data-slot="subject-tag-population" className="text-sm text-muted-foreground">
        {m.subject_work_tags_available({ count: model.disclosedCount }, o)}
      </p>
      {model.hasUnavailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_work_tags_partial_unavailable({}, o)}
        </p>
      ) : null}
      <dl className="grid min-w-0 gap-4">
        {[...facets.entries()].map(([property, facet]) => (
          <div
            key={property}
            className="grid min-w-0 gap-x-5 gap-y-2 sm:grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] sm:items-start"
          >
            <dt lang={facet.label.lang ?? undefined} dir="auto" className="min-w-0 text-sm text-muted-foreground">
              {facet.label.text}
            </dt>
            <dd>
              <ul aria-label={facet.label.text} className="grid min-w-0 gap-2">
                {facet.rows.map((row) => (
                  <li key={row.key} data-tag-index={model.rows.indexOf(row)} className="min-w-0">
                    <TagDetails
                      row={row}
                      related={related}
                      definitions={definitions}
                      locale={locale}
                      spoilerThreshold={spoilerThreshold}
                      workHref={returnHref}
                      returnToFor={returnToFor}
                    />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
      {lastPage > 0 ? (
        <nav aria-label={m.subject_work_tag_navigation({}, o)} className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            {m.subject_work_tag_previous({}, o)}
          </button>
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={page >= lastPage}
            onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
          >
            {m.subject_work_tag_next({}, o)}
          </button>
        </nav>
      ) : null}
    </section>
  );
}
