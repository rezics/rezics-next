import { redirect } from 'next/navigation';
import { readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function SignUpPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { oauthQuery, next, carry } = authQuery(await pageQuery(searchParams));
  if (!oauthQuery && (await readSession()).status === 'ok') redirect(next);
  return <AuthFrame><SignUpForm next={next} oauthQuery={oauthQuery} carry={carry} /></AuthFrame>;
}
