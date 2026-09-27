import { redirect } from 'next/navigation';
import { readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignInFlow } from '../../../features/auth/sign-in-flow.tsx';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function SignInPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const { oauthQuery, next, carry, wantsSignUp } = authQuery(query);
  const reauth = query.get('reauth') === '1';
  const session = await readSession();
  const signedIn = session.status === 'ok' ? session.data : undefined;
  // A signed-in visitor has nothing to do here unless an app or a sensitive
  // page asked for a fresh sign-in.
  if (signedIn && !oauthQuery && !reauth) redirect(next);
  return <AuthFrame>{wantsSignUp
    ? <SignUpForm next={next} oauthQuery={oauthQuery} carry={carry} />
    : <SignInFlow next={next} oauthQuery={oauthQuery} carry={carry}
      reauthEmail={reauth ? signedIn?.user.email : undefined}
      notice={query.get('deleted') === '1' ? 'deleted' : undefined} />}</AuthFrame>;
}
