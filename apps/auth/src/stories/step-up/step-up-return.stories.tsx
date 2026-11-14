import { useRef, useState } from 'react';
import { AuthPage, AuthShell } from '../../frame';
import { m } from '../../paraglide/messages.js';
import { StepUpReturnView } from '../../step-up-return-view';
import type { StepUpHistory, StepUpReturnState } from '../../step-up-return';
import { authLocale, button, reviewParameters, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Account/Step-up return',
  id: 'pages-account-step-up-return',
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
  recover = false,
  continuing = false,
}: {
  history: StepUpHistory;
  review: StepUpReturnState;
  canAuthenticate?: boolean;
  recover?: boolean;
  continuing?: boolean;
}) {
  const [currentReview, setCurrentReview] = useState(review);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  return (
    <AuthShell>
      <AuthPage heading={m.auth_step_up_heading()}>
        <StepUpReturnView
          history={history}
          review={currentReview}
          canAuthenticate={canAuthenticate}
          continuing={continuing}
          statusRef={statusRef}
          alertRef={alertRef}
          onRetry={() => {
            if (recover) setCurrentReview({ kind: 'continue', target: '/security' });
          }}
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

export const CheckingCurrentAdvice = {
  render: () => <ReturnStory history="unknown" review={{ kind: 'checking' }} canAuthenticate={false} />,
};
export const ReplacedAccount = {
  render: () => <ReturnStory history="acknowledged" review={{ kind: 'account-changed' }} canAuthenticate={false} />,
};
export const KnownRefusal = {
  render: () => <ReturnStory history="refused" review={{ kind: 'none' }} />,
};
export const Continuing = {
  render: () => <ReturnStory history="acknowledged" review={{ kind: 'continue', target: '/security' }} continuing />,
};
export const LongLocaleUnresolved = {
  globals: { locale: 'de' },
  render: () => <ReturnStory history="unknown" review={{ kind: 'changed' }} />,
};
export const IndependentReadRecovery = {
  render: () => <ReturnStory history="unknown" review={{ kind: 'unavailable' }} canAuthenticate={false} recover />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_login_retry()))).click();
    await waitFor(() => button(canvasElement, m.auth_step_up_return_continue()));
    if (!canvasElement.textContent?.includes(m.auth_step_up_return_unknown()))
      throw new Error('Recovered advice must retain the earlier unknown authentication outcome');
  },
};
