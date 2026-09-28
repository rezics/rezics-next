import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { signInPath } from '../../../features/auth/paths.ts';
import { readAgentProfile } from '../../../features/auth/agent-profile.ts';
import { readSession } from '../../../features/auth/session.ts';
import { ACCESS_COOKIE } from '../../../features/auth/cookies.ts';
import { ProfileSettings } from '../../../features/settings/profile-settings.tsx';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { getMessages } from '../../../i18n/server.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';

export default async function SettingsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const query = await searchParams;
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath('/settings', locale)));
  const agent = session.agent.status === 'selected' ? session.agent.agent : null;
  const profile = agent ? await readAgentProfile(agent.iri, (await cookies()).get(ACCESS_COOKIE)?.value) : null;
  const messages = await getMessages('settings', locale);
  return <ProfileSettings agent={agent} profile={profile}
    accountOrigin={serviceOrigin('ACCOUNT_ORIGIN')}
    locale={locale}
    messages={messages}
    error={query.error ?? null} updated={query.updated === 'handle' || query.updated === 'profile'
      ? query.updated : null} />;
}
