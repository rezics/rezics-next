import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { CreateCommunityPage } from '../../../../features/communities/create-page.tsx';
import { communityText as words } from '../../../../features/communities/messages.ts';
import { ACCESS_COOKIE } from '../../../../features/auth/cookies.ts';
import { sessionAgentState } from '../../../../features/auth/session.ts';
import { requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: words.createTitle[await requestLocale()] };
}

export default async function Page() {
  const [locale, jar] = await Promise.all([requestLocale(), cookies()]);
  const token = jar.get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject : null;
  return <CreateCommunityPage locale={locale} signedIn={Boolean(token)} actingSubject={actingSubject} />;
}
