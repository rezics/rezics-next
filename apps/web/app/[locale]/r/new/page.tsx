import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { buttonVariants } from '@rezics/ui/button';
import { CreateCommunityForm } from '../../../../features/communities/create-form.tsx';
import { communityText as words } from '../../../../features/communities/messages.ts';
import { ACCESS_COOKIE } from '../../../../features/auth/cookies.ts';
import { signInPath } from '../../../../features/auth/paths.ts';
import { sessionAgentState } from '../../../../features/auth/session.ts';
import Link from '../../../../features/shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../../../../features/shell/page.tsx';
import { localizedPath } from '../../../../i18n/locale.ts';
import { requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: words.createTitle[await requestLocale()] };
}

export default async function Page() {
  const [locale, jar] = await Promise.all([requestLocale(), cookies()]);
  const token = jar.get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject : null;
  return <PageContainer className="grid gap-8">
    <PageHeader title={words.createTitle[locale]} description={words.createIntro[locale]} />
    {actingSubject ? <CreateCommunityForm actingSubject={actingSubject} locale={locale} />
      : token ? <p role="status">{words.agentNeeded[locale]}</p>
        : <Link href={signInPath(localizedPath('/r/new', locale))} className={buttonVariants()}>
          {words.signIn[locale]}</Link>}
  </PageContainer>;
}
