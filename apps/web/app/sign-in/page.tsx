import { redirect } from 'next/navigation';
import { authMessages } from '../../features/auth/messages.ts';
import { safeReturnPath } from '../../features/auth/paths.ts';
import { readSession } from '../../features/auth/session.ts';
import { requestLocale } from '../../i18n/server.ts';
import { SignInForm } from './sign-in-form.tsx';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  const next = safeReturnPath(query.next);
  if (await readSession()) redirect(next);
  return <main className="mx-auto w-full max-w-md px-4 py-12">
    <SignInForm next={next} messages={authMessages[await requestLocale()]}
      notice={query.error === 'declined' ? 'declined'
        : query.error === 'sign-in' || query.error === 'sign-up' ? 'failed' : null} /></main>;
}
