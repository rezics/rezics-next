import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ScreenProfile } from '../features/catalogue/screen-profile-view';
import { screenName } from '../features/catalogue/screen-profile';
import { screenProfileFixture, type ScreenScenario } from '../kernel/fake/catalogue-screen-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';
import type { Release } from '@rezics/definitions';

function ScreenStory({
  scenario = 'ready',
  correction = false,
  type = 'schema:Movie',
}: {
  scenario?: ScreenScenario;
  correction?: boolean;
  type?: string;
}) {
  const locale = getLocale();
  const fixture = useMemo(
    () => screenProfileFixture(scenario, locale, correction, type),
    [scenario, locale, correction, type],
  );
  return (
    <PatternStory path="/catalogue/screen" visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <ScreenProfile
          locale={locale}
          id={correction ? fixture.id : undefined}
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          onNavigate={() => {
            /* Keep the exact ordinary-reader link visible. */
          }}
          search={async () => [
            {
              id: '00000000-0000-4000-8000-000000000301',
              title: 'Observatory season',
              types: ['schema:TVSeason'],
              typeLabel: 'Season',
              cover: null,
            },
            {
              id: '00000000-0000-4000-8000-000000000302',
              title: 'A. Observer',
              types: ['schema:Person'],
              typeLabel: 'Person',
              cover: null,
            },
          ]}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Film television and episode editor',
  component: ScreenStory,
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
          'Released film, series, season and episode profiles. Route stories enter the actual application. Interaction examples compose existing typed request fixtures. Native acceptance and Web visual review remain pending; use locale, viewport and theme globals.',
      },
    },
  },
} satisfies Meta<typeof ScreenStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const field = (id: string) => screenName(definitions.release as Release, id, getLocale()).text;
async function assertOwnedTarget(control: HTMLElement, region: HTMLElement, document: Document) {
  const rect = control.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  const view = document.defaultView!;
  const phoneWidth = document.documentElement.clientWidth < 768;
  const coarsePointer = view.matchMedia('(pointer: coarse)').matches;
  const minimumHeight = phoneWidth || coarsePointer ? 44 : 32;
  await expect(control).toBeVisible();
  await expect(rect.height).toBeGreaterThanOrEqual(minimumHeight);
  if (!phoneWidth && !coarsePointer) await expect(rect.height).toBeLessThan(44);
  await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
  await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
}
async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:Episode',
  );
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'The observatory');
  for (const property of ['schema:duration', 'schema:episodeNumber', 'schema:isPartOf']) {
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), property);
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const section = within(canvas.getByRole('heading', { name: field(property) }).closest('section')!);
    if (property === 'schema:duration') {
      await userEvent.type(section.getByRole('textbox', { name: m.correction_amount() }), '+1440');
      await userEvent.selectOptions(
        section.getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q11574',
      );
    } else if (property === 'schema:episodeNumber') {
      await userEvent.type(section.getByRole('textbox', { name: m.correction_value() }), '0.5');
    } else {
      await userEvent.type(section.getByRole('combobox', { name: field(property) }), 'Observatory');
      const body = within(canvasElement.ownerDocument.body);
      await userEvent.click(await body.findByRole('option', { name: /Observatory season/ }));
    }
  }
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Route: Story = {
  render: () => <PageStory visitor="Signed In" path="/catalogue/screen" />,
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: Run this actual route journey at phone390 and desktop1280. It measures owned select, add/remove and citation controls against rendered bounds, uses the real pointer media query for target sizing, and exercises add/remove with the keyboard before preserving the duration-entry oracle. Creation and correction result stories remain unchanged.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const document = canvasElement.ownerDocument;
    await expect(await canvas.findByRole('heading', { level: 1, name: m.screen_title() })).toBeVisible();
    await expect(canvasElement.querySelectorAll('main#main-content')).toHaveLength(1);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
      'schema:Episode',
    );
    const addField = canvas.getByRole('combobox', { name: m.character_add_fact() });
    const fields = addField.closest('fieldset')!;
    const add = canvas.getByRole('button', { name: m.correction_add() });
    await assertOwnedTarget(addField, fields, document);
    await assertOwnedTarget(add, fields, document);
    await userEvent.selectOptions(addField, 'schema:director');
    addField.focus();
    await userEvent.tab();
    await expect(add).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    const directorHeading = await canvas.findByRole('heading', { name: field('schema:director') });
    const director = within(directorHeading.closest('section')!);
    const qualifier = director.getByRole('combobox', { name: m.correction_add_qualifier() });
    await assertOwnedTarget(qualifier, directorHeading.closest('section')!, document);
    await userEvent.selectOptions(qualifier, 'schema:position');
    const citation = director.getByRole('textbox', { name: m.relation_citation() });
    await assertOwnedTarget(citation, directorHeading.closest('section')!, document);
    await userEvent.type(citation, 'https://example.org/credits/observatory-director');
    await expect(citation).toHaveValue('https://example.org/credits/observatory-director');

    const remove = director.getAllByRole('button', { name: m.relation_remove() });
    await expect(remove).toHaveLength(2);
    for (const action of remove) await assertOwnedTarget(action, directorHeading.closest('section')!, document);
    remove[0]!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(director.getAllByRole('button', { name: m.relation_remove() })).toHaveLength(1);
    const removeFact = director.getByRole('button', { name: m.relation_remove() });
    removeFact.focus();
    await userEvent.keyboard('{Enter}');
    await expect(directorHeading).not.toBeInTheDocument();

    await userEvent.selectOptions(addField, 'schema:duration');
    await userEvent.click(add);
    const duration = within(canvas.getByRole('heading', { name: field('schema:duration') }).closest('section')!);
    await userEvent.type(duration.getByRole('textbox', { name: m.correction_amount() }), '+1440');
    await userEvent.selectOptions(
      duration.getByRole('combobox', { name: m.correction_unit() }),
      'http://www.wikidata.org/entity/Q11574',
    );
    await expect(duration.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+1440');
  },
};
export const CurrentRoute: Story = {
  render: () => <PageStory visitor="Signed In" path="/subjects/01a1773a-f700-7072-b9eb-3c03e51c0440/mushishi/screen" />,
};
export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const CorrectionLoading: Story = { args: { correction: true, scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const Unavailable: Story = { args: { scenario: 'definitions-unavailable' } };
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await fill(canvasElement);
  },
};
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining('00000000-0000-4000-8000-00000000c001'),
    );
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_denied())).toBeVisible();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_invalid())).toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_conflict())).toBeVisible();
  },
};
export const Retry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
  },
};
export const Concealed: Story = { args: { correction: true, scenario: 'concealed' } };
export const Film: Story = { args: { correction: true } };
export const Series: Story = { args: { correction: true, type: 'schema:TVSeries' } };
export const Season: Story = { args: { correction: true, type: 'schema:TVSeason' } };
export const Episode: Story = { args: { correction: true, type: 'schema:Episode' } };
export const Stale: Story = {
  args: { correction: true, scenario: 'stale' },
  play: async (context) => {
    const canvas = await proposeDate(context);
    await expect(await canvas.findByText(m.correction_stale())).toBeVisible();
  },
};
export const Proposed: Story = {
  args: { correction: true },
  play: async (context) => {
    const canvas = await proposeDate(context);
    await expect(await canvas.findByText(m.correction_proposed())).toBeVisible();
  },
};
export const Partial: Story = {
  args: { correction: true, scenario: 'partial' },
  play: async (context) => {
    const canvas = await proposeDate(context, true);
    await expect(await canvas.findByText(m.correction_proposed())).toBeVisible();
    await expect(await canvas.findByText(m.correction_denied())).toBeVisible();
  },
};
async function proposeDate({ canvasElement }: { canvasElement: HTMLElement }, partial = false) {
  const canvas = within(canvasElement);
  const heading = (await canvas.findAllByRole('heading', { name: field('schema:datePublished') })).at(-1)!;
  const row = within(heading.closest('section')!);
  await userEvent.click(row.getByRole('button', { name: m.facts_edit_field() }));
  const date = row.getByRole('textbox', { name: m.correction_year() });
  await userEvent.clear(date);
  await userEvent.type(date, '2026');
  if (partial) {
    const languageHeading = canvas.getByRole('heading', { name: field('schema:inLanguage') });
    const languageRow = within(languageHeading.closest('section')!);
    const choices = languageRow.getByRole('combobox', { name: m.facts_choose_value() });
    const selected = within(choices).getAllByRole('option')[1]!.getAttribute('value')!;
    await userEvent.selectOptions(choices, selected);
    await userEvent.click(languageRow.getByRole('button', { name: m.facts_edit_field() }));
    const value = languageRow.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'ja');
  }
  await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
  return canvas;
}
