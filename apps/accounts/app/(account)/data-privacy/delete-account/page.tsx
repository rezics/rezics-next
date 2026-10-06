import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { DeleteAccount } from '../../../../features/account/delete-account.tsx';
import { readGuardianInvitations } from '../../../../features/api/server.ts';

export default async function DeleteAccountPage() {
  return renderAccountPage('data-privacy', async ({ methods }) => {
    const duties = await readGuardianInvitations(true);
    return <DeleteAccount hasPassword={methods.status !== 'ok' || methods.data.password}
      guardianDuty={duties.status === 'ok' && duties.data.items.length > 0} />;
  }, '/data-privacy/delete-account');
}
