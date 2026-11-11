import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CreateZone } from '../features/zones/manage/create';
import { zonesFixture, fixtureZoneId, type Scenario } from '../features/zones/manage/fixtures';
import { zonesNavigation } from '../features/zones/manage/navigation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { pickText } from '@rezics/composition';
import { starterChoices } from '../features/zones/manage/starters';
import { selectSharedOption } from './shared-select-interaction';

function bookStarterLabel() {
  return pickText(starterChoices.find((choice) => choice.id === 'book')!.labels, getLocale()).text;
}

function CreateStory({ scenario = 'list' }: { scenario?: Scenario | 'loading' | 'signed-out' }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => zonesFixture(scenario === 'loading' || scenario === 'signed-out' ? 'list' : scenario),
    [scenario],
  );
  return (
    <PatternStory path="/my/zones/new" visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell navigation={zonesNavigation}>
        <CreateZone
          locale={locale}
          session={scenario === 'loading' ? 'unknown' : scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          onCreate={fixture.create}
          onNavigate={() => {
            /* Keep the real saved destination reviewable in the canvas. */
          }}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Zones/Create',
  id: 'pages-zones-create',
  component: CreateStory,
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
          'Explicit inert starter creation through a synthetic native API. Review at 390 and 1280 in every locale and theme; no visual or native completion claim.',
      },
    },
  },
} satisfies Meta<typeof CreateStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseStarter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('combobox', { name: m.zones_create_starter() });
    const openNavigation = canvas.queryByRole('button', { name: m.shell_open_navigation() });
    if (openNavigation) await userEvent.click(openNavigation);
    const shell = within(canvasElement.ownerDocument.body);
    const createHref = `/${getLocale()}/my/zones/new`;
    for (const link of await shell.findAllByRole('link', { name: m.zones_owner_create() })) {
      await expect(link).toHaveAttribute('href', createHref);
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
    for (const link of await shell.findAllByRole('link', { name: m.zones_owner_title() })) {
      await expect(link).toHaveAttribute('href', `/${getLocale()}/my/zones`);
      await expect(link).not.toHaveAttribute('aria-current');
    }
    for (const link of shell.getAllByRole('link', { current: 'page' })) {
      await expect(link).toHaveAttribute('href', createHref);
    }
    if (openNavigation) await userEvent.keyboard('{Escape}');
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
async function submit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await selectSharedOption(await canvas.findByRole('combobox', { name: m.zones_create_starter() }), bookStarterLabel());
  await userEvent.click(canvas.getByRole('button', { name: m.zones_create_submit() }));
  return canvas;
}
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('link', { name: m.zones_owner_configure() })).toHaveAttribute(
      'href',
      `/${getLocale()}/my/zones/${fixtureZoneId}/edit`,
    );
    expect(canvas.getByRole('link', { name: m.zones_owner_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/zones/${fixtureZoneId}`,
    );
  },
};
export const Validation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.zones_create_submit() }));
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_invalid());
    expect(canvas.getByRole('combobox')).toHaveFocus();
  },
};
export const Names: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectSharedOption(
      await canvas.findByRole('combobox', { name: m.zones_create_starter() }),
      bookStarterLabel(),
    );
    expect(canvas.getAllByRole('textbox')).toHaveLength(8);
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_denied());
  },
};
export const ActorDenied: Story = {
  args: { scenario: 'actor' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_actor());
  },
};
export const FeatureClosed: Story = {
  args: { scenario: 'closed' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_closed());
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_conflict());
    expect(canvas.getByRole('button', { name: m.zones_create_review() })).toBeVisible();
  },
};
export const RejectedNames: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('textbox', { name: m.zones_create_label({ language: 'en' }) })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.zones_owner_retry() }));
    expect(await canvas.findByText(m.zones_create_saved())).toBeVisible();
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('button', { name: m.zones_owner_working() })).toBeDisabled();
  },
};
