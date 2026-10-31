import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { ProviderQueueView } from '../features/import-review/provider-queue-view';
import type { ProviderQueueRead } from '../features/import-review/provider-queue';
import { providerReviewFixture, type ProviderReviewScenario } from '../kernel/fake/provider-review-actions';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

function QueueStory({ scenario = 'ready' }: { scenario?: ProviderReviewScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => providerReviewFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path="/imports/review" visitor="Signed In">
      <StoryQueue key={`${scenario}:${locale}`} fixture={fixture} scenario={scenario} locale={locale} />
    </PatternStory>
  );
}
function StoryQueue({
  fixture,
  scenario,
  locale,
}: {
  fixture: ReturnType<typeof providerReviewFixture>;
  scenario: ProviderReviewScenario;
  locale: string;
}) {
  const [changed, setChanged] = useState<ProviderQueueRead>();
  return (
    <>
      {scenario === 'scope-change' && (
        <div className="px-4 pt-4">
          <Button
            onClick={() =>
              setChanged({
                ok: true,
                page: {
                  ...fixture.page,
                  scope: { ...fixture.page.scope, status: 'accepted' },
                  statusLabel: m.candidate_accepted(),
                },
              })
            }
          >
            {m.candidate_reload()}
          </Button>
        </div>
      )}
      <ProviderQueueView
        result={changed ?? fixture.result}
        locale={locale}
        transport={fixture.transport}
        onRead={setChanged}
        onRetry={async () => ({ ok: true, page: fixture.page })}
      />
    </>
  );
}
const meta = {
  title: 'Patterns/Imports/Review decisions',
  component: QueueStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Declared queue view samples and generated per-candidate decision transport. Native queue integration and Web/Root visual review remain pending. Use locale, theme and viewport globals.',
      },
    },
  },
} satisfies Meta<typeof QueueStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function select(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  for (const checkbox of await canvas.findAllByRole('checkbox')) await userEvent.click(checkbox);
  return canvas;
}
async function openConfirmation(canvasElement: HTMLElement, reject = false) {
  const canvas = await select(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: reject ? m.candidate_reject() : m.candidate_accept() }));
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
  await waitFor(async () => {
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-open');
  });
  return { canvas, dialog };
}
async function confirm(canvasElement: HTMLElement, reject = false) {
  const { canvas, dialog } = await openConfirmation(canvasElement, reject);
  await userEvent.click(
    within(dialog).getByRole('button', { name: reject ? m.provider_confirm_reject() : m.provider_confirm_accept() }),
  );
  return canvas;
}
export const Ready: Story = {};
export const Selection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement);
    expect(canvas.getByText(m.provider_selected_count({ count: 2 }))).toBeVisible();
  },
};
export const Confirmation: Story = {
  play: async ({ canvasElement }) => {
    await openConfirmation(canvasElement);
  },
};
export const PartialResults: Story = {
  args: { scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    for (const text of [
      m.provider_accepted(),
      m.provider_stale(),
      m.provider_denied(),
      m.provider_rate_limited(),
      m.provider_unavailable(),
    ])
      expect(await canvas.findByText(text)).toBeVisible();
  },
};
export const RetryPartialResults: Story = {
  args: { scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.provider_retry_failed() });
    await expect(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(await canvas.findAllByText(m.provider_accepted())).toHaveLength(3);
  },
};
export const ScopeChange: Story = {
  args: { scenario: 'scope-change' },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    expect(canvas.getByText(m.provider_selected_count({ count: 0 }))).toBeVisible();
    for (const checkbox of canvas.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
  },
};
export const Accepted: Story = {
  args: { scenario: 'success' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    expect(await canvas.findAllByText(m.provider_accepted())).toHaveLength(2);
    expect(canvas.queryByRole('button', { name: m.provider_retry_failed() })).toBeNull();
  },
};
export const Rejected: Story = {
  args: { scenario: 'success' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement, true);
    expect(await canvas.findAllByText(m.provider_rejected())).toHaveLength(2);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.provider_refresh() }));
    expect(await canvas.findAllByRole('checkbox')).toHaveLength(2);
  },
};
