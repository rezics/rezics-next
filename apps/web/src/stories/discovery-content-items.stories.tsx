import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { discoveryExample } from '../kernel/fake/search-discovery';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { DiscoveryResults } from '../search/discovery-results';
import type { DiscoveryState } from '../search/discovery';

const mixedAccountAndCatalogue: DiscoveryState = {
  status: 'ready',
  page: {
    ...discoveryExample,
    hits: discoveryExample.hits.filter((hit) => hit.summary.kind === 'account' || hit.key.kind === 'schema:Book'),
  },
};

function Example({ state }: { state: DiscoveryState }) {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <DiscoveryResults state={state} locale={getLocale()} />
    </div>
  );
}

const meta = {
  title: 'Patterns/Discovery/Shared content items',
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
  args: { state: mixedAccountAndCatalogue },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedAccountAndCatalogue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3);

    const account = canvasElement.querySelector<HTMLElement>(
      `[data-discovery-account="${discoveryExample.hits[1]!.key.id}"]`,
    )!;
    const title = within(account).getByRole('heading', { name: 'Mira', level: 2 });
    const accountLink = within(account).getByRole('link', { name: 'Mira' });
    await expect(title).toBeVisible();
    await expect(accountLink).toHaveAttribute('href', `/${getLocale()}/@mira`);

    const verifiedLink = within(account).getByRole('link', { name: m.discovery_verified_as({ name: 'Mira' }) });
    await expect(verifiedLink.closest('[data-slot="list-row-control"]')).toHaveClass('z-10');
    accountLink.focus();
    await userEvent.tab();
    await expect(verifiedLink).toHaveFocus();

    const handleless = canvasElement.querySelector<HTMLElement>(
      `[data-discovery-account="${discoveryExample.hits[2]!.key.id}"]`,
    )!;
    await expect(within(handleless).getByRole('heading', { name: 'Mira Reading Room', level: 2 })).toBeVisible();
    await expect(within(handleless).queryByRole('link')).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Mira’s Atlas' })).toBeVisible();
  },
};
