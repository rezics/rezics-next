import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
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
import { messages } from './messages.ts';
import { ProfileEditForm } from './profile-edit-form.tsx';

export function ProfileSettings({ agent, profile, locale, error, updated }: {
  agent: AgentOption | null;
  profile: PublicAgentProfile | null;
  locale: UiLocale;
  error: string | null;
  updated: 'handle' | 'profile' | null;
}) {
  const t = messages[locale];
  const ownPerson = agent?.kind === 'person' && agent.path === 'direct-principal';
  const name = profile?.displayName ?? (agent ? agentName(agent, authMessages[locale]) : '');
  const errors: Record<string, string> = { cooldown: t.cooldown, denied: t.denied,
    conflict: t.conflict, invalid: t.invalid, 'avatar-denied': t.avatarDenied,
    'avatar-unavailable': t.avatarUnavailable };
  const errorText = error ? errors[error] ?? t.failed : null;
  return <PageContainer className="grid max-w-2xl gap-6 py-8 sm:py-12">
    <header className="grid gap-2">
      <h1 className="font-semibold text-3xl">{t.title}</h1>
      <p className="text-muted-foreground">{t.description}</p>
    </header>
    {errorText || updated ? <Alert variant={errorText ? 'warning' : 'info'}>
      <AlertDescription role="status">{errorText ?? (updated === 'profile' ? t.profileSaved : t.saved)}</AlertDescription>
    </Alert> : null}
    {agent ? <>
      <Card><CardContent className="grid gap-5 p-6">
        <p className="text-muted-foreground text-sm">{t.actingAs}</p>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar size="lg">
            {profile?.avatarUrl ? <AvatarImage src={`${BFF_PREFIX}${profile.avatarUrl}`} alt="" /> : null}
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
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
    </> : <Card><CardContent className="p-6"><LocalizedLink
      href={localizedPath('/identity', locale)} className="text-primary underline underline-offset-4">
      {t.choose}</LocalizedLink></CardContent></Card>}
  </PageContainer>;
}
