import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PlatformExposurePage } from '../../platform/exposure/page';
import type { Page } from '../../platform/exposure/data';
import { m } from '../../paraglide/messages.js';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

// Illustrative Page fixtures cover presentation states; they do not claim installed data or native permission proof.
const unavailable: Page = { status: 'unavailable', discovery: { status: 'unavailable' } };
const managementOnly: Extract<Page, { status: 'ready' }> = {
  status: 'ready',
  discovery: { status: 'unavailable' },
  current: {
    status: 'available',
    viewer: { accountId: 'story-account', clientId: 'story-client' },
    actions: { open: false, close: false },
    exposureGroups: [{ group: 'collections', open: false, at: '2026-10-31T00:00:00.123456Z' }],
    next: null,
  },
};
const openOnly: Extract<Page, { status: 'ready' }> = {
  status: 'ready',
  discovery: { status: 'available', groups: ['collections'] },
  current: {
    ...managementOnly.current,
    actions: { open: true, close: false },
  },
};
const invalidContinuation: Page = {
  status: 'invalid-cursor',
  discovery: { status: 'available', groups: ['collections'] },
};
const meta = {
  title: 'Pages/Platform exposure/Closed native dependency',
  component: PlatformExposurePage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative closed-state page composition in the existing app shell at /platform/exposure. PatternStory supplies context without running production route guards; these DTOs do not establish native authority or signed-out route access.',
      },
    },
  },
  render: (args) => (
    <PatternStory visitor={args.initial.status === 'signed-out' ? 'Signed Out' : 'Signed In'} path="/platform/exposure">
      <AppShell>
        <PlatformExposurePage {...args} />
      </AppShell>
    </PatternStory>
  ),
  args: {
    initial: unavailable,
    io: {
      read: async () => unavailable,
      change: async () => ({ status: 'not-sent' as const, current: unavailable }),
    },
  },
} satisfies Meta<typeof PlatformExposurePage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function closedPageReady(canvasElement: HTMLElement, refusal: string) {
  const canvas = within(canvasElement);
  const main = await canvas.findByRole('main');
  await expect(canvas.getAllByRole('main')).toHaveLength(1);
  const view = within(main);
  await expect(view.getByRole('heading', { level: 1, name: m.exposure_title() })).toBeVisible();
  await expect(view.getByText(m.exposure_current_unavailable())).toBeVisible();
  await expect(view.getByText(refusal)).toBeVisible();
  await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
}

export const Unavailable: Story = {
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_unavailable());
    const view = within(canvasElement);
    await expect(view.getByText(m.exposure_current_unavailable())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
  },
};
export const SignedOut: Story = {
  args: { initial: { status: 'signed-out', discovery: { status: 'unavailable' } } },
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_signed_out());
  },
};
export const Denied: Story = {
  args: { initial: { status: 'denied', discovery: { status: 'unavailable' } } },
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_denied());
  },
};

export const ManagementOnly: Story = {
  args: { initial: managementOnly },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.exposure_state_closed())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.exposure_action_group({ action: m.exposure_open(), group: 'collections' }) })).toBeNull();
    await expect(view.queryByRole('button', { name: m.exposure_action_group({ action: m.exposure_close(), group: 'collections' }) })).toBeNull();
  },
};

export const InvalidContinuation: Story = {
  args: { initial: invalidContinuation },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.exposure_invalid_cursor())).toBeVisible();
    await expect(view.getByRole('button', { name: m.exposure_first_page() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
  },
};

export const UncertainCommand: Story = {
  args: {
    initial: openOnly,
    io: {
      read: async () => openOnly,
      change: async (operation) => ({ status: 'uncertain', operation, current: openOnly }),
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole('button', { name: m.exposure_action_group({ action: m.exposure_open(), group: 'collections' }) }),
    );
    await userEvent.click(view.getByRole('button', { name: m.exposure_confirm() }));
    await expect(view.getByText(m.exposure_uncertain())).toBeVisible();
    await expect(view.getByRole('button', { name: m.exposure_retry() })).toBeVisible();
  },
};
