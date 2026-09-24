import { safeReturnPath } from '../../features/auth/paths.ts';
import { SignInForm } from './sign-in-form.tsx';
import { getTranslation, requestLocale } from '../../i18n/server.ts';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const { data: messages } = await getTranslation('auth', [await requestLocale()]);
  return <main className="page-width"><div className="auth-layout">
    <SignInForm next={safeReturnPath(next)} messages={messages} /></div></main>;
}
