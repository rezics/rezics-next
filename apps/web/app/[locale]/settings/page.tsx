import { redirect } from 'next/navigation';
import { signInPath } from '../../../features/auth/paths.ts';
import { readAgentProfile } from '../../../features/auth/agent-profile.ts';
import { readSession } from '../../../features/auth/session.ts';
import { ProfileSettings } from '../../../features/settings/profile-settings.tsx';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';

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
  const profile = agent ? await readAgentProfile(agent.iri) : null;
  return <ProfileSettings agent={agent} profile={profile}
    locale={locale}
    error={query.error ?? null} updated={query.updated === 'handle' || query.updated === 'profile'
      ? query.updated : null} />;
}
