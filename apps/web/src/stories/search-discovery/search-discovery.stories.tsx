import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { currentLinkRefusal, discoveryExample } from '../../kernel/fake/search-discovery';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { DiscoveryResults } from '../../search/discovery-results';
import type { DiscoveryState } from '../../search/discovery';

function Example({ state }: { state: DiscoveryState }) {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <DiscoveryResults state={state} locale={getLocale()} />
    </div>
  );
}

const meta = {
  title: 'Patterns/Discovery/Mixed results',
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
  args: { state: { status: 'ready', page: discoveryExample } },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(4);
    const account = canvasElement.querySelector<HTMLElement>('[data-discovery-account]')!;
    const link = within(account).getByRole('link', { name: 'Mira', exact: true });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/@mira`);
    link.focus();
    await userEvent.tab();
    await expect(within(account).getByRole('link', { name: m.discovery_verified_as({ name: 'Mira' }) })).toHaveFocus();
  },
};

export const HandlelessAccount: Story = {
  args: {
    state: {
      status: 'ready',
      page: {
        ...discoveryExample,
        hits: discoveryExample.hits.filter((hit) => hit.summary.kind === 'account' && !hit.summary.value.handle),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Mira Reading Room' })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const PublicSubject: Story = {
  args: {
    state: {
      status: 'ready',
      page: { ...discoveryExample, hits: discoveryExample.hits.filter((hit) => hit.key.kind === 'schema:Book') },
    },
  },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'Mira’s Atlas' });
    link.focus();
    await expect(link).toHaveFocus();
    await expect(link.getAttribute('href')).toContain(`/subjects/${discoveryExample.hits[3]!.key.id}/`);
  },
};

export const Empty: Story = {
  args: { state: { status: 'ready', page: { ...discoveryExample, hits: [] } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.search_no_results());
  },
};
export const Unavailable: Story = {
  args: { state: { status: 'unavailable' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(m.search_failed());
  },
};
export const NotReady: Story = {
  args: { state: { status: 'not-ready' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.discovery_not_ready());
  },
};
export const Loading: Story = {
  args: { state: { status: 'loading' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  },
};
export const CurrentLinkRefusal: Story = {
  args: { state: { status: 'ready', page: currentLinkRefusal() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Mira', exact: true })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.tab();
    await expect(canvasElement.querySelector('a:focus')).toBeNull();
  },
};
