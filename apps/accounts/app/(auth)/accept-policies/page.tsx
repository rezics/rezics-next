import { redirect } from 'next/navigation';
import { accountsConfig } from '../../../features/config/env.ts';
import { readPolicyStatus, readSession } from '../../../features/api/server.ts';
import { AcceptPolicies, PoliciesUnavailable } from '../../../features/auth/accept-policies.tsx';
import { acceptanceContinuation } from '../../../features/auth/policies.ts';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

/** Where a policy change sends someone who signed up under the earlier text (Account's re-acceptance). */
export default async function AcceptPoliciesPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const next = acceptanceContinuation(query.get('continue'));
  const session = await readSession();
  if (session.status === 'signed-out') redirect(`/sign-in?${new URLSearchParams({ next: `/accept-policies?${query}` })}`);
  const status = session.status === 'ok' ? await readPolicyStatus() : undefined;
  if (status?.status === 'ok' && !status.data.acceptanceRequired) redirect(next);
  if (status?.status !== 'ok') return <AuthFrame><PoliciesUnavailable /></AuthFrame>;
  return <AuthFrame><AcceptPolicies policies={status.data.policies} next={next}
    aboutOrigin={accountsConfig().ABOUT_SITE_URL} /></AuthFrame>;
}
