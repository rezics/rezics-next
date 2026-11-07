import { m } from '../../../paraglide/messages.js';
import { actionClass, linkClass } from './hierarchy';
import { Button } from '@rezics/ui/shadcn/button';

export const membershipProperties = ['schema:genre', 'schema:keywords'] as const;
export type MembershipProperty = (typeof membershipProperties)[number];
export type ConceptHierarchyState = 'available' | 'lagging' | 'preparing' | 'unavailable' | 'unsupported';

export type ConceptMembershipRow = {
  id: string;
  label: string;
  lang: string | null;
  type: string;
  property: MembershipProperty;
  workPage: boolean;
  citations: { url: string }[];
};

export type ConceptMembershipStream = {
  property: MembershipProperty;
  state: ConceptHierarchyState;
  rows: ConceptMembershipRow[];
  cursor?: string;
  next: string | null;
  exactEmpty: boolean;
  unknownTotal: boolean;
  withheld: number;
};

export type ConceptMembership = {
  state: ConceptHierarchyState;
  rows: ConceptMembershipRow[];
  next: string | null;
  exactEmpty: boolean;
  withheld: number;
  streams: Record<MembershipProperty, ConceptMembershipStream>;
};

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

function streamHeading(property: MembershipProperty, locale: string) {
  const o = { locale: locale as never };
  return `${m.concept_tagged_works_property({}, o)} ${property}`;
}

function streamStatus(stream: ConceptMembershipStream, locale: string) {
  const o = { locale: locale as never };
  if (stream.state === 'preparing') return m.concept_explore_hierarchy_preparing({}, o);
  if (stream.state === 'unavailable') return m.concept_explore_hierarchy_unavailable({}, o);
  if (stream.state === 'lagging') return m.concept_explore_hierarchy_lagging({}, o);
  if (stream.exactEmpty) return m.concept_explore_empty({}, o);
  if (stream.unknownTotal) return m.concept_explore_page_empty({}, o);
  if (!stream.rows.length && stream.next) return m.concept_explore_page_empty({}, o);
  return null;
}

function WorkLink({
  row,
  href,
}: {
  row: ConceptMembershipRow;
  href: string;
}) {
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

function MembershipStreamReading({
  stream,
  locale,
  hrefFor,
  busy,
  index,
  onNext,
  onPrevious,
  onRetry,
}: {
  stream: ConceptMembershipStream;
  locale: string;
  hrefFor: (row: ConceptMembershipRow) => string;
  busy?: boolean | undefined;
  index: number;
  onNext?: ((property: MembershipProperty) => void) | undefined;
  onPrevious?: ((property: MembershipProperty) => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const o = { locale: locale as never };
  if (stream.state === 'unsupported') return null;
  const status = streamStatus(stream, locale);
  const canPage = stream.state === 'available' || stream.state === 'lagging';
  const oversized = stream.next !== null && new TextEncoder().encode(stream.next).byteLength > 4096;
  const state =
    stream.state === 'available' && stream.exactEmpty
      ? 'empty'
      : stream.state === 'available' && stream.unknownTotal
        ? 'unknown'
        : stream.state === 'available' && !stream.rows.length && stream.next
          ? 'sparse'
          : stream.state;
  return (
    <section
      className="space-y-2"
      aria-labelledby={`concept-membership-${stream.property}-heading`}
      data-slot="concept-membership-stream"
      data-concept-membership-property={stream.property}
      data-membership-state={state}
    >
      <h3 id={`concept-membership-${stream.property}-heading`} className="font-sans text-base font-semibold">
        {streamHeading(stream.property, locale)}
      </h3>
      {status ? (
        <p role="status" data-membership-stream-state={state}>
          {status}
        </p>
      ) : null}
      {(stream.state === 'preparing' || stream.state === 'unavailable') && onRetry ? (
        <Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onRetry}>
          {m.concept_explore_retry({}, o)}
        </Button>
      ) : null}
      {stream.withheld > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.concept_explore_broader_withheld({}, o)}
        </p>
      ) : null}
      {stream.rows.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {stream.rows.map((row) => (
            <WorkLink key={`${row.property}:${row.id}`} row={row} href={hrefFor(row)} />
          ))}
        </ul>
      ) : null}
      {canPage && (onNext || onPrevious) ? (
        <nav className="flex flex-wrap items-center gap-2" aria-label={streamHeading(stream.property, locale)}>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={index === 0 || busy || !onPrevious}
            onClick={() => onPrevious?.(stream.property)}
          >
            {m.concept_explore_previous({}, o)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={!stream.next || oversized || busy || !onNext}
            onClick={() => onNext?.(stream.property)}
          >
            {m.concept_tagged_works_next({}, o)}
          </Button>
        </nav>
      ) : null}
      {oversized ? <p>{m.concept_explore_cursor_too_large({}, o)}</p> : null}
    </section>
  );
}

/** Current inverse work membership. Search admission stays on ConceptTaggedWorks. */
export function ConceptMembershipReading({
  membership,
  locale,
  hrefFor,
  busy,
  onRetry,
  onNext,
  onPrevious,
  indexFor,
}: {
  membership: ConceptMembership;
  locale: string;
  hrefFor: (row: ConceptMembershipRow) => string;
  busy?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  onNext?: ((property: MembershipProperty) => void) | undefined;
  onPrevious?: ((property: MembershipProperty) => void) | undefined;
  indexFor?: ((property: MembershipProperty) => number) | undefined;
}) {
  const o = { locale: locale as never };
  if (membership.state === 'unsupported') return null;
  return (
    <section className="space-y-4" aria-labelledby="concept-membership-heading" data-slot="concept-membership">
      <h2 id="concept-membership-heading" tabIndex={-1} className="font-sans text-lg font-semibold">
        {m.concept_tagged_works_title({}, o)}
      </h2>
      {membership.state === 'preparing' || membership.state === 'unavailable' ? (
        <p role="status" data-membership-state={membership.state}>
          {membershipAnnouncement(membership, locale)}
        </p>
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
      {membershipProperties.map((property) => (
        <MembershipStreamReading
          key={property}
          stream={membership.streams[property]}
          locale={locale}
          hrefFor={hrefFor}
          {...(busy !== undefined ? { busy } : {})}
          index={indexFor?.(property) ?? 0}
          onNext={onNext}
          onPrevious={onPrevious}
          onRetry={onRetry}
        />
      ))}
    </section>
  );
}
