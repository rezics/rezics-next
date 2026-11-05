import { useMemo, type ReactNode } from 'react';
import { SecurityPage } from '../../../routes/security';
import type { AccountIdentitySource } from '../../../account-identity';
import type { GrantedConsent, InventoryPage, InventoryRows, InventoryView } from '../../../security-inventory';
import type { SecurityLoadResult } from '../../../security';
import type { InventorySource } from '../../../security-inventory-view';
import { m } from '../../../paraglide/messages.js';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  storyAccount,
  button,
  waitFor,
} from '../../accounts-operations/story';

export default {
  title: 'Pages/Account/Connected application navigation',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const initial: SecurityLoadResult = {
  kind: 'ready',
  accountId: storyAccount,
  sessions: [],
  passkeys: { kind: 'ready', passkeys: [] },
  page: {
    viewer: { account_id: storyAccount, session_id: 'current', client_id: 'login' },
    actions: { change_password: 'allowed', register_passkey: 'allowed' },
    sessions: { kind: 'ready', rows: [], limit: 64, truncated: false },
    passkeys: { kind: 'ready', rows: [], limit: 32, truncated: false },
  },
};
const identitySource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: storyAccount,
  email: 'reader@example.test',
});
const nextCursor = 'opaque/consent-page?key=one+two%3A読書';
const thirdCursor = 'opaque/consent-page?key=three';

const consent = (
  clientId: string,
  displayName: string,
  status: GrantedConsent['status'] = 'current',
): GrantedConsent => ({
  client_id: clientId,
  display_name: displayName,
  granted: status === 'current' ? ['subject:read'] : [],
  status,
  reducible: status === 'current',
  pending_reduction: false,
});
const firstRows: InventoryRows['consents'][] = [
  consent('current', 'Reading companion · 読書・閱讀・독서'),
  consent('inactive', 'Archived catalogue', 'inactive'),
  consent('unavailable', 'Unavailable application', 'unavailable'),
];
const middleRows: InventoryRows['consents'][] = [
  consent('middle-current', `Long translated application label ${'書籍・閱讀・독서 '.repeat(8)}`),
  consent('middle-inactive', 'Previously connected application', 'inactive'),
  consent('middle-unavailable', 'Unavailable permissions', 'unavailable'),
];

type Mode = 'pages' | 'empty-next' | 'failed-next' | 'failed-previous' | 'failed-reload' | 'expired' | 'pending';
function Review({ mode, theme }: { mode: Mode; theme: 'light' | 'dark' }) {
  const source = useMemo<InventorySource>(() => {
    const reads = new Map<string, number>();
    return async <V extends InventoryView>(view: V, cursor?: string): Promise<InventoryPage<V>> => {
      if (view === 'clients') return { kind: 'ready', rows: [], next: null } as InventoryPage<V>;
      const key = cursor ?? '<first>';
      const attempt = reads.get(key) ?? 0;
      reads.set(key, attempt + 1);
      if (mode === 'pending' && cursor) return new Promise<InventoryPage<V>>(() => {});
      if (mode === 'expired' && cursor) return { kind: 'expired' } as InventoryPage<V>;
      if (mode === 'failed-next' && cursor === nextCursor && attempt === 0)
        return { kind: 'unavailable' } as InventoryPage<V>;
      if (mode === 'failed-previous' && cursor === undefined && attempt === 1)
        return { kind: 'unavailable' } as InventoryPage<V>;
      if (mode === 'failed-reload' && cursor === nextCursor && attempt === 1)
        return { kind: 'unavailable' } as InventoryPage<V>;
      if (cursor === undefined) {
        return {
          kind: 'ready',
          rows: mode === 'empty-next' ? [] : firstRows,
          next: nextCursor,
        } as InventoryPage<V>;
      }
      if (cursor === nextCursor)
        return { kind: 'ready', rows: middleRows, next: mode === 'pages' ? thirdCursor : null } as InventoryPage<V>;
      if (cursor === thirdCursor) return { kind: 'ready', rows: firstRows, next: null } as InventoryPage<V>;
      return { kind: 'expired' } as InventoryPage<V>;
    };
  }, [mode]);

  const page: ReactNode = (
    <div className={`${theme === 'dark' ? 'dark' : ''} min-h-screen bg-background text-foreground`}>
      <SecurityPage initial={initial} identitySource={identitySource} inventorySource={source} />
    </div>
  );
  return <AuthStory>{page}</AuthStory>;
}

const phone = { viewport: { defaultViewport: 'phone390' } };
const desktop = { viewport: { defaultViewport: 'desktop1280' } };

export const PhoneLightMiddleBackward = {
  parameters: phone,
  render: () => <Review theme="light" mode="pages" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_previous())))!.click();
    await waitFor(() => canvasElement.textContent?.includes('Long translated application label'));
  },
};

export const DesktopDarkCurrentAndInactive = {
  parameters: desktop,
  render: () => <Review theme="dark" mode="pages" />,
};

export const PhoneDarkEmptyWithNext = {
  parameters: phone,
  render: () => <Review theme="dark" mode="empty-next" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.textContent?.includes(m.auth_connected_page_count({ count: 0 })));
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    await waitFor(() => canvasElement.textContent?.includes('Reading companion'));
  },
};

export const DesktopLightFailedNext = {
  parameters: desktop,
  render: () => <Review theme="light" mode="failed-next" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    await waitFor(() => button(canvasElement, m.auth_connected_retry_page()));
  },
};

export const PhoneLightFailedPrevious = {
  parameters: phone,
  render: () => <Review theme="light" mode="failed-previous" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    (await waitFor(() => button(canvasElement, m.auth_inventory_previous())))!.click();
    await waitFor(() => button(canvasElement, m.auth_connected_retry_page()));
  },
};

export const DesktopDarkFailedReload = {
  parameters: desktop,
  render: () => <Review theme="dark" mode="failed-reload" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    (await waitFor(() => button(canvasElement, m.auth_connected_reload_current())))!.click();
    await waitFor(() => button(canvasElement, m.auth_connected_retry_page()));
  },
};

export const PhoneDarkExpiredCursor = {
  parameters: phone,
  render: () => <Review theme="dark" mode="expired" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_expired()));
    await waitFor(() => button(canvasElement, m.auth_connected_first_page()));
  },
};

export const DesktopLightPendingNavigation = {
  parameters: desktop,
  render: () => <Review theme="light" mode="pending" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_inventory_next())))!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_loading()));
  },
};
