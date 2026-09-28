import { buttonVariants } from '@rezics/ui/button';
import { cookies } from 'next/headers';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import { sessionAgentState } from '../auth/session.ts';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import Link from '../shell/localized-link.tsx';
import { PostComposer, type CommunityChoice } from './composer.tsx';
import { postText as words } from './messages.ts';

export async function PostComposePage({ locale, initial }: { locale: UiLocale; initial?: CommunityChoice | null }) {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject : null;
  return <PageContainer className="grid gap-8">
    <PageHeader title={words.title[locale]} description={words.intro[locale]}
      actions={<Link href="/studio" className={buttonVariants({ variant: 'outline' })}>
        {words.createWork[locale]}</Link>} />
    {actingSubject ? <PostComposer locale={locale} actingSubject={actingSubject} initial={initial} />
      : token ? <p role="status">{words.agentNeeded[locale]}</p>
        : <Link href={signInPath(localizedPath('/submit', locale))} className={buttonVariants()}>
          {words.signIn[locale]}</Link>}
  </PageContainer>;
}
