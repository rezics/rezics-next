import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Avatar, AvatarFallback } from '@rezics/ui/avatar';
import { Card, CardContent } from '@rezics/ui/card';
import { agentName, type AgentOption } from '../auth/acting-identity.ts';
import { messages as authMessages } from '../auth/messages.ts';
import { HandleField } from '../onboarding/handle-field.tsx';
import { messages as onboardingMessages } from '../onboarding/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { messages } from './messages.ts';

export function ProfileSettings({ agent, locale, error, updated }: {
  agent: AgentOption | null;
  locale: UiLocale;
  error: string | null;
  updated: boolean;
}) {
  const t = messages[locale];
  const ownPerson = agent?.kind === 'person' && agent.path === 'direct-principal';
  const name = agent ? agentName(agent, authMessages[locale]) : '';
  const errorText = error === 'cooldown' ? t.cooldown
    : error === 'denied' ? t.denied
      : error === 'conflict' ? t.conflict
        : error ? t.failed : null;
  return <PageContainer className="grid max-w-2xl gap-6 py-8 sm:py-12">
    <header className="grid gap-2">
      <h1 className="font-semibold text-3xl">{t.title}</h1>
      <p className="text-muted-foreground">{t.description}</p>
    </header>
    {errorText || updated ? <Alert variant={errorText ? 'warning' : 'info'}>
      <AlertDescription role="status">{errorText ?? t.saved}</AlertDescription></Alert> : null}
    {agent ? <>
      <Card><CardContent className="grid gap-5 p-6">
        <p className="text-muted-foreground text-sm">{t.actingAs}</p>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0"><strong className="block truncate">{name}</strong>
            <span className="text-muted-foreground text-sm">@{agent.handle}</span></div>
        </div>
        <div className="grid gap-1 border-border border-t pt-4">
          <h2 className="font-medium">{t.displayName} & {t.avatar}</h2>
          <p className="text-muted-foreground text-sm">{ownPerson ? t.accountInfo : t.otherInfo}</p>
        </div>
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
