import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { SecureAccount } from '../../../../features/account/secure-account.tsx';

export default async function SecureAccountPage() {
  return renderAccountPage('security', ({ methods }) =>
    <SecureAccount twoStep={methods.status === 'ok' && methods.data.totp?.verified === true} />,
  '/security/secure-account');
}
