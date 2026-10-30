import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { AddonProfile } from '../features/catalogue/addon-profile-view';
import {
  addonProfileFixture,
  addonProfileId,
  addonWorkId,
  addonCreatedId,
  type AddonScenario,
} from '../kernel/fake/catalogue-addon-profile';
import { pageText } from '../features/pages/data';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
}: {
  scenario?: AddonScenario;
  existing?: boolean;
  work?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => addonProfileFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <AddonProfile
          key={`${scenario}:${existing}:${work}:${locale}`}
          locale={locale}
          {...fixture.props}
          {...(existing ? { id: addonProfileId } : {})}
          {...(work ? { work: addonWorkId } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Add-on and expansion editor',
  component: Example,
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
          'Synthetic native-shaped responses through current production adapters. Locale, viewport and theme use globals. Web owns captures and visible acceptance; these stories do not establish native execution.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/addon" /> };
export const Create: Story = {};
export const BaseWork: Story = { args: { work: true } };
export const CurrentProfile: Story = { args: { existing: true } };
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Northern lights');
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Created: Story = {
  args: { work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.addon_use_base() }));
    await create(canvasElement);
    const correction = await canvas.findByRole('link', { name: m.addon_correct() });
    expect(correction.getAttribute('href')).toContain(`/subjects/${addonCreatedId}/northern-lights/addon`);
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    expect(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_create_retry() }));
    await expect(canvas.findByRole('link', { name: m.addon_correct() })).resolves.toBeVisible();
  },
};
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = within(
      await canvas.findByRole('region', {
        name: pageText(addonProfileFixture().release.properties['schema:inLanguage']!.labels, getLocale()).text,
      }),
    );
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const value = field.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'ko');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const Partial: Story = {
  args: { existing: true, scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [property, value] of [
      ['schema:inLanguage', 'fr'],
      ['schema:url', 'https://example.org/addon'],
    ] as const) {
      const field = within(
        await canvas.findByRole('region', {
          name: pageText(addonProfileFixture().release.properties[property]!.labels, getLocale()).text,
        }),
      );
      await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
      const input = field.getByRole('textbox', { name: m.correction_value() });
      await userEvent.clear(input);
      await userEvent.type(input, value);
    }
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(canvas.findByText(m.correction_denied())).resolves.toBeVisible();
    await expect(canvas.findByText(m.correction_proposed())).resolves.toBeVisible();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_invalid())).resolves.toBeVisible();
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_reader_unavailable())).resolves.toBeVisible();
  },
};
export const ConcealedReader: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_concealed())).resolves.toBeVisible();
  },
};
