import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DefinitionPublicationWorkspace } from '../features/catalogue/definition-publication/workspace';
import { definitionPublicationFixture, type PublicationScenario } from '../features/catalogue/definition-publication/fixtures';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function PublicationStory({ scenario = 'review' }: { scenario?: PublicationScenario }) {
  const locale = getLocale();
  const fixture = definitionPublicationFixture(scenario);
  return (
    <PatternStory path="/catalogue/definitions/publish" visitor={scenario === 'denied' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <DefinitionPublicationWorkspace locale={locale} scope="platform" initial={fixture.initial} transport={fixture.transport} />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Definition publication',
  component: PublicationStory,
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
          'Grant-controlled author workspace for native catalogue publication. Review, build continuation, reconciliation and completed publication. Locale, theme and viewport are globals.',
      },
    },
  },
} satisfies Meta<typeof PublicationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function importReview(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const file = await canvas.findByLabelText(m.definition_publication_file());
  const handle = new File(
    [
      JSON.stringify({
        format: 'https://rezics.com/definitions/release/1',
        types: { 'ex:BoardGame': { labels: { en: 'Board game' }, properties: [] } },
        properties: {},
      }),
    ],
    'board.json',
    { type: 'application/json' },
  );
  await userEvent.upload(file, handle);
  expect(await canvas.findByText(m.definition_publication_identity())).toBeVisible();
  const publish = await canvas.findByRole('button', { name: m.definition_publication_publish() });
  publish.focus();
  expect(publish).toHaveFocus();
}

export const Review: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => importReview(canvasElement),
};
export const ReviewPhone: Story = { ...Review, globals: { viewport: { value: 'phone390', isRotated: false } } };
export const BuildContinuation: Story = {
  args: { scenario: 'build' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    await importReview(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.definition_publication_publish() }));
    const cont = await canvas.findByRole('button', { name: m.definition_publication_continue_build() });
    cont.focus();
    expect(cont).toHaveFocus();
  },
};
export const BuildContinuationPhone: Story = {
  ...BuildContinuation,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const Reconciliation: Story = {
  args: { scenario: 'reconciliation' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    await importReview(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.definition_publication_publish() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.definition_publication_activate() }));
    const reload = await canvas.findByRole('button', { name: m.definition_publication_reload() });
    reload.focus();
    expect(reload).toHaveFocus();
  },
};
export const ReconciliationPhone: Story = {
  ...Reconciliation,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const Completed: Story = {
  args: { scenario: 'completed' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    await importReview(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.definition_publication_publish() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.definition_publication_activate() }));
    expect(await canvas.findByText(m.definition_publication_completed())).toBeVisible();
    const create = await canvas.findByRole('button', { name: m.definition_publication_create_subject() });
    create.focus();
    expect(create).toHaveFocus();
  },
};
export const CompletedPhone: Story = { ...Completed, globals: { viewport: { value: 'phone390', isRotated: false } } };
export const Closed: Story = { args: { scenario: 'closed' } };
export const Denied: Story = { args: { scenario: 'denied' } };
