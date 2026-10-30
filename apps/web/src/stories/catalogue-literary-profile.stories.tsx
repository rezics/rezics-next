import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { LiteraryProfile } from '../features/catalogue/literary-profile-view';
import type { LiteraryType } from '../features/catalogue/literary-profile';
import {
  literaryFixture,
  literaryWorkId,
  literaryRelease,
  type LiteraryScenario,
} from '../kernel/fake/catalogue-literary-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function LiteraryStory({
  scenario = 'ready',
  type = 'schema:Book',
  editing = false,
  signedOut = false,
}: {
  scenario?: LiteraryScenario;
  type?: LiteraryType;
  editing?: boolean;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => literaryFixture(scenario, locale, type, editing), [scenario, locale, type, editing]);
  return (
    <PatternStory visitor={signedOut ? 'Signed Out' : 'Signed In'} path="/catalogue/literary">
      <AppShell>
        <LiteraryProfile
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          id={editing ? literaryWorkId : undefined}
          transport={fixture.transport}
          facts={fixture.facts}
          review={fixture.review}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Book and book-series work editor',
  component: LiteraryStory,
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
          'Released book/series metadata and ordinary request seams. Native binding and visual acceptance are separate; no provider prose, covers or inferred word coverage.',
      },
    },
  },
} satisfies Meta<typeof LiteraryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function enterWork(canvasElement: HTMLElement, type = 'schema:Book') {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.catalogue_create_type() }), type);
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'ja');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), '原語の作品名');
  if (type === 'schema:Book') {
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.refinement_property() }), 'schema:wordCount');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_amount() }), '+12000');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.correction_unit() }), '1');
  }
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await enterWork(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Create: Story = {};
export const CurrentBook: Story = { args: { editing: true } };
export const CurrentBookSeries: Story = { args: { editing: true, type: 'schema:BookSeries' } };
export const CreateOriginalLanguageWork: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    const link = await canvas.findByRole('link', { name: m.catalogue_create_open() });
    expect(link.getAttribute('href')).toContain(`/subjects/${literaryWorkId}/`);
    expect(canvas.queryByRole('button', { name: m.catalogue_create_submit() })).toBeNull();
  },
};
export const CreateBookSeries: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await enterWork(canvasElement, 'schema:BookSeries');
    expect(
      canvas.getByRole('combobox', { name: m.refinement_property() }).querySelector('option[value="schema:wordCount"]'),
    ).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(literaryWorkId),
    );
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'metadata-unavailable' } };
export const NoReleasedProfiles: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_denied());
    expect(canvas.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+12000');
  },
};
export const Stale: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_conflict());
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
  },
};
export const Uncertain: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(literaryWorkId),
    );
  },
};
export const CreatedReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
export const Concealed: Story = { args: { scenario: 'concealed', editing: true } };
export const ProposeChangedWordCount: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('region', {
      name: pickText(literaryRelease.properties['schema:wordCount']!.labels, getLocale()).text,
    });
    const controls = within(field);
    await userEvent.click(controls.getByRole('button', { name: m.facts_edit_field() }));
    const amount = controls.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+13000');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    expect(await controls.findByText(m.correction_proposed())).toBeVisible();
    expect(controls.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain(
      'candidate=00000000-0000-4000-8000-00000000b002',
    );
  },
};
export const Route: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={`/subjects/${literaryWorkId}/an-original-literary-work/literary`} />
  ),
};
