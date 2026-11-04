import { useRef } from 'react';
import { AuthPage, AuthShell } from '../../frame';
import { m } from '../../paraglide/messages.js';
import { StepUpReturnView } from '../../step-up-return-view';
import type { StepUpHistory, StepUpReturnState } from '../../step-up-return';
import { authLocale, reviewParameters } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Pages/Account/Step-up return',
  parameters: {
    ...reviewParameters,
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
  },
  decorators: [authLocale],
};

function ReturnStory({
  history,
  review,
  canAuthenticate = true,
}: {
  history: StepUpHistory;
  review: StepUpReturnState;
  canAuthenticate?: boolean;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  return (
    <AuthShell>
      <AuthPage heading={m.auth_step_up_heading()}>
        <StepUpReturnView
          history={history}
          review={review}
          canAuthenticate={canAuthenticate}
          continuing={false}
          statusRef={statusRef}
          alertRef={alertRef}
          onRetry={() => {}}
          onContinue={() => {}}
          onAuthenticate={() => {}}
        />
      </AuthPage>
    </AuthShell>
  );
}

export const DispatchUnknown = {
  render: () => <ReturnStory history="unknown" review={{ kind: 'continue', target: '/security' }} />,
};

export const PreDispatchCancellation = {
  render: () => <ReturnStory history="unsent" review={{ kind: 'none' }} />,
};

export const CurrentAdviceUnavailable = {
  render: () => <ReturnStory history="unknown" review={{ kind: 'unavailable' }} canAuthenticate={false} />,
};

export const ReplacedContinuation = {
  render: () => <ReturnStory history="unknown" review={{ kind: 'changed' }} />,
};
