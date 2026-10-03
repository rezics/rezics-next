import { authQuery } from '../../../features/auth/auth-query.ts';
import { enrollmentSiteKey } from '../../../features/config/env.ts';
import { RecoveryForm } from '../../../features/auth/recovery-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { authenticate } from '../../../features/auth/form-actions.ts';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const query = await pageQuery(searchParams);
  const action = authenticate.bind(null, {
    operations: ['recover'],
    localChallenge: enrollmentSiteKey() === 'local',
  });
  return (
    <AuthFrame>
      <RecoveryForm
        action={action}
        email={query.get('email') ?? ''}
        carry={authQuery(query).carry}
        turnstileSiteKey={enrollmentSiteKey()}
      />
    </AuthFrame>
  );
}
