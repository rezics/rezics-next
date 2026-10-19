import { zoneMemberHref } from '../address/path.ts';
import type { ZoneContext, ZonePackage, ZoneWork } from '@rezics/zone-sdk';
import { notFound } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { zoneText } from '../realm/adapt.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { loadWork } from '../work-page/read.ts';
import { readCatalogueFacts } from './catalogue-facts.ts';
import { SlotBoundary } from './slot-boundary.tsx';
import { ZoneAboutDiscussion } from './about-discussion-entry.tsx';
import { aboutDiscussionAddress } from './about-discussion-intent.ts';
import {
  idOf,
  iriOf,
  parseContentsQuery,
  parseCursor,
  parseHistoryQuery,
  parseVersionQuery,
  scopeAt,
  type WorkTab,
  workTabs,
  type ZoneWorkBase,
} from '../work-page/route.ts';
import {
  WorkContents,
  WorkDiscussion,
  WorkFrameView,
  WorkHistory,
  WorkOverview,
  WorkVersions,
} from '../work-page/work-views.tsx';
import { WorkUnavailable } from '../work-page/work-states.tsx';
import { ConnectionsPage, EditionsPage } from '../work-levels/pages.tsx';
import { parseConnectionsQuery, parseEditionsQuery } from '../work-levels/route.ts';
import { RegionFailure } from '../work-page/region.tsx';

type Search = Record<string, string | string[] | undefined>;

/** The Work's tab a Zone path names: none is the overview, and a name that is not a tab is no page. */
export function workTabOf(tab: string | null): WorkTab {
  if (tab === null) return 'overview';
  const known = workTabs.find((item) => item === tab);
  if (!known || known === 'overview') notFound();
  return known;
}

/** Where a Work's pages are in this Zone's site: under its mount when it came through one, else under `/w`. */
export function workBase(
  ref: string,
  id: string,
  mount: string | null,
  realm: string,
): ZoneWorkBase {
  return { ref: id, path: zoneMemberHref(ref, mount ?? 'w', id), realm };
}

/**
 * The Work's own page and tabs inside the Zone's frame, with the Zone's Realm as their scope unless the URL
 * names another. Nothing here is a second copy of the Work page; `base` only moves its addresses.
 */
const recordedStatus = (value: string | null | undefined): ZoneWork['status'] =>
  value === 'ongoing' || value === 'completed' || value === 'hiatus' || value === 'upcoming'
    || value === 'cancelled' ? value : null;

export async function ZoneWorkPage({
  base,
  tab,
  search,
  locale,
  pkg,
  zone,
}: {
  base: ZoneWorkBase;
  tab: WorkTab;
  search: Search;
  locale: UiLocale;
  /** The Zone's running package; its `hubOrder` chooses the hub sections the page leads with. */
  pkg?: ZonePackage | null;
  /** The Zone the fact panel addresses. Omitted where the page has no catalogue package. */
  zone?: ZoneContext | null;
}) {
  const discussionAddress = aboutDiscussionAddress(base.path);
  // Start the live attachment read with the frame, before its streamed Work regions spend the page deadline.
  const [work, messages, discussion] = await Promise.all([
    loadWork(base.ref, locale),
    getMessages('workPage', locale),
    discussionAddress ? ZoneAboutDiscussion({ spaceRef: discussionAddress.spaceRef, path: discussionAddress.path,
      href: base.path, locale }) : null,
  ]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  const common = { workRef: base, id: work.id, locale, messages };
  const scope = scopeAt(base, search);
  const context =
    typeof search.context === 'string' && idOf(iriOf(search.context)) ? search.context : undefined;
  const lead = pkg?.hubOrder;
  const Panel = pkg?.slots.cataloguePanel;
  const catalogue = pkg?.catalogue;
  const read = tab === 'overview' && Panel && catalogue && zone
    ? await readCatalogueFacts(work.id, locale, catalogue.count, catalogue.formatNames) : null;
  // The year is the Work's own accepted first-publication Statement; no year means none is recorded.
  const facts = read;
  const connections = tab === 'connections' ? parseConnectionsQuery(search) : null;
  const editions = tab === 'editions' ? parseEditionsQuery(search) : null;
  return (
    <WorkFrameView {...common} work={work.header} lead={lead}
      factObligations={facts && !facts.unavailable && (facts.format !== null || facts.years.length || facts.count !== null)
        ? facts.factObligations : undefined}>
      {tab === 'overview' ? (
        <>
          {facts && Panel && zone ? <SlotBoundary slot="cataloguePanel" fallback={null}>
            <Panel zone={zone} work={{ id: work.id, href: base.path, title: zoneText(work.header.title),
              status: recordedStatus(work.header.completionStatus) }} facts={facts} credits={null} fallback={null}
              Link={LocalizedLink} />
          </SlotBoundary> : null}
          <WorkOverview {...common} work={work.header} scope={scope} context={context} lead={lead} />
          {discussion}
        </>
      ) : tab === 'contents' ? (
        <WorkContents {...common} work={work.header} query={parseContentsQuery(search)} />
      ) : tab === 'versions' ? (
        <WorkVersions {...common} query={parseVersionQuery(search)} />
      ) : tab === 'connections' ? (
        connections ? <ConnectionsPage workRef={base} id={work.id}
          query={connections} locale={locale} pageMessages={messages} />
          : <RegionFailure title={messages.connectionsView} failure="invalid" messages={messages} />
      ) : tab === 'editions' ? (
        editions ? <EditionsPage workRef={base} id={work.id}
          query={editions} locale={locale} pageMessages={messages} />
          : <RegionFailure title={messages.editionsView} failure="invalid" messages={messages} />
      ) : tab === 'history' ? (
        <WorkHistory {...common} query={parseHistoryQuery(search)} />
      ) : (
        discussionAddress ? discussion : <WorkDiscussion {...common} scope={scope} cursor={parseCursor(search)} />
      )}
    </WorkFrameView>
  );
}
