import { RecoveryClaimForm } from '../../../features/auth/recovery-claim-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { pageQuery, type PageSearchParams } from '../../../features/shell/search-params.ts';

export default async function RecoverAccountPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const query = await pageQuery(searchParams);
  return (
    <AuthFrame>
      <RecoveryClaimForm
        email={query.get('email') ?? ''}
        claimId={query.get('claimId') ?? ''}
        carry={authQuery(query).carry}
      />
    </AuthFrame>
  );
}
