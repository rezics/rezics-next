import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ProviderQueue } from '../features/import-review/provider-queue-view';
import { providerQueueFixture, type ProviderQueueScenario } from '../kernel/fake/provider-review-queue';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function QueueStory({ scenario = 'loaded' }: { scenario?: ProviderQueueScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => providerQueueFixture(scenario), [scenario, locale]);
  return (
    <PatternStory path="/imports/review" visitor="Signed In">
      <AppShell>
        <ProviderQueue
          key={`${scenario}:${locale}`}
          transport={fixture.transport}
          initial={fixture.initial}
          initialScope={fixture.scope}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Imports/Review queue',
  component: QueueStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof QueueStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.prq_status() }), 'accepted_unselected');
    await userEvent.click(canvas.getByRole('button', { name: m.prq_load() }));
    expect(await canvas.findAllByText(m.prq_accepted())).toHaveLength(2);
    expect(canvas.getByRole('button', { name: m.candidate_accept() }).hasAttribute('disabled')).toBe(true);
  },
};
export const Preparing: Story = {
  args: { scenario: 'preparing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.prq_retry() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.prq_continue() }));
    expect(await canvas.findByRole('link', { name: m.prq_subject() })).toBeTruthy();
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByText(m.prq_empty())).toBeTruthy();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).queryByRole('button', { name: m.prq_prepare() })).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.prq_prepare() }));
    expect(await canvas.findByText(m.prq_preparing())).toBeTruthy();
  },
};
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Decision: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.provider_confirm_accept() }));
    expect(await canvas.findByText(m.provider_accepted())).toBeTruthy();
  },
};
