import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { env } from '../../.storybook/cloudflare-workers';
import { m } from '../paraglide/messages.js';
import type { EditableProfile } from '../settings/editable-profile-source';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const accountId = 'story-viewer';
// The native claim policy admits up to 64 ASCII characters with alphanumeric ends.
const handle = `reader${'a'.repeat(58)}`;
type Call = { method: string; path: string; body: unknown; authorization: string | null; cache: string | null };
const calls: Call[] = [];
let unavailable = false;
let releaseRead: (() => void) | undefined;

const meta = {
  title: 'Pages/Account/Settings',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Runs the generated Settings route, its session gate and its real AccountRenameRegion read. */
export const AccountIdentityAndSafety: Story = {
  name: 'Current account safety',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone390', isRotated: false } },
  beforeEach: () => {
    calls.length = 0;
    unavailable = false;
    releaseRead = undefined;
    const originalFetch = globalThis.fetch;
    const declaration = Object.getOwnPropertyDescriptor(env, 'AUTH_MANAGEMENT_PAGE_ROUTES');
    Object.defineProperty(env, 'AUTH_MANAGEMENT_PAGE_ROUTES', {
      configurable: true,
      value: '["/account/rename"]',
    });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin !== 'http://kernel.local') return originalFetch(input, init);
      const request = new Request(input, init);
      const body: unknown = request.method === 'GET' ? null : await request.clone().json();
      calls.push({
        method: request.method,
        path: url.pathname,
        body,
        authorization: request.headers.get('authorization'),
        cache: request.headers.get('cache-control'),
      });
      if (url.pathname === '/v1/viewerActions' && request.method === 'POST') {
        // The same bounded current-account discovery envelope as the native rename fixtures.
        if (JSON.stringify(body) === JSON.stringify({ resources: [{ type: 'access.account', id: accountId }] }))
          return Response.json({
            resources: [
              {
                type: 'access.account',
                id: accountId,
                viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
              },
            ],
          });
      }
      if (url.pathname === `/v1/accounts/${accountId}/profile` && request.method === 'GET') {
        if (unavailable) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
          return Response.json(
            {
              type: 'https://rezics.com/problems/dependency_unavailable',
              title: 'Service unavailable',
              code: 'dependency_unavailable',
              retryable: true,
              request_id: 'account-identity-read',
            },
            { status: 503 },
          );
        }
        // Keep the existing private profile recording and change only its supplied current handle.
        const response = await originalFetch(request);
        const recorded = (await response.json()) as { profile: EditableProfile };
        return Response.json({ ...recorded, profile: { ...recorded.profile, handle } }, { status: response.status });
      }
      return originalFetch(request);
    }) as typeof fetch;
    return () => {
      releaseRead?.();
      globalThis.fetch = originalFetch;
      if (declaration) Object.defineProperty(env, 'AUTH_MANAGEMENT_PAGE_ROUTES', declaration);
      else Reflect.deleteProperty(env, 'AUTH_MANAGEMENT_PAGE_ROUTES');
    };
  },
  render: () => <PageStory visitor="Signed In" path="/settings" />,
  play: async (context) => {
    await context.step(
      'Default Settings Account shows its genuine recognizable current handle with readable long identity and comfortable bounded safety actions on phones',
      async () => {
        await pageReady(context);
        await selectSettingsCategory(context.canvasElement, m.settings_account_heading());
        const canvas = within(context.canvasElement);
        const region = await canvas.findByRole('region', { name: m.settings_account_heading() });
        const account = within(region);
        const identity = await account.findByText(`@${handle}`);
        const continuation = await account.findByRole('link', { name: m.settings_account_rename_continue() });
        const reload = account.getByRole('button', {
          name: `${m.settings_reload()}: ${m.settings_account_rename_heading()}`,
        });
        await expect(identity.textContent).toBe(`@${handle}`);
        await expect(identity.compareDocumentPosition(continuation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await expect(identity.closest('details')).toBeNull();
        const identityStyle = getComputedStyle(identity);
        await expect(identityStyle.overflowWrap).toBe('anywhere');
        await expect(identityStyle.whiteSpace).toBe('normal');
        await expect(parseFloat(identityStyle.fontSize)).toBeGreaterThanOrEqual(16);
        await expect(identity.getBoundingClientRect().width).toBeCloseTo(continuation.getBoundingClientRect().width, 0);
        await expect(identity.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          continuation.getBoundingClientRect().top,
        );
        const details = account.getByText(m.settings_account_reference_details()).closest('details')!;
        await expect(details).not.toHaveAttribute('open');
        const reference = account.getByText(m.settings_account_rename_identity({ account: accountId }));
        await expect(reference).not.toBeVisible();
        const summary = details.querySelector('summary')!;
        summary.focus();
        await userEvent.keyboard('{Enter}');
        await expect(reference).toBeVisible();
        await userEvent.keyboard('{Enter}');

        const security = account.getByRole('link', { name: m.account_security_settings() });
        const deletion = account.getByRole('link', { name: m.settings_account_delete_continue() });
        const signOut = account.getByRole('button', { name: m.account_sign_out() });
        for (const action of [continuation, reload, security, signOut, deletion, summary]) {
          const style = getComputedStyle(action);
          await expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
          await expect(style.maxWidth).toBe('100%');
          await expect(style.whiteSpace).toBe('normal');
          await expect(style.overflowWrap).toBe('anywhere');
          await expect(action.getBoundingClientRect().width).toBeLessThanOrEqual(region.getBoundingClientRect().width);
          await expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth + 1);
        }
        await expect(security).toHaveAttribute('href', 'https://auth.example.test/security');
        await expect(deletion).toHaveAttribute('href', 'https://auth.example.test/account/delete');
        await expect(security.parentElement).not.toBe(deletion.parentElement);
        for (const [action, description] of [
          [security, m.settings_account_safety_text()],
          [signOut, m.settings_account_sign_out_text()],
          [deletion, m.settings_account_delete_text()],
        ] as const)
          await expect(action).toHaveAccessibleDescription(description);
        await expect(account.getByText(m.settings_account_rename_policy())).toBeVisible();
        await expect(account.getByText(m.settings_account_rename_confirmation())).toBeVisible();
        const currentReads = () =>
          calls.filter(({ path }) => path.endsWith('/profile') || path === '/v1/viewerActions');
        await expect(currentReads()).toHaveLength(2);
        await expect(currentReads().find(({ path }) => path === '/v1/viewerActions')?.body).toEqual({
          resources: [{ type: 'access.account', id: accountId }],
        });
        for (const read of currentReads()) {
          await expect(read.authorization).toBe('Bearer recorded-story-token');
          await expect(read.cache).toBe('no-store');
        }
        const commands = () => calls.filter(({ method, path }) => method !== 'GET' && path !== '/v1/viewerActions');
        await expect(commands()).toHaveLength(0);
        await expect(calls.some(({ path }) => path === '/v1/accounts')).toBe(false);
        await expect(continuation).toHaveAttribute('href', 'https://auth.example.test/account/rename');
        await expect(continuation).toHaveAttribute('referrerpolicy', 'no-referrer');
        const beforeNavigation = [...calls];
        let destination: string | undefined;
        continuation.addEventListener(
          'click',
          (event) => {
            event.preventDefault(); // Keep the real external document link inside this recorded preview.
            destination = (event.currentTarget as HTMLAnchorElement).href;
          },
          { once: true },
        );
        await userEvent.click(continuation);
        await expect(destination).toBe('https://auth.example.test/account/rename');
        await expect(calls).toEqual(beforeNavigation);
        await expect(within(document.body).queryByRole('alertdialog')).toBeNull();
        const form = signOut.closest('form')!;
        await expect(form).toHaveAttribute('method', 'post');
        await expect(form).toHaveAttribute('action', '/auth/sign-out');
        await expect(form.querySelector('[name="csrf_token"]')).toHaveValue('story-csrf-token');
        await expect(signOut).toBeEnabled();

        unavailable = true;
        await userEvent.click(reload);
        await waitFor(() => expect(typeof releaseRead).toBe('function'));
        await expect(reload).toBeDisabled();
        await expect(account.queryByText(`@${handle}`)).toBeNull();
        await expect(account.queryByText(m.settings_account_reference_details())).toBeNull();
        await expect(account.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
        releaseRead!();
        await account.findByText(m.settings_account_rename_failed());
        await expect(account.queryByText(`@${handle}`)).toBeNull();
        await expect(account.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
        await expect(currentReads()).toHaveLength(4);
        await expect(commands()).toHaveLength(0);
        unavailable = false;
        await userEvent.click(reload);
        await account.findByText(`@${handle}`);
        await expect(currentReads()).toHaveLength(6);
        await expect(commands()).toHaveLength(0);
      },
    );
  },
};
