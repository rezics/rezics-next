import { useRef, useState } from 'react';
import type { SessionProof } from '@rezics/auth-contract';
import { AuthPage, AuthShell } from '../../../frame';
import { managementOperationProfile } from '../../../management-operations';
import { m } from '../../../paraglide/messages.js';
import type { OpeningReturnEntry } from '../../../operator-opening-return';
import { OpeningCurrentSessionView, OpeningReturnHistoryView } from '../../../operator-opening-return-view';
import { authLocale, button, reviewParameters, waitFor } from '../story';

export default {
  title: 'Pages/Accounts operations/Operators/Opening return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const currentSession = {
  account_id: '33333333-3333-4333-8333-333333333333',
  client_id: managementOperationProfile('opening').client_id,
  scope: [...managementOperationProfile('opening').scope],
  authn_epoch: 4,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['operator'],
} as SessionProof;

function ReturnStory({
  entries,
  source,
  tone = 'light',
}: {
  entries: OpeningReturnEntry[];
  source?: 'opening-response' | 'session-readback';
  tone?: 'light' | 'dark';
}) {
  const [visible, setVisible] = useState(entries);
  const historyFocus = useRef<HTMLElement | null>(null);
  return (
    <div className={tone === 'dark' ? 'dark' : ''}>
      <AuthShell>
        <AuthPage heading={m.auth_opening_heading()}>
          <div className="space-y-5">
            <OpeningReturnHistoryView
              entries={visible}
              focusRef={historyFocus}
              dismiss={() => {
                setVisible([]);
                document.getElementById('opening-current-state-heading')?.focus();
              }}
            />
            {source ? (
              <OpeningCurrentSessionView
                session={currentSession}
                source={source}
                continueHref="/"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{m.auth_opening_unknown()}</p>
            )}
          </div>
        </AuthPage>
      </AuthShell>
    </div>
  );
}

export const CachedReturnWithCurrentObservation = {
  render: () => <ReturnStory entries={['unconfirmed']} source="session-readback" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.querySelector('#opening-return-heading'));
    button(canvasElement, m.auth_opening_return_dismiss())?.click();
    await waitFor(() => !canvasElement.querySelector('#opening-return-heading'));
    if (!canvasElement.querySelector('#opening-current-state-heading'))
      throw new Error('Dismissing history must keep the separate current-session observation visible.');
  },
};

export const AcknowledgedByOpeningResponse = {
  render: () => <ReturnStory entries={['acknowledged']} source="opening-response" />,
};

export const PreflightThenUnknown = {
  render: () => <ReturnStory entries={['review', 'approval', 'unconfirmed']} />,
};

export const ReplacementViewerAndLaterAcknowledgement = {
  globals: { locale: 'zh-Hant' },
  render: () => (
    <ReturnStory entries={['unconfirmed', 'acknowledged']} source="session-readback" tone="dark" />
  ),
};
