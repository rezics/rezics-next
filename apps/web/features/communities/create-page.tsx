import { buttonVariants } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { CreateCommunityForm } from './create-form.tsx';
import { RealmSiteCreation } from './realm-site-creation.tsx';
import { communityText as words } from './messages.ts';

/** The route and stories share the authenticated creation boundary and one page frame. */
export function CreateCommunityPage({ locale, signedIn, actingSubject }: {
  locale: UiLocale; signedIn: boolean; actingSubject: string | null;
}) {
  return <PageContainer className="grid gap-8">
    <PageHeader title={words.createTitle[locale]} description={words.createIntro[locale]} />
    {signedIn && actingSubject ? <>
      <RealmSiteCreation actingSubject={actingSubject} locale={locale} />
      <CreateCommunityForm actingSubject={actingSubject} locale={locale} />
    </>
      : signedIn ? <p role="status">{words.agentNeeded[locale]}</p>
        : <Link href={signInPath(localizedPath('/r/new', locale))} className={buttonVariants()}>
          {words.signIn[locale]}</Link>}
  </PageContainer>;
}
