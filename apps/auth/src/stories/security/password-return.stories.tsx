import { AuthPage } from '../../frame';
import { m } from '../../paraglide/messages.js';
import { PasswordChangeReturnView } from '../../password-change-return-view';
import type { PasswordChangeReturnHistory } from '../../password-change-return';
import { AuthStory, authLocale, reviewParameters } from '../accounts-operations/story';

export default {
  title: 'Pages/Account/Password change return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

function view(history: PasswordChangeReturnHistory) {
  return (
    <AuthStory>
      <AuthPage heading={m.auth_security_heading()}>
        <PasswordChangeReturnView
          history={history}
          acknowledged={false}
          reading={false}
          canReview
          canStartNew
          advice="allowed"
          onReview={() => {}}
          onAcknowledge={() => {}}
        />
      </AuthPage>
    </AuthStory>
  );
}

export const StageInterrupted = {
  render: () => view({ unknownPhase: 'stage', applicationConfirmed: false }),
};

export const ApprovalInterrupted = {
  render: () => view({ unknownPhase: 'approve', applicationConfirmed: false }),
};

export const ApplicationInterrupted = {
  render: () => view({ unknownPhase: 'apply', applicationConfirmed: false }),
};

export const ApplicationAcknowledged = {
  render: () => view({ unknownPhase: null, applicationConfirmed: true }),
};
