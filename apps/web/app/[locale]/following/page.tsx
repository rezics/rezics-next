import { signInPath } from '../../../features/auth/paths.ts';
import { FollowingManager } from '../../../features/relationships/manager.tsx';
import { shellReader } from '../../../features/shell/communities-read.ts';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export default async function FollowingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const reader = await shellReader();
  return <FollowingManager locale={locale} signedIn={reader.signedIn} actingSubject={reader.actingSubject}
    signInHref={signInPath(localizedPath('/following', locale))} />;
}
