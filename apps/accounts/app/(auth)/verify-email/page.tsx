import { readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { VerifyEmailResult } from '../../../features/auth/verify-email-result.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

/** Where verification links land. Better Auth appends `error` when one fails;
 * an email change marks its steps with `change` (Account's auth.ts), and a
 * sign-up carries where it started so the person can continue there. */
export default async function VerifyEmailPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const change = query.get('change');
  const signedIn = (await readSession()).status === 'ok';
  return <AuthFrame><VerifyEmailResult failed={query.has('error')} signedIn={signedIn}
    change={change === 'requested' || change === 'verified' ? change : undefined}
    carry={authQuery(query).carry} /></AuthFrame>;
}
