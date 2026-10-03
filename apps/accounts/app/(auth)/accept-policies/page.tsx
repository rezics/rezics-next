import { redirect } from 'next/navigation';
import { accountsConfig } from '../../../features/config/env.ts';
import { readPolicyStatus, readSession } from '../../../features/api/server.ts';
import { AcceptPolicies, PoliciesUnavailable } from '../../../features/auth/accept-policies.tsx';
import { safeReturnPath } from '../../../features/api/oauth-query.ts';
import { acceptanceSignInPath, acceptanceContinuation } from '../../../features/auth/policies.ts';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { authenticate } from '../../../features/auth/form-actions.ts';
import { acceptances } from '../../../features/auth/policies.ts';

/** Where a policy change sends someone who signed up under the earlier text (Account's re-acceptance). */
export default async function AcceptPoliciesPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const query = await pageQuery(searchParams);
  const next = query.has('continue')
    ? acceptanceContinuation(query.get('continue'))
    : safeReturnPath(query.get('next'));
  const signIn = acceptanceSignInPath(query.get('return'));
  const session = await readSession();
  if (session.status === 'signed-out')
    redirect(`/sign-in?${new URLSearchParams({ next: `/accept-policies?${query}` })}`);
  const status = session.status === 'ok' ? await readPolicyStatus() : undefined;
  if (status?.status === 'ok' && !status.data.acceptanceRequired) redirect(next);
  if (status?.status !== 'ok')
    return (
      <AuthFrame>
        <PoliciesUnavailable retryHref={`/accept-policies?${query}`} />
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <AcceptPolicies
        policies={status.data.policies}
        next={next}
        signIn={signIn}
        action={authenticate.bind(null, {
          operations: ['accept', 'decline'],
          next,
          signIn,
          policies: acceptances(status.data.policies),
        })}
        aboutOrigin={accountsConfig().ABOUT_SITE_URL}
      />
    </AuthFrame>
  );
}
