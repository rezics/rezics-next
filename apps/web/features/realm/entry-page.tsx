import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { privateDiscovery } from '../address/space-page.ts';
import { signInPath } from '../auth/paths.ts';
import type { JoinPage, SpaceAccessApi } from '../manage/settings-api.ts';
import { PrivateSpaceJoinPage } from '../space-access/join-page.tsx';

/** A route's limited request landing. Main alone supplies its terms and requester status. */
export function RealmJoinPage({ page, locale, here, actingSubject, api, persist = true }: {
  page: JoinPage; locale: UiLocale; here: string; actingSubject: string | null;
  api?: SpaceAccessApi; persist?: boolean;
}) {
  return <PrivateSpaceJoinPage page={{ ...page, discovery: privateDiscovery(page.discovery) }}
    discoveryMetadata={false} locale={locale} actingSubject={actingSubject}
    signInHref={signInPath(localizedPath(here, locale))} api={api} persist={persist} />;
}
