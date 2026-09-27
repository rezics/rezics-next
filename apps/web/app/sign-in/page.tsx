import { Card, CardContent } from '@rezics/ui/card';
import { redirect } from 'next/navigation';
import { safeReturnPath } from '../../features/auth/paths.ts';
import { readSession } from '../../features/auth/session.ts';
import { PageContainer } from '../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../i18n/server.ts';
import { SignInForm } from './sign-in-form.tsx';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  const next = safeReturnPath(query.next);
  if (await readSession()) redirect(next);
  return <PageContainer className="max-w-md sm:py-12"><Card><CardContent>
    <SignInForm next={next} messages={await getMessages('auth', await requestLocale())}
      notice={query.error === 'declined' ? 'declined'
        : query.error === 'sign-in' || query.error === 'sign-up' ? 'failed' : null} />
  </CardContent></Card></PageContainer>;
}
