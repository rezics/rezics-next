import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PublicRealmsPage } from '../../../accounts/public-profile/view';
import type { PublicRealms } from '../../../accounts/public-profile/read';
import realmRecording from '../../../kernel/recorded/realm.json';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { PatternStory } from '../../page';

function Example({ result }: { result: PublicRealms }) {
  return (
    <PatternStory>
      <PublicRealmsPage handle="mira" title="Mira" locale={getLocale()} result={result} retry={() => {}} />
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Accounts/Public Realms',
  component: Example,
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
    await expect(within(canvasElement).getByRole('link', { name: m.public_account_next() })).toBeVisible();
    await expect(within(canvasElement).queryByText(m.public_account_realms_empty())).toBeNull();
  },
};
export const ExpiredContinuation: Story = { args: { result: { state: 'invalid-cursor' } } };
export const Denied: Story = { args: { result: { state: 'denied' } } };
export const Unavailable: Story = { args: { result: { state: 'unavailable' } } };
