import { useMemo } from 'react';
import { RenameAccountPage } from '../../routes/account.rename';
import { AuthShell } from '../../frame';
import { RENAME_PROFILE, type RenameRead, type RenameSource } from '../../account-rename';
import { m } from '../../paraglide/messages.js';
import { authLocale, reviewParameters, button, fill, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default { title: 'Pages/Account/Rename/Recovery', parameters: reviewParameters, decorators: [authLocale] };
function Page({ after }: { after: 'refused' | 'signed-out' | 'management-auth-required' | 'ready' | 'acknowledged' }) {
  const source = useMemo<RenameSource>(() => {
    let sent = false;
    const target = {
      accountId: 'story-account',
      handle: 'reader',
      clientId: RENAME_PROFILE.client_id,
      scopes: ['account:update'],
    };
    return {
      readCurrent: async (): Promise<RenameRead> =>
        !sent || after === 'acknowledged'
          ? { kind: 'ready', target }
          : after === 'ready'
            ? { kind: 'ready', target: { ...target, handle: 'new-reader' } }
            : after === 'management-auth-required'
              ? { kind: after, accountId: target.accountId }
              : { kind: after },
      run: async (attempt) => {
        sent = true;
        attempt.submitted = true;
        return after === 'acknowledged'
          ? { kind: 'acknowledged', current: { kind: 'unavailable' } }
          : { kind: 'unknown' };
      },
      stepUp: async () => false,
      stepUpForReview: async () => false,
    };
  }, [after]);
  return (
    <AuthShell>
      <RenameAccountPage source={source} />
    </AuthShell>
  );
}
async function sent(canvasElement: HTMLElement) {
  const input = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#rename-handle'));
  fill(input, 'new-reader');
  canvasElement.querySelector<HTMLInputElement>('#rename-confirm')!.click();
  const submit = await waitFor(() => button(canvasElement, m.auth_rename_submit()));
  await waitFor(() => !submit.disabled);
  submit.click();
}
const reviewed = (after: 'refused' | 'signed-out' | 'management-auth-required' | 'ready') => ({
  render: () => <Page after={after} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await sent(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_rename_unknown()));
    button(canvasElement, m.auth_rename_reload())!.click();
    await waitFor(() => canvasElement.querySelector('button[aria-busy="false"]'));
  },
});
export const UnknownThenRefused = reviewed('refused');
export const UnknownThenSignedOut = reviewed('signed-out');
export const UnknownThenAuthenticationRequired = reviewed('management-auth-required');
export const MatchingCurrentObservation = reviewed('ready');
export const AcknowledgedReadUnavailable = {
  render: () => <Page after="acknowledged" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await sent(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_rename_acknowledged()));
  },
};
