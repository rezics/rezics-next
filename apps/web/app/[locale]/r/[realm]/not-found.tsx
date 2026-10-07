import { headers } from 'next/headers';
import { RealmNotFound, RealmUnavailable } from '../../../../features/realm/states.tsx';
import { loadRealmView, RealmFrame } from '../../../../features/realm/realm-page.tsx';
import { realmRefFromPageUrl, ZonePageMissing } from '../../../../features/zones/page-missing.tsx';
import { isUiLocale } from '../../../../i18n/define.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';
import { spaceHref } from '../../../../features/address/path.ts';

export default async function RealmNotFoundPage() {
  const locale = await requestLocale();
  const ref = isUiLocale(locale)
    ? realmRefFromPageUrl((await headers()).get('x-rezics-page-url'))
    : null;
  if (ref && isUiLocale(locale)) {
    const view = await loadRealmView(ref, locale, {});
    if (view.kind === 'view') {
      const messages = await getMessages('zones', locale);
      return (
        <RealmFrame view={view} tab="home" locale={locale} search={{}}>
          <ZonePageMissing
            title={messages.pageMissingTitle}
            body={messages.pageMissingBody}
            back={messages.pageMissingBack}
            href={spaceHref(view.context.ref, 'community')}
          />
        </RealmFrame>
      );
    }
    if (view.kind === 'unavailable')
      return <RealmUnavailable messages={await getMessages('realm', locale)} failure={view.failure}
        reference={view.reference} />;
  }
  return <RealmNotFound messages={await getMessages('realm', locale)} />;
}
