import { ResetPasswordForm } from '../../../features/auth/reset-password-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { authenticate } from '../../../features/auth/form-actions.ts';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const query = await pageQuery(searchParams);
  const token = query.get('error') ? undefined : (query.get('token') ?? undefined);
  return (
    <AuthFrame>
      <ResetPasswordForm
        token={token}
        action={authenticate.bind(null, { operations: ['reset'], token })}
      />
    </AuthFrame>
  );
}
