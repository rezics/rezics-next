import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Card, CardContent } from '@rezics/ui/card';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../../../features/auth/cookies.ts';
import { safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readSession, sessionAgents } from '../../../features/auth/session.ts';
import { ensureOnboarding } from '../../../features/onboarding/ensure.ts';
import { HandleField } from '../../../features/onboarding/handle-field.tsx';
import { messages } from '../../../features/onboarding/messages.ts';
import { PageContainer } from '../../../features/shell/page.tsx';
import LocalizedLink from '../../../features/shell/localized-link.tsx';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export default async function OnboardingPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const query = await searchParams;
  const next = safeReturnPath(query.next, localizedPath('/', locale));
  const session = await readSession();
  if (!session) redirect(signInPath(`${localizedPath('/onboarding', locale)}?next=${encodeURIComponent(next)}`));
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const key = jar.get(SESSION_KEY_COOKIE)?.value;
  const listed = await sessionAgents();
  // Onboarding is only asked for once a Person exists; until then the page
  // renders without calling it, so opening it creates nothing.
  const existing = listed?.items.find(item => item.kind === 'person');
  const outcome = !listed || !token || !key ? { kind: 'unavailable' as const }
    : existing ? await ensureOnboarding(token, key) : { kind: 'name-required' as const };
  const t = messages[locale];
  const label = outcome.kind === 'active'
    ? listed?.items.find(item => item.actingSubject === outcome.person.agent)?.displayName ?? null : null;
  const retryPath = `${localizedPath('/onboarding', locale)}?next=${encodeURIComponent(next)}`;
  const problems: Record<string, string> = { conflict: t.changeConflict, 'invalid-name': t.invalidName,
    invalid: t.invalid };
  const action = localizedPath('/onboarding/finish', locale);
  return <PageContainer className="max-w-xl py-8 sm:py-16">
    <Card><CardContent className="grid gap-6 p-6 sm:p-8">
      {outcome.kind === 'active' || outcome.kind === 'name-required' ? <>
        <header className="grid gap-2">
          <h1 className="font-semibold text-2xl sm:text-3xl">{t.welcome}</h1>
          <p className="text-muted-foreground">{t.welcomeHelp}</p>
        </header>
        {query.error ? <Alert variant="warning"><AlertDescription role="alert">
          {problems[query.error] ?? t.failed}
        </AlertDescription></Alert> : null}
        <HandleField action={action} askName={outcome.kind === 'name-required'}
          initial={outcome.kind === 'active' ? outcome.person.suggestedHandle : ''}
          submit={t.continue} messages={t}>
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          {outcome.kind === 'active' ? <div className="grid gap-1 rounded-lg border border-border bg-muted/40 p-4">
            <span className="text-muted-foreground text-sm">{t.displayName}</span>
            <strong lang={label?.language} dir={label?.direction}>{label?.value}</strong>
            <span className="text-muted-foreground text-sm">{t.displayNameHelp}</span>
          </div> : null}
        </HandleField>
        <p className="text-muted-foreground text-sm">{t.topicsLater}</p>
      </> : <>
        <h1 className="font-semibold text-2xl">{t.pending}</h1>
        <p className="text-muted-foreground">{outcome.kind === 'pending' ? t.pendingHelp : t.failed}</p>
        <LocalizedLink href={retryPath} className="font-medium text-primary underline underline-offset-4">
          {t.retry}</LocalizedLink>
      </>}
    </CardContent></Card>
  </PageContainer>;
}
