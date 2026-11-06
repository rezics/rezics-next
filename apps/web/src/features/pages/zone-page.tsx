import type { ComponentProps, ReactNode } from 'react';
import { RoutePage, type RoutePageData } from './route';
import { layoutComponents, pageDefinitions, PageHost, PageRoot } from './layout';
import { dataComponents, PageData, type PageMessages } from './data';
import { CompositionRender } from './render';
import { ZoneDestinationsContext, type ZoneDestinations } from './zone-destinations';
import { ZoneSubjectLink } from './zone-subject-link';
import { ZoneTypeList } from './zone-type-list';

const zoneComponents = { ...layoutComponents, ...dataComponents, TypeList: ZoneTypeList };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const slotsByType = new Map(pageDefinitions.map(({ type, slots }) => [type, slots]));

function hasPageHeading(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    if (!isRecord(node) || typeof node.type !== 'string' || !isRecord(node.props)) return false;
    if (node.type === 'SubjectHeader' || (node.type === 'Heading' && node.props.level === 1)) return true;
    return (slotsByType.get(node.type) ?? []).some((slot) =>
      hasPageHeading((node.props as Record<string, unknown>)[slot]),
    );
  });
}

/** Configured Zone pages keep TypeList continuation and subject cards on the Zone route. */
export function ZoneRoutePage({
  page,
  locale,
  heading,
  messages,
  destinations,
}: {
  page: RoutePageData;
  locale: string;
  heading: string;
  messages: PageMessages;
  destinations: ZoneDestinations;
  nonce?: string;
}) {
  return (
    <ZoneDestinationsContext.Provider value={destinations}>
      <PageHost>
        {!hasPageHeading(page.document.content) && <h1 className="sr-only">{heading}</h1>}
        <PageData
          locale={locale}
          subject={page.subject ?? null}
          document={page.document}
          reads={page.reads}
          messages={messages}
          link={ZoneSubjectLink}
        >
          <CompositionRender
            document={page.document}
            definitions={pageDefinitions}
            components={zoneComponents}
            root={PageRoot}
          />
        </PageData>
      </PageHost>
    </ZoneDestinationsContext.Provider>
  );
}

export function zonePageDestinations(zoneId: string, locale: string, route: string, cursor?: string): ZoneDestinations {
  return { zoneId, locale, route, ...(cursor ? { cursor } : {}) };
}

export type { RoutePageData };
export type ZonePageMessages = PageMessages;
export type ZoneRoutePageLink = ComponentProps<typeof RoutePage>['link'];
export type ZonePageChildren = ReactNode;
