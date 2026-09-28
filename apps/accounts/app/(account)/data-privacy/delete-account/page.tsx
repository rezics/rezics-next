import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { DeleteAccount } from '../../../../features/account/delete-account.tsx';

export default async function DeleteAccountPage() {
  return renderAccountPage('data-privacy', ({ methods }) =>
    <DeleteAccount hasPassword={methods.status !== 'ok' || methods.data.password} />, '/data-privacy/delete-account');
}
