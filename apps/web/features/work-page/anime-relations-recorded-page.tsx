import type { WorkAt } from './route.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { ConnectionsSection } from '../work-levels/connections.tsx';
import { copyOf } from '../work-levels/messages.ts';
import { PartsSection } from '../work-levels/parts.tsx';
import type { ConnectionsQuery } from '../work-levels/route.ts';
import type { AnimeRelationsConnections } from './anime-relations-recorded-page.ts';
import type { WorkPageMessages } from './messages.ts';

/** The production connections regions, with Main's disclosure and continuation intact. */
export function AnimeRelationsSections({ view, workRef, id, query, locale, pageMessages }: {
  view: AnimeRelationsConnections; workRef: WorkAt; id: string; query: ConnectionsQuery;
  locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  return <>
    <PartsSection parts={view.parts} wholes={view.wholes} names={view.names} workRef={workRef} query={query}
      locale={locale} t={t} pageMessages={pageMessages} />
    <ConnectionsSection relations={view.relations} franchises={view.franchises} names={view.names} people={view.people}
      workRef={workRef} current={id} query={query} locale={locale} t={t} pageMessages={pageMessages} />
  </>;
}

