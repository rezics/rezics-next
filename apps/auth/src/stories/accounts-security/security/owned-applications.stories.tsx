import { useMemo } from 'react';
import { AuthPage, AuthShell } from '../../../frame';
import { OwnedApplicationReview } from '../../../owned-application-review-view';
import { m } from '../../../paraglide/messages.js';
import type { InventoryPage, OwnedClient } from '../../../security-inventory';
import type { InventorySource } from '../../../security-inventory-view';
import { authLocale, reviewParameters, button, waitFor } from '../../accounts-operations/story';

export default { title: 'Pages/Account/Owned applications', parameters: reviewParameters, decorators: [authLocale] };

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
function Review({
  theme,
  mode = 'pages',
  unavailableClipboard = false,
}: {
  theme: 'light' | 'dark';
  mode?: Mode;
  unavailableClipboard?: boolean;
}) {
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
    <div className={`${theme === 'dark' ? 'dark' : ''} min-h-screen bg-background text-foreground`}>
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
const phone = { viewport: { defaultViewport: 'phone390' } };
const desktop = { viewport: { defaultViewport: 'desktop1280' } };

export const PhoneLightLongIdentity = {
  parameters: phone,
  render: () => <Review theme="light" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 3),
};
export const PhoneDarkDisabledEmptyScopes = {
  parameters: phone,
  render: () => <Review theme="dark" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 2),
};
export const DesktopLightDuplicateNames = {
  parameters: desktop,
  render: () => <Review theme="light" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => disclose(canvasElement, 0),
};
export const DesktopDarkNextPrevious = {
  parameters: desktop,
  render: () => <Review theme="dark" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_previous()))).click();
    await disclose(canvasElement, 1);
  },
};
export const FailedNextRetry = {
  parameters: phone,
  render: () => <Review theme="light" mode="failure" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    (await waitFor(() => button(canvasElement, m.auth_owned_retry()))).click();
    await waitFor(() => canvasElement.textContent?.includes('next-page-client'));
  },
};
export const ExpiredCursor = {
  parameters: desktop,
  render: () => <Review theme="dark" mode="expired" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_owned_expired()));
  },
};
export const ClipboardUnavailable = {
  parameters: phone,
  render: () => <Review theme="dark" unavailableClipboard />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await disclose(canvasElement, 0);
    button(canvasElement, m.auth_owned_copy())!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_owned_copy_failed()));
  },
};
export const EmptyPage = { parameters: phone, render: () => <Review theme="light" mode="empty" /> };
export const Loading = { parameters: desktop, render: () => <Review theme="dark" mode="loading" /> };
export const SignedOut = { parameters: phone, render: () => <Review theme="light" mode="signed-out" /> };
export const Denied = { parameters: desktop, render: () => <Review theme="dark" mode="denied" /> };
export const Unavailable = { parameters: phone, render: () => <Review theme="light" mode="unavailable" /> };
