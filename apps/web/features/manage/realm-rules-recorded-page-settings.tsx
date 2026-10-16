import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AdminApi } from './admin-api.ts';
import type { ManageMessages } from './messages.ts';
import { ManageFailure } from './parts.tsx';
import type { readRealmRulesSettings } from './realm-rules-recorded-page.ts';
import { realmHref } from './routes.ts';
import { SettingsAccess } from './settings-access.tsx';
import type { SpaceAccessApi } from './settings-api.ts';
import { SettingsView } from './settings-view.tsx';

/** Shared route display; supplied APIs keep the production interaction on replay's transport. */
export function RealmRulesSettings({ loaded, principal, actingSubject, address, locale, messages, signInHref,
  api, accessApi }: {
  loaded: Awaited<ReturnType<typeof readRealmRulesSettings>>;
  principal: string; actingSubject: string; address: string; locale: UiLocale; messages: ManageMessages;
  signInHref: string; api?: AdminApi; accessApi?: SpaceAccessApi;
}) {
  if (loaded.kind !== 'settings') {
    const result = loaded.result;
    const problem = loaded.kind === 'access-failure'
      ? loaded.result.title ? { title: loaded.result.title, status: loaded.result.status, code: loaded.result.code } : undefined
      : loaded.result.problem;
    const failure = result.failure === 'stale' ? 'moved'
      : result.failure === 'conflict' || result.failure === 'pending' ? 'unavailable' : result.failure;
    return <>
      {problem ? <p role="alert" data-status={problem.status} data-problem-code={problem.code}>{problem.title}</p> : null}
      <ManageFailure failure={failure} locale={locale} messages={messages} signInHref={signInHref}
        retryHref={localizedPath(realmHref(address, 'settings'), locale)} />
    </>;
  }
  const { capability, access, settings } = loaded;
  return <div className="grid gap-8">
    <SettingsAccess key={`access:${capability}:${actingSubject}`} initial={access} realmSettings={settings}
      actingSubject={actingSubject} locale={locale} api={accessApi} />
    <SettingsView principal={principal} key={`rules:${principal}:${capability}:${actingSubject}`} realm={capability}
      actingSubject={actingSubject} initial={settings} locale={locale} messages={messages} api={api} />
  </div>;
}
