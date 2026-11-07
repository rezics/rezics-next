import { useContext, type ReactNode } from 'react';
import type { OverviewValue, Section } from './overview';
import { OverviewContext } from './overview-context';
import { PageReadState } from './page-read-state';
import { subjectViewHref } from '../../subject/load-subject';
import { m } from '../../paraglide/messages.js';
import { formatCount, type Count } from '../count';
import { linkClass, linkColor } from './shared';

export const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
export const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const anchorClass = 'scroll-mt-32';
const sectionTitleClass = `${headingClass} min-w-0 max-w-full [overflow-wrap:anywhere]`;
const sectionActionClass = `${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-sm font-medium whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

export function useOverview(id: unknown): { value: OverviewValue; section: Section | undefined } | null {
  const value = useContext(OverviewContext);
  if (!value) return null;
  return { value, section: value.sections.get(typeof id === 'string' ? id : '') };
}

export function viewHref(value: OverviewValue, view: string, property?: string): string | null {
  if (
    value.agentBase !== undefined &&
    property === undefined &&
    (view === 'posts' || view === 'reviews' || view === 'collections')
  )
    return `${value.agentBase}/${view}`;
  const href = value.subject
    ? subjectViewHref(
        { id: value.subject, label: value.subjectLabel || value.unlabelled },
        value.locale,
        view,
        property === undefined ? '' : `?property=${encodeURIComponent(property)}`,
      )
    : null;
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  if (!href || !realm) return href;
  return `${href}${href.includes('?') ? '&' : '?'}realm=${encodeURIComponent(realm)}`;
}

/** A preview section: a heading with its count, then the body, then a link to the full view when there is more. */
export function Preview({
  slot,
  id,
  title,
  titleLang,
  count,
  more,
  href,
  locale,
  children,
}: {
  slot: string;
  id: string;
  title: string;
  titleLang?: string | undefined;
  count?: Count | undefined;
  more: boolean;
  href: string | null;
  locale: string;
  children: ReactNode;
}) {
  return (
    <section id={id} data-slot={slot} aria-labelledby={`${id}-title`} className={`${sectionClass} ${anchorClass}`}>
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
        <div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-1">
          <h2 id={`${id}-title`} lang={titleLang} className={sectionTitleClass}>
            {title}
          </h2>
          {count && (
            <span
              data-slot="count"
              className="max-w-full text-sm text-muted-foreground tabular-nums [overflow-wrap:anywhere]"
            >
              {formatCount(count, locale)}
            </span>
          )}
        </div>
        {more && href && (
          <a data-slot="see-all" href={href} aria-describedby={`${id}-title`} className={sectionActionClass}>
            {m.subject_view_all({ label: title }, { locale: locale as never })}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

/** A section whose read did not succeed says so with a retry; the rest of the page is unaffected. */
export function Failed({
  slot,
  id,
  title,
  titleLang,
  locale,
}: {
  slot: string;
  id: string;
  title: string;
  titleLang?: string | undefined;
  locale: string;
}) {
  const value = useContext(OverviewContext);
  const section = value?.sections.get(id);
  const failure = section && !section.ok ? section : {};
  return (
    <section
      id={id}
      data-slot={slot}
      data-state="failed"
      aria-labelledby={`${id}-title`}
      className={`${sectionClass} ${anchorClass}`}
    >
      <h2 id={`${id}-title`} lang={titleLang} className={sectionTitleClass}>
        {title}
      </h2>
      <PageReadState key={JSON.stringify(failure)} failure={failure} locale={locale} describedBy={`${id}-title`} />
    </section>
  );
}
