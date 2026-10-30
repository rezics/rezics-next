import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { WorkPartsPage } from '../features/catalogue/work-parts-page';
import { workPartsFixture, type WorkPartsScenario } from '../kernel/fake/work-parts';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function WorkPartsExample({ scenario }: { scenario: WorkPartsScenario | 'loading' }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => workPartsFixture(scenario === 'loading' ? 'current' : scenario, locale),
    [scenario, locale],
  );
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <WorkPartsPage
          key={`${scenario}:${locale}`}
          id={fixture.id}
          locale={locale}
          initial={scenario === 'loading' ? undefined : fixture.snapshot()}
          search={fixture.search}
          transport={
            scenario === 'loading' ? { ...fixture.transport, read: () => new Promise(() => {}) } : fixture.transport
          }
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Patterns/Catalogue/Work parts',
  component: WorkPartsExample,
  parameters: { layout: 'fullscreen' },
  args: { scenario: 'current' },
} satisfies Meta<typeof WorkPartsExample>;
export default meta;
type Story = StoryObj<typeof meta>;
async function proposeCorrection(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_correct() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.relation_open() }));
  const position = await canvas.findByLabelText(
    pickText(bundledRelease.properties['schema:position']!.labels, getLocale()).text,
  );
  await userEvent.clear(position);
  await userEvent.type(position, '10');
  await userEvent.click(await canvas.findByRole('button', { name: m.relation_propose() }));
  const confirmation = await canvas.findByRole('group', {
    name: m.candidate_confirm_title({ action: m.relation_propose() }),
  });
  await userEvent.click(within(confirmation).getByRole('button', { name: m.relation_propose() }));
  return canvas;
}
export const Current: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await proposeCorrection(canvasElement);
    await expect(
      canvas.findByText(m.work_parts_candidate({ candidate: '00000000-0000-4000-8000-000000000804' })),
    ).resolves.toBeVisible();
  },
};
export const Partial: Story = {
  args: { scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_more() }));
    await expect(canvas.findByRole('link', { name: 'Volume Ten' })).resolves.toBeVisible();
  },
};
export const NoPosition: Story = { args: { scenario: 'no-position' } };
export const MissingAssertion: Story = { args: { scenario: 'missing-assertion' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Stale: Story = { args: { scenario: 'stale' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Pending: Story = { args: { scenario: 'pending' } };
export const Uncertain: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await proposeCorrection(canvasElement);
    await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(m.candidate_unavailable());
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
