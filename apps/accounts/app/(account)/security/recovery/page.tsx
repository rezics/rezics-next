import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { RecoverySettings } from '../../../../features/account/recovery-settings.tsx';
import { readGuardianInvitations, readRecoveryPolicy } from '../../../../features/api/server.ts';

export default async function RecoveryPage() {
  return renderAccountPage(
    'security',
    async ({ methods, session }) => {
      const [recovery, invitations] = await Promise.all([
        readRecoveryPolicy(),
        readGuardianInvitations(),
      ]);
      return (
        <RecoverySettings
          recovery={recovery}
          invitations={invitations}
          hasPassword={methods.status !== 'ok' || methods.data.password}
          emailVerified={session.user.emailVerified}
        />
      );
    },
    '/security/recovery',
  );
}
