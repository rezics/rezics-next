import { messages } from '../../../../features/auth/messages.ts';
import { isSignInFailure, plainProviderCode, safeReturnPath } from '../../../../features/auth/paths.ts';
import { SignInFailed } from '../../../../features/auth/sign-in-failed.tsx';
import { isUiLocale } from '../../../../i18n/define.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

export default async function SignInFailedPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ reason?: string; code?: string; next?: string }>;
}) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const query = await searchParams;
  return <SignInFailed reason={isSignInFailure(query.reason) ? query.reason : 'unknown'}
    providerCode={plainProviderCode(query.code)}
    next={safeReturnPath(query.next, localizedPath('/', locale))} messages={messages[locale]} />;
}
