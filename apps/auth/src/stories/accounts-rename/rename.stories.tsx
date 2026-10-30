import { useMemo } from 'react';
import { RenameAccountPage } from '../../routes/account.rename';
import { AuthShell } from '../../frame';
import { m } from '../../paraglide/messages.js';
import { RENAME_PROFILE, type RenameRead, type RenameSource } from '../../account-rename';
import { authLocale, reviewParameters, button, fill, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default { title: 'Pages/Account/Rename', parameters: reviewParameters, decorators: [authLocale] };

// Presentation fixtures only. Native readback/step-up remain owner integration debt.
function Page({ mode = 'ready' }: { mode?: 'ready' | 'unavailable' | 'signed-out' | 'unknown' }) {
  const source = useMemo<RenameSource>(
    () => ({
      readCurrent: async (): Promise<RenameRead> =>
        mode === 'unavailable' || mode === 'signed-out'
          ? { kind: mode }
          : {
              kind: 'ready',
              target: {
                accountId: 'story-account',
                handle: 'reading-person',
                clientId: RENAME_PROFILE.client_id,
                scopes: [...RENAME_PROFILE.scope],
              },
            },
      run: async (attempt) => {
        if (mode === 'unknown') {
          attempt.submitted = true;
          return { kind: 'unknown' };
        }
        return { kind: 'unavailable' };
      },
      stepUp: async () => false,
    }),
    [mode],
  );
  return (
    <AuthShell>
      <RenameAccountPage source={source} />
    </AuthShell>
  );
}
export const Ready = { render: () => <Page /> };
export const DependencyUnavailable = { render: () => <Page mode="unavailable" /> };
export const SignedOut = { render: () => <Page mode="signed-out" /> };
export const ExplicitConfirmationAndUnknownOutcome = {
  render: () => <Page mode="unknown" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const input = await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#rename-handle'));
    fill(input, 'new-reader');
    const submit = button(canvasElement, m.auth_rename_submit())!;
    if (!submit.disabled) throw new Error('Rename must require explicit confirmation');
    canvasElement.querySelector<HTMLInputElement>('#rename-confirm')!.click();
    await waitFor(() => !submit.disabled);
    submit.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_rename_unknown()));
    if (!input.disabled) throw new Error('An ambiguous operation must keep its original body');
  },
};
