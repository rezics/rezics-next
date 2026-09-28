import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
import { initials } from '@rezics/ui/avatar-initials';
import { Card, CardContent } from '@rezics/ui/card';
import { agentName, type AgentOption } from '../auth/acting-identity.ts';
import type { PublicAgentProfile } from '../auth/agent-profile.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { messages as authMessages } from '../auth/messages.ts';
import { HandleField } from '../onboarding/handle-field.tsx';
import { messages as onboardingMessages } from '../onboarding/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { messages as fallbackMessages, type SettingsMessages } from './messages.ts';
import { ProfileEditForm } from './profile-edit-form.tsx';
import { SettingsSections } from './settings-sections.tsx';

export function ProfileSettings({ agent, profile, locale, error, updated, accountOrigin, preview,
  messages: translatedMessages }: {
  agent: AgentOption | null;
  profile: PublicAgentProfile | null;
  locale: UiLocale;
  error: string | null;
  updated: 'handle' | 'profile' | null;
  accountOrigin?: string;
  preview?: boolean;
  messages?: SettingsMessages;
}) {
  const t = translatedMessages ?? fallbackMessages[locale];
  const ownPerson = agent?.kind === 'person' && agent.path === 'direct-principal';
  const name = profile?.displayName ?? (agent ? agentName(agent, authMessages[locale]) : '');
  const errors: Record<string, string> = { cooldown: t.cooldown, denied: t.denied,
    conflict: t.conflict, invalid: t.invalid, 'avatar-denied': t.avatarDenied,
    'avatar-unavailable': t.avatarUnavailable };
  const errorText = error ? errors[error] ?? t.failed : null;
  return <PageContainer className="grid max-w-2xl gap-6 py-8 sm:py-12">
    <header className="grid gap-2">
      <h1 className="font-semibold text-3xl">{t.pageTitle}</h1>
      <p className="text-muted-foreground">{t.pageDescription}</p>
    </header>
    <nav aria-label={t.pageTitle} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {(['notifications', 'privacy', 'reading', 'display', 'profile', 'account'] as const)
        .filter(section => !!agent || section !== 'privacy' && section !== 'reading').map(section =>
        <a key={section} href={`#${section}`} className="text-primary underline-offset-4 hover:underline">
          {section === 'notifications' ? t.notificationsTitle : section === 'privacy' ? t.privacyTitle
            : section === 'reading' ? t.readingTitle : section === 'display' ? t.displayTitle
              : section === 'profile' ? t.title : t.accountTitle}</a>)}
    </nav>
    {errorText || updated ? <Alert variant={errorText ? 'warning' : 'info'}>
      <AlertDescription role="status">{errorText ?? (updated === 'profile' ? t.profileSaved : t.saved)}</AlertDescription>
    </Alert> : null}
    <SettingsSections agent={agent?.iri ?? null} locale={locale} t={t}
      accountOrigin={accountOrigin ?? 'https://account.rezics.com'} preview={preview}>
      {agent ? <>
      <Card id="profile"><CardContent className="grid gap-5 p-6">
        <div className="grid gap-1"><h2 className="font-semibold text-xl">{t.title}</h2>
          <p className="text-muted-foreground text-sm">{t.description}</p></div>
        <p className="text-muted-foreground text-sm">{t.actingAs}</p>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar size="lg">
            {profile?.avatarUrl ? <AvatarImage src={`${BFF_PREFIX}${profile.avatarUrl}`} alt="" /> : null}
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0"><strong className="block truncate">{name}</strong>
            <span className="text-muted-foreground text-sm">@{agent.handle}</span></div>
        </div>
        <ProfileEditForm agent={agent.iri} profile={profile} locale={locale} t={t}
          ownPerson={ownPerson} operationKey={crypto.randomUUID()} />
      </CardContent></Card>
      <Card><CardContent className="grid gap-5 p-6">
        <div className="grid gap-1"><h2 className="font-semibold text-xl">{t.handleTitle}</h2>
          <p className="text-muted-foreground text-sm">{t.handleHelp}</p></div>
        <HandleField action={localizedPath('/settings/handle', locale)}
          initial={agent.handle ?? ''} current={agent.handle} submit={t.save}
          messages={onboardingMessages[locale]}>
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <input type="hidden" name="agent" value={agent.iri} />
          <input type="hidden" name="expectedHandle" value={agent.handle ?? ''} />
        </HandleField>
      </CardContent></Card>
    </> : <Card id="profile"><CardContent className="p-6"><LocalizedLink
      href={localizedPath('/identity', locale)} className="text-primary underline underline-offset-4">
      {t.choose}</LocalizedLink></CardContent></Card>}
    </SettingsSections>
  </PageContainer>;
}
