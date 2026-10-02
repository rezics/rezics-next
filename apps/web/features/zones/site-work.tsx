import { zoneMemberHref } from '../address/path.ts';
import type { ZonePackage } from '@rezics/zone-sdk';
import { notFound } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { loadWork } from '../work-page/read.ts';
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
export async function ZoneWorkPage({
  base,
  tab,
  search,
  locale,
  pkg,
}: {
  base: ZoneWorkBase;
  tab: WorkTab;
  search: Search;
  locale: UiLocale;
  /** The Zone's running package; its `hubOrder` chooses the hub sections the page leads with. */
  pkg?: ZonePackage | null;
}) {
  const [work, messages] = await Promise.all([
    loadWork(base.ref, locale),
    getMessages('workPage', locale),
  ]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  const common = { workRef: base, id: work.id, locale, messages };
  const scope = scopeAt(base, search);
  const context =
    typeof search.context === 'string' && idOf(iriOf(search.context)) ? search.context : undefined;
  const lead = pkg?.hubOrder;
  return (
    <WorkFrameView {...common} work={work.header} lead={lead}>
      {tab === 'overview' ? (
        <WorkOverview {...common} work={work.header} scope={scope} context={context} lead={lead} />
      ) : tab === 'contents' ? (
        <WorkContents {...common} work={work.header} query={parseContentsQuery(search)} />
      ) : tab === 'versions' ? (
        <WorkVersions {...common} query={parseVersionQuery(search)} />
      ) : tab === 'history' ? (
        <WorkHistory {...common} query={parseHistoryQuery(search)} />
      ) : (
        <WorkDiscussion {...common} scope={scope} cursor={parseCursor(search)} />
      )}
    </WorkFrameView>
  );
}
