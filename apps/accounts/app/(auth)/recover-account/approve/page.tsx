import { RecoveryApproval } from '../../../../features/auth/recovery-claim-form.tsx';
import { AuthFrame } from '../../../../features/shell/auth-frame.tsx';
import { pageQuery, type PageSearchParams } from '../../../../features/shell/search-params.ts';

export default async function RecoveryApprovalPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const query = await pageQuery(searchParams);
  return (
    <AuthFrame>
      <RecoveryApproval claimId={query.get('claimId') ?? ''} />
    </AuthFrame>
  );
}
