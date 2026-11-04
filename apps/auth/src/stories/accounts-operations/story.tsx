import { useLayoutEffect, type ReactNode } from 'react';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { AuthShell } from '../../frame';
import { setLocale, locales } from '../../paraglide/runtime.js';
import { operationKeyFor, storePendingOrganizationHandle, type AccountSessionResult } from '../../account-operations';
import { storePendingAccountOperationStepUp } from '../../account-operation-step-up';
import type { InventoryPage, InventoryView } from '../../security-inventory';
import type { InventorySource } from '../../security-inventory-view';
import '../../styles.css';

export const storyAccount = 'story-account';
export function session(kind: 'organization' | 'delete'): AccountSessionResult {
  return {
    kind: 'ready',
    accountId: storyAccount,
    clientId: AUTH_PAGE_OPERATION_CLIENT_ID,
    scopes: [...AUTH_PAGE_OPERATION_SCOPES[kind]],
  };
}

export const populatedInventory: InventorySource = async <V extends InventoryView>(
  view: V,
  cursor?: string,
): Promise<InventoryPage<V>> => {
  const page =
    view === 'clients'
      ? {
          kind: 'ready',
          rows: [
            {
              client_id: 'owned-app',
              display_name: cursor
                ? 'Reading companion'
                : 'A reading application with a long name for shared ownership responsibilities',
              disabled: false,
              scopes: ['subject:read'],
            },
          ],
          next: cursor ? null : 'signed-story-next',
        }
      : {
          kind: 'ready',
          rows: [
            {
              client_id: 'third-party',
              display_name: 'Reading companion',
              granted: ['subject:read'],
              status: 'current',
              reducible: true,
              pending_reduction: false,
            },
            {
              client_id: 'first-party',
              display_name: 'REZICS',
              granted: ['openid'],
              status: 'current',
              reducible: false,
              pending_reduction: false,
            },
            {
              client_id: 'reducing',
              display_name: 'Reading archive',
              granted: [],
              status: 'unavailable',
              reducible: false,
              pending_reduction: true,
            },
          ],
          next: null,
        };
  return page as InventoryPage<V>;
};
export const emptyInventory: InventorySource = async () => ({ kind: 'ready', rows: [], next: null });
export const unavailableInventory: InventorySource = async () => ({ kind: 'unavailable' });
export const deniedInventory: InventorySource = async () => ({ kind: 'denied' });
export const preparingInventory: InventorySource = () => new Promise(() => {});

export const reviewParameters = {
  layout: 'fullscreen',
  viewport: {
    options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    },
  },
};
export function authLocale(Story: () => ReactNode, context: { globals: Record<string, unknown> }) {
  const locale = String(context.globals.locale ?? 'en');
  setLocale(locales.includes(locale as (typeof locales)[number]) ? (locale as (typeof locales)[number]) : 'en', {
    reload: false,
  });
  return <Story />;
}

type Mode =
  | 'success'
  | 'refused'
  | 'closed'
  | 'unavailable'
  | 'unknown'
  | 'unknown-then-refused'
  | 'approval-pending'
  | 'execution-pending'
  | 'last-credential';
/** Story-only HTTP responses. These are presentation fixtures, not native outcome evidence. */
export function AuthStory({
  children,
  mode = 'success',
  returning,
  returningSubmitted,
}: {
  children: ReactNode;
  mode?: Mode;
  returning?: 'delete' | 'organization';
  returningSubmitted?: boolean;
}) {
  useLayoutEffect(() => {
    const originalFetch = globalThis.fetch;
    for (const key of [
      'rezics.account-operation.pending',
      'rezics.account-operation.step-up',
      'rezics.organization.pending-handle',
    ])
      window.sessionStorage.removeItem(key);
    if (returning) {
      const operation =
        returning === 'delete'
          ? { kind: 'delete' as const, accountId: storyAccount }
          : { kind: 'organization' as const, handle: 'reading-group' };
      const operationKey = operationKeyFor(operation, storyAccount);
      storePendingAccountOperationStepUp({
        kind: returning,
        accountId: storyAccount,
        operationKey,
        operation,
        ...(returningSubmitted === undefined ? {} : { submitted: returningSubmitted }),
      });
      if (returning === 'organization') storePendingOrganizationHandle('reading-group');
    }
    let approvals = 0;
    let executions = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const path = url.pathname;
      if (path === '/consent/third-party')
        return Response.json({
          client_id: 'third-party',
          display_name: 'Reading companion',
          scopes: ['openid', 'offline_access', 'subject:read'],
          requested: url.searchParams.get('scope')?.split(' ').filter(Boolean) ?? [],
          granted: ['openid', 'offline_access', 'subject:read'],
          pending_reduction: false,
          acting_account: { account_id: storyAccount, email: 'reader@example.test' },
          decisions: { allow: true, decline: true, switch_account: true },
        });
      if (
        !['/account-operations/approve', '/account-operations/execute', '/consent', '/passkeys/remove'].includes(path)
      )
        return originalFetch(input, init);
      if (path === '/account-operations/approve') {
        approvals++;
        if (mode === 'approval-pending') return new Promise<Response>(() => {});
        if (mode === 'unknown-then-refused' && approvals > 1)
          return Response.json({ error: 'account_operation_denied' }, { status: 403 });
      }
      if (path === '/account-operations/execute') {
        executions++;
        if (mode === 'execution-pending') return new Promise<Response>(() => {});
        if (mode === 'unknown-then-refused' && executions <= 2) throw new TypeError('Story: lost response');
      }
      if (mode === 'unknown' && ['/account-operations/execute', '/consent'].includes(path))
        throw new TypeError('Story: lost response');
      if (mode === 'refused' && path === '/consent')
        return Response.json({ code: 'stale_review' }, { status: 409 });
      const failure =
        mode === 'unavailable'
          ? 503
          : mode === 'closed'
            ? 403
            : mode === 'refused' || mode === 'last-credential'
              ? 409
              : 0;
      if (failure)
        return Response.json(
          { error: mode === 'closed' ? 'platform_closed' : 'account_operation_denied' },
          { status: failure },
        );
      if (path === '/account-operations/approve')
        return Response.json({
          reference: 'story-native-approval',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (path === '/consent') {
        const body = JSON.parse(String(init?.body));
        return Response.json({ client_id: body.client_id, scope: body.scope });
      }
      if (path === '/passkeys/remove') return Response.json({});
      const body = JSON.parse(String(init?.body)) as { operation: { kind: string; accountId?: string } };
      return Response.json({ accountId: body.operation.accountId ?? 'story-organization' });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }, [mode, returning]);
  return <AuthShell>{children}</AuthShell>;
}

export async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const result = read();
    if (result) return result;
    if (Date.now() > end) throw new Error('Expected page state did not appear');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
export function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
export function button(canvas: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...canvas.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
}
