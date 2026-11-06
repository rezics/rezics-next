import type { CompositionDocument } from '@rezics/composition';
import type { ComponentProps, ReactNode } from 'react';
import { RoutePage, type RoutePageData } from '../features/pages/route';
import { subjectPageMessages } from '../features/pages/route-support';
import { withSubjectVisitReturn } from '../features/pages/subject-visit-navigation';
import type { LinkProps, PageLink } from '../features/pages/shared';
import { ZonePageSurface, ZoneShell, zonePageTitle, zoneRouteHeading } from './zone-shell';
import type { ReceivedZonePage } from './receive.ts';
import { projectZoneSlots } from './slots.ts';
import { zoneVisitWithoutCursor, zoneVisitHref, type ZoneVisit } from './visit.ts';

function ZoneMemberLink({ href, lang, className, children }: LinkProps) {
  return (
    <a href={href} lang={lang} className={className}>
      {children}
    </a>
  );
}

export function zonePageHeading(page: ReceivedZonePage, visit: ZoneVisit): string {
  if (visit.target.kind === 'subject') return zonePageTitle(page.zone, '', visit.locale);
  return visit.target.route === ''
    ? zonePageTitle(page.zone, '', visit.locale)
    : zoneRouteHeading(visit.target.route, visit.locale);
}

export function ZoneComposedPage({
  page,
  visit,
  nonce,
  link,
}: {
  page: ReceivedZonePage;
  visit: ZoneVisit;
  nonce?: string;
  link?: PageLink;
}) {
  const slots = projectZoneSlots(page, visit);
  const returnTo = zoneReturnTo(visit);
  const memberLink: PageLink = (props) => {
    const href = props.href.startsWith(`/${visit.locale}/subjects/`)
      ? withSubjectVisitReturn(props.href, returnTo, visit.locale)
      : props.href;
    return <ZoneMemberLink {...props} href={href} />;
  };
  const memberHref = (subject: { id: string; label: string }) => slots.memberHref(subject);
  const listHref =
    visit.target.kind === 'route' ? (node: string, cursor?: string) => slots.listHref(node, cursor) : undefined;
  const route = visit.target.kind === 'route' ? visit.target.route : '';
  const document = page.document as CompositionDocument;
  return (
    <ZoneShell zone={page.zone} locale={visit.locale} route={route}>
      <ZonePageSurface zone={page.zone} document={document}>
        {(merged) => (
          <RoutePage
            page={{ ...page, route, document: merged, reads: slots.reads } as unknown as RoutePageData}
            locale={visit.locale}
            heading={zonePageHeading(page, visit)}
            messages={subjectPageMessages(visit.locale)}
            link={link ?? memberLink}
            currentHref={slots.currentHref}
            {...(listHref ? { listHref } : {})}
            memberHref={memberHref}
            renderJsonLd={false}
            {...(nonce !== undefined ? { nonce } : {})}
          />
        )}
      </ZonePageSurface>
    </ZoneShell>
  );
}

export function zoneReturnTo(visit: ZoneVisit): string {
  return zoneVisitHref(zoneVisitWithoutCursor(visit));
}

export type ZoneComposedPageProps = ComponentProps<typeof ZoneComposedPage>;
export type ZonePageChildren = ReactNode;
