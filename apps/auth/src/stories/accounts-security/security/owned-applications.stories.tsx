import { useMemo } from 'react';
import { AuthPage, AuthShell } from '../../../frame';
import { OwnedApplicationReview } from '../../../owned-application-review-view';
import { m } from '../../../paraglide/messages.js';
import type { InventoryPage, OwnedClient } from '../../../security-inventory';
import type { InventorySource } from '../../../security-inventory-view';
import { authLocale, reviewParameters, button, waitFor } from '../../accounts-operations/story';

export default {
  title: 'Account/Owned applications',
  id: 'pages-account-owned-applications',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const rows: OwnedClient[] = [
  {
    client_id: 'reading-companion-A',
    display_name: 'Reading companion',
    disabled: false,
    scopes: ['subject:read', 'unfamiliar:future'],
  },
  { client_id: 'reading-companion-B', display_name: 'Reading companion', disabled: false, scopes: [] },
  { client_id: 'unnamed-disabled', display_name: ' \t ', disabled: true, scopes: [] },
  {
    client_id: `client-読書-${'識別子'.repeat(24)}`,
    display_name: `読書・閱讀・독서 ${'Long multilingual application name '.repeat(5)}`,
    disabled: false,
    scopes: ['openid', `unfamiliar:${'長い範囲'.repeat(30)}`],
  },
];
type Mode = 'pages' | 'failure' | 'expired' | 'empty' | 'loading' | 'signed-out' | 'denied' | 'unavailable';
function Review({ mode = 'pages', unavailableClipboard = false }: { mode?: Mode; unavailableClipboard?: boolean }) {
  const source = useMemo<InventorySource>(() => {
    let failed = false;
    return async (view, cursor) => {
      if (mode === 'loading') return new Promise(() => {});
      if (mode === 'empty') return { kind: 'ready', rows: [], next: null };
      if (mode === 'signed-out' || mode === 'denied' || mode === 'unavailable') return { kind: mode };
      if (cursor && mode === 'expired') return { kind: 'expired' };
      if (cursor && mode === 'failure' && !failed) {
        failed = true;
        return { kind: 'unavailable' };
      }
      return {
        kind: 'ready',
        rows: cursor ? [{ ...rows[0]!, client_id: 'next-page-client', display_name: 'Next page' }] : rows,
        next: cursor ? null : 'opaque-story-next',
      } as InventoryPage<typeof view>;
    };
  }, [mode]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AuthShell>
        <AuthPage heading={m.auth_security_heading()}>
          <OwnedApplicationReview
            source={source}
            {...(unavailableClipboard
              ? {
                  copyIdentifier: async () => {
                    throw new Error('Clipboard unavailable');
                  },
                }
              : {})}
          />
        </AuthPage>
      </AuthShell>
    </div>
  );
}
async function disclose(canvas: HTMLElement, index: number) {
  (await waitFor(() => canvas.querySelectorAll<HTMLButtonElement>('[data-owned-control]')[index])).click();
  await waitFor(() => canvas.querySelector('[role="region"] h3'));
}

export const LongIdentity = {
  render: () => <Review />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 3),
};
export const DisabledEmptyScopes = {
  render: () => <Review />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 2),
};
export const DuplicateNames = {
  render: () => <Review />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 0),
};
export const NextPrevious = {
  render: () => <Review />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_previous()))).click();
    await disclose(canvasElement, 1);
  },
};
export const FailedNextRetry = {
  render: () => <Review mode="failure" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    (await waitFor(() => button(canvasElement, m.auth_owned_retry()))).click();
    await waitFor(() => canvasElement.textContent?.includes('next-page-client'));
  },
};
export const ExpiredCursor = {
  render: () => <Review mode="expired" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_owned_expired()));
  },
};
export const ClipboardUnavailable = {
  render: () => <Review unavailableClipboard />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await disclose(canvasElement, 0);
    button(canvasElement, m.auth_owned_copy())!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_owned_copy_failed()));
  },
};
export const EmptyPage = { render: () => <Review mode="empty" /> };
export const Loading = { render: () => <Review mode="loading" /> };
export const SignedOut = { render: () => <Review mode="signed-out" /> };
export const Denied = { render: () => <Review mode="denied" /> };
export const Unavailable = { render: () => <Review mode="unavailable" /> };
