import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

type KernelWrite = { method: string; path: string; body: unknown; key: string | null };
const writes: KernelWrite[] = [];

const meta = {
  title: 'Account/Settings',
  id: 'pages-account-settings',
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    writes.length = 0;
    const original = globalThis.fetch;
    // Observe the installed recorded kernel boundary without replacing any response or product component.
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== 'http://kernel.local' || method === 'GET' || method === 'HEAD') return original(input, init);
      const request = new Request(input, init);
      writes.push({
        method,
        path: url.pathname,
        body: await request.clone().json(),
        key: request.headers.get('idempotency-key'),
      });
      return original(request);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SavingBoundaries: Story = {
  name: 'Saving boundaries',
  tags: ['!dev'],
  globals: {},
  render: () => <PageStory visitor="Signed In" path="/settings#profile" />,
  play: async (context) => {
    await context.step(
      'Default Settings explains automatic versus explicit saves and preserves draft-only profile editing until Save',
      async () => {
        await pageReady(context);
        const view = within(context.canvasElement);
        const profileElement = await view.findByRole('region', { name: m.settings_profile_heading() });
        const profile = within(profileElement);
        await expect(await profile.findByText(m.settings_profile_save_help())).toBeVisible();
        await expect(profile.queryByText(m.settings_profile_unsaved())).toBeNull();
        const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
        const save = profile.getByRole('button', { name: m.settings_profile_save() });
        await expect(save).toBeDisabled();
        await expect(writes).toHaveLength(0);

        // The actual shared inputs/buttons receive their comfortable targets at the Settings callers.
        await expect(profile.getByRole('textbox', { name: m.settings_profile_link_label() })).toBeVisible();
        await expect(profile.getByRole('textbox', { name: m.settings_profile_link_url() })).toBeVisible();
        await expect(profile.getByRole('button', { name: m.settings_profile_choose_avatar() })).toBeVisible();
        await expect(profile.getByRole('button', { name: m.settings_profile_reload_current() })).toBeVisible();
        for (const control of profileElement.querySelectorAll('[data-slot="input"], [data-slot="button"]')) {
          await expect(control).toHaveClass('min-h-11');
          await expect(parseFloat(getComputedStyle(control).minHeight)).toBeGreaterThanOrEqual(44);
        }

        const updatedName = `${(name as HTMLInputElement).value} edited`;
        await userEvent.clear(name);
        await userEvent.type(name, updatedName);
        const unsaved = await profile.findByText(m.settings_profile_unsaved());
        await expect(unsaved).toBeVisible();
        await expect(unsaved).toHaveAttribute('role', 'status');
        await expect(unsaved).toHaveAttribute('aria-live', 'polite');
        await expect(profile.queryByText(m.settings_saved())).toBeNull();
        await expect(save).toBeEnabled();
        await expect(writes).toHaveLength(0);

        await userEvent.click(save);
        await expect(await profile.findByText(m.settings_saved())).toHaveAttribute('role', 'status');
        await expect(profile.queryByText(m.settings_profile_unsaved())).toBeNull();
        await expect(save).toBeDisabled();
        await expect(writes).toHaveLength(1);
        const originalWrite = writes[0]!;
        await expect(originalWrite).toMatchObject({ method: 'PATCH', body: { displayName: updatedName } });
        await expect(originalWrite.body).toEqual({ displayName: updatedName });
        await expect(originalWrite.path).toMatch(/^\/v1\/accounts\/[^/]+$/);
        await expect(originalWrite.key).toBeTruthy();

        const navigation = within(view.getByRole('navigation', { name: m.settings_sections_label() }));
        await userEvent.click(navigation.getByRole('link', { name: m.settings_public_activity_heading() }));
        const activity = within(await view.findByRole('region', { name: m.settings_public_activity_heading() }));
        await expect(activity.getByText(m.settings_public_activity_save_help())).toBeVisible();
        const reviews = await activity.findByRole('switch', { name: m.settings_public_reviews() });
        const wasChecked = reviews.getAttribute('aria-checked') === 'true';
        await userEvent.click(reviews);
        await expect(writes).toHaveLength(1);
        await expect(activity.getByText(m.settings_public_activity_unsaved())).toBeVisible();
        await userEvent.click(activity.getByRole('button', { name: m.settings_profile_save_activity() }));
        await expect(await activity.findByText(m.settings_saved())).toHaveAttribute('role', 'status');
        await expect(reviews).toHaveAttribute('aria-checked', String(!wasChecked));
        await expect(writes).toHaveLength(2);
        await expect(writes[1]).toMatchObject({ method: 'PATCH', path: originalWrite.path });
        await expect(writes[1]!.body).toEqual({ publicViews: { reviews: !wasChecked } });
        await expect(writes[1]!.key).toBeTruthy();
        await expect(writes[1]!.key).not.toBe(originalWrite.key);

        await userEvent.click(navigation.getByRole('link', { name: m.settings_profile_heading() }));
        await expect(name).toHaveValue(updatedName);
        await expect(save).toBeDisabled();
        await expect(profile.queryByText(m.settings_profile_unsaved())).toBeNull();
        await expect(writes).toHaveLength(2);
      },
    );
  },
};
