import { headers } from 'next/headers';
import { spaceHref } from '../../../../features/address/path.ts';
import { resolveSite } from '../../../../features/realm/read.ts';
import { loadRealmView, RealmFrame } from '../../../../features/realm/realm-page.tsx';
import { RealmNotFound, RealmUnavailable } from '../../../../features/realm/states.tsx';
import { realmRefFromPageUrl, ZonePageMissing } from '../../../../features/zones/page-missing.tsx';
import { isUiLocale } from '../../../../i18n/define.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function SiteNotFoundPage() {
  const locale = await requestLocale();
  const ref = realmRefFromPageUrl((await headers()).get('x-rezics-page-url'));
  if (ref && isUiLocale(locale)) {
    const site = await resolveSite(ref, locale);
    if (site.kind === 'site') {
      const messages = await getMessages('zones', locale);
      const page = (
        <ZonePageMissing
          title={messages.pageMissingTitle}
          body={messages.pageMissingBody}
          back={messages.pageMissingBack}
          href={spaceHref(site.address.canonical, 'site')}
        />
      );
      if (!site.realm) return page;
      const view = await loadRealmView(ref, locale, {}, 'site');
      if (view.kind === 'view')
        return (
          <RealmFrame view={view} tab={null} locale={locale} search={{}}>
            {page}
          </RealmFrame>
        );
      if (view.kind === 'unavailable')
        return <RealmUnavailable messages={await getMessages('realm', locale)} />;
    }
  }
  return <RealmNotFound messages={await getMessages('realm', locale)} />;
}
