import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PublicRealmsPage } from '../../../accounts/public-profile/view';
import type { PublicRealms } from '../../../accounts/public-profile/read';
import realmRecording from '../../../kernel/recorded/realm.json';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { AppShell } from '../../../shell/shell';
import { PatternStory } from '../../page';

function Example({ result }: { result: PublicRealms }) {
  return (
    <PatternStory visitor="Signed Out" path="/@mira/realms">
      <AppShell>
        <PublicRealmsPage handle="mira" title="Mira" locale={getLocale()} result={result} retry={() => {}} />
      </AppShell>
    </PatternStory>
  );
}

async function realmsPageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const main = await canvas.findByRole('main');
  await expect(canvas.getAllByRole('main')).toHaveLength(1);
  const page = within(main);
  await expect(page.getByRole('heading', { level: 1, name: m.public_account_realms() })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: m.public_account_realms() })).toHaveClass('font-sans');
}

const meta = {
  title: 'Pages/Account/Public Realms',
  id: 'pages-accounts-public-realms',
  component: Example,
  play: realmsPageReady,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: {
    result: {
      state: 'ready',
      realms: [
        {
          id: realmRecording.realm.realmId,
          title: realmRecording.realm.title,
          summary: realmRecording.realm.summary,
          role: 'member',
        },
      ],
      next: 'signed-continuation',
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    await realmsPageReady({ canvasElement });
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: realmRecording.realm.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/realms/${realmRecording.realm.realmId}`,
    );
    const next = canvas.getByRole('link', { name: m.public_account_next() });
    next.focus();
    await expect(next).toHaveFocus();
  },
};
export const Empty: Story = { args: { result: { state: 'ready', realms: [], next: null } } };
export const HiddenRows: Story = {
  args: { result: { state: 'ready', realms: [], next: 'signed-continuation' } },
  play: async ({ canvasElement }) => {
    await realmsPageReady({ canvasElement });
    const page = within(within(canvasElement).getByRole('main'));
    await expect(within(canvasElement).getByRole('link', { name: m.public_account_next() })).toBeVisible();
    await expect(within(canvasElement).queryByText(m.public_account_realms_empty())).toBeNull();
    await expect(page.getByRole('link', { name: m.public_account_next() })).toHaveAttribute(
      'href',
      `/${getLocale()}/@mira/realms?cursor=signed-continuation`,
    );
  },
};
export const ExpiredContinuation: Story = { args: { result: { state: 'invalid-cursor' } } };
export const Denied: Story = {
  args: { result: { state: 'denied' } },
  play: async ({ canvasElement }) => {
    await realmsPageReady({ canvasElement });
    const page = within(within(canvasElement).getByRole('main'));
    await expect(page.getByRole('status')).toHaveTextContent(m.public_account_denied());
    await expect(page.queryByRole('list', { name: m.public_account_realms() })).toBeNull();
    await expect(page.queryByRole('link', { name: realmRecording.realm.title })).toBeNull();
    await expect(page.queryByRole('link', { name: m.public_account_next() })).toBeNull();
    await expect(page.queryByText(m.public_account_realms_empty())).toBeNull();
  },
};
export const Unavailable: Story = { args: { result: { state: 'unavailable' } } };
