import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import type { ConceptMembership, ConceptMembershipRow } from '../../catalogue/source-concept-explorer';
import { actionClass, linkClass } from './hierarchy';
import { Button } from '@rezics/ui/shadcn/button';

export function membershipAnnouncement(membership: ConceptMembership, locale: string) {
  const o = { locale: locale as never };
  switch (membership.state) {
    case 'preparing':
      return m.concept_explore_hierarchy_preparing({}, o);
    case 'unavailable':
      return m.concept_explore_hierarchy_unavailable({}, o);
    case 'unsupported':
      return m.concept_explore_inverse_unsupported({}, o);
    case 'lagging':
      return m.concept_explore_hierarchy_lagging({}, o);
    case 'available':
      return membership.exactEmpty ? m.concept_tagged_works_title({}, o) : m.concept_explore_page_ready({}, o);
  }
}

function WorkLink({
  row,
  locale,
  returnTo,
  hrefFor,
}: {
  row: ConceptMembershipRow;
  locale: string;
  returnTo?: string | undefined;
  hrefFor?: ((href: string, row: ConceptMembershipRow) => string) | undefined;
}) {
  const base = subjectHref({ id: row.id, label: row.label }, locale).href;
  const href = hrefFor?.(base, row) ?? (returnTo ? `${base}?${new URLSearchParams({ returnTo })}` : base);
  return (
    <li data-concept-membership-row={row.id} data-concept-membership-property={row.property}>
      <a className={linkClass} href={href} lang={row.lang ?? undefined} data-concept-target={row.id}>
        {row.label}
      </a>
      {row.citations.map((citation) => (
        <a
          key={citation.url}
          className={`${linkClass} ms-3 text-sm`}
          href={citation.url}
          data-source-citation={citation.url}
          rel="noreferrer"
        >
          {citation.url}
        </a>
      ))}
    </li>
  );
}

/** Current inverse work membership. Search admission stays on ConceptTaggedWorks. */
export function ConceptMembershipReading({
  membership,
  locale,
  returnTo,
  hrefFor,
  busy,
  onRetry,
}: {
  membership: ConceptMembership;
  locale: string;
  returnTo?: string | undefined;
  hrefFor?: ((href: string, row: ConceptMembershipRow) => string) | undefined;
  busy?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  const o = { locale: locale as never };
  if (membership.state === 'unsupported') return null;
  return (
    <section className="space-y-2" aria-labelledby="concept-membership-heading" data-slot="concept-membership">
      <h2 id="concept-membership-heading" tabIndex={-1} className="font-sans text-lg font-semibold">
        {m.concept_tagged_works_title({}, o)}
      </h2>
      {membership.state === 'preparing' || membership.state === 'unavailable' ? (
        <div className="space-y-2">
          <p role="status" data-membership-state={membership.state}>
            {membershipAnnouncement(membership, locale)}
          </p>
          {onRetry ? (
            <Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onRetry}>
              {m.concept_explore_retry({}, o)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {membership.state === 'lagging' ? (
        <p role="status" data-membership-state="lagging">
          {membershipAnnouncement(membership, locale)}
        </p>
      ) : null}
      {membership.state === 'available' && membership.exactEmpty ? (
        <p role="status" data-membership-state="empty">
          {m.concept_explore_empty({}, o)}
        </p>
      ) : null}
      {membership.withheld > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.concept_explore_broader_withheld({}, o)}
        </p>
      ) : null}
      {membership.rows.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {membership.rows.map((row) => (
            <WorkLink
              key={`${row.property}:${row.id}`}
              row={row}
              locale={locale}
              returnTo={returnTo}
              hrefFor={hrefFor}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
