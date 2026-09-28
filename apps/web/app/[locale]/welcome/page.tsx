import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { messages } from '../../../features/onboarding/messages.ts';
import { WelcomeFlow } from '../../../features/onboarding/welcome-flow.tsx';
import { readWelcome } from '../../../features/onboarding/welcome-read.ts';
import { PageContainer } from '../../../features/shell/page.tsx';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: messages[isUiLocale(locale) ? locale : 'en'].setupTitle, robots: { index: false } };
}

/** `/welcome?next=`: a new reader's first-minute setup, after choosing a handle and before Home. */
export default async function WelcomePage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }>;
}) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const next = safeReturnPath((await searchParams).next, localizedPath('/', locale));
  const here = `${localizedPath('/welcome', locale)}?next=${encodeURIComponent(next)}`;
  if (!await readSession()) redirect(signInPath(here));
  const welcome = await readWelcome(locale);
  // Choices are made as a person Agent; without one there is nothing to set up yet.
  if (!welcome.actingSubject) redirect(next);
  return <PageContainer className="max-w-4xl py-6 sm:py-10">
    <h1 className="sr-only">{messages[locale].setupTitle}</h1>
    <WelcomeFlow locale={locale} messages={messages[locale]} actingSubject={welcome.actingSubject}
      avatarQuery={welcome.avatarQuery} choices={welcome.choices} savedLanguages={welcome.savedLanguages} next={next} />
  </PageContainer>;
}
