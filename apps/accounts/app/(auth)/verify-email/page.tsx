import { readSession } from '../../../features/api/server.ts';
import { authQuery, authorizationAfterVerification } from '../../../features/auth/auth-query.ts';
import { VerifyEmailResult } from '../../../features/auth/verify-email-result.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { redirect } from 'next/navigation';

/** Where verification links land. Better Auth appends `error` when one fails;
 * an email change marks its steps with `change` (Account's auth.ts), and a
 * sign-up carries where it started so the person can continue there. */
export default async function VerifyEmailPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const change = query.get('change');
  const signedIn = (await readSession()).status === 'ok';
  const { oauthQuery, carry } = authQuery(query);
  if (signedIn && !query.has('error') && !change && oauthQuery) {
    const continuation = authorizationAfterVerification(oauthQuery);
    if (continuation) redirect(continuation);
  }
  return <AuthFrame><VerifyEmailResult failed={query.has('error')} signedIn={signedIn}
    change={change === 'requested' || change === 'verified' ? change : undefined}
    carry={carry} /></AuthFrame>;
}
