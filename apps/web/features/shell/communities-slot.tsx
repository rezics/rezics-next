import { Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { readCommunityNavigation } from './communities-read.ts';
import { CommunityNav } from './community-nav.tsx';

async function Communities({ locale }: { locale: UiLocale }) {
  return <CommunityNav data={await readCommunityNavigation(locale)} />;
}

/**
 * The side navigation's communities, read on the server and streamed in, so
 * pages never wait for them. The root layout passes this to the shell.
 */
export function ShellCommunities({ locale }: { locale: UiLocale }) {
  return <Suspense fallback={null}><Communities locale={locale} /></Suspense>;
}
